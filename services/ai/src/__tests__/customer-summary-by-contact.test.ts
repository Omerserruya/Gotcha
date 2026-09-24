/**
 * "Summarise all of it", reachable from the screen that wants it.
 *
 * 04c asks for a merchant-triggered cross-history summary. It already existed:
 * `refreshCustomerBriefFromConversation` loads the CROSS-CHANNEL bundle, so
 * `refresh: true` has always summarised everything. It was only reachable from
 * a conversationId, and a customer screen holds a Contact id - the capability
 * sat in an id space its caller could not get to. Same shape as
 * `evidenceConversationIds` and `/customers/:customerId/memory`.
 *
 * So this adds an ENTRY POINT, not a second summariser. One brief, one writer.
 *
 * ★ The resolver names origin. `applyLiveByDefault` injects `origin: "LIVE"`
 * into bulk Conversation reads, so a customer whose history was imported and
 * who has no live conversation yet would resolve to nothing - and be reported
 * as having "no prior interactions" despite years of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  contacts: [] as any[],
  conversation: null as any,
  seenConvWhere: null as any,
  brief: null as any,
  refreshed: [] as string[],
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: { findFirst: async ({ where }: any) => state.contacts.find((c) => c.id === where.id) ?? null },
    conversation: {
      findFirst: async (args: any) => { state.seenConvWhere = args.where; return state.conversation; },
      findUnique: async () => ({ channel: "WHATSAPP", customerExternalId: "+972500000000", tenantId: "t1" }),
    },
    customerBrief: { findFirst: async () => state.brief },
  },
  findSiblingContacts: async (_t: string, c: any) => [c],
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
}));

vi.mock("../services/customer-brief.service", () => ({
  getCustomerBrief: async () => state.brief,
  refreshCustomerBriefFromConversation: async ({ conversationId }: any) => {
    state.refreshed.push(conversationId);
    return state.brief;
  },
  deriveIdentityKey: () => "person:p1",
}));

import customerSummaryRouter from "../routes/customer-summary";

const app = express();
app.use(express.json());
app.use("/api/customer-summary", customerSummaryRouter);

const BRIEF = {
  brief: "Buys every few weeks, prefers evening delivery.",
  signals: ["repeat buyer"],
  generatedAt: "2026-09-01T00:00:00.000Z",
  conversationCount: 12,
  channels: ["WHATSAPP"],
  tone: "warm", mood: "positive", recommendedBehaviors: [],
  lastSourceChannel: "WHATSAPP", lastSourceConvId: "cv9",
  identityKey: "person:p1",
  meta: { crm_linked: false, person_linked: true },
};

beforeEach(() => {
  state.contacts = [{ id: "c1", tenantId: "t1", channel: "WHATSAPP", externalId: "+972500000000", mergedIntoId: null, metadata: {}, personId: "p1" }];
  state.conversation = { id: "cv9" };
  state.seenConvWhere = null;
  state.brief = { ...BRIEF };
  state.refreshed = [];
});

const post = (body: any) => request(app).post("/api/customer-summary").send(body);

describe("a contact id is enough", () => {
  it("★ resolves the contact to a conversation and returns the brief", async () => {
    const res = await post({ contactId: "c1" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toBe(BRIEF.brief);
  });

  it("★ refresh regenerates across the whole history, not one conversation", async () => {
    const res = await post({ contactId: "c1", refresh: true });

    expect(res.status).toBe(200);
    // Delegates to the existing writer, which loads the cross-channel bundle.
    // A second summariser here is what would make two briefs disagree.
    expect(state.refreshed).toEqual(["cv9"]);
  });

  it("★ follows a soft-merge pointer to the SURVIVING person's identifiers", async () => {
    // Distinct identifiers on purpose: a mocked findFirst returns a
    // conversation whatever it is asked for, so only the WHERE can show which
    // contact was resolved. Asserting on the response passed either way.
    state.contacts.push({
      id: "c_old", tenantId: "t1", channel: "EMAIL", externalId: "dana@old.example",
      mergedIntoId: "c1", metadata: {},
    });

    const res = await post({ contactId: "c_old" });

    expect(res.status).toBe(200);
    expect(state.seenConvWhere.OR).toEqual([
      { channel: "WHATSAPP", customerExternalId: "+972500000000" },
    ]);
    // Not the merged-away row's own identity.
    expect(JSON.stringify(state.seenConvWhere)).not.toContain("dana@old.example");
  });

  it("still accepts a conversationId, unchanged", async () => {
    const res = await post({ conversationId: "cv9" });

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe(BRIEF.brief);
  });

  it("requires one of the two, and says which", async () => {
    const res = await post({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("conversationId or contactId required");
  });
});

describe("the three outcomes are told apart", () => {
  it("404s an unknown contact", async () => {
    const res = await post({ contactId: "nope" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("contact_not_found");
  });

  it("★ a real contact with no conversations is a normal answer, not an error", async () => {
    state.conversation = null;

    const res = await post({ contactId: "c1" });

    expect(res.status).toBe(200);
    expect(res.body.meta.reason).toBe("no_conversations");
    expect(res.body.meta.conversation_count).toBe(0);
    expect(res.body.signals).toEqual([]);
  });

  it("answers in Hebrew when asked", async () => {
    state.conversation = null;

    const res = await post({ contactId: "c1", locale: "he" });

    expect(res.body.summary).toContain("לקוח חדש");
  });
});

describe("the imported history is reachable", () => {
  it("★ NAMES origin when resolving the contact's conversation", async () => {
    await post({ contactId: "c1" });

    // Without this the guard injects origin: "LIVE", and a customer whose
    // history was imported but who has no live conversation resolves to
    // nothing - reported as "no prior interactions" about years of them.
    expect(state.seenConvWhere.origin).toEqual({ in: ["LIVE", "HISTORICAL_IMPORT"] });
  });

  it("picks the most recent conversation", async () => {
    await post({ contactId: "c1" });

    expect(state.seenConvWhere.OR).toEqual([{ channel: "WHATSAPP", customerExternalId: "+972500000000" }]);
  });
});
