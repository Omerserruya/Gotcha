/**
 * ★ Home's "waiting on you" count and Home's ranked queue use ONE definition of
 * "waiting for a person": a conversation the AI or a flow is answering is not
 * waiting for anyone (unless the AI handed it over). The count used to include
 * them: 21 on the card, 10 in the queue it opens.
 */
import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as any[], wheres: [] as any[] }));

function matches(r: any, w: any): boolean {
  if (r.tenantId !== w.tenantId || r.isTest !== false) return false;
  if (String(r.customerExternalId).startsWith("sandbox:")) return false;
  if (!w.status.in.includes(r.status) || r.assignedAgentId !== null) return false;
  return w.AND[0].OR.some((o: any) => Object.entries(o).every(([k, v]) => (r[k] ?? null) === v));
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: {
        findMany: async (a: any) => { H.wheres.push(a.where); return H.rows.filter((r) => matches(r, a.where)); },
        count: async (a: any) => H.rows.filter((r) => matches(r, a.where)).length,
      },
    },
  };
});

import { getQueueDepth, waitingForPersonWhere } from "../services/analytics.service";

const conv = (id: string, o: any = {}) => ({ id, tenantId: "T", isTest: false, customerExternalId: "972500", status: "OPEN", assignedAgentId: null, handledBy: null, isHandedOver: false, createdAt: new Date(0), lastMessageAt: new Date(0), ...o });

describe("★ waiting for a person", () => {
  it("counts the people queue: not the AI's, not a flow's (unless handed over), not assigned, not a rehearsal", async () => {
    H.rows = [
      conv("nobody"),                                          // waiting
      conv("human", { handledBy: "human" }),                   // waiting
      conv("handed", { handledBy: "ai_agent", isHandedOver: true }), // the AI gave up: waiting
      conv("ai", { handledBy: "ai_agent" }),                   // the AI is answering: NOT waiting
      conv("flow", { handledBy: "flow" }),                     // a flow is answering: NOT waiting
      conv("mine", { assignedAgentId: "u1" }),                 // a person has it
      conv("closed", { status: "CLOSED" }),
      conv("rehearsal", { customerExternalId: "sandbox:abc" }),
    ];
    expect((await getQueueDepth("T")).waiting).toBe(3);
    expect(H.wheres[0]).toEqual(waitingForPersonWhere("T"));
  });
});
