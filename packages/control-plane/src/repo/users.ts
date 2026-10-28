import type { User } from "@zhixingbot/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings, userCounters, users } from "../db/schema.js";
import { newId } from "../ids.js";
import { hashPassword, verifyPassword } from "../password.js";
import { ensureAssistant } from "./bots.js";
import { toUser } from "./rows.js";

export type NewUser = {
  readonly name: string;
  readonly email: string;
  readonly password: string;
};

/** 注册撞邮箱时只认数据库唯一约束，不先查后写。 */
export function isEmailTaken(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "23505" &&
    "constraint_name" in error &&
    error.constraint_name === "users_email_unique"
  );
}

export async function createUser(db: Db, input: NewUser): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        id: newId(),
        name: input.name,
        email: input.email,
        passwordHash,
      })
      .returning();
    if (row === undefined) throw new Error("建用户没有返回行");
    await tx.insert(userCounters).values({ userId: row.id });
    await tx.insert(settings).values({ userId: row.id });
    const user = toUser(row);
    await ensureAssistant(tx, user.id);
    return user;
  });
}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row === undefined ? null : toUser(row);
}

/**
 * 嵌进宿主（知行人生）时的 provisioning：宿主用户 id 直接当知行Bot用户 id（两边 id 都只是字符串），
 * 首次见到才建行。密码哈希是不可能有账号匹配的占位串——合并模式下登录路由根本不开。
 * 并发首访撞主键/邮箱唯一约束时认输重查，谁插进去算谁的。
 */
export async function provisionExternalUser(
  db: Db,
  input: { readonly id: string; readonly name: string; readonly email: string },
): Promise<User> {
  const [existing] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
  if (existing !== undefined) return toUser(existing);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ id: input.id, name: input.name, email: input.email, passwordHash: "duowei-external" })
        .returning();
      if (row === undefined) throw new Error("provisioning 用户没有返回行");
      await tx.insert(userCounters).values({ userId: row.id });
      await tx.insert(settings).values({ userId: row.id });
      const user = toUser(row);
      await ensureAssistant(tx, user.id);
      return user;
    });
  } catch (error) {
    const duplicated =
      error instanceof Error && "code" in error && error.code === "23505" && isUserConstraint(error);
    if (!duplicated) throw error;
    const [row] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (row === undefined) throw error;
    return toUser(row);
  }
}

function isUserConstraint(error: Error & { code?: unknown; constraint_name?: unknown }): boolean {
  return error.constraint_name === "users_pkey" || error.constraint_name === "users_email_unique";
}

// 邮箱不存在时拿它顶上，这样两条路径都只跑一次 scrypt，响应时间不泄露账号是否存在。
const ABSENT_USER_HASH = await hashPassword("没有这个账号");

export async function authenticate(db: Db, email: string, password: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const ok = await verifyPassword(password, row?.passwordHash ?? ABSENT_USER_HASH);
  if (!ok || row === undefined) return null;
  return toUser(row);
}
