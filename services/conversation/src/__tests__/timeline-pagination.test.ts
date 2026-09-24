/**
 * The timeline was a sample presented as a history.
 *
 * `take: 50` conversations x `take: 5` messages capped it at 250 events and
 * took the five NEWEST messages of each conversation, so a 300-message thread
 * contributed five. Merged and sorted, that produced a plausible stream with
 * undisclosed holes in the middle - and a screen calling it "her whole history"
 * claimed a completeness no consumer could check.
 *
 * ★ It also excluded the imported history. `applyLiveByDefault` injects
 * `origin: "LIVE"` into bulk Conversation/Message reads, so for a customer
 * whose WhatsApp history was imported this endpoint dropped exactly the history.
 *
 * These assert on the QUERY as well as the output, because a mocked findMany is
 * blind to its own WHERE: an assertion on returned rows cannot see a filter that
 * was never applied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  contact: { id: "c1", tenantId: "t1", channel: "WHATSAPP", externalId: "+972500000000", mergedIntoId: null as string | null, metadata: {} as any, displayName: "Dana" },
  conversations: [] as any[],
  conversationCount: 0,
  messages: [] as any[],
  messageCount: 0,
  seen: { convWhere: null as any, msgArgs: null as any, countWhere: null as any },
  throwOnFindMany: false,
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: { findFirst: async ({ where }: any) => (where.id === state.contact.id ? state.contact : null) },
    conversation: {
      count: async ({ where }: any) => { state.seen.countWhere = where; return state.conversationCount; },
      findMany: async (args: any) => { state.seen.convWhere = args.where; return state.conversations.slice(0, args.take); },
    },
    message: {
      count: async ({ where }: any) => state.messageCount,
      findMany: async (args: any) => {
        state.seen.msgArgs = args;
        if (state.throwOnFindMany) throw new Error("cursor not found");
        // Prisma's cursor row is INCLUSIVE; `skip: 1` is what excludes it. A
        // fake that skips it unconditionally does the code's job for it, and a
        // dropped `skip: 1` then passes - which it did, until this was fixed.
        const at = args.cursor ? state.messages.findIndex((m) => m.id === args.cursor.id) : -1;
        const start = args.cursor ? at + (args.skip ?? 0) : 0;
        return state.messages.slice(start, start + args.take);
      },
    },
    identityLinkSuggestion: { findMany: async () => [], create: async () => ({}) },
    person: { findFirst: async () => null },
  },
  findSiblingContacts: async () => [state.contact],
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  requirePermission: () => (_q: any, _s: any, n: any) => n(),
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  normalizePhone: (p: string) => p,
  withHistoricalRecords: (fn: any) => fn(),
  writeAudit: async () => undefined,
  AuditAction: {},
}));

import identityRouter from "../routes/identity";

const app = express();
app.use(express.json());
app.use("/api/identity", identityRouter);

/** `n` messages, newest first, as the endpoint's ordering returns them. */
function makeMessages(n: number, origin = "LIVE") {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${String(i).padStart(4, "0")}`,
    conversationId: "cv1",
    direction: i % 2 === 0 ? "INBOUND" : "OUTBOUND",
    body: `message ${i}`,
    createdAt: new Date(Date.now() - i * 60_000),
    origin,
  }));
}

beforeEach(() => {
  state.contact.mergedIntoId = null;
  state.contact.metadata = {};
  state.conversations = [{ id: "cv1", channel: "WHATSAPP", origin: "LIVE" }];
  state.conversationCount = 1;
  state.messages = makeMessages(120);
  state.messageCount = 120;
  state.seen = { convWhere: null, msgArgs: null, countWhere: null };
  state.throwOnFindMany = false;
});

const get = (q = "") => request(app).get(`/api/identity/c1/timeline${q}`);

describe("the page is honest about being a page", () => {
  it("★ reports the real total, so a screen cannot imply completeness", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(50);
    // 50 of 120. The old shape returned events and nothing else, so a caller
    // had no way to know 70 were missing.
    expect(res.body.totals.messages).toBe(120);
    expect(res.body.page.hasMore).toBe(true);
    expect(res.body.page.nextCursor).toBe("m0049");
  });

  it("★ paginates MESSAGES, not conversations", async () => {
    await get();

    // The old query took 5 messages PER CONVERSATION, so a 300-message thread
    // contributed five and the stream had undisclosed holes. One cursor over
    // messages is what removes that.
    expect(state.seen.msgArgs.take).toBe(51);
    expect(state.seen.msgArgs.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(state.seen.msgArgs.where.conversationId).toEqual({ in: ["cv1"] });
  });

  it("walks to the end without repeating or skipping an event", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard++) {
      const res: any = await get(`?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...res.body.events.map((e: any) => e.body));
      cursor = res.body.page.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it("the last page says hasMore false and stops offering a cursor", async () => {
    const res = await get("?limit=200");

    expect(res.body.events).toHaveLength(120);
    expect(res.body.page.hasMore).toBe(false);
    expect(res.body.page.nextCursor).toBeNull();
  });

  it("caps an oversized limit instead of refusing it", async () => {
    state.messages = makeMessages(400);
    state.messageCount = 400;

    const res = await get("?limit=9999");

    expect(res.body.page.limit).toBe(200);
    expect(res.body.events).toHaveLength(200);
  });

  it("ignores a nonsense limit and uses the default", async () => {
    const res = await get("?limit=abc");

    expect(res.body.page.limit).toBe(50);
  });

  it("★ refuses a bad cursor by name rather than restarting at the top", async () => {
    state.throwOnFindMany = true;

    const res = await get("?cursor=m_deleted");

    // Silently restarting would look like the end of the list wrapping around,
    // which a paging UI renders as an infinite history.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
  });
});

