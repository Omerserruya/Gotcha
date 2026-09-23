/**
 * The language mix of recent conversations.
 *
 * This is the input for "most of your traffic is in X - do you answer in X?",
 * so two things have to be right or the suggestion is built on a wrong number:
 * setup rehearsals must not count as traffic, and conversations whose language
 * was never detected must not quietly leave the denominator.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: { groupBy: vi.fn<(...a: any[]) => any>() },
}));

vi.mock("@chatcenter/shared", () => ({ prisma: prismaMock }));

import { getLanguageShare, REAL_CONVERSATION } from "../services/analytics.service";

const row = (detectedLocale: string | null, n: number) => ({ detectedLocale, _count: { _all: n } });

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.groupBy.mockResolvedValue([]);
});

describe("what counts as traffic", () => {
  it("excludes sandbox rehearsals by BOTH halves of the predicate", async () => {
    await getLanguageShare("t1");

    const where = prismaMock.conversation.groupBy.mock.calls[0]![0].where;
    // isTest alone is inert here: sandbox conversations carry isTest=false, so
    // the external-id prefix is the half that actually excludes them.
    expect(where.isTest).toBe(false);
    expect(where.NOT).toEqual({ customerExternalId: { startsWith: "sandbox:" } });
  });

  it("uses the shared predicate rather than a fourth private copy", () => {
    // The same pair defines a billable conversation in usage-allowance and in
    // billing's observed-usage measurement. A copy here would be a fourth
    // definition of "a conversation", which is how isTest came to be wrong in
    // 21 places in this very file.
    expect(REAL_CONVERSATION).toEqual({
      isTest: false,
      NOT: { customerExternalId: { startsWith: "sandbox:" } },
    });
  });

  it("bounds the window it asks for", async () => {
    await getLanguageShare("t1", 7);

    const where = prismaMock.conversation.groupBy.mock.calls[0]![0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    // Seven days back, not the beginning of time.
    const ageDays = (Date.now() - where.createdAt.gte.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(6.9);
    expect(ageDays).toBeLessThan(7.1);
  });
});

describe("the shares themselves", () => {
  it("reports the real mix and sums to 100%", async () => {
    prismaMock.conversation.groupBy.mockResolvedValue([row("he", 76), row("en", 12)]);

    const out = await getLanguageShare("t1");

    expect(out.total).toBe(88);
    expect(out.rows).toEqual([
      { locale: "he", conversations: 76, share: 86.4 },
      { locale: "en", conversations: 12, share: 13.6 },
    ]);
    expect(out.rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(100, 1);
  });

  it("★ keeps undetected conversations in the denominator, as their own row", async () => {
    prismaMock.conversation.groupBy.mockResolvedValue([row("he", 60), row(null, 40)]);

    const out = await getLanguageShare("t1");

    // ASSERTED ON THE QUERY TOO, and this is not belt-and-braces. The mock
    // returns the null row whatever the where clause says, so adding
    // `detectedLocale: { not: null }` to the query would drop undetected
    // conversations in production and still pass every assertion below. That
    // mutation DID pass until this line existed.
    const where = prismaMock.conversation.groupBy.mock.calls[0]![0].where;
    expect(where.detectedLocale).toBeUndefined();

    // Dropping the 40 would report Hebrew at 100% of a population that is
    // really 60% - wrong in the direction that invites a decision.
    expect(out.total).toBe(100);
    expect(out.rows).toEqual([
      { locale: "he", conversations: 60, share: 60 },
      { locale: null, conversations: 40, share: 40 },
    ]);
  });

  it("merges language tags onto the language", async () => {
    prismaMock.conversation.groupBy.mockResolvedValue([row("he-IL", 30), row("he", 20), row("en-US", 10)]);

    const out = await getLanguageShare("t1");

    // "he-IL" and "he" are one language to somebody choosing which languages to
    // answer in; two rows for one language would understate it twice over.
    expect(out.rows).toEqual([
      { locale: "he", conversations: 50, share: 83.3 },
      { locale: "en", conversations: 10, share: 16.7 },
    ]);
  });

  it("returns an empty mix rather than dividing by zero", async () => {
    const out = await getLanguageShare("t1");

    expect(out).toEqual({ windowDays: 30, total: 0, rows: [] });
  });

  it("orders by volume, so the answer to 'what should we add' is first", async () => {
    prismaMock.conversation.groupBy.mockResolvedValue([row("en", 5), row("ru", 20), row("he", 12)]);

    const out = await getLanguageShare("t1");

    expect(out.rows.map((r) => r.locale)).toEqual(["ru", "he", "en"]);
  });
});
