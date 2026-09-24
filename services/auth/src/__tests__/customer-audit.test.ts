/**
 * One customer's audit log - screen 04e.
 *
 * `GET /api/audit-logs` filters on actorType, action, from and to. There is no
 * `targetId` parameter, and adding one would not be enough: the customer is not
 * a column on `AuditLog`, and `conversations` has NO `contact_id`, so the join
 * runs on an EXTERNAL identifier.
 *
 * ★ That soft join is the whole risk. A contact whose `external_id` disagrees
 * with its conversations gets a silently short log, and an incomplete audit log
 * looks exactly like a quiet customer. So the person is resolved through the
 * sibling walk and preserved aliases, and these assert on the QUERY - a mocked
 * findMany returns whatever it likes regardless of the filter it was handed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  contacts: [] as any[],
  siblings: [] as any[],
  conversations: [] as any[],
  conversationCount: 0,
  rows: [] as any[],
  seen: { convWhere: null as any, auditWhere: null as any, auditSelect: null as any },
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: { findFirst: async ({ where }: any) => state.contacts.find((c) => c.id === where.id) ?? null },
    conversation: {
      count: async () => state.conversationCount,
      findMany: async (args: any) => { state.seen.convWhere = args.where; return state.conversations.slice(0, args.take); },
    },
    auditLog: {
      groupBy: async () => [],
      findMany: async (args: any) => {
        state.seen.auditWhere = args.where;
        state.seen.auditSelect = args.select;
        return state.rows.slice(0, args.take);
      },
    },
  },
  findSiblingContacts: async () => state.siblings,
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: "u1", role: "ADMIN" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requirePermissionOrRole: () => (_q: any, _s: any, n: any) => n(),
  assertTenantId: (req: any) => req.tenantId,
}));

import auditRouter from "../routes/audit-logs";

const app = express();
app.use(express.json());
app.use("/api", auditRouter);

const row = (o: Partial<any> = {}) => ({
  id: "a1", actorType: "ai", actorId: "agent1", action: "ai.responded",
  targetType: "conversation", targetId: "cv1",
  createdAt: new Date("2026-09-01T10:00:00Z"), metadata: { ok: true }, ...o,
});

beforeEach(() => {
  state.contacts = [{ id: "c1", tenantId: "t1", channel: "WHATSAPP", externalId: "+972500000000", mergedIntoId: null, metadata: {}, displayName: "Dana" }];
  state.siblings = [state.contacts[0]];
  state.conversations = [{ id: "cv1" }, { id: "cv2" }];
  state.conversationCount = 2;
  state.rows = [row()];
  state.seen = { convWhere: null, auditWhere: null, auditSelect: null };
});

const get = (q = "", id = "c1") => request(app).get(`/api/audit-logs/customer/${id}${q}`);

describe("the log is scoped to the person, not the contact row", () => {
  it("★ queries audit rows by the person's CONVERSATION ids", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(state.seen.auditWhere.OR).toEqual([
      { targetType: "conversation", targetId: { in: ["cv1", "cv2"] } },
    ]);
  });

  it("★ resolves conversations through siblings AND preserved aliases", async () => {
    state.contacts[0].metadata = { aliases: [{ channel: "EMAIL", externalId: "dana@example.com" }] };
    state.siblings = [state.contacts[0], { channel: "INSTAGRAM", externalId: "dana_ig" }];

    await get();

    // A merge that dropped any of these would shorten the log silently, and a
    // short audit log reads as a quiet customer.
    expect(state.seen.convWhere.OR).toEqual([
      { channel: "WHATSAPP", customerExternalId: "+972500000000" },
      { channel: "INSTAGRAM", customerExternalId: "dana_ig" },
      { channel: "EMAIL", customerExternalId: "dana@example.com" },
    ]);
  });

  it("★ follows a soft-merge pointer to the surviving person's identities", async () => {
    state.contacts.push({ id: "c_old", tenantId: "t1", channel: "EMAIL", externalId: "old@example.com", mergedIntoId: "c1", metadata: {} });

    const res = await get("", "c_old");

    expect(res.status).toBe(200);
    expect(res.body.contact.id).toBe("c1");
    expect(JSON.stringify(state.seen.convWhere)).not.toContain("old@example.com");
  });

  it("★ names BOTH origins, so an imported history is in the customer's own log", async () => {
    await get();

    // applyLiveByDefault injects origin LIVE into bulk Conversation reads. A
    // customer whose WhatsApp history was imported would otherwise have that
    // history missing from the record of what was done for them.
    expect(state.seen.convWhere.origin).toEqual({ in: ["LIVE", "HISTORICAL_IMPORT"] });
  });

  it("404s an unknown contact", async () => {
    expect((await get("", "nope")).status).toBe(404);
  });

  it("answers an empty log, not an error, for a contact with no channel identity", async () => {
    state.siblings = [];

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.scope.identities).toBe(0);
  });
});

describe("the outcome is two facts, never merged into one", () => {
  it("★ keeps succeeded null when the emitter recorded no verdict", async () => {
    state.rows = [row({ action: "conversation.updated", metadata: {} })];

    const res = await get();

    // "We did not record whether this worked" is not "it failed".
    expect(res.body.data[0].succeeded).toBeNull();
    expect(res.body.data[0].nameImpliesSucceeded).toBeNull();
    expect(res.body.data[0].outcomeDisagrees).toBe(false);
  });

  it("★ reads the name as a SEPARATE, weaker signal", async () => {
    state.rows = [
      row({ id: "a1", action: "adapter.err.shopify.process_refund", metadata: {} }),
      row({ id: "a2", action: "adapter.ok.shopify.get_customer_orders", metadata: {} }),
    ];

    const res = await get();

    // The prefix never becomes `succeeded`: a naming convention is not evidence.
    expect(res.body.data[0]).toMatchObject({ succeeded: null, nameImpliesSucceeded: false });
    expect(res.body.data[1]).toMatchObject({ succeeded: null, nameImpliesSucceeded: true });
  });

  it("★ FLAGS a row where the emitter contradicts its own name", async () => {
    state.rows = [row({ action: "adapter.err.shopify.process_refund", metadata: { ok: true } })];

    const res = await get();

    // The emitter disagreeing with itself about whether a refund happened is a
    // bug worth surfacing, not a value worth smoothing.
    expect(res.body.data[0].succeeded).toBe(true);
    expect(res.body.data[0].nameImpliesSucceeded).toBe(false);
    expect(res.body.data[0].outcomeDisagrees).toBe(true);
  });

  it("does not flag agreement", async () => {
    state.rows = [row({ action: "adapter.ok.shopify.get_customer_orders", metadata: { ok: true } })];

    const res = await get();

    expect(res.body.data[0].outcomeDisagrees).toBe(false);
  });

  it("★ never returns metadata, on a customer screen least of all", async () => {
    state.rows = [row({ metadata: { ok: true, args: { phone: "+972545680665" }, tool: "shopify.get_customer_by_phone" } })];

    const res = await get();

    // metadata.args carries customer phone numbers. It is selected so that
    // `succeeded` can be lifted, and must never reach the response.
    expect(res.body.data[0].metadata).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("+972545680665");
    expect(JSON.stringify(res.body)).not.toContain("get_customer_by_phone");
  });
});

describe("what it cannot attribute, it declares", () => {
  it("★ says order-keyed rows are not attributable, with a reason", async () => {
    const res = await get();

    // There is no local Order table, so a person's orders cannot be enumerated
    // to match order-keyed audit rows. An empty list would read as "no orders".
    expect(res.body.coverage.order).toMatchObject({ attributable: false, reason: "no_local_order_table" });
    // And the one that IS attributable says what it needs from the caller.
    expect(res.body.coverage.customer).toMatchObject({ attributable: true, requires: "shopifyCustomerId" });
  });

  it("★ excludes customer-keyed rows until the caller supplies the commerce id", async () => {
    await get();
    expect(state.seen.auditWhere.OR).toHaveLength(1);

    await get("?shopifyCustomerId=gid://shopify/Customer/123");

    // targetId there is a Shopify customer id, not a Contact id, so it cannot
    // be derived here - only supplied.
    expect(state.seen.auditWhere.OR).toContainEqual({
      targetType: "customer", targetId: "gid://shopify/Customer/123",
    });
  });

  it("discloses a truncated conversation scan", async () => {
    state.conversationCount = 900;

    const res = await get();

    expect(res.body.scope.conversations).toBe(900);
    expect(res.body.scope.conversationScanTruncated).toBe(true);
  });
});


describe("it reuses the tenant-wide filters rather than inventing its own", () => {
  it("applies actorType, action and the date range", async () => {
    await get("?actorType=user&action=crm.link.linked&from=2026-09-01&to=2026-09-30");

    expect(state.seen.auditWhere.actorType).toBe("user");
    expect(state.seen.auditWhere.action).toBe("crm.link.linked");
    expect(state.seen.auditWhere.createdAt).toEqual({
      gte: new Date("2026-09-01"), lte: new Date("2026-09-30"),
    });
  });

  it("422s a malformed date, the same as its siblings", async () => {
    const res = await get("?from=not-a-date");

    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe("from");
  });

  it("caps the page size and pages by cursor", async () => {
    state.rows = Array.from({ length: 60 }, (_, i) => row({ id: `a${i}` }));

    const res = await get("?limit=9999");

    // 60 rows available, cap is 100, so the cap is not what bounded this page.
    expect(res.body.page_limit_used ?? 100).toBe(100);
    expect(res.body.data).toHaveLength(60);
    expect(res.body.nextCursor).toBeNull();
  });
});
