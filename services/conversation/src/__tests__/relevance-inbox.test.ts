/** Relevance in the inbox (2026-11-17). */
import { describe, it, expect, vi } from "vitest";

const S = vi.hoisted(() => ({ rows: [] as any[], updates: [] as any[], events: [] as any[] }));

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
    publishEvent: async (e: any) => { S.events.push(e); },
    outgoingMessageQueue: { add: async () => undefined },
    notificationsQueue: { add: async () => undefined },
    withHistoricalRecords: (fn: any) => fn(),
    prisma: {
      conversation: {
        findFirst: async (a: any) => S.rows.find((r) => ok(r, a.where)) ?? null,
        update: async (a: any) => { const r = S.rows.find((x) => x.id === a.where.id); Object.assign(r, a.data); S.updates.push(a); return { ...r }; },
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

import { listWhere, unreadCounts, setRelevanceOverride } from "../services/conversation.service";
import { presentRelevance, notIrrelevantWhere } from "@chatcenter/shared/src/lib/conversation-relevance";

/**
 * Relevance in the inbox (2026-11-17): view=irrelevant, the opt-in hideIrrelevant, and a person's override.
 */
const c = (id: string, o: any = {}) => ({
  id, tenantId: "T", customerExternalId: "9725", status: "OPEN", assignedAgentId: null, isTest: false,
  handledBy: null, isHandedOver: false, departmentId: null, channel: "WHATSAPP", lastMessageAt: new Date(1), relevanceCategory: null, ...o,
});
const admin = { userRole: "ADMIN", userId: "a1" };
const rows = () => [
  c("unlabelled"),
  c("business", { relevanceCategory: "business" }),
  c("personal", { relevanceCategory: "personal" }),
  c("notice-ai", { relevanceCategory: "notice", handledBy: "ai_agent" }),
  c("marketing-closed", { relevanceCategory: "marketing", status: "CLOSED" }),
  c("auto", { relevanceCategory: "auto_reply" }),
  c("internal", { relevanceCategory: "internal" }),
  c("unclear", { relevanceCategory: "unclear" }),
];
const ids = (w: any) => S.rows.filter((r) => ok(r, w)).map((r) => r.id).sort();

describe("relevance in the inbox", () => {
  it("★ view=irrelevant: the not-relevant labels only, any status, automated included", async () => {
    S.rows = rows();
    expect(ids(await listWhere("T", { view: "irrelevant", ...admin } as any))).toEqual(["auto", "marketing-closed", "notice-ai", "personal"]);
  });
  it("★ hideIrrelevant keeps the unlabelled (the NULL branch) and leaves internal in", async () => {
    S.rows = rows();
    expect(ids(await listWhere("T", { includeAutomated: true, hideIrrelevant: true, ...admin } as any))).toEqual(["business", "internal", "unclear", "unlabelled"]);
    // Opt-in: without it nothing changes.
    expect(ids(await listWhere("T", { includeAutomated: true, ...admin } as any))).toHaveLength(8);
    expect(ok({ relevanceCategory: null }, notIrrelevantWhere())).toBe(true);
  });
  it("★ unread-counts: 'irrelevant' is a view, and hideIrrelevant applies to the others", async () => {
    S.rows = rows();
    const plain = await unreadCounts("T", { userId: "a1", role: "ADMIN" }, ["all", "irrelevant"] as any);
    expect(plain.totals).toEqual({ all: 8, irrelevant: 4 });
    const hidden = await unreadCounts("T", { userId: "a1", role: "ADMIN" }, ["all", "irrelevant"] as any, { hideIrrelevant: true });
    expect(hidden.totals).toEqual({ all: 4, irrelevant: 4 });
  });
  it("★ an override sticks, names the person, and moves the row live", async () => {
    S.rows = rows(); S.updates = []; S.events = [];
    const r = await setRelevanceOverride("T", "internal", "business", { userId: "u9", role: "ADMIN" });
    expect(r).toMatchObject({ category: "business", source: "override", overriddenBy: "u9" });
    expect(S.events.some((e) => e.event === "conversation:updated" && e.data.relevance?.category === "business")).toBe(true);
    await expect(setRelevanceOverride("T", "internal", "notice", { userId: "u9", role: "ADMIN" })).rejects.toMatchObject({ status: 400 });
    expect(await setRelevanceOverride("T", "nope", "business", { userId: "u9", role: "ADMIN" })).toBeNull();
    // Another tenant's conversation is not found.
    expect(await setRelevanceOverride("OTHER", "business", "personal", { userId: "u9", role: "ADMIN" })).toBeNull();
  });
  it("the row's relevance object; an unknown value reads as unclear", () => {
    expect(presentRelevance({ relevanceCategory: null })).toBeNull();
    expect(presentRelevance({ relevanceCategory: "spam", relevanceConfidence: 0.4 })).toMatchObject({ category: "unclear", confidence: 0.4 });
  });
});
