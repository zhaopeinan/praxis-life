import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { CaptchaStore, type CaptchaChallenge } from "./captcha.js";
import { devCodesEnabled, sendVerificationMail, smtpConfigured } from "./mailer.js";
import { hashPassword, randomCode, randomToken, sameHash, sha256, verifyPassword } from "./passwords.js";
import { DomainError, type Store } from "./store.js";
import type { AccessTokenSummary, BaseMember, MemberRole, McpAgent, McpAgentBaseGrant, McpAgentStatus, PublicUser, SystemRole } from "./types.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const SEND_LIMIT = 5;
const MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const LOGIN_FAIL_LIMIT = 8;

type CodePurpose = "login";

function asString(value: unknown): string {
  return String(value ?? "");
}

function asNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new DomainError("邮箱格式不正确");
  return value;
}

function loadPepper(dataDir: string): string {
  if (process.env.DUOWEI_PEPPER) return process.env.DUOWEI_PEPPER;
  const file = path.join(dataDir, "pepper");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fs.mkdirSync(dataDir, { recursive: true });
  const pepper = randomToken("pepper");
  fs.writeFileSync(file, pepper, { mode: 0o600 });
  return pepper;
}

export class Accounts {
  private failures = new Map<string, { count: number; resetAt: number }>();
  private pepper: string;
  private exposeDevCodes: boolean;
  private captchas = new CaptchaStore();

  constructor(
    private db: Client,
    private store: Store,
    dataDir: string,
    options?: { devCodes?: boolean; pepper?: string },
  ) {
    this.pepper = options?.pepper ?? loadPepper(dataDir);
    this.exposeDevCodes = options?.devCodes ?? devCodesEnabled();
  }

  createCaptcha(): CaptchaChallenge {
    return this.captchas.create({ exposeAnswer: this.exposeDevCodes });
  }

  async userCount(): Promise<number> {
    const result = await this.db.execute("SELECT COUNT(*) AS count FROM users");
    return asNumber(result.rows[0]?.count);
  }

