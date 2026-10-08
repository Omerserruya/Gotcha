/**
 * ★ The inbox's "Waiting in queue" view (view=queue) is exactly "waiting for a
 * person" (the shared waitingForPersonClause, the one Home counts):
 *   - only open, unassigned, not AI/flow-handled (unless handed over), not a rehearsal
 *   - its `viewTotal` is that same set (Home said 9, the view showed 10)
 *   - ★ the inbox's visibility clause still applies (the definition's own OR
 *     must not overwrite it)
 *   - without view=queue nothing changes (other callers keep the old default)
 */
import { describe, it, expect, vi } from "vitest";

const S = vi.hoisted(() => ({ rows: [] as any[] }));

/** Evaluates the where clause the way Postgres would, for the shapes the list builds. */
function ok(row: any, w: any): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return (v as any[]).every((x) => ok(row, x));
    if (k === "OR") return (v as any[]).some((x) => ok(row, x));
    if (k === "NOT") return !ok(row, v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
      if ("startsWith" in v) return String(row[k] ?? "").startsWith(v.startsWith);
      if ("lt" in v) return row[k] != null && row[k] < v.lt;
      if ("gt" in v) return row[k] != null && row[k] > v.gt;
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

import { list } from "../services/conversation.service";

const c = (id: string, o: any = {}) => ({
  id, tenantId: "T", isTest: false, customerExternalId: "9725", status: "OPEN", assignedAgentId: null,
  handledBy: null, isHandedOver: false, departmentId: null, lastMessageAt: new Date(1), ...o,
});
const fixture = () => [
  c("nobody"), c("waiting", { status: "WAITING" }), c("human", { handledBy: "human" }), c("handed", { handledBy: "ai_agent", isHandedOver: true }),
  c("ai", { handledBy: "ai_agent" }), c("flow", { handledBy: "flow" }),
  c("assigned", { assignedAgentId: "u9" }), c("closed", { status: "CLOSED" }),
  c("rehearsal", { customerExternalId: "sandbox:x" }), c("testrow", { isTest: true }),
  c("sales", { departmentId: "sales" }), c("support", { departmentId: "support" }),
];
const admin = { userRole: "ADMIN", userId: "a1" };

describe("★ view=queue is 'waiting for a person'", () => {
  it("only the waiting conversations, and viewTotal is the same set (keyset and offset)", async () => {
    S.rows = fixture();
    const k: any = await list("T", { view: "queue", cursor: "", ...admin });
    expect(k.data.map((r: any) => r.id).sort()).toEqual(["handed", "human", "nobody", "sales", "support", "waiting"]);
    expect(k.viewTotal).toBe(6);
    const o: any = await list("T", { view: "queue", ...admin });
    expect(o.viewTotal).toBe(6);
    expect(o.meta.total).toBe(6);
  });

  it("viewTotal is the whole view on every page, not what is left after the cursor", async () => {
    S.rows = fixture().map((r, i) => ({ ...r, lastMessageAt: new Date(1000 - i) }));
    const p1: any = await list("T", { view: "queue", cursor: "", limit: 2, ...admin });
    expect(p1.page.nextCursor).toBeTruthy();
    const p2: any = await list("T", { view: "queue", cursor: p1.page.nextCursor, limit: 2, ...admin });
    expect(p2.viewTotal).toBe(6);
  });

  it("★ a department-restricted agent still sees only theirs (visibility kept)", async () => {
    S.rows = fixture();
    const r: any = await list("T", { view: "queue", cursor: "", userRole: "AGENT", userId: "u1", userDepartmentId: "sales" });
    // sales + the department-less unassigned ones; never support's.
    expect(r.data.map((x: any) => x.id)).not.toContain("support");
    expect(r.data.map((x: any) => x.id)).toContain("sales");
    expect(r.viewTotal).toBe(r.data.length);
  });

  it("a status in the query neither widens nor narrows the view", async () => {
    S.rows = fixture();
    const r: any = await list("T", { view: "queue", status: "CLOSED", cursor: "", ...admin });
    expect(r.data.map((x: any) => x.id)).not.toContain("closed");
    const open: any = await list("T", { view: "queue", status: "OPEN", cursor: "", ...admin });
    expect(open.data.map((x: any) => x.id)).toContain("waiting");
  });

  it("without view=queue, the default is unchanged (closed and assigned still listed); its viewTotal when asked", async () => {
    S.rows = fixture();
    const r: any = await list("T", { cursor: "", ...admin });
    expect(r.data.map((x: any) => x.id)).toEqual(expect.arrayContaining(["closed", "assigned"]));
    expect(r.viewTotal).toBeUndefined();
    const asked: any = await list("T", { cursor: "", withTotal: true, ...admin });
    expect(asked.viewTotal).toBe(asked.data.length);
  });
});
