/**
 * The classifier's internal write (2026-11-17): validated, tenant-scoped, and never over a person's override.
 */
import { describe, it, expect, vi } from "vitest";

const S = vi.hoisted(() => ({ rows: [] as any[], events: [] as any[] }));
vi.mock("@chatcenter/shared", () => ({
  getInternalServiceKey: () => "k", readDurableSetting: async () => null, recordHandover: async () => undefined,
  waitingForPersonClause: () => ({ AND: [{}] }), parseBusinessHours: () => null, isWorkspaceDay: () => true, dayStart: () => new Date(0), nextWorkspaceDay: (d: string) => d,
  publishEvent: async (e: any) => { S.events.push(e); },
  outgoingMessageQueue: { add: async () => undefined }, notificationsQueue: { add: async () => undefined },
  withHistoricalRecords: (fn: any) => fn(), replyWindowsFor: async () => new Map(),
  prisma: {
    conversation: {
      findFirst: async (a: any) => { const r = S.rows.find((x) => x.id === a.where.id && x.tenantId === a.where.tenantId); return r ? { ...r } : null; },
      updateMany: async (a: any) => {
        // Only the conditions the caller wrote: the override guard must come from the service's where.
        const hit = S.rows.filter((r) => r.id === a.where.id && r.tenantId === a.where.tenantId && (!("relevanceOverriddenBy" in a.where) || (r.relevanceOverriddenBy ?? null) === a.where.relevanceOverriddenBy));
        for (const r of hit) Object.assign(r, a.data);
        return { count: hit.length };
      },
    },
  },
}));
vi.mock("../lib/socket", () => ({ getIO: () => null }));
vi.mock("../lib/unread-state", () => ({ unreadStates: async () => new Map() }));
vi.mock("../services/message.service", () => ({ create: vi.fn() }));

import { setClassifiedRelevance } from "../services/conversation.service";

const row = (o: any = {}) => ({ id: "c1", tenantId: "T", relevanceCategory: null, relevanceOverriddenBy: null, ...o });

describe("internal relevance write", () => {
  it("★ writes the label and moves the row live", async () => {
    S.rows = [row()]; S.events = [];
    const out = await setClassifiedRelevance("T", "c1", { category: "auto_reply", confidence: 0.9, reason: "greeting", source: "fast", classifiedAt: "2026-11-17T12:00:00Z" });
    expect(out).toMatchObject({ written: true, relevance: { category: "auto_reply", confidence: 0.9, source: "fast" } });
    expect(S.events.some((e) => e.event === "conversation:updated" && e.data.relevance?.category === "auto_reply")).toBe(true);
  });
  it("★ the sender rule's label is accepted as it is", async () => {
    S.rows = [row()]; S.events = [];
    const out = await setClassifiedRelevance("T", "c1", { category: "personal", confidence: 1, reason: "this sender was marked personal by hand", source: "sender" });
    expect(out).toMatchObject({ written: true, relevance: { category: "personal", confidence: 1, source: "sender" } });
  });
  it("★ never replaces a person's override", async () => {
    S.rows = [row({ relevanceCategory: "business", relevanceSource: "override", relevanceOverriddenBy: "u1" })]; S.events = [];
    const out = await setClassifiedRelevance("T", "c1", { category: "internal", confidence: 0.95, source: "fast" });
    expect(out).toMatchObject({ written: false, relevance: { category: "business", overriddenBy: "u1" } });
    expect(S.events).toHaveLength(0);
  });
  it("★ tenant-scoped, and validated", async () => {
    S.rows = [row()];
    expect(await setClassifiedRelevance("OTHER", "c1", { category: "business", source: "model" })).toBeNull();
    await expect(setClassifiedRelevance("T", "c1", { category: "spam", source: "model" })).rejects.toMatchObject({ status: 400 });
    await expect(setClassifiedRelevance("T", "c1", { category: "business", source: "override" })).rejects.toMatchObject({ status: 400 });
  });
});
