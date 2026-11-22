/**
 * Deleting one conversation (the inbox's swipe to delete, 2026-11-22):
 * lib/delete-conversation.ts. The store below is a small stand-in for the
 * tables the delete reads and writes; its transaction rolls back on a throw.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  conversations: [] as any[],
  messages: [] as any[],
  scheduled: [] as any[],
  audits: [] as any[],
  removed: [] as Array<{ tenantId: string; names: string[]; conversationStillThere: boolean }>,
  historical: false,
  /** The scope each message read or delete ran in. */
  messageScopes: [] as boolean[],
  raceDelete: false,
  failTransaction: false,
}));

vi.mock("@chatcenter/shared", () => {
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v && typeof v === "object" && "not" in (v as any)) return row[k] !== (v as any).not;
      return row[k] === v;
    });
  // What the real client does: a message read outside the historical scope sees live rows only.
  const visible = (m: any) => H.historical || m.origin !== "HISTORICAL";
  const client = {
    conversation: {
      findFirst: async (a: any) => H.conversations.find((c) => matches(c, a.where)) ?? null,
      deleteMany: async (a: any) => {
        if (H.raceDelete) return { count: 0 };
        const before = H.conversations.length;
        const gone = H.conversations.filter((c) => matches(c, a.where)).map((c) => c.id);
        H.conversations = H.conversations.filter((c) => !gone.includes(c.id));
        // The database's cascade.
        H.messages = H.messages.filter((m) => !gone.includes(m.conversationId));
        return { count: before - H.conversations.length };
      },
    },
    message: {
      findMany: async (a: any) => { H.messageScopes.push(H.historical); return H.messages.filter((m) => visible(m) && matches(m, a.where)); },
      deleteMany: async (a: any) => {
        H.messageScopes.push(H.historical);
        const before = H.messages.length;
        H.messages = H.messages.filter((m) => !(visible(m) && matches(m, a.where)));
        return { count: before - H.messages.length };
      },
    },
    scheduledMessage: {
      updateMany: async (a: any) => {
        const rows = H.scheduled.filter((s) => matches(s, a.where));
        for (const r of rows) Object.assign(r, a.data);
        return { count: rows.length };
      },
    },
    $transaction: async (fn: any) => {
      if (H.failTransaction) throw new Error("db down");
      const snapshot = JSON.stringify([H.conversations, H.messages, H.scheduled]);
      try {
        return await fn(client);
      } catch (err) {
        [H.conversations, H.messages, H.scheduled] = JSON.parse(snapshot);
        throw err;
      }
    },
  };
  return {
    prisma: client,
    withHistoricalRecords: async (fn: any) => {
      H.historical = true;
      try { return await fn(); } finally { H.historical = false; }
    },
    writeAudit: async (e: any) => { H.audits.push(e); },
    AuditAction: { CONVERSATION_DELETED: "conversation.deleted" },
  };
});

vi.mock("../lib/erase-uploads", async (original) => ({
  ...(await original<typeof import("../lib/erase-uploads")>()),
  removeUnnamedUploads: async (tenantId: string, names: string[]) => {
    H.removed.push({ tenantId, names, conversationStillThere: H.conversations.some((c) => c.id === "c1") });
    return { removed: names.length - 1, missing: 0, kept: names.slice(0, 1), left: [] };
  },
}));

import { deleteConversation, CANCELLED_BY_DELETE } from "../lib/delete-conversation";

const FILE_A = "0f8fad5b-d9cb-469f-a165-70867728950e.jpg";
const FILE_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf";
const AVATAR = "6ba7b810-9dad-11d1-80b4-00c04fd430c8.jpg";
const SECRET_TEXT = "my card ends with 4242";

beforeEach(() => {
  H.conversations = [
    { id: "c1", tenantId: "t1", status: "CLOSED", channel: "WHATSAPP", customerName: "Dana Levi", customerAvatarUrl: `/api/uploads/${AVATAR}` },
    { id: "c2", tenantId: "t1", status: "OPEN", channel: "WHATSAPP", customerAvatarUrl: null },
    { id: "c9", tenantId: "t2", status: "CLOSED", channel: "WHATSAPP", customerAvatarUrl: null },
  ];
  H.messages = [
    { id: "m1", tenantId: "t1", conversationId: "c1", origin: "LIVE", body: SECRET_TEXT, mediaUrl: null },
    { id: "m2", tenantId: "t1", conversationId: "c1", origin: "LIVE", body: "", mediaUrl: `/api/uploads/${FILE_A}` },
    { id: "m3", tenantId: "t1", conversationId: "c1", origin: "HISTORICAL", body: "old", mediaUrl: `https://app.example/api/uploads/${FILE_B}` },
    { id: "m4", tenantId: "t1", conversationId: "c1", origin: "LIVE", body: "", mediaUrl: "https://pps.whatsapp.net/v/x.jpg" },
    { id: "m5", tenantId: "t1", conversationId: "c2", origin: "LIVE", body: "other", mediaUrl: `/api/uploads/${FILE_A}` },
    { id: "m6", tenantId: "t2", conversationId: "c9", origin: "LIVE", body: "other tenant", mediaUrl: null },
  ];
  H.scheduled = [
    { id: "s1", tenantId: "t1", conversationId: "c1", status: "PENDING", error: null },
    { id: "s2", tenantId: "t1", conversationId: "c1", status: "SENT", error: null },
    { id: "s3", tenantId: "t1", conversationId: "c2", status: "PENDING", error: null },
    { id: "s4", tenantId: "t2", conversationId: "c1", status: "PENDING", error: null },
  ];
  H.audits = []; H.removed = []; H.messageScopes = [];
  H.historical = false; H.raceDelete = false; H.failTransaction = false;
});

