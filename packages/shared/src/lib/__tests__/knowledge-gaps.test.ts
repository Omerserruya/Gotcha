import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    unansweredQuestion: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    productDemandTerm: { upsert: vi.fn() },
  },
}));
vi.mock("../prisma", () => ({ prisma: prismaMock }));

import {
  clusterKeyFor, isoWeekKey, recordUnansweredQuestion, recordProductDemand, isQuestionText,
} from "../knowledge-gaps";

describe("clusterKeyFor", () => {
  it("collapses phrasing differences into one cluster", () => {
    // The owner wants ONE row for this gap, not five for five ways of asking.
    const a = clusterKeyFor("How do I return a package?");
    const b = clusterKeyFor("package return, how?");
    const c = clusterKeyFor("  RETURN a PACKAGE!!  ");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("keeps genuinely different questions apart", () => {
    expect(clusterKeyFor("where is my order")).not.toBe(clusterKeyFor("how do I return this"));
  });

  it("does not collapse every stopword-only message into one bucket", () => {
    // "hello?" and "thanks!" are both meaningless to cluster, but merging them
    // would invent a single enormous fake gap at the top of the list.
    expect(clusterKeyFor("hello?")).not.toBe(clusterKeyFor("thanks!"));
  });

  it("is stable across repeated words", () => {
    expect(clusterKeyFor("refund refund refund")).toBe(clusterKeyFor("refund"));
  });
});

describe("isoWeekKey", () => {
  it("formats as YYYY-Www and sorts lexically", () => {
    expect(isoWeekKey(new Date("2026-09-08T12:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/);
    expect(isoWeekKey(new Date("2026-01-05T00:00:00Z")) < isoWeekKey(new Date("2026-03-05T00:00:00Z"))).toBe(true);
  });

  it("puts an early-January date in the year its ISO week belongs to", () => {
    // 2027-01-01 is a Friday, so it falls in week 53 of 2026. Naive year-taking
    // would file it as 2027-W01 and the week would silently reset mid-January.
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });
});

describe("recordUnansweredQuestion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a cluster the first time", async () => {
    prismaMock.unansweredQuestion.findUnique.mockResolvedValue(null);
    await recordUnansweredQuestion({ tenantId: "t1", question: "do you ship to Eilat?", reason: "no_knowledge" });
    expect(prismaMock.unansweredQuestion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ askCount: 1, reason: "no_knowledge" }) }),
    );
  });

  it("increments instead of inserting a second row", async () => {
    prismaMock.unansweredQuestion.findUnique.mockResolvedValue({ id: "q1", askedBy: 1, resolvedAt: null });
    await recordUnansweredQuestion({ tenantId: "t1", question: "do you ship to Eilat?", reason: "no_knowledge" });
    expect(prismaMock.unansweredQuestion.create).not.toHaveBeenCalled();
    expect(prismaMock.unansweredQuestion.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ askCount: { increment: 1 } }) }),
    );
  });

  it("reopens a resolved gap when it is asked again", async () => {
    // Being asked again IS the evidence the fix did not land.
    prismaMock.unansweredQuestion.findUnique.mockResolvedValue({
      id: "q1", askedBy: 3, resolvedAt: new Date("2026-09-01T00:00:00Z"),
    });
    await recordUnansweredQuestion({ tenantId: "t1", question: "do you ship to Eilat?", reason: "no_knowledge" });
    expect(prismaMock.unansweredQuestion.update.mock.calls[0][0].data.resolvedAt).toBeNull();
  });

  it("does not inflate askedBy when it cannot tell askers apart", async () => {
    prismaMock.unansweredQuestion.findUnique.mockResolvedValue({ id: "q1", askedBy: 1, resolvedAt: null });
    await recordUnansweredQuestion({ tenantId: "t1", question: "hours?", reason: "low_confidence" });
    expect(prismaMock.unansweredQuestion.update.mock.calls[0][0].data.askedBy).toBeUndefined();
  });

  it("never throws - the notebook must not break the conversation", async () => {
    prismaMock.unansweredQuestion.findUnique.mockRejectedValue(new Error("db is down"));
    await expect(
      recordUnansweredQuestion({ tenantId: "t1", question: "anything", reason: "no_knowledge" }),
    ).resolves.toBeUndefined();
  });

  it("ignores an empty question", async () => {
    await recordUnansweredQuestion({ tenantId: "t1", question: "   ", reason: "no_knowledge" });
    expect(prismaMock.unansweredQuestion.findUnique).not.toHaveBeenCalled();
  });
});

describe("recordProductDemand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a miss, normalised and week-bucketed", async () => {
    await recordProductDemand({
      tenantId: "t1", term: "  Navy Towels ", inCatalogue: false,
      at: new Date("2026-09-08T12:00:00Z"),
    });
    const call = prismaMock.productDemandTerm.upsert.mock.calls[0][0];
    expect(call.where.tenantId_term_weekKey.term).toBe("navy towels");
    expect(call.where.tenantId_term_weekKey.weekKey).toMatch(/^2026-W\d{2}$/);
    expect(call.create.inCatalogue).toBe(false);
  });

  it("records hits too, so a delisted product shows as a CHANGE", async () => {
    await recordProductDemand({ tenantId: "t1", term: "navy towels", inCatalogue: true });
    expect(prismaMock.productDemandTerm.upsert.mock.calls[0][0].update.inCatalogue).toBe(true);
  });

  it("never throws", async () => {
    prismaMock.productDemandTerm.upsert.mockRejectedValue(new Error("db is down"));
    await expect(recordProductDemand({ tenantId: "t1", term: "x", inCatalogue: false })).resolves.toBeUndefined();
  });
});

describe("★ a placeholder for a non-text message is never an unanswered question (2026-10-14)", () => {
  it("reactions, stickers, media placeholders and emoji-only messages are not questions; real questions are", () => {
    for (const t of ["[reaction message]", "[Sticker]", "[Image]", "[Document]", "[Voice message]", "[Unknown message]", "[Shared location: Eilat Port (29.55, 34.95)]", "👍", "?", "  ", "", null]) {
      expect(isQuestionText(t as any), String(t)).toBe(false);
    }
    for (const t of ["מה זמני המשלוח?", "do you ship to Eilat?", "[order 575] where is it?", "575"]) {
      expect(isQuestionText(t), t).toBe(true);
    }
  });

  it("★ recording one writes nothing", async () => {
    prismaMock.unansweredQuestion.findUnique.mockReset();
    prismaMock.unansweredQuestion.create.mockReset();
    prismaMock.unansweredQuestion.update.mockReset();
    for (const q of ["[reaction message]", "[Sticker]", "😂😂"]) {
      await recordUnansweredQuestion({ tenantId: "T", question: q, reason: "low_confidence" });
    }
    expect(prismaMock.unansweredQuestion.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.unansweredQuestion.create).not.toHaveBeenCalled();
    expect(prismaMock.unansweredQuestion.update).not.toHaveBeenCalled();
  });
});
