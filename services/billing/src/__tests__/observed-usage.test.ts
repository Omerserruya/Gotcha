/**
 * The tenant's OWN credits-per-conversation, and when it refuses to claim one.
 *
 * These branches cannot be reached against the dev database, and that is a
 * property of the data rather than of the code: no tenant there has credit
 * consumption and conversations in the same span. The subject tenant consumed
 * between 2026-07-28 and 2026-08-07 and every one of its conversations was
 * created from 2026-08-30 onward, so a trailing window either catches the
 * conversations or the burn, never both. The live check therefore only ever
 * exercises the refusal, which is why the measured path is pinned here.
 *
 * What must not drift:
 *   - the rate is ALL consumption over conversations, so overhead a
 *     conversation causes but is not tagged with still counts against it
 *   - a thin sample produces null and a reason, never a confident number
 *   - the coverage figure counts a conversation the tenant owns even when it
 *     started before the window
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  aiUnitLedgerEntry: { findMany: vi.fn() },
  conversation: { findMany: vi.fn() },
}));

vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));

import {
  observedConversationCost,
  remainingAtObservedRate,
  MIN_SAMPLE_CONVERSATIONS,
} from "../services/observed-usage.service";

/** CONSUME units are stored negative; the service takes absolute values. */
const entry = (units: number, referenceId: string | null = null) => ({ units: -units, referenceId });
const conversations = (n: number, prefix = "conv") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks. `clear` resets recorded calls but leaves
  // queued `mockResolvedValueOnce` values in place, and these tests do not all
  // consume the same number: the service skips its second conversation query
  // when no ledger entry names anything, so a test that queues two Onces and
  // uses one leaks the spare into whichever test runs next. That is exactly
  // how the "nothing consumed" case came to read 0 conversations instead of 88
  // - a failure in the test, pointing at nothing wrong in the service.
  vi.resetAllMocks();
  prismaMock.conversation.findMany.mockResolvedValue([]);
  prismaMock.aiUnitLedgerEntry.findMany.mockResolvedValue([]);
});

describe("measuring the rate", () => {
  it("divides all consumption by the conversations, overhead included", async () => {
    // 100 credits over 25 conversations = 4.00 each. Half the burn names no
    // conversation - embeddings and knowledge resolution - and still counts,
    // because the conversations are what caused it.
    prismaMock.aiUnitLedgerEntry.findMany.mockResolvedValue([entry(50, "conv-1"), entry(50, null)]);
    prismaMock.conversation.findMany
      .mockResolvedValueOnce(conversations(25))
      .mockResolvedValueOnce([{ id: "conv-1" }]);

    const observed = await observedConversationCost("t1");

    expect(observed.creditsPerConversation).toBe(4);
    expect(observed.reason).toBeNull();
    expect(observed.sample.conversations).toBe(25);
    expect(observed.sample.creditsConsumed).toBe(100);
    // Half of the spend names a conversation, and the screen is told so.
    expect(observed.sample.conversationAttributedPct).toBe(50);
  });

  it("counts a conversation the tenant owns even if it started before the window", async () => {
    // The referenced conversation is NOT among the in-window ones. It is still
    // this tenant's conversation, so its spend is attributed.
    prismaMock.aiUnitLedgerEntry.findMany.mockResolvedValue([entry(80, "older-conv")]);
    prismaMock.conversation.findMany
      .mockResolvedValueOnce(conversations(20))
      .mockResolvedValueOnce([{ id: "older-conv" }]);

    const observed = await observedConversationCost("t1");

    expect(observed.sample.conversationAttributedPct).toBe(100);
  });

  it("does not attribute spend referencing something that is not this tenant's conversation", async () => {
    prismaMock.aiUnitLedgerEntry.findMany.mockResolvedValue([entry(80, "someone-elses")]);
    prismaMock.conversation.findMany
      .mockResolvedValueOnce(conversations(20))
      .mockResolvedValueOnce([]); // the lookup is scoped by tenantId and finds nothing

    const observed = await observedConversationCost("t1");

    expect(observed.sample.conversationAttributedPct).toBe(0);
  });
});

describe("refusing to guess", () => {
  it("returns no rate when the sample is too thin", async () => {
    prismaMock.aiUnitLedgerEntry.findMany.mockResolvedValue([entry(100, null)]);
    prismaMock.conversation.findMany
      .mockResolvedValueOnce(conversations(MIN_SAMPLE_CONVERSATIONS - 1))
      .mockResolvedValueOnce([]);

    const observed = await observedConversationCost("t1");

    expect(observed.creditsPerConversation).toBeNull();
    expect(observed.reason).toBe("not_enough_conversations");
    // The evidence is still reported, so the screen can say how close it is.
    expect(observed.sample.conversations).toBe(MIN_SAMPLE_CONVERSATIONS - 1);
  });

  it("returns no rate when nothing was consumed in the window", async () => {
    // This is the dev database's actual shape: conversations, no burn.
    prismaMock.aiUnitLedgerEntry.findMany.mockResolvedValue([]);
    prismaMock.conversation.findMany.mockResolvedValueOnce(conversations(88)).mockResolvedValueOnce([]);

    const observed = await observedConversationCost("t1");

    expect(observed.creditsPerConversation).toBeNull();
    expect(observed.reason).toBe("no_consumption_recorded");
    expect(observed.sample.conversations).toBe(88);
  });

  it("never throws - a failed measurement must not take the balance screen down", async () => {
    prismaMock.aiUnitLedgerEntry.findMany.mockRejectedValue(new Error("db gone"));

    const observed = await observedConversationCost("t1");

    expect(observed.creditsPerConversation).toBeNull();
    expect(observed.reason).toBe("no_consumption_recorded");
  });
});

describe("turning the rate into runway", () => {
  const measured = (per: number | null) =>
    ({
      creditsPerConversation: per,
      reason: null,
      sample: {
        conversations: 25,
        creditsConsumed: 100,
        windowStart: "",
        windowEnd: "",
        conversationAttributedPct: 100,
      },
    }) as any;

  it("floors the division, because a partial conversation is not one you can have", () => {
    expect(remainingAtObservedRate(90, measured(4))).toBe(22);
  });

  it("is null when there is no measured rate, so the caller falls back and says so", () => {
    expect(remainingAtObservedRate(90, measured(null))).toBeNull();
  });

  it("is null rather than Infinity when the rate is zero", () => {
    expect(remainingAtObservedRate(90, measured(0))).toBeNull();
  });
});
