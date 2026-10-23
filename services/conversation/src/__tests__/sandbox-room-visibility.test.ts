/**
 * A sandbox rehearsal is its tester's alone (2026-10-23): no other agent - not
 * even an admin who sees every conversation - can open it by id or join its
 * socket room, so nothing the onboarding employee test emits reaches them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as any[] }));

/** Just enough of Prisma's where semantics for the clauses this rule writes. */
function matches(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return (v as any[]).every((x) => matches(row, x));
    if (k === "OR") return (v as any[]).some((x) => matches(row, x));
    if (k === "NOT") return !matches(row, v);
    if (v && typeof v === "object" && ("startsWith" in v || "endsWith" in v)) {
      const s = String(row[k] ?? "");
      return ("startsWith" in v ? s.startsWith(v.startsWith) : true) && ("endsWith" in v ? s.endsWith(v.endsWith) : true);
    }
    if (v && typeof v === "object") return true; // role clauses: not under test here
    return row[k] === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  prisma: { conversation: { findFirst: async ({ where }: any) => H.rows.find((r) => matches(r, where)) ?? null } },
}));

import { canViewConversation } from "../lib/conversation-visibility";

beforeEach(() => {
  H.rows = [
    { id: "real", tenantId: "T", customerExternalId: "972501234567" },
    { id: "sb", tenantId: "T", customerExternalId: "sandbox:ag1:owner1" },
  ];
});

describe("sandbox conversations by id", () => {
  const admin = (userId: string) => ({ userId, role: "ADMIN" as any, departmentId: undefined });
  it("the tester sees their own rehearsal", async () => {
    expect(await canViewConversation("T", "sb", admin("owner1"))).toBe(true);
  });
  it("another admin cannot open it or join its room", async () => {
    expect(await canViewConversation("T", "sb", admin("other-admin"))).toBe(false);
  });
  it("real conversations are unaffected", async () => {
    expect(await canViewConversation("T", "real", admin("other-admin"))).toBe(true);
  });
});
