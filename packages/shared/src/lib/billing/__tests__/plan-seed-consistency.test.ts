/**
 * The seed catalog has to be arithmetically honest.
 *
 * Every advertised "N conversations per business day" must be exactly what the
 * configured credit allocation buys at the configured public ratio. These tests
 * run against the seed constants, so a future edit that quietly breaks the
 * relationship between price, credits and advertised volume fails here rather
 * than on a pricing page.
 */
import { describe, it, expect } from "vitest";
import {
  PRICING_PLAN_SEEDS,
  CHAT_OPTIONS,
  VOICE_OPTIONS,
  CREDIT_PACKAGES,
  ESTIMATION,
} from "../../../../prisma/seed-pricing";
import { estimateChannel, estimatePlanCapacity, type EstimationRatios } from "../estimation";
import { money, toMinor } from "../money";
import { FEATURE_CATALOG, getFeatureDef } from "../feature-catalog";

const RATIOS: EstimationRatios = {
  chatCreditsPerEstimatedConversation: ESTIMATION.chatCreditsPerEstimatedConversation,
  voiceCreditsPerEstimatedCall: ESTIMATION.voiceCreditsPerEstimatedCall,
  businessDaysPerMonth: ESTIMATION.businessDaysPerMonth,
  version: 1,
  configId: "seed",
  scope: "GLOBAL",
};

const plan = (key: string) => PRICING_PLAN_SEEDS.find((p) => p.key === key)!;

