/**
 * Plan catalog helpers + tier ordering (for upgrade vs downgrade detection).
 */
import { prisma } from "@chatcenter/shared";

const TIER_ORDER = ["light", "pro", "business", "enterprise"] as const;

export function tierRank(key: string): number {
  const i = TIER_ORDER.indexOf(key as any);
  return i === -1 ? -1 : i;
}

/** true if moving `from`→`to` is an upgrade (higher tier). */
export function isUpgrade(from: string, to: string): boolean {
  const a = tierRank(from);
  const b = tierRank(to);
  return a >= 0 && b >= 0 && b > a;
}

export async function getPlan(key: string, version = 1) {
  return prisma.plan.findUnique({ where: { key_version: { key, version } } });
}

export async function listActivePlans() {
  return prisma.plan.findMany({ where: { active: true }, include: { entitlements: true }, orderBy: { basePrice: "asc" } });
}