  /** 仅当库中尚无用户时可调用：创建首位管理员并播种示例表 */
  async bootstrapAdmin(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<{ user: PublicUser; token: string }> {
    if ((await this.userCount()) > 0) throw new DomainError("系统已初始化，请使用管理员账号登录", 403);
    const email = normalizeEmail(input.email);
    const name = cleanPersonName(input.name);
    assertPassword(input.password);
    const now = Date.now();
    const id = `u_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await this.db.execute({
      sql: `INSERT INTO users (id, name, email, password_hash, role, disabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'admin', 0, ?, ?)`,
      args: [id, name, email, await hashPassword(input.password), now, now],
    });
    const bases = await this.store.listBases();
    if (bases.length === 0) await this.store.seedDemo();
    const seeded = await this.store.listBases();
    for (const base of seeded) await this.addMember(base.id, id, "owner");
    const user = await this.requireUser(id);
    const token = await this.createSession(user.id);
    return { user, token };
  }

  /** 从环境变量自动引导（可选），不创建会话 */
  async maybeBootstrapFromEnv(): Promise<PublicUser | null> {
    if ((await this.userCount()) > 0) return null;
    const email = process.env.DUOWEI_BOOTSTRAP_EMAIL?.trim();
    const password = process.env.DUOWEI_BOOTSTRAP_PASSWORD ?? "";
    if (!email || !password) return null;
    const name = process.env.DUOWEI_BOOTSTRAP_NAME?.trim() || "管理员";
    const result = await this.bootstrapAdmin({ name, email, password });
    return result.user;
  }

  async sendCode(emailInput: string, purpose: CodePurpose = "login"): Promise<{ devCode?: string }> {
    if (purpose !== "login") throw new DomainError("不支持的验证码用途");
    const email = normalizeEmail(emailInput);
    const existing = await this.findUserByEmail(email);
    if (!existing) throw new DomainError("该邮箱尚未开通账号，请联系管理员");
    if (existing.disabled) throw new DomainError("账号已停用", 403);

    const since = Date.now() - SEND_WINDOW_MS;
    const recent = await this.db.execute({
      sql: "SELECT COUNT(*) AS count FROM verification_codes WHERE email = ? AND created_at > ?",
      args: [email, since],
    });
    if (asNumber(recent.rows[0]?.count) >= SEND_LIMIT) throw new DomainError("验证码发送过于频繁，请一小时后再试", 429);

    const code = randomCode();
    const now = Date.now();
    await this.db.execute({
      sql: "UPDATE verification_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL",
      args: [now, email, purpose],
    });
    await this.db.execute({
      sql: `INSERT INTO verification_codes (id, email, purpose, code_hash, attempts, expires_at, consumed_at, created_at)
            VALUES (?, ?, ?, ?, 0, ?, NULL, ?)`,
      args: [`c_${crypto.randomUUID().slice(0, 8)}`, email, purpose, this.hashCode(email, purpose, code), now + CODE_TTL_MS, now],
    });

    if (smtpConfigured()) await sendVerificationMail(email, code, purpose);
    else if (!this.exposeDevCodes) throw new DomainError("未配置邮件服务，无法发送验证码");

    return this.exposeDevCodes ? { devCode: code } : {};
  }

  async createUser(input: {
    name: string;
    email: string;
    password: string;
    role?: SystemRole;
  }): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    const name = cleanPersonName(input.name);
    assertPassword(input.password);
    if (await this.findUserByEmail(email)) throw new DomainError("该邮箱已存在");
    const role: SystemRole = input.role === "admin" ? "admin" : "member";
    const now = Date.now();
    const id = `u_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await this.db.execute({
      sql: `INSERT INTO users (id, name, email, password_hash, role, disabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      args: [id, name, email, await hashPassword(input.password), role, now, now],
    });
    return this.requireUser(id);
  }

  async login(input: {
    email: string;
    password?: string;
    code?: string;
    captchaId: string;
    captcha: string;
  }): Promise<{ user: PublicUser; token: string }> {
    const email = normalizeEmail(input.email);
    this.assertNotLocked(email);

    if (!input.captchaId?.trim() || !input.captcha?.trim()) {
      this.noteFailure(email);
      throw new DomainError("请填写图形验证码", 401);
    }
    if (!this.captchas.consume(input.captchaId, input.captcha)) {
      this.noteFailure(email);
      throw new DomainError("图形验证码不正确或已过期", 401);
    }

    const row = await this.findUserByEmail(email);
    if (!row) {
      this.noteFailure(email);
      throw new DomainError("邮箱或密码不正确", 401);
    }
    if (row.disabled) throw new DomainError("账号已停用", 403);

    if (input.code) {
      const ok = await this.checkCode(email, "login", input.code);
      if (!ok) {
        this.noteFailure(email);
        throw new DomainError("邮箱验证码不正确或已过期", 401);
      }
      await this.consumeCode(email, "login");
    } else if (input.password) {
      const match = await verifyPassword(input.password, row.passwordHash);
      if (!match) {
        this.noteFailure(email);
        throw new DomainError("邮箱或密码不正确", 401);
      }
    } else {
      throw new DomainError("请输入密码或邮箱验证码");
    }

    this.failures.delete(email);
    const token = await this.createSession(row.id);
    return { user: this.toPublic(row), token };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [sha256(token)] });
  }

  async userFromSecret(secret: string | undefined): Promise<PublicUser | null> {
    if (!secret) return null;
    const hash = sha256(secret);
    const now = Date.now();
    const session = await this.db.execute({
      sql: `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      args: [hash, now],
    });
    if (session.rows[0]) return this.toPublic(session.rows[0]);

    const access = await this.db.execute({
      sql: `SELECT users.*, access_tokens.id AS token_id FROM access_tokens
            JOIN users ON users.id = access_tokens.user_id
            WHERE access_tokens.token_hash = ?`,
      args: [hash],
    });
    const row = access.rows[0];
    if (row) {
      await this.db.execute({
        sql: "UPDATE access_tokens SET last_used_at = ? WHERE id = ?",
        args: [now, asString(row.token_id)],
      });
      return this.toPublic(row);
    }

    return this.agentFromTokenHash(hash, now);
  }

  /** MCP 专用：仅接受已激活的 Agent 令牌（不接受人类 PAT/session） */
  async agentFromMcpToken(secret: string | undefined): Promise<PublicUser | null> {
    if (!secret) return null;
    return this.agentFromTokenHash(sha256(secret), Date.now());
  }

  private async agentFromTokenHash(hash: string, now: number): Promise<PublicUser | null> {
    const result = await this.db.execute({
      sql: "SELECT * FROM mcp_agents WHERE token_hash = ?",
      args: [hash],
    });
    const row = result.rows[0];
    if (!row) return null;
    if (asString(row.status) !== "active") return null;
    await this.db.execute({
      sql: "UPDATE mcp_agents SET last_used_at = ? WHERE id = ?",
      args: [now, asString(row.id)],
    });
    return {
      id: asString(row.id),
      name: asString(row.name),
      email: asString(row.contact) || `${asString(row.id)}@agent.local`,
      role: "member",
      disabled: false,
      createdAt: asNumber(row.created_at),
      kind: "agent",
    };
  }

  async memberBaseIds(userId: string): Promise<string[]> {
    const result = await this.db.execute({
      sql: "SELECT base_id FROM base_members WHERE user_id = ?",
      args: [userId],
    });
    return result.rows.map((row) => asString(row.base_id));
  }

  async visibleBaseIds(user: PublicUser): Promise<string[] | "all"> {
    if (user.role === "admin" && user.kind !== "agent") return "all";
    if (user.kind === "agent") return this.agentBaseIds(user.id);
    return this.memberBaseIds(user.id);
  }

  async agentBaseRole(agentId: string, baseId: string): Promise<MemberRole | null> {
    const result = await this.db.execute({
      sql: "SELECT role FROM mcp_agent_bases WHERE agent_id = ? AND base_id = ?",
      args: [agentId, baseId],
    });
    const role = result.rows[0]?.role;
    if (role === "owner" || role === "editor" || role === "viewer") return role;
    return null;
  }

  async agentBaseIds(agentId: string): Promise<string[]> {
    const result = await this.db.execute({
      sql: "SELECT base_id FROM mcp_agent_bases WHERE agent_id = ?",
      args: [agentId],
    });
    return result.rows.map((row) => asString(row.base_id));
  }

  async registerMcpAgent(input: {
    name: string;
    description?: string;
    contact?: string;
  }): Promise<McpAgent> {
    const name = cleanPersonName(input.name);
    const now = Date.now();
    const id = `ag_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await this.db.execute({
      sql: `INSERT INTO mcp_agents (id, name, description, contact, status, token_hash, token_prefix, approved_by, last_used_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?)`,
      args: [id, name, (input.description ?? "").trim().slice(0, 500), (input.contact ?? "").trim().slice(0, 120), now, now],
    });
    return this.getMcpAgent(id);
  }

  async createMcpAgent(
    actorId: string,
    input: {
      name: string;
      description?: string;
      contact?: string;
      bases?: Array<{ baseId: string; role: MemberRole }>;
    },
  ): Promise<{ agent: McpAgent; token: string }> {
    const name = cleanPersonName(input.name);
    const now = Date.now();
    const id = `ag_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const token = randomToken("dwa");
    await this.db.execute({
      sql: `INSERT INTO mcp_agents (id, name, description, contact, status, token_hash, token_prefix, approved_by, last_used_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)`,
      args: [
        id,
        name,
        (input.description ?? "").trim().slice(0, 500),
        (input.contact ?? "").trim().slice(0, 120),
        sha256(token),
        token.slice(0, 10),
        actorId,
        now,
        now,
      ],
    });
    if (input.bases?.length) await this.setMcpAgentBases(id, input.bases);
    return { agent: await this.getMcpAgent(id), token };
  }

  async listMcpAgents(): Promise<McpAgent[]> {
    const result = await this.db.execute("SELECT * FROM mcp_agents ORDER BY created_at DESC");
    const agents = [];
    for (const row of result.rows) agents.push(await this.mapMcpAgent(row as Record<string, unknown>));
    return agents;
  }

  async getMcpAgent(agentId: string): Promise<McpAgent> {
    const result = await this.db.execute({ sql: "SELECT * FROM mcp_agents WHERE id = ?", args: [agentId] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到 Agent", 404);
    return this.mapMcpAgent(row as Record<string, unknown>);
  }

  async approveMcpAgent(
    agentId: string,
    actorId: string,
    bases?: Array<{ baseId: string; role: MemberRole }>,
  ): Promise<{ agent: McpAgent; token: string }> {
    const agent = await this.getMcpAgent(agentId);
    if (agent.status !== "pending" && agent.status !== "rejected") {
      throw new DomainError("仅待审批或已拒绝的申请可批准");
    }
    const token = randomToken("dwa");
    const now = Date.now();
    await this.db.execute({
      sql: `UPDATE mcp_agents SET status = 'active', token_hash = ?, token_prefix = ?, approved_by = ?, updated_at = ? WHERE id = ?`,
      args: [sha256(token), token.slice(0, 10), actorId, now, agentId],
    });
    if (bases) await this.setMcpAgentBases(agentId, bases);
    return { agent: await this.getMcpAgent(agentId), token };
  }

  async setMcpAgentStatus(agentId: string, status: Exclude<McpAgentStatus, "pending">): Promise<McpAgent> {
    await this.getMcpAgent(agentId);
    if (status === "rejected") {
      await this.db.execute({
        sql: `UPDATE mcp_agents SET status = ?, token_hash = NULL, token_prefix = NULL, updated_at = ? WHERE id = ?`,
        args: [status, Date.now(), agentId],
      });
    } else {
      await this.db.execute({
        sql: "UPDATE mcp_agents SET status = ?, updated_at = ? WHERE id = ?",
        args: [status, Date.now(), agentId],
      });
    }
    return this.getMcpAgent(agentId);
  }

  async rotateMcpAgentToken(agentId: string): Promise<{ agent: McpAgent; token: string }> {
    const agent = await this.getMcpAgent(agentId);
    if (agent.status !== "active") throw new DomainError("仅启用中的 Agent 可轮换令牌");
    const token = randomToken("dwa");
    await this.db.execute({
      sql: "UPDATE mcp_agents SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?",
      args: [sha256(token), token.slice(0, 10), Date.now(), agentId],
    });
    return { agent: await this.getMcpAgent(agentId), token };
  }

  async setMcpAgentBases(agentId: string, bases: Array<{ baseId: string; role: MemberRole }>): Promise<McpAgent> {
    await this.getMcpAgent(agentId);
    const basesList = await this.store.listBases();
    const known = new Set(basesList.map((b) => b.id));
    await this.db.execute({ sql: "DELETE FROM mcp_agent_bases WHERE agent_id = ?", args: [agentId] });
    for (const grant of bases) {
      if (!known.has(grant.baseId)) throw new DomainError(`找不到多维表格：${grant.baseId}`, 404);
      const role = grant.role === "owner" || grant.role === "editor" || grant.role === "viewer" ? grant.role : "viewer";
      await this.db.execute({
        sql: "INSERT INTO mcp_agent_bases (agent_id, base_id, role) VALUES (?, ?, ?)",
        args: [agentId, grant.baseId, role],
      });
    }
    return this.getMcpAgent(agentId);
  }

  async updateMcpAgent(
    agentId: string,
    patch: { name?: string; description?: string; contact?: string },
  ): Promise<McpAgent> {
    const current = await this.getMcpAgent(agentId);
    const name = patch.name != null ? cleanPersonName(patch.name) : current.name;
    const description = patch.description != null ? patch.description.trim().slice(0, 500) : current.description;
    const contact = patch.contact != null ? patch.contact.trim().slice(0, 120) : current.contact;
    await this.db.execute({
      sql: "UPDATE mcp_agents SET name = ?, description = ?, contact = ?, updated_at = ? WHERE id = ?",
      args: [name, description, contact, Date.now(), agentId],
    });
    return this.getMcpAgent(agentId);
  }

  async deleteMcpAgent(agentId: string): Promise<void> {
    await this.getMcpAgent(agentId);
    await this.db.execute({ sql: "DELETE FROM mcp_agents WHERE id = ?", args: [agentId] });
  }

  private async mapMcpAgent(row: Record<string, unknown>): Promise<McpAgent> {
    const id = asString(row.id);
    const grants = await this.db.execute({
      sql: "SELECT * FROM mcp_agent_bases WHERE agent_id = ?",
      args: [id],
    });
    const basesList = await this.store.listBases();
    const nameById = new Map(basesList.map((b) => [b.id, b.name]));
    const bases: McpAgentBaseGrant[] = grants.rows.map((g) => ({
      baseId: asString(g.base_id),
      baseName: nameById.get(asString(g.base_id)),
      role: asString(g.role) as MemberRole,
    }));
    return {
      id,
      name: asString(row.name),
      description: asString(row.description ?? ""),
      contact: asString(row.contact ?? ""),
      status: asString(row.status) as McpAgentStatus,
      tokenPrefix: row.token_prefix == null ? null : asString(row.token_prefix),
      lastUsedAt: row.last_used_at == null ? null : asNumber(row.last_used_at),
      approvedBy: row.approved_by == null ? null : asString(row.approved_by),
      createdAt: asNumber(row.created_at),
      updatedAt: asNumber(row.updated_at),
      bases,
    };
  }

  async listUsers(): Promise<PublicUser[]> {
    const result = await this.db.execute("SELECT * FROM users ORDER BY created_at ASC");
    return result.rows.map((row) => this.toPublic(row));
  }

  async updateUser(
    actorId: string,
    userId: string,
    patch: { name?: string; role?: SystemRole; disabled?: boolean; password?: string },
  ): Promise<PublicUser> {
    const user = await this.requireUser(userId);
    if (userId === actorId && (patch.disabled || (patch.role && patch.role !== "admin" && user.role === "admin"))) {
      throw new DomainError("不能停用或降级自己的管理员账号");
    }
    const nextRole = patch.role ?? user.role;
    const nextDisabled = patch.disabled ?? user.disabled;
    if (user.role === "admin" && (nextRole !== "admin" || nextDisabled)) {
      const admins = await this.db.execute({
        sql: "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?",
        args: [userId],
      });
      if (asNumber(admins.rows[0]?.count) === 0) throw new DomainError("至少保留一名可用的管理员");
    }
    const name = patch.name != null ? cleanPersonName(patch.name) : user.name;
    if (patch.password != null) assertPassword(patch.password);
    const passwordHash = patch.password != null ? await hashPassword(patch.password) : null;
    if (passwordHash) {
      await this.db.execute({
        sql: "UPDATE users SET name = ?, role = ?, disabled = ?, password_hash = ?, updated_at = ? WHERE id = ?",
        args: [name, nextRole, nextDisabled ? 1 : 0, passwordHash, Date.now(), userId],
      });
      await this.db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] });
    } else {
      await this.db.execute({
        sql: "UPDATE users SET name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?",
        args: [name, nextRole, nextDisabled ? 1 : 0, Date.now(), userId],
      });
    }
    if (nextDisabled) {
      await this.db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [userId] });
    }
    return this.requireUser(userId);
  }

  async createAccessToken(userId: string, name: string): Promise<{ token: string; summary: AccessTokenSummary }> {
    const label = name.trim();
    if (!label) throw new DomainError("令牌名称不能为空");
    const token = randomToken("dw");
    const now = Date.now();
    const summary: AccessTokenSummary = {
      id: `p_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      name: label.slice(0, 40),
      prefix: token.slice(0, 10),
      createdAt: now,
      lastUsedAt: null,
    };
    await this.db.execute({
      sql: `INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      args: [summary.id, userId, summary.name, sha256(token), summary.prefix, now],
    });
    return { token, summary };
  }

  async listAccessTokens(userId: string): Promise<AccessTokenSummary[]> {
    const result = await this.db.execute({
      sql: "SELECT * FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC",
      args: [userId],
    });
    return result.rows.map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      prefix: asString(row.token_prefix),
      createdAt: asNumber(row.created_at),
      lastUsedAt: row.last_used_at == null ? null : asNumber(row.last_used_at),
    }));
  }

  async deleteAccessToken(userId: string, tokenId: string): Promise<void> {
    const result = await this.db.execute({
      sql: "DELETE FROM access_tokens WHERE id = ? AND user_id = ?",
      args: [tokenId, userId],
    });
    if (result.rowsAffected === 0) throw new DomainError("找不到访问令牌", 404);
  }

  async memberRole(baseId: string, userId: string): Promise<MemberRole | null> {
    const result = await this.db.execute({
      sql: "SELECT role FROM base_members WHERE base_id = ? AND user_id = ?",
      args: [baseId, userId],
    });
    const role = result.rows[0]?.role;
    if (role === "owner" || role === "editor" || role === "viewer") return role;
    return null;
  }

  async listMembers(baseId: string): Promise<BaseMember[]> {
    const result = await this.db.execute({
      sql: `SELECT base_members.role, base_members.created_at, users.id, users.name, users.email
            FROM base_members JOIN users ON users.id = base_members.user_id
            WHERE base_members.base_id = ?
            ORDER BY base_members.created_at ASC`,
      args: [baseId],
    });
    return result.rows.map((row) => ({
      userId: asString(row.id),
      name: asString(row.name),
      email: asString(row.email),
      role: asString(row.role) as MemberRole,
      createdAt: asNumber(row.created_at),
    }));
  }

  async addMember(baseId: string, userId: string, role: MemberRole): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO base_members (base_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(base_id, user_id) DO UPDATE SET role = excluded.role`,
      args: [baseId, userId, role, Date.now()],
    });
  }

  async setMember(baseId: string, emailInput: string, role: MemberRole): Promise<BaseMember[]> {
    const email = normalizeEmail(emailInput);
    const user = await this.findUserByEmail(email);
    if (!user) throw new DomainError("找不到该用户，请先由管理员开通账号");
    if (user.disabled) throw new DomainError("该用户已停用");
    const current = await this.memberRole(baseId, user.id);
    if (current === "owner" && role !== "owner") await this.assertKeepsOwner(baseId, user.id);
    await this.addMember(baseId, user.id, role);
    return this.listMembers(baseId);
  }

  async removeMember(baseId: string, userId: string): Promise<BaseMember[]> {
    const current = await this.memberRole(baseId, userId);
    if (!current) throw new DomainError("该用户不在此多维表格中", 404);
    if (current === "owner") await this.assertKeepsOwner(baseId, userId);
    await this.db.execute({
      sql: "DELETE FROM base_members WHERE base_id = ? AND user_id = ?",
      args: [baseId, userId],
    });
    return this.listMembers(baseId);
  }

  private async assertKeepsOwner(baseId: string, userId: string): Promise<void> {
    const result = await this.db.execute({
      sql: "SELECT COUNT(*) AS count FROM base_members WHERE base_id = ? AND role = 'owner' AND user_id <> ?",
      args: [baseId, userId],
    });
    if (asNumber(result.rows[0]?.count) === 0) throw new DomainError("至少保留一名所有者");
  }

  private async checkCode(email: string, purpose: CodePurpose, code: string): Promise<boolean> {
    const row = await this.activeCode(email, purpose);
    if (!row) return false;
    const expected = this.hashCode(email, purpose, code.trim());
    if (!sameHash(expected, asString(row.code_hash))) {
      const attempts = asNumber(row.attempts) + 1;
      await this.db.execute({
        sql: "UPDATE verification_codes SET attempts = ?, consumed_at = ? WHERE id = ?",
        args: [attempts, attempts >= MAX_ATTEMPTS ? Date.now() : null, asString(row.id)],
      });
      return false;
    }
    return true;
  }

  private async consumeCode(email: string, purpose: CodePurpose): Promise<void> {
    const row = await this.activeCode(email, purpose);
    if (!row) return;
    await this.db.execute({
      sql: "UPDATE verification_codes SET consumed_at = ? WHERE id = ?",
      args: [Date.now(), asString(row.id)],
    });
  }

  private async activeCode(email: string, purpose: CodePurpose) {
    const result = await this.db.execute({
      sql: `SELECT * FROM verification_codes
            WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1`,
      args: [email, purpose, Date.now()],
    });
    return result.rows[0];
  }

  private hashCode(email: string, purpose: CodePurpose, code: string): string {
    return sha256(`${this.pepper}:${purpose}:${email}:${code}`);
  }

  private async createSession(userId: string): Promise<string> {
    const token = randomToken("sess");
    const now = Date.now();
    await this.db.execute({
      sql: "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [`s_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, userId, sha256(token), now + SESSION_TTL_MS, now],
    });
    return token;
  }

  private assertNotLocked(email: string): void {
    const entry = this.failures.get(email);
    if (!entry) return;
    if (entry.resetAt < Date.now()) {
      this.failures.delete(email);
      return;
    }
    if (entry.count >= LOGIN_FAIL_LIMIT) throw new DomainError("尝试次数过多，请 10 分钟后再试", 429);
  }

  private noteFailure(email: string): void {
    const now = Date.now();
    const entry = this.failures.get(email);
    if (!entry || entry.resetAt < now) {
      this.failures.set(email, { count: 1, resetAt: now + LOGIN_LOCK_MS });
      return;
    }
    entry.count += 1;
  }

  private async findUserByEmail(email: string): Promise<(PublicUser & { passwordHash: string }) | null> {
    const result = await this.db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] });
    const row = result.rows[0];
    if (!row) return null;
    return { ...this.toPublic(row), passwordHash: asString(row.password_hash) };
  }

  async findPublicByEmail(emailInput: string): Promise<PublicUser | null> {
    try {
      const row = await this.findUserByEmail(normalizeEmail(emailInput));
      if (!row) return null;
      const { passwordHash: _, ...user } = row;
      return user;
    } catch {
      return null;
    }
  }

  async findPublicByNameOrEmail(query: string): Promise<PublicUser | null> {
    const q = query.trim();
    if (!q) return null;
    if (q.includes("@")) return this.findPublicByEmail(q);
    const users = await this.listUsers();
    const exact = users.filter((u) => !u.disabled && (u.name === q || u.name.toLowerCase() === q.toLowerCase()));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new DomainError(`用户名不唯一：${q}`);
    return null;
  }

  private async requireUser(id: string): Promise<PublicUser> {
    const result = await this.db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] });
    const row = result.rows[0];
    if (!row) throw new DomainError("找不到用户", 404);
    return this.toPublic(row);
  }

  private toPublic(row: Record<string, unknown>): PublicUser {
    return {
      id: asString(row.id),
      name: asString(row.name),
      email: asString(row.email),
      role: asString(row.role) === "admin" ? "admin" : "member",
      disabled: asNumber(row.disabled) === 1,
      createdAt: asNumber(row.created_at),
      kind: "user",
    };
  }
}

function cleanPersonName(name: string): string {
  const value = name.trim();
  if (!value) throw new DomainError("姓名不能为空");
  if (value.length > 40) throw new DomainError("姓名不能超过 40 个字符");
  return value;
}

function assertPassword(password: string): void {
  if (password.length < 8) throw new DomainError("密码至少 8 位");
  if (password.length > 72) throw new DomainError("密码不能超过 72 位");
}
