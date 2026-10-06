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
  handovers: [] as any[],
  siblings: null as any[] | null,
  actions: [] as any[],
  seen: { convWhere: null as any, msgArgs: null as any, countWhere: null as any, handoverArgs: null as any, actionArgs: null as any },
}));

/**
 * The keyset predicate the route builds, applied the way Postgres would.
 *
 * The fake has to honour it exactly: a double that is more permissive than the
 * database lets a broken cursor pass, which is how the first version of this
 * suite missed a walk that stopped at 100 of 120 and called itself complete.
 */
function applyKeyset(rows: any[], args: any, field: string): any[] {
  const or = args.where?.OR;
  if (!Array.isArray(or)) return rows;
  const lt = or[0]?.[field]?.lt;
  const tie = or[1]?.AND;
  const tieAt = tie?.[0]?.[field];
  const tieId = tie?.[1]?.id?.lt;
  return rows.filter((r) => {
    if (lt && r[field] < lt) return true;
    if (tieAt && r[field].getTime() === tieAt.getTime() && r.id < tieId) return true;
    return false;
  });
}

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: { findFirst: async ({ where }: any) => (where.id === state.contact.id ? state.contact : null) },
    conversation: {
      count: async ({ where }: any) => { state.seen.countWhere = where; return state.conversationCount; },
      findMany: async (args: any) => { state.seen.convWhere = args.where; return state.conversations.slice(0, args.take); },
    },
    message: {
      count: async () => state.messageCount,
      findMany: async (args: any) => {
        state.seen.msgArgs = args;
        // The cursor is a WHERE predicate now, not Prisma's `cursor`, because
        // three tables interleave and Prisma's addresses one. The fake applies
        // the same filter the database would, so dropping it from the code
        // cannot pass here.
        return applyKeyset(state.messages, args, "createdAt").slice(0, args.take);
      },
    },
    conversationHandover: {
      count: async () => state.handovers.length,
      findMany: async (args: any) => {
        state.seen.handoverArgs = args;
        return applyKeyset(state.handovers, args, "at").slice(0, args.take);
      },
    },
    // AI actions come from tool_execution_requests (the orchestrator's row per
    // tool call); tool_executions only ever held catalog HTTP tools.
    toolExecutionRequest: {
      count: async () => state.actions.length,
      findMany: async (args: any) => {
        state.seen.actionArgs = args;
        return applyKeyset(state.actions, args, "proposedAt").slice(0, args.take);
      },
    },
    identityLinkSuggestion: { findMany: async () => [], create: async () => ({}) },
    person: { findFirst: async () => null },
  },
  findSiblingContacts: async () => state.siblings ?? [state.contact],
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
  state.handovers = [];
  state.siblings = null;
  state.actions = [];
  state.seen = { convWhere: null, msgArgs: null, countWhere: null, handoverArgs: null, actionArgs: null };
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
    // `iso~id`, because a cursor over a MERGED stream cannot be one table's
    // row id.
    expect(res.body.page.nextCursor).toBe(`${state.messages[49].createdAt.toISOString()}~m0049`);
  });

  it("★ paginates MESSAGES, not conversations", async () => {
    await get();

    // The old query took 5 messages PER CONVERSATION, so a 300-message thread
    // contributed five and the stream had undisclosed holes. Paging the events
    // themselves is what removes that.
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

  it("★ refuses a malformed cursor by name rather than restarting at the top", async () => {
    const res = await get("?cursor=m_deleted");

    // Silently restarting would look like the end of the list wrapping around,
    // which a paging UI renders as an infinite history.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_cursor");
  });

  it("★ survives a cursor row that was deleted between pages", async () => {
    const at = state.messages[49]!.createdAt.toISOString();
    state.messages = state.messages.filter((m) => m.id !== "m0049");

    const res = await get(`?cursor=${encodeURIComponent(`${at}~m0049`)}`);

    // The cursor is a POINT, not a row. Locating the row instead would have
    // restarted the walk when it vanished.
    expect(res.status).toBe(200);
    expect(res.body.events[0].body).toBe("message 50");
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

/**
 * One stream, and an honest statement of what it cannot contain.
 *
 * 04b asks for conversations, orders, returns, AI actions and notes in one
 * timeline. Three of those have no local model at all - there is no Order or
 * Return table, and notes live in the merchant's CRM - so the union is built
 * from what exists and the rest is DECLARED on the wire.
 *
 * ★ An empty list cannot say why it is empty. "This customer has no orders"
 * and "this endpoint never had orders" are different facts, and the difference
 * decides whether a screen renders an empty state or a link somewhere else.
 */
describe("the union carries what exists and names what does not", () => {
  const handover = (id: string, iso: string, o: any = {}) => ({
    id, conversationId: "cv1", at: new Date(iso),
    fromHandler: "ai", toHandler: "human", actorUserId: "u9", reason: "customer asked", ...o,
  });
  const action = (id: string, iso: string, o: any = {}) => ({
    id, conversationId: "cv1", proposedAt: new Date(iso),
    tool: "shopify.get_order", status: "completed", actor: {}, decidedAt: null,
    startedAt: new Date(iso), completedAt: new Date(new Date(iso).getTime() + 120), ...o,
  });

  it("★ interleaves the three sources in one time-ordered stream", async () => {
    state.messages = [
      { id: "m1", conversationId: "cv1", direction: "INBOUND", body: "where is it", createdAt: new Date("2026-09-01T10:00:00Z"), origin: "LIVE" },
      { id: "m2", conversationId: "cv1", direction: "OUTBOUND", body: "checking", createdAt: new Date("2026-09-01T10:02:00Z"), origin: "LIVE" },
    ];
    state.messageCount = 2;
    state.actions = [action("t1", "2026-09-01T10:01:00Z")];
    state.handovers = [handover("h1", "2026-09-01T10:03:00Z")];

    const res = await get();

    expect(res.body.events.map((e: any) => e.id)).toEqual(["h1", "m2", "t1", "m1"]);
    expect(res.body.events.map((e: any) => e.type)).toEqual(["handover", "message", "ai_action", "message"]);
  });

  it("carries the handover's detail, which is the event a history actually wants", async () => {
    state.messages = [];
    state.messageCount = 0;
    state.handovers = [handover("h1", "2026-09-01T10:00:00Z")];

    const res = await get();

    expect(res.body.events[0].handover).toEqual({
      from: "ai", to: "human", actorUserId: "u9", reason: "customer asked",
    });
  });

  it("carries an AI action's tool and outcome, including a failure", async () => {
    state.messages = [];
    state.messageCount = 0;
    state.actions = [action("t1", "2026-09-01T10:00:00Z", { status: "failed" })];

    const res = await get();

    expect(res.body.events[0].action).toEqual({
      tool: "shopify.get_order", labelKey: "looking_up_order", success: false, status: "failed", triggeredBy: "ai", durationMs: 120, approvedBy: null,
    });
  });

  it("an approved action names who approved it", async () => {
    state.messages = [];
    state.messageCount = 0;
    state.actions = [action("t1", "2026-09-01T10:00:00Z", { status: "approved", actor: { agentId: "u3" }, decidedAt: new Date("2026-09-01T10:00:30Z"), startedAt: null, completedAt: null })];

    const res = await get();

    expect(res.body.events[0].action).toMatchObject({ status: "approved", success: false, approvedBy: "u3", durationMs: null });
  });

  it("★ declares orders, returns and notes ABSENT, with a reason", async () => {
    const res = await get();

    // Not omitted, not an empty array. An empty array reads as "none yet".
    expect(res.body.coverage.order).toMatchObject({ available: false, reason: "no_local_model" });
    expect(res.body.coverage.return).toMatchObject({ available: false, reason: "no_local_model" });
    expect(res.body.coverage.note).toMatchObject({ available: false, reason: "external_crm" });
  });

  it("★ states the AI-action COVERAGE, because the gap is invisible from the data", async () => {
    const res = await get();

    // The source is every tool call the AI made through the orchestrator,
    // adapter tools included (a Shopify refund is in it now), with its status.
    expect(res.body.coverage.ai_action.available).toBe(true);
    expect(res.body.coverage.ai_action.detail).toContain("including adapter tools");
  });

  it("honours ?types= and reports what it used", async () => {
    state.actions = [action("t1", "2026-09-01T10:00:00Z")];
    state.handovers = [handover("h1", "2026-09-01T10:05:00Z")];

    const res = await get("?types=message");

    expect(res.body.page.types).toEqual(["message"]);
    expect(res.body.events.every((e: any) => e.type === "message")).toBe(true);
    // Not queried at all, rather than queried and filtered out.
    expect(state.seen.handoverArgs).toBeNull();
    expect(state.seen.actionArgs).toBeNull();
  });

  it("★ refuses an unknown type instead of quietly returning less", async () => {
    const res = await get("?types=message,orders");

    // A typo must not look like "this customer has no orders".
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_event_type");
    expect(res.body.unknown).toEqual(["orders"]);
  });

  it("counts each source separately", async () => {
    state.actions = [action("t1", "2026-09-01T10:00:00Z")];
    state.handovers = [handover("h1", "2026-09-01T10:05:00Z"), handover("h2", "2026-09-01T11:00:00Z")];

    const res = await get();

    expect(res.body.totals.messages).toBe(120);
    expect(res.body.totals.handovers).toBe(2);
    expect(res.body.totals.aiActions).toBe(1);
  });

  it("★ pages correctly across a mixed stream", async () => {
    state.messages = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, conversationId: "cv1", direction: "INBOUND", body: `m${i}`,
      createdAt: new Date(Date.parse("2026-09-01T10:00:00Z") - i * 120_000), origin: "LIVE",
    }));
    state.messageCount = 5;
    state.handovers = Array.from({ length: 5 }, (_, i) =>
      handover(`h${i}`, new Date(Date.parse("2026-09-01T10:01:00Z") - i * 120_000).toISOString()));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 12; guard++) {
      const res: any = await get(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...res.body.events.map((e: any) => e.id));
      cursor = res.body.page.nextCursor;
      if (!cursor) break;
    }

    // Every event once, in one order, across three pages drawn from two tables.
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });
});