describe("the imported history is no longer invisible", () => {
  it("★ names BOTH origins, which is what suppresses the live-only injection", async () => {
    await get();

    // Asserting on the WHERE, not on rows: a mocked findMany returns whatever it
    // likes regardless of the filter, so output alone cannot see this.
    expect(state.seen.convWhere.origin).toEqual({ in: ["LIVE", "HISTORICAL_IMPORT"] });
    expect(state.seen.msgArgs.where.origin).toEqual({ in: ["LIVE", "HISTORICAL_IMPORT"] });
  });

  it("carries each event's origin so a screen can label it", async () => {
    state.messages = makeMessages(3, "HISTORICAL_IMPORT");
    state.messageCount = 3;

    const res = await get();

    expect(res.body.events.every((e: any) => e.origin === "HISTORICAL_IMPORT")).toBe(true);
  });

  it("★ still MENTIONS origin when asked for live only", async () => {
    await get("?includeImported=false");

    // Omitting the clause would let the guard inject it, which happens to give
    // the same rows - so this is the one case where a passing result would hide
    // a missing filter. Pinned explicitly.
    expect(state.seen.convWhere.origin).toBe("LIVE");
    expect(state.seen.msgArgs.where.origin).toBe("LIVE");
  });
});

describe("what it keeps doing", () => {
  it("serves the same event fields the existing consumer reads", async () => {
    const res = await get("?limit=1");

    // CustomerTimeline.tsx reads exactly these. Adding to the response is safe;
    // renaming any of them is not.
    expect(res.body.events[0]).toMatchObject({
      type: "message",
      channel: "WHATSAPP",
      conversationId: "cv1",
      direction: "INBOUND",
    });
    expect(res.body.events[0].createdAt).toBeTruthy();
    expect(res.body.contact.displayName).toBe("Dana");
  });

  it("follows the soft-merge pointer to the surviving contact", async () => {
    state.contact.mergedIntoId = "c1";

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.contact.id).toBe("c1");
  });

  it("★ answers an empty page, not an error, for a contact with no channel identity", async () => {
    state.conversations = [];
    state.conversationCount = 0;

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.totals.messages).toBe(0);
    expect(res.body.page.hasMore).toBe(false);
  });

  it("★ discloses a truncated conversation scan instead of dropping oldest threads", async () => {
    state.conversationCount = 900;

    const res = await get();

    // The id list becomes an IN clause, so it is capped. Saying so is the
    // difference between a bounded read and a silent omission.
    expect(res.body.totals.conversations).toBe(900);
    expect(res.body.totals.conversationScanTruncated).toBe(true);
  });

  it("does not claim truncation when the scan covered everything", async () => {
    const res = await get();

    expect(res.body.totals.conversationScanTruncated).toBe(false);
  });
});
