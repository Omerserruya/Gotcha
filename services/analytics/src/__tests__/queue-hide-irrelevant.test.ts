/**
 * The Home's waiting number and the waiting card can leave out conversations labelled not relevant
 * (2026-11-17), opt-in with hideIrrelevant. Without it, nothing changes.
 */
import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as any[] }));

function ok(r: any, w: any): boolean {
  return Object.entries(w).every(([k, v]: [string, any]) => {
    if (k === "AND") return (v as any[]).every((x) => ok(r, x));
    if (k === "OR") return (v as any[]).some((x) => ok(r, x));
    if (k === "NOT") return !ok(r, v);
    if (v && typeof v === "object") {
      if ("notIn" in v) return r[k] != null && !v.notIn.includes(r[k]);
      if ("in" in v) return v.in.includes(r[k]);
      if ("startsWith" in v) return String(r[k] ?? "").startsWith(v.startsWith);
      return true;
    }
    return (r[k] ?? null) === v;
  });
}

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: {
      conversation: {
        findMany: async (a: any) => H.rows.filter((r) => ok(r, a.where)),
        count: async (a: any) => H.rows.filter((r) => ok(r, a.where)).length,
      },
    },
  };
});

import { getQueueDepth } from "../services/analytics.service";

const conv = (id: string, relevanceCategory: string | null) => ({ id, tenantId: "T", isTest: false, customerExternalId: "972500", status: "OPEN", assignedAgentId: null, handledBy: null, isHandedOver: false, createdAt: new Date(0), lastMessageAt: new Date(0), relevanceCategory });

describe("★ the waiting number without the not-relevant", () => {
  it("hideIrrelevant leaves out personal, notice, marketing and auto_reply; keeps unlabelled, internal and unclear", async () => {
    H.rows = [conv("a", null), conv("b", "business"), conv("c", "personal"), conv("d", "notice"), conv("e", "marketing"), conv("f", "auto_reply"), conv("g", "internal"), conv("h", "unclear")];
    expect((await getQueueDepth("T")).waiting).toBe(8);
    expect((await getQueueDepth("T", { hideIrrelevant: true })).waiting).toBe(4);
  });
});
