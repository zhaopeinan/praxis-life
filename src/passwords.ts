import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomInt } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const hash = (await scrypt(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, digest] = stored.split("$");
  if (algo !== "scrypt" || !salt || !digest) return false;
  const hash = (await scrypt(password, salt, 32)) as Buffer;
  const expected = Buffer.from(digest, "base64url");
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function randomCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
