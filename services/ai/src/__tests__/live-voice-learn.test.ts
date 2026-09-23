/**
 * Learning a voice from LIVE conversations must never learn the bot's own.
 *
 * The import pipeline reads an uploaded history, which is by construction
 * writing by people at the business. This path reads live traffic, which is
 * mostly not: on the dev database, 178 of 179 outbound messages were written
 * by the product ("AI Bot", "System", "Broadcast", or an AI agent's own
 * display name). Learning from those would store the model's register in
 * `BusinessProfile.observedVoice`, render it into the prompt of every agent,
 * and present the result to the customer as their own voice.
 *
 * Verified against the running stack: the endpoint reported 1 human / 178
 * machine, and with the sender filter removed it reported 179 human - which
 * CROSSES the 50-message threshold, so the unfiltered version would have gone
 * on to learn. That is what these tests pin.
 *
 * They also cover the one branch that could not be reached live: the dev
 * tenant's AI unit balance is exhausted, so the real run stopped at the model
 * call and never exercised the write. Here the model is stubbed, so the write
 * is checked directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  businessProfile: {
    findUnique: vi.fn(),
    update: vi.fn(async () => ({})),
  },
  message: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
}));

const structuredCallMock = vi.hoisted(() => vi.fn());

vi.mock("@chatcenter/shared", () => ({
  prisma: prismaMock,
  withHistoricalRecords: async (fn: () => any) => fn(),
}));

vi.mock("../services/historical-intelligence/llm", () => ({
  structuredCall: structuredCallMock,
}));

vi.mock("../services/historical-intelligence/stage-utils", () => ({
  tenantPromptLanguage: async () => "en",
  languageDirective: () => "",
  recordEvent: async () => undefined,
}));

import { learnVoiceFromLiveWriting } from "../services/live-voice.service";

const TENANT = "tenant-1";

/** A corpus of human-written messages, varied enough for the real analyser. */
function humanCorpus(n: number) {
  const bodies = [
    "Hey! Thanks for reaching out, let me check that for you.",
    "Hi there! Your order is on its way, should arrive Thursday.",
    "Sorry about that! I have refunded it, 3-5 days to land.",
    "Thanks for your patience. Anything else I can help with?",
    "We are open Sunday to Thursday, 9 to 6. Happy to help!",
    "Good news, that one is back in stock. Want me to hold one?",
  ];
  return Array.from({ length: n }, (_, i) => ({
    body: bodies[i % bodies.length]!,
    conversationId: `conv-${i % 7}`,
    createdAt: new Date(Date.now() - i * 60_000),
  }));
}

const VOICE = {
  guidance: "- Open with a greeting and the customer's first name\n- Keep replies to one or two sentences",
  summary: "Warm, brief, first-person replies that get to the point.",
  emojiPalette: ["😊"],
  greetingExample: "Hey! Thanks for reaching out.",
  closingExample: "Anything else I can help with?",
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.businessProfile.findUnique.mockResolvedValue({ id: "bp-1", observedVoiceEditedAt: null });
  prismaMock.businessProfile.update.mockResolvedValue({});
  structuredCallMock.mockResolvedValue(VOICE);
});

describe("the corpus is chosen by an allow-list, not by excluding known bots", () => {
  it("asks only for outbound live messages whose sender is an email address", async () => {
    prismaMock.message.findMany.mockResolvedValue([]);
    prismaMock.message.count.mockResolvedValue(0);

    await learnVoiceFromLiveWriting(TENANT);

    const where = prismaMock.message.findMany.mock.calls[0]![0].where;
    expect(where.direction).toBe("OUTBOUND");
    // Stated explicitly rather than left to the client's live-by-default
    // injection: naming origin suppresses that injection, so this filter is
    // the one doing the work.
    expect(where.origin).toBe("LIVE");
    // THE RULE. A person's send stores `req.user.email`; every machine path
    // stores "AI Bot", "System", "Broadcast" or an agent's display name.
    expect(where.senderName).toEqual({ contains: "@" });
    // A setup rehearsal is not the business talking to a customer, and
    // sandbox rows carry isTest=false, so the id prefix is the real predicate.
    expect(where.conversation.is.NOT).toEqual({ customerExternalId: { startsWith: "sandbox:" } });
  });

  it("reports machine writing as total minus human, so the two always sum to the total", async () => {
    prismaMock.message.findMany.mockResolvedValue([]);
    // count() is called for the total and again for the human subset.
    prismaMock.message.count.mockResolvedValueOnce(179).mockResolvedValueOnce(1);

    const result = await learnVoiceFromLiveWriting(TENANT);

    expect(result.machineWritten).toBe(178);
    expect(result.humanWritten).toBe(0);
  });
});