describe("seed catalog — three public plans", () => {
  it("seeds exactly Foundation, AI Workforce and AI Voice", () => {
    expect(PRICING_PLAN_SEEDS.map((p) => p.key)).toEqual(["foundation", "ai_workforce", "ai_voice"]);
  });

  it("marks exactly one plan recommended", () => {
    expect(PRICING_PLAN_SEEDS.filter((p) => p.recommended)).toHaveLength(1);
  });

  it("orders the plans by ascending price", () => {
    const byOrder = [...PRICING_PLAN_SEEDS].sort((a, b) => a.sortOrder - b.sortOrder);
    const prices = byOrder.map((p) => toMinor(p.monthlyPriceUsd));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("prices every plan in USD minor units without float drift", () => {
    expect(toMinor(plan("foundation").monthlyPriceUsd)).toBe(14_900);
    expect(toMinor(plan("ai_workforce").monthlyPriceUsd)).toBe(49_900);
    expect(toMinor(plan("ai_voice").monthlyPriceUsd)).toBe(149_900);
  });
});

describe("seed catalog — advertised capacity matches the allocation", () => {
  it("Foundation: 2,000 credits is 250 chats a month, 10 a business day", () => {
    const e = estimatePlanCapacity({
      chatCredits: plan("foundation").baseChatCredits,
      voiceCredits: plan("foundation").baseVoiceCredits,
      ratios: RATIOS,
    });
    expect(e.chat.estimatedMonthly).toBe(250);
    expect(e.chat.estimatedDaily).toBe(10);
    expect(e.voice.estimatedMonthly).toBe(0);
  });

  it("AI Workforce base: 2,000 credits is 10 chats a business day, and no voice", () => {
    const p = plan("ai_workforce");
    const e = estimatePlanCapacity({ chatCredits: p.baseChatCredits, voiceCredits: p.baseVoiceCredits, ratios: RATIOS });
    expect(e.chat.estimatedDaily).toBe(10);
    expect(e.voice.estimatedDaily).toBe(0);
  });

  it("AI Voice base funds BOTH 10 chats and 10 calls a business day", () => {
    const p = plan("ai_voice");
    const e = estimatePlanCapacity({ chatCredits: p.baseChatCredits, voiceCredits: p.baseVoiceCredits, ratios: RATIOS });
    expect(e.chat.estimatedDaily).toBe(10);
    expect(e.voice.estimatedDaily).toBe(10);
  });

  it("AI Voice's base allowance is the SUM of its channel pools, not a shared 2,000", () => {
    const p = plan("ai_voice");
    expect(p.baseChatCredits + p.baseVoiceCredits).toBe(p.includedCredits);
    // The dishonest version of this plan would have been 2,000 credits claiming
    // both. Under the configured ratios that funds 10 chats a day OR 4 calls a
    // day, never both - which is exactly the claim we refuse to make.
    expect(p.includedCredits).toBeGreaterThan(2000);
  });

  it("every plan's base split adds up to its included credits", () => {
    for (const p of PRICING_PLAN_SEEDS) {
      expect(p.baseChatCredits + p.baseVoiceCredits).toBe(p.includedCredits);
    }
  });
});

describe("seed catalog — chat volume options", () => {
  const base = plan("ai_workforce").baseChatCredits;

  it("offers 10 / 25 / 50 / 100 / 200 per business day", () => {
    expect(CHAT_OPTIONS.map((o) => o.dailyVolume)).toEqual([10, 25, 50, 100, 200]);
  });

  it("defaults to 10 per business day at no extra cost", () => {
    const def = CHAT_OPTIONS.find((o) => o.isDefault)!;
    expect(def.dailyVolume).toBe(10);
    expect(toMinor(def.additionalPrice)).toBe(0);
    expect(def.additionalCredits).toBe(0);
  });

  it.each(CHAT_OPTIONS.map((o) => [o.key, o] as const))(
    "%s delivers exactly its advertised daily volume",
    (_key, o) => {
      const total = base + o.additionalCredits;
      const e = estimateChannel(total, RATIOS.chatCreditsPerEstimatedConversation, RATIOS.businessDaysPerMonth);
      expect(e.estimatedDaily).toBe(o.dailyVolume);
      expect(e.estimatedMonthly).toBe(o.dailyVolume * RATIOS.businessDaysPerMonth);
    },
  );

  it("prices and credits both increase monotonically with volume", () => {
    const credits = CHAT_OPTIONS.map((o) => o.additionalCredits);
    const prices = CHAT_OPTIONS.map((o) => toMinor(o.additionalPrice));
    expect(credits).toEqual([...credits].sort((a, b) => a - b));
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("gets cheaper per conversation as volume grows", () => {
    const perChat = CHAT_OPTIONS.slice(1).map(
      (o) => toMinor(o.additionalPrice) / (o.additionalCredits / RATIOS.chatCreditsPerEstimatedConversation),
    );
    for (let i = 1; i < perChat.length; i++) expect(perChat[i]).toBeLessThan(perChat[i - 1]);
  });
});

describe("seed catalog — voice volume options", () => {
  const base = plan("ai_voice").baseVoiceCredits;

  it("offers 10 / 25 / 50 / 100 / 200 calls per business day", () => {
    expect(VOICE_OPTIONS.map((o) => o.dailyVolume)).toEqual([10, 25, 50, 100, 200]);
  });

  it("includes the 10-per-day option in the plan base at no extra cost", () => {
    const def = VOICE_OPTIONS.find((o) => o.isDefault)!;
    expect(def.dailyVolume).toBe(10);
    expect(toMinor(def.additionalPrice)).toBe(0);
  });

  it.each(VOICE_OPTIONS.map((o) => [o.key, o] as const))(
    "%s delivers exactly its advertised daily volume",
    (_key, o) => {
      const total = base + o.additionalCredits;
      const e = estimateChannel(total, RATIOS.voiceCreditsPerEstimatedCall, RATIOS.businessDaysPerMonth);
      expect(e.estimatedDaily).toBe(o.dailyVolume);
    },
  );

  it("is selected independently of chat", () => {
    const p = plan("ai_voice");
    const chat = CHAT_OPTIONS.find((o) => o.key === "chat_100")!;
    const voice = VOICE_OPTIONS.find((o) => o.key === "voice_25")!;
    const e = estimatePlanCapacity({
      chatCredits: p.baseChatCredits + chat.additionalCredits,
      voiceCredits: p.baseVoiceCredits + voice.additionalCredits,
      ratios: RATIOS,
    });
    expect(e.chat.estimatedDaily).toBe(100);
    expect(e.voice.estimatedDaily).toBe(25);
  });
});

describe("seed catalog — credit packages", () => {
  it("seeds four USD packages in ascending size", () => {
    expect(CREDIT_PACKAGES.map((c) => c.units)).toEqual([1000, 5000, 20000, 50000]);
  });

  it("offers a real discount at every step up", () => {
    const perCredit = CREDIT_PACKAGES.map((c) => toMinor(c.price) / c.units);
    for (let i = 1; i < perCredit.length; i++) expect(perCredit[i]).toBeLessThan(perCredit[i - 1]);
  });

  it("prices the smallest package at $0.025 per credit, below the auto-purchase rate", () => {
    const smallest = CREDIT_PACKAGES[0];
    expect(toMinor(smallest.price) / smallest.units).toBeCloseTo(2.5, 5); // cents per credit
  });
});

describe("seed catalog — commercial honesty", () => {
  it("never entitles a capability the product has not built", () => {
    const unbuilt = FEATURE_CATALOG.filter((f) => !f.implemented).map((f) => f.key);
    expect(unbuilt.length).toBeGreaterThan(0); // the guard is actually exercised
    for (const p of PRICING_PLAN_SEEDS) {
      for (const key of unbuilt) expect(p.features).not.toContain(key);
    }
  });

  it("only entitles keys that exist in the catalog", () => {
    for (const p of PRICING_PLAN_SEEDS) {
      for (const key of p.features) expect(getFeatureDef(key), `unknown feature ${key}`).toBeDefined();
    }
  });

  it("makes each tier a strict superset of the one below it", () => {
    const [foundation, workforce, voice] = PRICING_PLAN_SEEDS;
    for (const f of foundation.features) expect(workforce.features).toContain(f);
    for (const f of workforce.features) expect(voice.features).toContain(f);
  });

  it("keeps AI Employee and Copilot out of Foundation", () => {
    expect(plan("foundation").features).not.toContain("ai.employee");
    expect(plan("foundation").features).not.toContain("ai.copilot");
  });

  it("keeps voice out of everything below AI Voice", () => {
    for (const key of ["foundation", "ai_workforce"]) {
      expect(plan(key).features.filter((f) => f.startsWith("voice."))).toEqual([]);
      expect(plan(key).limits["limit:voice_channels"]).toBe(0);
    }
  });

  it("gives Foundation zero AI employees, matching its feature set", () => {
    expect(plan("foundation").limits["limit:ai_employees"]).toBe(0);
    expect(plan("ai_workforce").limits["limit:ai_employees"]).toBeGreaterThan(0);
  });

  it("raises every numeric limit monotonically up the tiers", () => {
    const keys = Object.keys(plan("foundation").limits);
    for (const k of keys) {
      const [a, b, c] = PRICING_PLAN_SEEDS.map((p) => p.limits[k]);
      expect(b, `${k} regressed from Foundation to AI Workforce`).toBeGreaterThanOrEqual(a);
      expect(c, `${k} regressed from AI Workforce to AI Voice`).toBeGreaterThanOrEqual(b);
    }
  });

  it("disables the volume selectors Foundation is not meant to offer yet", () => {
    expect(plan("foundation").chatVolumeEnabled).toBe(false);
    expect(plan("foundation").voiceVolumeEnabled).toBe(false);
    expect(plan("ai_workforce").chatVolumeEnabled).toBe(true);
    expect(plan("ai_workforce").voiceVolumeEnabled).toBe(false);
    expect(plan("ai_voice").chatVolumeEnabled).toBe(true);
    expect(plan("ai_voice").voiceVolumeEnabled).toBe(true);
  });
});

describe("seed catalog — price per conversation stays sane", () => {
  it("Foundation is under $1 per estimated conversation", () => {
    const p = plan("foundation");
    const e = estimateChannel(p.baseChatCredits, RATIOS.chatCreditsPerEstimatedConversation, RATIOS.businessDaysPerMonth);
    const perChat = toMinor(p.monthlyPriceUsd) / e.estimatedMonthly;
    expect(perChat).toBeLessThan(100); // cents
    expect(money(p.monthlyPriceUsd).minor).toBe(14_900);
  });
});
