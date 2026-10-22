/**
 * An AI reply to an email continues the customer's thread (2026-10-22).
 *
 * The bot sends through the adapter directly and passed no thread, so its
 * answer to an email went out as a new email with the default subject, beside
 * the customer's thread. emailThreadFor resolves it from the conversation's
 * recent messages, the same way the outgoing worker does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ history: [] as any[], calls: 0 }));

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    getInternalServiceKey: () => "test-internal-key",
    prisma: {
      message: {
        findMany: vi.fn(async (args: any) => {
          H.calls++;
          expect(args.where).toEqual({ tenantId: "t1", conversationId: "c1" });
          return H.history;
        }),
      },
    },
  };
});

import { emailThreadFor } from "../services/ai-bot.service";

beforeEach(() => { H.history = []; H.calls = 0; });

const inbound = {
  direction: "INBOUND",
  metadata: { email: { messageIdHeader: "<cust-2@mail.test>", references: ["<cust-1@mail.test>"], subject: "Order 1234", threadId: "t_77", providerMessageId: "AAMk9" } },
};

describe("★ emailThreadFor", () => {
  it("an email conversation: the reply continues the customer's thread", async () => {
    H.history = [inbound];
    const t = await emailThreadFor("t1", "c1", "GMAIL");
    expect(t).toMatchObject({
      subject: "Re: Order 1234",
      inReplyTo: "<cust-2@mail.test>",
      references: ["<cust-1@mail.test>", "<cust-2@mail.test>"],
      threadId: "t_77",
    });
  });

  it("works for every email channel", async () => {
    H.history = [inbound];
    for (const ch of ["EMAIL", "GMAIL", "OUTLOOK"]) expect(await emailThreadFor("t1", "c1", ch), ch).toBeDefined();
  });

  it("a messaging channel: undefined (the same call as before) and no database read", async () => {
    for (const ch of ["WHATSAPP", "INSTAGRAM", "MESSENGER", "SHOPIFY_LIVE_CHAT"]) {
      expect(await emailThreadFor("t1", "c1", ch)).toBeUndefined();
    }
    expect(H.calls).toBe(0);
  });

  it("no email history yet: undefined, so the adapter uses its own default", async () => {
    expect(await emailThreadFor("t1", "c1", "GMAIL")).toBeUndefined();
  });
});