describe("refusals", () => {
  it("will not characterise a business from too little of its own writing", async () => {
    prismaMock.message.findMany.mockResolvedValue(humanCorpus(12));
    prismaMock.message.count.mockResolvedValueOnce(190).mockResolvedValueOnce(12);

    const result = await learnVoiceFromLiveWriting(TENANT);

    expect(result.status).toBe("too_little_writing");
    expect(result.humanWritten).toBe(12);
    expect(result.required).toBe(50);
    // No model call, and nothing written: an under-strength corpus must cost
    // nothing and change nothing.
    expect(structuredCallMock).not.toHaveBeenCalled();
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
  });

  it("keeps a hand-edited voice even when there is plenty to learn from", async () => {
    prismaMock.businessProfile.findUnique.mockResolvedValue({
      id: "bp-1",
      observedVoiceEditedAt: new Date(),
    });
    prismaMock.message.findMany.mockResolvedValue(humanCorpus(80));
    prismaMock.message.count.mockResolvedValueOnce(260).mockResolvedValueOnce(80);

    const result = await learnVoiceFromLiveWriting(TENANT);

    expect(result.status).toBe("edited_by_hand");
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
    // Reported as a refusal with its counts rather than a success that
    // changed nothing - the screen has to be able to say why.
    expect(result.humanWritten).toBe(80);
  });

  it("writes nothing when the model is unavailable", async () => {
    structuredCallMock.mockResolvedValue(null);
    prismaMock.message.findMany.mockResolvedValue(humanCorpus(80));
    prismaMock.message.count.mockResolvedValueOnce(260).mockResolvedValueOnce(80);

    const result = await learnVoiceFromLiveWriting(TENANT);

    expect(result.status).toBe("model_unavailable");
    expect(prismaMock.businessProfile.update).not.toHaveBeenCalled();
  });
});

describe("a successful learn", () => {
  it("stores the guidance and leaves the edit stamp alone", async () => {
    prismaMock.message.findMany.mockResolvedValue(humanCorpus(80));
    prismaMock.message.count.mockResolvedValueOnce(260).mockResolvedValueOnce(80);

    const result = await learnVoiceFromLiveWriting(TENANT);

    expect(result.status).toBe("learned");
    expect(prismaMock.businessProfile.update).toHaveBeenCalledTimes(1);
    const data = prismaMock.businessProfile.update.mock.calls[0]![0].data;
    expect(data.observedVoice).toContain(VOICE.summary);
    // THE STAMP MUST NOT BE SET. The workspace GET reads it to tell "learned"
    // from "edited", and setting it here would make the next learn refuse
    // itself as a hand edit that never happened.
    expect(data).not.toHaveProperty("observedVoiceEditedAt");
    expect(result.guidance).toContain(VOICE.summary);
  });

  it("analyses only the messages it was given, and reports that count", async () => {
    prismaMock.message.findMany.mockResolvedValue(humanCorpus(64));
    prismaMock.message.count.mockResolvedValueOnce(300).mockResolvedValueOnce(64);

    const result = await learnVoiceFromLiveWriting(TENANT);

    expect(result.status).toBe("learned");
    // The reported figure is what the analyser counted, not the raw corpus:
    // `analyzeBrandVoice` drops what it cannot read, and the threshold is
    // applied to the analysed number for the same reason.
    expect(result.humanWritten).toBe(64);
  });
});