/**
 * Every handle the person is known by - and why the alias list alone is not it.
 *
 * `metadata.aliases` covers only handles MERGED INTO this contact. Somebody
 * unified-but-never-merged, linked by `personId`, has handles that list cannot
 * see - so a panel built on aliases says "channels we joined up" rather than
 * "her channels". The sibling walk already happens to scope the query; it was
 * simply discarded on the way out.
 *
 * ★ PROJECTED, never the raw rows. `findSiblingContacts` selects no columns, so
 * each sibling arrives carrying its whole `metadata` JSON - which holds customer
 * phone numbers. Returning them as-is would ship that blob once per channel.
 */
describe("the person's channels", () => {
  const sibling = (id: string, channel: string, externalId: string) => ({
    id, channel, externalId, displayName: "Dana", personId: "p1", mergedIntoId: null,
    // The surplus the projection must not pass on.
    metadata: { phone: "+972500000000", internalNote: "do not ship this" },
  });

  it("★ returns one entry per linked contact, PROJECTED", async () => {
    state.siblings = [sibling("c1", "WHATSAPP", "+972500000000"), sibling("c2", "EMAIL", "dana@example.com")];

    const res = await get();

    expect(res.body.identityChannels).toEqual([
      { contactId: "c1", channel: "WHATSAPP", externalId: "+972500000000", displayName: "Dana", source: "linked" },
      { contactId: "c2", channel: "EMAIL", externalId: "dana@example.com", displayName: "Dana", source: "linked" },
    ]);
  });

  it("★ never ships a sibling's raw metadata", async () => {
    state.siblings = [sibling("c1", "WHATSAPP", "+972500000000")];

    const res = await get();

    // The whole reason this is a projection and not a pass-through.
    const body = JSON.stringify(res.body.identityChannels);
    expect(body).not.toContain("internalNote");
    expect(body).not.toContain("do not ship this");
    expect(res.body.identityChannels[0].metadata).toBeUndefined();
  });

  it("★ includes merged aliases, marked as a different provenance", async () => {
    state.siblings = [sibling("c1", "WHATSAPP", "+972500000000")];
    state.contact.metadata = { aliases: [{ channel: "INSTAGRAM", externalId: "dana_ig" }] };

    const res = await get();

    // "linked" and "merged" are different facts about how we know the handle,
    // and a screen may caption them differently.
    expect(res.body.identityChannels).toContainEqual(
      { contactId: null, channel: "INSTAGRAM", externalId: "dana_ig", displayName: null, source: "merged" },
    );
  });

  it("does not list a channel twice when an alias is also a live sibling", async () => {
    state.siblings = [sibling("c1", "WHATSAPP", "+972500000000")];
    state.contact.metadata = { aliases: [{ channel: "WHATSAPP", externalId: "+972500000000" }] };

    const res = await get();

    expect(res.body.identityChannels).toHaveLength(1);
    // The live row wins: it carries a contactId the alias cannot.
    expect(res.body.identityChannels[0].source).toBe("linked");
  });

  it("ignores a malformed alias rather than emitting a half-empty handle", async () => {
    state.siblings = [];
    state.contact.metadata = { aliases: [{ channel: "INSTAGRAM" }, null, { externalId: "x" }, "nope"] };

    const res = await get();

    expect(res.body.identityChannels).toEqual([]);
  });

  it("is present even on an empty timeline", async () => {
    state.siblings = [sibling("c1", "WHATSAPP", "+972500000000")];
    state.conversations = [];
    state.conversationCount = 0;

    const res = await get();

    // An absent key and an empty list are different facts; the panel needs the
    // handles even when there are no events yet.
    expect(res.body.identityChannels).toHaveLength(1);
  });
});

/**
 * The response carries named columns, never the open JSON column.
 *
 * `effective` was a `findFirst` with no `select`, so every timeline response
 * shipped the contact's `metadata` - which holds phone numbers among other
 * things. One consumer was picking `aliases` out of it and asserting in its own
 * test that a `phone` beside it did not survive its parse: a guard protecting
 * exactly one caller. `aliases` is served as part of `identityChannels` now, so
 * nothing needs the blob.
 */
describe("the contact in the response", () => {
  it("★ never carries the raw metadata blob", async () => {
    state.contact.metadata = { aliases: [], phone: "+972500000000", internalNote: "surplus" };

    const res = await get();

    expect(res.body.contact.metadata).toBeUndefined();
    const body = JSON.stringify(res.body.contact);
    expect(body).not.toContain("internalNote");
    expect(body).not.toContain("surplus");
  });

  it("still carries what a customer panel legitimately shows", async () => {
    const res = await get();

    // The surplus was never the named columns - a panel shows the customer their
    // own details. It was everything else an unbounded JSON column can hold.
    expect(res.body.contact.id).toBe("c1");
    expect(res.body.contact.displayName).toBe("Dana");
  });
});
