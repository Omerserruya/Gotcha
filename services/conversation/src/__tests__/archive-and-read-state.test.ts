/**
 * Archive, and per-person unread: the two inbox actions that existed only in a
 * browser.
 *
 * `mark as unread` lived in `localStorage` under `chatcenter:markedUnread`, so
 * it was lost on another device, lost when site data was cleared, and invisible
 * to the rest of the team. `archive` existed nowhere at all.
 *
 * ★ THE TWO SHAPES ARE DELIBERATELY DIFFERENT, and these cases pin the
 * difference rather than the plumbing:
 *
 *   archive  is a fact about the CONVERSATION  -> a column, everyone sees it
 *   unread   is a fact about the PERSON        -> a row per (user, conversation)
 *
 * A column for unread would mean one agent marking unread marks it unread for
 * the whole team, which is neither what the old product did nor what anyone
 * expects. That is the whole design decision, so it gets a test with two users
 * in it.
 *
 * ★★ AND THE FAKE HONOURS `tenantId`. A fake that ignores it returns the row
 * regardless, so every tenant-scoping case would pass against a route that had
 * no scoping at all - the output cannot see a missing filter. The `where`
 * clauses are captured and asserted directly for the same reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  viewer: "u1",
  conversations: [] as any[],
  readStates: [] as any[],
  seenFindWhere: [] as any[],
  seenUpsertWhere: [] as any[],
  updateCalls: 0,
}));

vi.mock("@chatcenter/shared", () => ({
  prisma: {
    conversation: {
      // Honours BOTH id and tenantId, the way the real query does.
      findFirst: async ({ where }: any) => {
        state.seenFindWhere.push(where);
        return state.conversations.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null;
      },
      update: async ({ where, data }: any) => {
        state.updateCalls++;
        const row = state.conversations.find((c) => c.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
    },
    conversationReadState: {
      upsert: async ({ where, create, update }: any) => {
        state.seenUpsertWhere.push(where);
        const key = where.userId_conversationId;
        const found = state.readStates.find(
          (r) => r.userId === key.userId && r.conversationId === key.conversationId,
        );
        if (found) { Object.assign(found, update); return { ...found }; }
        /*
         * ★ THE UNIQUE CONSTRAINT IS ENFORCED HERE, and it has to be.
         *
         * Without it this fake looks up by the WHERE and then stores whatever
         * `create` says - so a route that searched on the wrong key still
         * produced a correct-looking row, and a mutation keying the lookup on a
         * constant passed the per-user test. The real database would raise
         * P2002 on the second insert for the same (userId, conversationId).
         *
         * A fake that does not enforce what the schema enforces cannot see a
         * lookup-key bug, which is the only kind of bug this upsert can have.
         */
        const clash = state.readStates.find(
          (r) => r.userId === create.userId && r.conversationId === create.conversationId,
        );
        if (clash) {
          const err: any = new Error("Unique constraint failed on the fields: (`userId`,`conversationId`)");
          err.code = "P2002";
          throw err;
        }
        const row = { id: `rs${state.readStates.length + 1}`, markedUnread: false, lastReadAt: null, ...create };
        state.readStates.push(row);
        return { ...row };
      },
    },
  },
  authenticate: (req: any, _r: any, n: any) => { req.user = { userId: state.viewer, role: "AGENT" }; n(); },
  resolveTenant: (req: any, _r: any, n: any) => { req.tenantId = "t1"; n(); },
  requireActiveTenant: () => (_q: any, _s: any, n: any) => n(),
  requireRole: () => (_q: any, _s: any, n: any) => n(),
  latestHandover: async () => null,
}));
vi.mock("../services/conversation.service", () => ({}));

import conversationsRouter from "../routes/conversations";

const app = express();
app.use(express.json());
app.use("/conversations", conversationsRouter);

beforeEach(() => {
  state.viewer = "u1";
  state.conversations = [
    { id: "c1", tenantId: "t1", archivedAt: null },
    { id: "other", tenantId: "t2", archivedAt: null }, // another tenant's
  ];
  state.readStates = [];
  state.seenFindWhere = [];
  state.seenUpsertWhere = [];
  state.updateCalls = 0;
});

