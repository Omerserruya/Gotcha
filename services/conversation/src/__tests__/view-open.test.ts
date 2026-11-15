/**
 * The "open" view (Frontend contract, 2026-11-15): the one view of a
 * workspace with one member. Everything not closed, minus exactly what GOTCHA
 * handles alone. "active" (status OPEN) misses WAITING and a claim that never
 * flipped the latch; this one does not.
 */
import { describe, it, expect, vi } from "vitest";

const S = vi.hoisted(() => ({ rows: [] as any[] }));

function ok(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return (v as any[]).every((x) => ok(row, x));
    if (k === "OR") return (v as any[]).some((x) => ok(row, x));
    if (k === "NOT") return !ok(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      // SQL: a NULL column is neither in nor not in a list.
      if ("notIn" in v) return row[k] != null && !v.notIn.includes(row[k]);
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      return true;
    }
    return (row[k] ?? null) === v;
  });
}
vi.mock("@chatcenter/shared", async () => {
  const queue: any = await vi.importActual("@chatcenter/shared/src/lib/conversation-queue");
  return {
    waitingForPersonClause: queue.waitingForPersonClause,
    getInternalServiceKey: () => "k",
    readDurableSetting: async () => null,
    recordHandover: async () => undefined,
    publishEvent: async () => undefined,
    outgoingMessageQueue: { add: async () => undefined },
    notificationsQueue: { add: async () => undefined },
    withHistoricalRecords: (fn: any) => fn(),
    prisma: {
      conversation: {
        findMany: async (a: any) => S.rows.filter((r) => ok(r, a.where)).map((r) => ({ ...r, messages: [] })),
        count: async (a: any) => S.rows.filter((r) => ok(r, a.where)).length,
      },
      contact: { findMany: async () => [] },
    },
  };
});
vi.mock("../lib/unread-state", () => ({ unreadStates: async () => new Map() }));
// socket.io is not installed in every checkout; nothing here emits.
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../services/message.service", () => ({ create: vi.fn() }));

import { listWhere, unreadCounts } from "../services/conversation.service";

const c = (id: string, o: any = {}) => ({
  id, tenantId: "T", customerExternalId: "9725", status: "OPEN", assignedAgentId: null,
  handledBy: null, isHandedOver: false, departmentId: null, channel: "WHATSAPP", lastMessageAt: new Date(1), ...o,
});
const admin = { userRole: "ADMIN", userId: "a1" };

describe("view=open", () => {
  const rows = () => [
    c("unclaimed", { status: "WAITING", handledBy: "human", isHandedOver: true }),
    c("no-owner", { status: "OPEN", handledBy: null }),
    c("ai-alone", { status: "OPEN", handledBy: "ai_agent" }),
    c("flow-alone", { status: "OPEN", handledBy: "flow" }),
    c("claimed-latch-unflipped", { status: "OPEN", handledBy: "ai_agent", assignedAgentId: "u1" }),
    c("taken-over", { status: "OPEN", handledBy: "ai_agent", isHandedOver: true }),
    c("closed", { status: "CLOSED", handledBy: "human", isHandedOver: true }),
  ];
  it("everything not closed that a person has; never what GOTCHA handles alone", async () => {
    S.rows = rows();
    const w = await listWhere("T", { view: "open", ...admin } as any);
    expect(S.rows.filter((r) => ok(r, w)).map((r) => r.id).sort()).toEqual(["claimed-latch-unflipped", "no-owner", "taken-over", "unclaimed"]);
  });
  it("with gotcha and resolved it partitions every conversation", async () => {
    S.rows = rows();
    const open = await listWhere("T", { view: "open", ...admin } as any);
    const gotcha = await listWhere("T", { automatedOnly: true, ...admin } as any);
    const resolved = await listWhere("T", { status: "CLOSED", includeAutomated: true, ...admin } as any);
    for (const r of S.rows) expect([open, gotcha, resolved].filter((w) => ok(r, w)).length, r.id).toBe(1);
  });
  it("is a key of /unread-counts, counted with the list's own filter", async () => {
    S.rows = rows();
    const { UNREAD_COUNT_VIEWS } = await import("../services/conversation.service");
    expect(UNREAD_COUNT_VIEWS).toContain("open");
    const got = await unreadCounts("T", { userId: "a1", role: "ADMIN" }, ["open"] as any);
    expect(got.totals.open).toBe(4);
  });
});
