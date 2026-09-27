import { createClient, type Client } from "@libsql/client";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DomainError } from "./store.js";

export type BackupSettings = {
  enabled: boolean;
  davUrl: string;
  username: string;
  /** 是否已配置密码（不回传明文） */
  hasPassword: boolean;
  remotePath: string;
  hour: number;
  minute: number;
  keepDays: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
};

export type BackupSettingsInput = {
  enabled?: boolean;
  davUrl?: string;
  username?: string;
  /** 留空表示不修改已有密码 */
  password?: string;
  remotePath?: string;
  hour?: number;
  minute?: number;
  keepDays?: number;
};

export type BackupLog = {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "ok" | "error";
  message: string;
  fileName: string | null;
  fileSize: number | null;
  remotePath: string | null;
};

type StoredSettings = {
  enabled: number;
  dav_url: string;
  username: string;
  password: string;
  remote_path: string;
  hour: number;
  minute: number;
  keep_days: number;
  last_run_at: number | null;
};

/** 知行人生备份统一按北京时间（UTC+8，无夏令时）调度与展示。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiParts(from = Date.now()) {
  const d = new Date(from + SHANGHAI_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function shanghaiWallToUtc(year: number, month: number, day: number, hour: number, minute: number) {
  return Date.UTC(year, month - 1, day, hour, minute, 0) - SHANGHAI_OFFSET_MS;
}

function nid(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function joinDav(base: string, ...parts: string[]) {
  const root = base.replace(/\/+$/, "");
  const rest = parts
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return rest ? `${root}/${rest}` : `${root}/`;
}

function authHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function run(command: string, args: string[], cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `${command} exited ${code}`));
    });
  });
}

export class BackupService {
  private running = false;

  constructor(
    private db: Client,
    private dataDir: string,
  ) {}

  async ensureTables() {
    await this.db.execute(`CREATE TABLE IF NOT EXISTS system_backup_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      dav_url TEXT NOT NULL DEFAULT 'https://dav.jianguoyun.com/dav/',
      username TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      remote_path TEXT NOT NULL DEFAULT '/知行人生备份',
      hour INTEGER NOT NULL DEFAULT 2,
      minute INTEGER NOT NULL DEFAULT 0,
      keep_days INTEGER NOT NULL DEFAULT 3,
      last_run_at INTEGER
    )`);
    await this.db.execute(`CREATE TABLE IF NOT EXISTS system_backup_logs (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      file_name TEXT,
      file_size INTEGER,
      remote_path TEXT
    )`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_backup_logs_started ON system_backup_logs(started_at DESC)`);
    const existing = await this.db.execute("SELECT id FROM system_backup_settings WHERE id = 1");
    if (!existing.rows[0]) {
      await this.db.execute({
        sql: `INSERT INTO system_backup_settings (id, enabled, dav_url, username, password, remote_path, hour, minute, keep_days)
              VALUES (1, 0, 'https://dav.jianguoyun.com/dav/', '', '', '/知行人生备份', 2, 0, 3)`,
        args: [],
      });
    }
  }

  private async rawSettings(): Promise<StoredSettings> {
    await this.ensureTables();
    const result = await this.db.execute("SELECT * FROM system_backup_settings WHERE id = 1");
    const row = result.rows[0];
    if (!row) throw new DomainError("备份配置不存在", 500);
    return {
      enabled: Number(row.enabled) ? 1 : 0,
      dav_url: String(row.dav_url ?? ""),
      username: String(row.username ?? ""),
      password: String(row.password ?? ""),
      remote_path: String(row.remote_path ?? "/知行人生备份"),
      hour: Number(row.hour ?? 2),
      minute: Number(row.minute ?? 0),
      keep_days: Number(row.keep_days ?? 3),
      last_run_at: row.last_run_at == null ? null : Number(row.last_run_at),
    };
  }

  private computeNextRun(hour: number, minute: number, from = Date.now()): number {
    const p = shanghaiParts(from);
    let next = shanghaiWallToUtc(p.year, p.month, p.day, hour, minute);
    if (next <= from) {
      const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day) + 24 * 60 * 60 * 1000);
      next = shanghaiWallToUtc(
        tomorrow.getUTCFullYear(),
        tomorrow.getUTCMonth() + 1,
        tomorrow.getUTCDate(),
        hour,
        minute,
      );
    }
    return next;
  }

  async getSettings(): Promise<BackupSettings> {
    const raw = await this.rawSettings();
    return {
      enabled: Boolean(raw.enabled),
      davUrl: raw.dav_url,
      username: raw.username,
      hasPassword: Boolean(raw.password),
      remotePath: raw.remote_path,
      hour: raw.hour,
      minute: raw.minute,
      keepDays: raw.keep_days,
      lastRunAt: raw.last_run_at,
      nextRunAt: raw.enabled ? this.computeNextRun(raw.hour, raw.minute) : null,
    };
  }

  async updateSettings(input: BackupSettingsInput): Promise<BackupSettings> {
    const raw = await this.rawSettings();
    const enabled = input.enabled == null ? raw.enabled : input.enabled ? 1 : 0;
    const davUrl = (input.davUrl ?? raw.dav_url).trim() || "https://dav.jianguoyun.com/dav/";
    const username = (input.username ?? raw.username).trim();
    const password = input.password == null || input.password === "" ? raw.password : input.password;
    const remotePath = (input.remotePath ?? raw.remote_path).trim() || "/知行人生备份";
    const hour = Math.min(23, Math.max(0, Math.floor(input.hour ?? raw.hour)));
    const minute = Math.min(59, Math.max(0, Math.floor(input.minute ?? raw.minute)));
    const keepDays = Math.min(30, Math.max(1, Math.floor(input.keepDays ?? raw.keep_days)));
    await this.db.execute({
      sql: `UPDATE system_backup_settings
            SET enabled = ?, dav_url = ?, username = ?, password = ?, remote_path = ?, hour = ?, minute = ?, keep_days = ?
            WHERE id = 1`,
      args: [enabled, davUrl, username, password, remotePath, hour, minute, keepDays],
    });
    return this.getSettings();
  }

  async listLogs(limit = 50): Promise<BackupLog[]> {
    await this.ensureTables();
    const result = await this.db.execute({
      sql: "SELECT * FROM system_backup_logs ORDER BY started_at DESC LIMIT ?",
      args: [Math.min(200, Math.max(1, limit))],
    });
    return result.rows.map((row) => ({
      id: String(row.id),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at == null ? null : Number(row.finished_at),
      status: String(row.status) as BackupLog["status"],
      message: String(row.message ?? ""),
      fileName: row.file_name == null ? null : String(row.file_name),
      fileSize: row.file_size == null ? null : Number(row.file_size),
      remotePath: row.remote_path == null ? null : String(row.remote_path),
    }));
  }

  private async writeLog(
    id: string,
    patch: Partial<{
      finishedAt: number;
      status: BackupLog["status"];
      message: string;
      fileName: string | null;
      fileSize: number | null;
      remotePath: string | null;
    }>,
  ) {
    await this.db.execute({
      sql: `UPDATE system_backup_logs
            SET finished_at = COALESCE(?, finished_at),
                status = COALESCE(?, status),
                message = COALESCE(?, message),
                file_name = COALESCE(?, file_name),
                file_size = COALESCE(?, file_size),
                remote_path = COALESCE(?, remote_path)
            WHERE id = ?`,
      args: [
        patch.finishedAt ?? null,
        patch.status ?? null,
        patch.message ?? null,
        patch.fileName ?? null,
        patch.fileSize ?? null,
        patch.remotePath ?? null,
        id,
      ],
    });
  }

  private async davRequest(
    settings: StoredSettings,
    method: string,
    urlPath: string,
    init?: { body?: Buffer | Uint8Array | string; headers?: Record<string, string> },
  ) {
    if (!settings.username || !settings.password) {
      throw new DomainError("请先填写坚果云账号和应用密码", 400);
    }
    const url = joinDav(settings.dav_url, ...urlPath.split("/"));
    const body =
      init?.body == null
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : new Uint8Array(init.body);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(settings.username, settings.password),
        ...(init?.headers ?? {}),
      },
      body,
    });
    return { response, url };
  }

  private async ensureRemoteDir(settings: StoredSettings) {
    const segments = settings.remote_path.split("/").filter(Boolean);
    let built = "";
    for (const segment of segments) {
      built = built ? `${built}/${segment}` : segment;
      const { response } = await this.davRequest(settings, "MKCOL", built);
      if (![201, 405, 409, 301, 200].includes(response.status)) {
        const text = await response.text().catch(() => "");
        if (response.status !== 405) {
          throw new DomainError(`创建坚果云目录失败（${response.status}）：${text.slice(0, 200) || built}`, 400);
        }
      }
    }
  }

  async testConnection(): Promise<{ ok: true; url: string; remotePath: string }> {
    const settings = await this.rawSettings();
    await this.ensureRemoteDir(settings);
    const { response, url } = await this.davRequest(settings, "PROPFIND", settings.remote_path, {
      headers: { Depth: "0", "Content-Type": "application/xml" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
    });
    if (![207, 200].includes(response.status)) {
      const text = await response.text().catch(() => "");
      throw new DomainError(`连接坚果云失败（${response.status}）：${text.slice(0, 240) || "请检查账号、应用密码与 WebDAV 地址"}`, 400);
    }
    return { ok: true, url, remotePath: settings.remote_path };
  }

  private async listRemoteFiles(settings: StoredSettings): Promise<Array<{ name: string; href: string }>> {
    const { response } = await this.davRequest(settings, "PROPFIND", settings.remote_path, {
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/></d:prop></d:propfind>`,
    });
    const xml = await response.text();
    if (![207, 200].includes(response.status)) {
      throw new DomainError(`列举坚果云文件失败（${response.status}）`, 400);
    }
    const hrefs = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/gi)].map((match) => decodeURIComponent(match[1]));
    const files: Array<{ name: string; href: string }> = [];
    for (const href of hrefs) {
      const name = href.split("/").filter(Boolean).pop() ?? "";
      if (!name || !name.startsWith("zhixing-") || !name.endsWith(".tar.gz")) continue;
      files.push({ name, href });
    }
    return files;
  }

  private async pruneRemote(settings: StoredSettings) {
    const files = await this.listRemoteFiles(settings);
    const sorted = files.sort((a, b) => b.name.localeCompare(a.name));
    const keep = Math.max(1, settings.keep_days);
    for (const file of sorted.slice(keep)) {
      const relative = `${settings.remote_path.replace(/^\/+|\/+$/g, "")}/${file.name}`;
      await this.davRequest(settings, "DELETE", relative);
    }
  }

  private async createArchive(): Promise<{ filePath: string; fileName: string; size: number }> {
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fileName = `zhixing-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.tar.gz`;
    const tmpDir = path.join(this.dataDir, ".backup-tmp");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const snapshotDb = path.join(tmpDir, "duowei.db");
    const liveDb = path.join(this.dataDir, "duowei.db");

    // Consistent snapshot via temporary libsql copy + checkpoint
    try {
      await this.db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    fs.copyFileSync(liveDb, snapshotDb);
    for (const side of ["duowei.db-wal", "duowei.db-shm"]) {
      const src = path.join(this.dataDir, side);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, side));
    }
    const pepper = path.join(this.dataDir, "pepper");
    if (fs.existsSync(pepper)) fs.copyFileSync(pepper, path.join(tmpDir, "pepper"));
    const uploads = path.join(this.dataDir, "uploads");
    if (fs.existsSync(uploads)) {
      await run("cp", ["-a", uploads, path.join(tmpDir, "uploads")]);
    }

    // Verify snapshot opens
    const probe = createClient({ url: `file:${snapshotDb}` });
    await probe.execute("SELECT 1");

    const outPath = path.join(this.dataDir, fileName);
    await run("tar", ["-czf", outPath, "-C", tmpDir, "."]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const size = fs.statSync(outPath).size;
    return { filePath: outPath, fileName, size };
  }

  async runBackup(trigger: "manual" | "schedule" = "manual"): Promise<BackupLog> {
    if (this.running) throw new DomainError("已有备份任务在进行中", 409);
    this.running = true;
    const settings = await this.rawSettings();
    const id = nid("bk");
    const startedAt = Date.now();
    await this.db.execute({
      sql: `INSERT INTO system_backup_logs (id, started_at, status, message) VALUES (?, ?, 'running', ?)`,
      args: [id, startedAt, trigger === "manual" ? "手动备份开始" : "定时备份开始"],
    });

    let archive: { filePath: string; fileName: string; size: number } | null = null;
    try {
      if (!settings.username || !settings.password) {
        throw new DomainError("请先配置坚果云账号和应用密码", 400);
      }
      archive = await this.createArchive();
      await this.ensureRemoteDir(settings);
      const remoteRelative = `${settings.remote_path.replace(/^\/+|\/+$/g, "")}/${archive.fileName}`;
      const body = fs.readFileSync(archive.filePath);
      const { response } = await this.davRequest(settings, "PUT", remoteRelative, {
        body,
        headers: { "Content-Type": "application/gzip", "Content-Length": String(body.length) },
      });
      if (![200, 201, 204].includes(response.status)) {
        const text = await response.text().catch(() => "");
        throw new DomainError(`上传坚果云失败（${response.status}）：${text.slice(0, 240)}`, 400);
      }
      await this.pruneRemote(settings);
      const finishedAt = Date.now();
      await this.db.execute({
        sql: "UPDATE system_backup_settings SET last_run_at = ? WHERE id = 1",
        args: [finishedAt],
      });
      await this.writeLog(id, {
        finishedAt,
        status: "ok",
        message: `备份成功，已上传并保留最近 ${settings.keep_days} 份`,
        fileName: archive.fileName,
        fileSize: archive.size,
        remotePath: `${settings.remote_path.replace(/\/$/, "")}/${archive.fileName}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeLog(id, {
        finishedAt: Date.now(),
        status: "error",
        message,
        fileName: archive?.fileName ?? null,
        fileSize: archive?.size ?? null,
        remotePath: null,
      });
      throw error instanceof DomainError ? error : new DomainError(message, 500);
    } finally {
      if (archive?.filePath && fs.existsSync(archive.filePath)) {
        try {
          fs.unlinkSync(archive.filePath);
        } catch {
          /* ignore */
        }
      }
      this.running = false;
    }

    const logs = await this.listLogs(1);
    return logs[0];
  }

  /** Called by schedule tick; runs at most once per day after configured Beijing time. */
  async tick(): Promise<void> {
    const settings = await this.rawSettings();
    if (!settings.enabled) return;
    if (this.running) return;
    const p = shanghaiParts();
    if (p.hour < settings.hour || (p.hour === settings.hour && p.minute < settings.minute)) {
      return;
    }
    const startOfDay = shanghaiWallToUtc(p.year, p.month, p.day, 0, 0);
    if (settings.last_run_at != null && settings.last_run_at >= startOfDay) return;
    try {
      await this.runBackup("schedule");
    } catch (error) {
      // Mark attempted so a failing night does not retry every minute.
      await this.db.execute({
        sql: "UPDATE system_backup_settings SET last_run_at = ? WHERE id = 1",
        args: [Date.now()],
      });
      console.error("backup schedule failed", error);
    }
  }
}
