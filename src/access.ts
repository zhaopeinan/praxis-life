import type { Accounts } from "./accounts.js";
import { DomainError } from "./store.js";
import type { MemberRole, PublicUser } from "./types.js";

const RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, owner: 3 };

export async function baseRole(accounts: Accounts, user: PublicUser, baseId: string): Promise<MemberRole | null> {
  if (user.kind === "agent") return accounts.agentBaseRole(user.id, baseId);
  if (user.role === "admin") return "owner";
  return accounts.memberRole(baseId, user.id);
}

export async function assertBaseRole(
  accounts: Accounts,
  user: PublicUser,
  baseId: string,
  needed: MemberRole,
): Promise<MemberRole> {
  const role = await baseRole(accounts, user, baseId);
  if (!role || RANK[role] < RANK[needed]) throw new DomainError("没有权限", 403);
  return role;
}