describe("archive - a fact about the conversation", () => {
  it("sets archivedAt", async () => {
    const res = await request(app).post("/conversations/c1/archive");
    expect(res.status).toBe(200);
    expect(res.body.data.archivedAt).toBeTruthy();
    expect(state.conversations[0].archivedAt).toBeTruthy();
  });

  it("★ a second click keeps the FIRST archive time", async () => {
    // The menu can be opened twice. Re-stamping would make "archived at" mean
    // "last time somebody clicked archive", which is not what it says.
    await request(app).post("/conversations/c1/archive");
    const first = state.conversations[0].archivedAt;
    state.updateCalls = 0;

    const res = await request(app).post("/conversations/c1/archive");

    expect(res.status).toBe(200);
    expect(state.conversations[0].archivedAt).toEqual(first);
    // Asserted on the WRITE, not just the value: an unconditional update with
    // the same clock could coincide within a millisecond and pass on value.
    expect(state.updateCalls).toBe(0);
  });

  it("unarchive clears it", async () => {
    await request(app).post("/conversations/c1/archive");
    const res = await request(app).delete("/conversations/c1/archive");
    expect(res.status).toBe(200);
    expect(state.conversations[0].archivedAt).toBeNull();
  });
});

describe("unread - a fact about the person", () => {
  it("★ one agent reading it leaves the OTHER agent's mark standing", async () => {
    // THE design decision, and it needs BOTH agents to WRITE.
    //
    // An earlier version had u1 mark unread and u2 mark read, which passed even
    // when the mark-unread route looked rows up by a constant instead of by
    // user - because only one of the two routes was wrong and the second call
    // took the other path. Two writes against the same conversation is what
    // actually exercises the key.
    state.viewer = "u1";
    expect((await request(app).post("/conversations/c1/unread")).status).toBe(200);
    state.viewer = "u2";
    expect((await request(app).post("/conversations/c1/unread")).status).toBe(200);

    state.viewer = "u1";
    expect((await request(app).delete("/conversations/c1/unread")).status).toBe(200);

    const u1 = state.readStates.find((r) => r.userId === "u1");
    const u2 = state.readStates.find((r) => r.userId === "u2");
    expect(state.readStates).toHaveLength(2);
    expect(u1.markedUnread).toBe(false);  // u1 read it
    expect(u2.markedUnread).toBe(true);   // and u2's mark survives
  });

  it("★ marking unread does NOT move the read point", async () => {
    // `markedUnread` is set by hand; "has unseen messages" derives from
    // lastReadAt. A conversation you HAVE read can still be deliberately marked
    // unread - that is the entire point - so clearing lastReadAt here would
    // destroy the other signal.
    state.readStates.push({
      id: "rs0", tenantId: "t1", userId: "u1", conversationId: "c1",
      markedUnread: false, lastReadAt: new Date("2026-03-04T05:06:07.000Z"),
    });

    await request(app).post("/conversations/c1/unread");

    const row = state.readStates[0];
    expect(row.markedUnread).toBe(true);
    expect(row.lastReadAt).toEqual(new Date("2026-03-04T05:06:07.000Z"));
  });

  it("marking read clears the mark AND moves the read point", async () => {
    await request(app).post("/conversations/c1/unread");
    await request(app).delete("/conversations/c1/unread");
    const row = state.readStates[0];
    expect(row.markedUnread).toBe(false);
    expect(row.lastReadAt).toBeTruthy();
  });

  it("★★ the upsert carries tenantId in its WHERE, or the guard refuses it", async () => {
    // Not redundant with the `create` payload, which is why it reads as
    // deletable: the tenant guard rejects an upsert whose WHERE omits tenantId
    // ("where clause must include tenantId"), so without this the route throws
    // on its first call in a real process. Nothing else would catch that -
    // every other case here passes with it removed.
    await request(app).post("/conversations/c1/unread");
    await request(app).delete("/conversations/c1/unread");

    expect(state.seenUpsertWhere).toHaveLength(2);
    for (const where of state.seenUpsertWhere) {
      expect(where.tenantId).toBe("t1");
      expect(where.userId_conversationId).toEqual({ userId: "u1", conversationId: "c1" });
    }
  });
});

describe("tenant scoping on all four routes", () => {
  const cases: Array<[string, "post" | "delete", string]> = [
    ["archive", "post", "/conversations/other/archive"],
    ["unarchive", "delete", "/conversations/other/archive"],
    ["mark unread", "post", "/conversations/other/unread"],
    ["mark read", "delete", "/conversations/other/unread"],
  ];

  for (const [name, method, path] of cases) {
    it(`${name} answers 404 for another tenant's conversation`, async () => {
      const res = await request(app)[method](path);

      expect(res.status).toBe(404);
      // The 404 must come from SCOPING, not from the row being absent: the
      // lookup has to have been asked with this tenant's id. A route that
      // looked up by id alone would also 404 here if the row were missing, and
      // would happily archive it when it was not.
      expect(state.seenFindWhere.at(-1)).toEqual({ id: "other", tenantId: "t1" });
      expect(state.conversations[1].archivedAt).toBeNull();
      expect(state.readStates).toHaveLength(0);
    });
  }
});
