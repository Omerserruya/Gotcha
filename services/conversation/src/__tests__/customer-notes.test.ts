/**
 * Customer notes: the CRUD the stub only pretended to have.
 *
 * The stub answered 200 with a well-formed note it never wrote. These cover the
 * replacement, and specifically the four decisions that a simpler shape would
 * have got wrong:
 *
 *   1. MIRRORING, not routing. A note is always stored locally and ALSO copied
 *      to the elected system, because routing to the CRM instead would discard
 *      visibility, edit history, mentions and AI suggestions for exactly the
 *      tenants who have a CRM.
 *   2. NOT_APPLICABLE and FAILED are different states. "Nobody elected a
 *      system" is normal; "there was a target and it refused" is not. One
 *      boolean would merge them and a screen could not say which.
 *   3. A PRIVATE note is never mirrored. A private note in the merchant's
 *      shared CRM is not private.
 *   4. The response is RE-READ after mirroring, so it reports the sync outcome
 *      that happened rather than the optimistic one - which is the stub's own
 *      defect at one remove.
 *
 * Visibility is asserted on the WHERE clause, not on the rows: a fake returns
 * whatever it likes regardless of the filter, so output alone cannot see a
 * missing one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  viewer: "u1" as string | null,
  contacts: [] as any[],
  notes: [] as any[],
  seq: 0,
  seenListWhere: null as any,
  fetch: { calls: [] as any[], reply: { ok: true, status: 200, body: { data: { vendor: "hubspot", note_id: "crm_1" } } } },
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    contact: { findFirst: async ({ where }: any) => state.contacts.find((c) => c.id === where.id) ?? null },
    user: { findFirst: async () => ({ name: "Yael Cohen", email: "yael@example.com" }) },
    customerNote: {
      findMany: async (args: any) => { state.seenListWhere = args.where; return state.notes.filter((n) => !n.deletedAt).map((n) => ({ ...n })); },
      findFirst: async ({ where }: any) => state.notes.find((n) => n.id === where.id) ?? null,
      // ★ Every read and write returns a COPY, the way a database round-trip
      // does. Handing back the stored object makes `create`'s return value and
      // the stored row the same reference, so a later mutation appears in a
      // snapshot taken before it - and "return the row as created" then passes
      // the test that exists to require a re-read. It did, until this was fixed.
      create: async ({ data }: any) => {
        const row = { id: `n${++state.seq}`, deletedAt: null, externalSystem: null, externalNoteId: null,
          externalSyncStatus: "NOT_APPLICABLE", externalSyncError: null, externalSyncedAt: null,
          createdAt: new Date(), updatedAt: new Date(), ...data };
        state.notes.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = state.notes.find((n) => n.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
    },
  },
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: state.viewer, role: "AGENT" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
}));

import notesRouter from "../routes/customer-notes";

const app = express();
app.use(express.json());
app.use("/api/identity", notesRouter);

beforeEach(() => {
  state.viewer = "u1";
  state.contacts = [{ id: "c1", mergedIntoId: null, personId: "p1" }];
  state.notes = [];
  state.seq = 0;
  state.seenListWhere = null;
  state.fetch = { calls: [], reply: { ok: true, status: 200, body: { data: { vendor: "hubspot", note_id: "crm_1" } } } };

  global.fetch = (async (url: any, init: any) => {
    state.fetch.calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), headers: init?.headers });
    if (state.fetch.reply instanceof Error) throw state.fetch.reply;
    const r = state.fetch.reply as any;
    return { ok: r.ok, status: r.status, json: async () => r.body } as any;
  }) as any;
});

const post = (body: any) =>
  request(app).post("/api/identity/c1/notes").set("Authorization", "Bearer tok").send(body);

describe("a note is stored, and it is about a person", () => {
  it("★ persists it and returns 201 - no echo of something unwritten", async () => {
    const res = await post({ body: "Prefers evening delivery" });

    expect(res.status).toBe(201);
    expect(res.body.note.body).toBe("Prefers evening delivery");
    // The row exists. The stub's 200 described a note that did not.
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].contactId).toBe("c1");
  });

  it("attributes it to the author by NAME, not just an id", async () => {
    const res = await post({ body: "Called about a return" });

    // A user row can be deleted; an unattributable note is worth less than none.
    expect(res.body.note.authorUserId).toBe("u1");
    expect(res.body.note.authorName).toBe("Yael Cohen");
  });

  it("carries personId so a later merge cannot orphan it", async () => {
    const res = await post({ body: "x" });

    expect(res.body.note.personId).toBe("p1");
  });

  it("files a note against a merged-away contact under the SURVIVOR", async () => {
    state.contacts.push({ id: "c_old", mergedIntoId: "c1", personId: null });

    const res = await request(app).post("/api/identity/c_old/notes")
      .set("Authorization", "Bearer tok").send({ body: "written against the ghost" });

    expect(res.status).toBe(201);
    expect(res.body.note.contactId).toBe("c1");
  });

  it("refuses an empty body and one over the limit, by name", async () => {
    expect((await post({ body: "   " })).body.error).toBe("body_required");
    expect((await post({ body: "x".repeat(5001) })).body.error).toBe("body_too_long");
  });

  it("404s an unknown contact", async () => {
    const res = await request(app).post("/api/identity/nope/notes")
      .set("Authorization", "Bearer tok").send({ body: "x" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("contact_not_found");
  });
});

describe("mirroring to the elected system", () => {
  it("★ copies the body to the CRM and records what came back", async () => {
    const res = await post({ body: "Wants the blue one", conversationId: "cv1" });

    expect(state.fetch.calls[0].url).toContain("/api/crm/conversation/cv1/notes");
    expect(state.fetch.calls[0].body).toEqual({ body: "Wants the blue one" });
    // Forwarded, so the CRM endpoint's permission checks apply to the PERSON
    // who wrote the note rather than to a service identity.
    expect(state.fetch.calls[0].headers.Authorization).toBe("Bearer tok");
    expect(res.body.note.externalSyncStatus).toBe("SYNCED");
    expect(res.body.note.externalSystem).toBe("hubspot");
    expect(res.body.note.externalNoteId).toBe("crm_1");
  });

  it("★ the note is still stored locally when the CRM accepts it", async () => {
    await post({ body: "both places", conversationId: "cv1" });

    // Mirroring, not routing. Routing would have discarded visibility, history,
    // mentions and suggestions for every tenant that has a CRM.
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].body).toBe("both places");
  });

  it("★ NEVER mirrors a PRIVATE note", async () => {
    const res = await post({ body: "my own reminder", visibility: "PRIVATE", conversationId: "cv1" });

    // A private note in the merchant's shared CRM is not private.
    expect(state.fetch.calls).toHaveLength(0);
    expect(res.body.note.externalSyncStatus).toBe("NOT_APPLICABLE");
  });

  it("★ says NOT_APPLICABLE, not FAILED, when no CRM is configured", async () => {
    state.fetch.reply = { ok: false, status: 409, body: { error: "no_crm_configured" } } as any;

    const res = await post({ body: "x", conversationId: "cv1" });

    // A tenant without a CRM is a normal state. Reporting it as a failure would
    // put an error on the screen of every tenant who has not connected one.
    expect(res.body.note.externalSyncStatus).toBe("NOT_APPLICABLE");
    expect(res.body.note.externalSyncError).toBe("no_crm_configured");
  });

  it("★ says FAILED when there WAS a target and it refused", async () => {
    state.fetch.reply = { ok: false, status: 502, body: { error: "hubspot_rejected" } } as any;

    const res = await post({ body: "x", conversationId: "cv1" });

    // The distinction NOT_APPLICABLE/FAILED is the whole reason this is an enum
    // and not a boolean.
    expect(res.body.note.externalSyncStatus).toBe("FAILED");
    expect(res.body.note.externalSyncError).toBe("hubspot_rejected");
  });

  it("★ a transport failure is FAILED, not NOT_APPLICABLE", async () => {
    state.fetch.reply = new Error("ECONNREFUSED ai:4006") as any;

    const res = await post({ body: "x", conversationId: "cv1" });

    // Collapsing these would make an outage look like a tenant with no CRM.
    expect(res.body.note.externalSyncStatus).toBe("FAILED");
    expect(res.body.note.externalSyncError).toContain("ECONNREFUSED");
  });

  it("★ the mirror never loses the note, whatever the CRM does", async () => {
    state.fetch.reply = new Error("boom") as any;

    const res = await post({ body: "survives the failure", conversationId: "cv1" });

    expect(res.status).toBe(201);
    expect(state.notes[0].body).toBe("survives the failure");
  });

  it("has nothing to mirror to without a conversation", async () => {
    const res = await post({ body: "written from the customer page" });

    // The ai endpoint is conversation-keyed; with no conversation there is
    // nothing to resolve a CRM contact from. A real "nothing to do".
    expect(state.fetch.calls).toHaveLength(0);
    expect(res.body.note.externalSyncStatus).toBe("NOT_APPLICABLE");
  });
});

describe("editing keeps what it used to say", () => {
  const seed = async () => (await post({ body: "first version" })).body.note;

  it("★ appends the PREVIOUS body to editHistory", async () => {
    const note = await seed();

    const res = await request(app).patch(`/api/identity/c1/notes/${note.id}`)
      .set("Authorization", "Bearer tok").send({ body: "corrected version" });

    expect(res.body.note.body).toBe("corrected version");
    // A note that can be corrected silently is only a record of whatever it
    // currently says.
    expect(res.body.note.editHistory).toHaveLength(1);
    expect(res.body.note.editHistory[0]).toMatchObject({ previousBody: "first version", byName: "Yael Cohen" });
  });

  it("does not record an edit that changed nothing", async () => {
    const note = await seed();

    const res = await request(app).patch(`/api/identity/c1/notes/${note.id}`)
      .set("Authorization", "Bearer tok").send({ body: "first version", visibility: "PRIVATE" });

    expect(res.body.note.visibility).toBe("PRIVATE");
    expect(res.body.note.editHistory).toHaveLength(0);
  });

  it("★ only the AUTHOR may edit", async () => {
    const note = await seed();
    state.viewer = "u2";

    const res = await request(app).patch(`/api/identity/c1/notes/${note.id}`)
      .set("Authorization", "Bearer tok").send({ body: "not mine to change" });

    // Anyone with access can READ a team note. Letting them rewrite it would
    // make authorName a claim about somebody who did not write what it says.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_the_author");
  });

  it("refuses to edit a deleted note rather than resurrecting it", async () => {
    const note = await seed();
    await request(app).delete(`/api/identity/c1/notes/${note.id}`).set("Authorization", "Bearer tok");

    const res = await request(app).patch(`/api/identity/c1/notes/${note.id}`)
      .set("Authorization", "Bearer tok").send({ body: "back from the dead" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_deleted");
  });

  it("404s an unknown note", async () => {
    const res = await request(app).patch("/api/identity/c1/notes/nope")
      .set("Authorization", "Bearer tok").send({ body: "x" });

    expect(res.body.error).toBe("note_not_found");
  });
});

describe("deleting is soft", () => {
  it("★ keeps the row and stamps deletedAt", async () => {
    const note = (await post({ body: "mistaken" })).body.note;

    const res = await request(app).delete(`/api/identity/c1/notes/${note.id}`)
      .set("Authorization", "Bearer tok");

    expect(res.status).toBe(200);
    // A customer's history should not develop holes, and a deleted note is
    // still evidence of what somebody believed.
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].deletedAt).toBeTruthy();
    expect(res.body.note.deletedAt).toBeTruthy();
  });

  it("excludes deleted notes from the default read", async () => {
    await request(app).get("/api/identity/c1/notes").set("Authorization", "Bearer tok");

    expect(state.seenListWhere.deletedAt).toBeNull();
  });

  it("includes them when asked", async () => {
    await request(app).get("/api/identity/c1/notes?includeDeleted=true").set("Authorization", "Bearer tok");

    expect("deletedAt" in state.seenListWhere).toBe(false);
  });
});

describe("visibility is enforced in the QUERY", () => {
  it("★ scopes PRIVATE notes to their author", async () => {
    state.viewer = "u7";

    await request(app).get("/api/identity/c1/notes").set("Authorization", "Bearer tok");

    // Asserted on the WHERE, not the rows: a post-query filter would still have
    // loaded the row, and any later count or export that forgot it would leak.
    expect(state.seenListWhere.OR).toEqual([
      { visibility: "TEAM" },
      { visibility: "PRIVATE", authorUserId: "u7" },
    ]);
  });

  it("★ hides AI suggestions from the default read", async () => {
    await request(app).get("/api/identity/c1/notes").set("Authorization", "Bearer tok");

    // A note nobody accepted is not a note. Same reason an unapproved knowledge
    // candidate is not knowledge.
    expect(state.seenListWhere.status).toEqual({ in: ["PUBLISHED"] });
  });

  it("includes them when the screen asks", async () => {
    await request(app).get("/api/identity/c1/notes?includeSuggestions=true").set("Authorization", "Bearer tok");

    expect(state.seenListWhere.status).toEqual({ in: ["PUBLISHED", "AI_SUGGESTED"] });
  });
});

describe("a note the AI proposed", () => {
  const suggest = async () =>
    (await post({ body: "She mentioned a birthday in May", status: "AI_SUGGESTED", conversationId: "cv1" })).body.note;

  it("★ is NOT mirrored while it is only a suggestion", async () => {
    await suggest();

    // It must not appear in the merchant's CRM before a person agreed with it.
    expect(state.fetch.calls).toHaveLength(0);
  });

  it("★ accepting re-attributes it to the PERSON who accepted", async () => {
    const note = await suggest();
    state.viewer = "u9";

    const res = await request(app).post(`/api/identity/c1/notes/${note.id}/accept`)
      .set("Authorization", "Bearer tok").send({});

    expect(res.body.note.status).toBe("PUBLISHED");
    // A team note credited to the AI is a note nobody agreed to.
    expect(res.body.note.authorUserId).toBe("u9");
    expect(res.body.note.authorName).toBe("Yael Cohen");
  });

  it("mirrors it once accepted", async () => {
    const note = await suggest();

    await request(app).post(`/api/identity/c1/notes/${note.id}/accept`)
      .set("Authorization", "Bearer tok").send({});

    expect(state.fetch.calls).toHaveLength(1);
  });

  it("rejecting KEEPS the row rather than deleting it", async () => {
    const note = await suggest();

    const res = await request(app).post(`/api/identity/c1/notes/${note.id}/reject`)
      .set("Authorization", "Bearer tok").send({});

    expect(res.body.note.status).toBe("REJECTED");
    // Kept so the AI is not re-proposing the same thing forever.
    expect(state.notes).toHaveLength(1);
  });

  it("refuses to decide a note that was never a suggestion", async () => {
    const note = (await post({ body: "a real note" })).body.note;

    const res = await request(app).post(`/api/identity/c1/notes/${note.id}/accept`)
      .set("Authorization", "Bearer tok").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_suggestion");
  });
});

describe("mentions", () => {
  it("stores ids, deduplicated, ignoring non-strings", async () => {
    const res = await post({ body: "@yael take a look", mentions: ["u2", "u2", "", 7, "u3"] });

    // Ids not names, so a rename does not break a mention.
    expect(res.body.note.mentions).toEqual(["u2", "u3"]);
  });
});