const run = (o: Partial<Parameters<typeof deleteConversation>[0]> = {}) =>
  deleteConversation({ tenantId: "t1", conversationId: "c1", force: false, actorId: "u-admin", ...o });
const untouched = () => expect({ c: H.conversations.length, m: H.messages.length, a: H.audits.length, f: H.removed.length, s: H.scheduled.map((s) => s.status) })
  .toEqual({ c: 3, m: 6, a: 0, f: 0, s: ["PENDING", "SENT", "PENDING", "PENDING"] });

describe("deleting one conversation", () => {
  it("removes the conversation and every one of its messages, and nothing of any other conversation", async () => {
    const r = await run();
    expect(r).toMatchObject({ outcome: "deleted", conversationId: "c1", messages: 4 });
    expect(H.conversations.map((c) => c.id)).toEqual(["c2", "c9"]);
    expect(H.messages.map((m) => m.id)).toEqual(["m5", "m6"]);
  });

  it("counts and reads the messages whatever their origin: every message read runs in the historical scope", async () => {
    await run();
    expect(H.messageScopes.length).toBeGreaterThanOrEqual(2);
    expect(H.messageScopes.every(Boolean)).toBe(true);
    // The imported message's file is among the names, so it was read.
    expect(H.removed[0]!.names).toContain(FILE_B);
  });

  it("another workspace's conversation is not found, and nothing is touched", async () => {
    expect(await run({ conversationId: "c9" })).toEqual({ outcome: "not_found" });
    expect(await run({ conversationId: "nope" })).toEqual({ outcome: "not_found" });
    untouched();
  });

  it("another workspace's OPEN conversation is not found either: the answer never says it exists", async () => {
    H.conversations.find((c) => c.id === "c9")!.status = "OPEN";
    expect(await run({ conversationId: "c9" })).toEqual({ outcome: "not_found" });
    expect(await run({ conversationId: "c9", force: true })).toEqual({ outcome: "not_found" });
    untouched();
  });

  it("an open conversation is deleted only with force", async () => {
    expect(await run({ conversationId: "c2" })).toEqual({ outcome: "must_close" });
    untouched();
    expect(await run({ conversationId: "c2", force: true })).toMatchObject({ outcome: "deleted", messages: 1 });
    expect(H.conversations.map((c) => c.id)).toEqual(["c1", "c9"]);
    expect(H.audits[0].metadata).toMatchObject({ forced: true, statusBefore: "OPEN" });
  });

  it("a closed one needs no force, and its audit row says it was not forced", async () => {
    await run({ force: true });
    expect(H.audits[0].metadata).toMatchObject({ forced: false, statusBefore: "CLOSED" });
  });

  it("cancels this conversation's waiting scheduled messages only: not a sent one, another conversation's, or another workspace's", async () => {
    const r = await run();
    expect(r).toMatchObject({ scheduledCancelled: 1 });
    expect(H.scheduled.map((s) => [s.id, s.status, s.error])).toEqual([
      ["s1", "CANCELLED", CANCELLED_BY_DELETE],
      ["s2", "SENT", null],
      ["s3", "PENDING", null],
      ["s4", "PENDING", null],
    ]);
  });

  it("hands the stored files to the shared-file check after the commit: our uploads and the avatar, never a provider's URL", async () => {
    const r = await run();
    expect(H.removed).toHaveLength(1);
    expect(H.removed[0]).toEqual({ tenantId: "t1", names: [FILE_A, FILE_B, AVATAR], conversationStillThere: false });
    expect(r).toMatchObject({ uploadsRemoved: 2, uploadsKeptShared: 1, uploadsLeftBehind: 0 });
  });

  it("writes one audit row: the action, the admin, the message count, and no message text or customer name", async () => {
    await run();
    expect(H.audits).toHaveLength(1);
    expect(H.audits[0]).toMatchObject({
      tenantId: "t1", actorType: "user", actorId: "u-admin", action: "conversation.deleted",
      targetType: "conversation", targetId: "c1",
      metadata: { messageCount: 4, channel: "WHATSAPP", scheduledCancelled: 1, uploadsRemoved: 2, uploadsKeptShared: 1, uploadsLeftBehind: 0 },
    });
    const text = JSON.stringify(H.audits[0]);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("Dana");
  });

  it("deleted by somebody else in the same moment: everything is put back, not found, no audit, no file removed", async () => {
    H.raceDelete = true;
    expect(await run()).toEqual({ outcome: "not_found" });
    untouched();
  });

  it("a failed transaction is an error, with no audit row and no file removed", async () => {
    H.failTransaction = true;
    await expect(run()).rejects.toThrow("db down");
    untouched();
  });
});
