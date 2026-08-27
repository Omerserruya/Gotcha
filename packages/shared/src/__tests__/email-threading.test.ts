/**
 * Replying to an email from the inbox.
 *
 * Email has no native conversation. A mail client decides two messages belong
 * together by reading In-Reply-To, References and Subject, and GOTCHA sent none
 * of them: both mail adapters hard-coded `Subject: "Message"`, so every support
 * reply landed in the customer's inbox as a brand new email called "Message",
 * detached from the question it answered.
 *
 * These are the ways that can go wrong once fixed: a subject that accumulates
 * "Re: Re: Re:", a References chain that grows without bound, a reply that
 * threads at Gmail but nowhere else, and a deliberately new thread that gets
 * dragged back into the old one.
 */
import { describe, it, expect } from "vitest";
import {
  baseSubject,
  replySubject,
  buildReferences,
  parseMessageIdList,
  readEmailMeta,
  resolveEmailThread,
  threadHeaderLines,
  outgoingSubject,
  DEFAULT_EMAIL_SUBJECT,
} from "../channels/email-thread";

// ─── Subjects ───────────────────────────────────────────────

describe("subjects", () => {
  it("prefixes a reply", () => {
    expect(replySubject("Order 1234")).toBe("Re: Order 1234");
  });

  it("does not stack Re: on a subject that already has one", () => {
    expect(replySubject("Re: Order 1234")).toBe("Re: Order 1234");
  });

  it("collapses a subject that bounced between clients", () => {
    // Real threads arrive like this after a few round trips.
    expect(replySubject("Re: RE: Re: Order 1234")).toBe("Re: Order 1234");
  });

  it("handles the numbered form some clients use", () => {
    expect(replySubject("Re[2]: Order 1234")).toBe("Re: Order 1234");
    expect(replySubject("RE(3): Order 1234")).toBe("Re: Order 1234");
  });

  it("leaves a forward marker alone, because a forward is not a reply", () => {
    expect(replySubject("Fwd: Invoice")).toBe("Re: Fwd: Invoice");
  });

  it("keeps a subject that merely starts with the letters r-e", () => {
    // "Refund request" must not be mistaken for a reply prefix.
    expect(baseSubject("Refund request")).toBe("Refund request");
    expect(replySubject("Refund request")).toBe("Re: Refund request");
  });

  it("falls back to something a customer can read, not to 'Message'", () => {
    expect(replySubject("")).toBe(DEFAULT_EMAIL_SUBJECT);
    expect(replySubject(undefined)).toBe(DEFAULT_EMAIL_SUBJECT);
    expect(outgoingSubject(undefined)).toBe(DEFAULT_EMAIL_SUBJECT);
  });

  it("truncates a subject long enough to be rejected by a mail server", () => {
    const out = replySubject("x".repeat(500));
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("uses the caller's own subject for a deliberately new thread", () => {
    expect(outgoingSubject({ subject: "Your renewal" })).toBe("Your renewal");
  });
});

// ─── Header parsing ─────────────────────────────────────────

describe("reading message-id headers", () => {
  it("splits a whitespace-separated References chain", () => {
    expect(parseMessageIdList("<a@x> <b@x>\n <c@x>")).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("tolerates a comma-separated sender", () => {
    expect(parseMessageIdList("<a@x>, <b@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  it("drops entries that are not angle-bracketed ids", () => {
    // One malformed entry breaks threading for the whole chain, so it is
    // dropped rather than passed through.
    expect(parseMessageIdList("<a@x> garbage <b@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  it("returns nothing for an absent header", () => {
    expect(parseMessageIdList(undefined)).toEqual([]);
    expect(parseMessageIdList("")).toEqual([]);
  });
});

describe("building the References chain", () => {
  it("appends the parent to what the parent referenced", () => {
    expect(buildReferences(["<a@x>"], "<b@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  it("starts a chain when the parent referenced nothing", () => {
    expect(buildReferences(undefined, "<a@x>")).toEqual(["<a@x>"]);
  });

  it("does not duplicate an id already in the chain", () => {
    expect(buildReferences(["<a@x>"], "<a@x>")).toEqual(["<a@x>"]);
  });

  it("keeps the root and the recent tail when a long thread would overflow the header", () => {
    const long = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`);
    const out = buildReferences(long, "<newest@x>");

    expect(out.length).toBeLessThanOrEqual(20);
    // The root anchors the thread; the tail is what clients match on.
    expect(out[0]).toBe("<m0@x>");
    expect(out[out.length - 1]).toBe("<newest@x>");
  });
});

// ─── Reading a message row ──────────────────────────────────

describe("reading metadata off a message", () => {
  it("reads a well-formed row", () => {
    const meta = readEmailMeta({ email: { messageIdHeader: "<a@x>", subject: "Order", threadId: "t1" } });
    expect(meta).toMatchObject({ messageIdHeader: "<a@x>", subject: "Order", threadId: "t1" });
  });

  it("returns null for a row with no email metadata", () => {
    expect(readEmailMeta(null)).toBeNull();
    expect(readEmailMeta({})).toBeNull();
    expect(readEmailMeta({ email: "nonsense" })).toBeNull();
  });

  it("ignores fields of the wrong type rather than passing them on", () => {
    // Metadata is a JSON column; nothing guarantees its shape.
    const meta = readEmailMeta({ email: { messageIdHeader: 42, references: ["<a@x>", 7], threadId: {} } });
    expect(meta!.messageIdHeader).toBeUndefined();
    expect(meta!.references).toEqual(["<a@x>"]);
    expect(meta!.threadId).toBeUndefined();
  });
});

// ─── Resolving what to reply to ─────────────────────────────

const inbound = (email: any) => ({ direction: "INBOUND" as const, metadata: { email } });
const outbound = (email?: any) => ({ direction: "OUTBOUND" as const, metadata: email ? { email } : undefined });

describe("choosing which email to answer", () => {
  it("answers the newest inbound email", () => {
    // Newest first, which is the order the inbox reads them in.
    const thread = resolveEmailThread([
      inbound({ messageIdHeader: "<new@x>", subject: "Re: Order 1", references: ["<old@x>"], threadId: "t1" }),
      outbound(),
      inbound({ messageIdHeader: "<old@x>", subject: "Order 1", threadId: "t1" }),
    ]);

    expect(thread).toEqual({
      subject: "Re: Order 1",
      inReplyTo: "<new@x>",
      references: ["<old@x>", "<new@x>"],
      threadId: "t1",
      providerMessageId: undefined,
    });
  });

  it("answers the last of several follow-ups, not the first", () => {
    // A customer who sent three messages should get the answer under the last.
    const thread = resolveEmailThread([
      inbound({ messageIdHeader: "<third@x>", subject: "Re: Order 1" }),
      inbound({ messageIdHeader: "<second@x>", subject: "Re: Order 1" }),
      inbound({ messageIdHeader: "<first@x>", subject: "Order 1" }),
    ]);
    expect(thread!.inReplyTo).toBe("<third@x>");
  });

  it("does not reply to our own outbound message", () => {
    // Threading onto our own last reply would quote the wrong parent.
    const thread = resolveEmailThread([
      outbound({ messageIdHeader: "<ours@x>", subject: "Re: Order 1", threadId: "t1" }),
      inbound({ messageIdHeader: "<theirs@x>", subject: "Order 1", threadId: "t1" }),
    ]);
    expect(thread!.inReplyTo).toBe("<theirs@x>");
  });

  it("stays in the thread when only our own outbound email is on record", () => {
    // An outbound-first conversation still knows its thread and subject.
    const thread = resolveEmailThread([outbound({ subject: "Your renewal", threadId: "t9" })]);
    expect(thread).toEqual({ subject: "Re: Your renewal", threadId: "t9" });
  });

  it("returns nothing when the conversation holds no email at all", () => {
    // A brand new outbound, or a conversation whose emails predate this
    // recording. The caller sends a normal first message rather than a broken
    // reply with empty headers.
    expect(resolveEmailThread([])).toBeNull();
    expect(resolveEmailThread([{ direction: "INBOUND", metadata: { interactiveReply: {} } }])).toBeNull();
  });

  it("threads on the provider id alone when a sender set no Message-ID", () => {
    const thread = resolveEmailThread([inbound({ subject: "Order 1", threadId: "t1" })]);
    expect(thread!.threadId).toBe("t1");
    expect(thread!.inReplyTo).toBeUndefined();
  });

  it("carries the provider message id, which is what Outlook's reply endpoint needs", () => {
    const thread = resolveEmailThread([inbound({ subject: "Order", providerMessageId: "AAMk123" })]);
    expect(thread!.providerMessageId).toBe("AAMk123");
  });
});

// ─── Headers on the way out ─────────────────────────────────

describe("the headers a reply carries", () => {
  it("emits both threading headers", () => {
    expect(
      threadHeaderLines({ subject: "Re: Order", inReplyTo: "<a@x>", references: ["<a@x>", "<b@x>"] }),
    ).toEqual(["In-Reply-To: <a@x>", "References: <a@x> <b@x>"]);
  });

  it("emits nothing when there is nothing to point at", () => {
    // An empty In-Reply-To is worse than an absent one: some servers treat the
    // malformed header as a reason to reject the message.
    expect(threadHeaderLines({ subject: "Hello" })).toEqual([]);
    expect(threadHeaderLines({ subject: "Hello", references: [] })).toEqual([]);
    expect(threadHeaderLines(undefined)).toEqual([]);
  });

  it("carries no threading headers on a deliberately new thread", () => {
    // The whole point of "send as new email": nothing that could drag it back
    // into the conversation the agent chose to leave.
    const newThread = { subject: "A separate matter" };
    expect(threadHeaderLines(newThread)).toEqual([]);
    expect(outgoingSubject(newThread)).toBe("A separate matter");
  });
});
