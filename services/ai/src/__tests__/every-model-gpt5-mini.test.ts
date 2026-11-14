/**
 * Omer, 2026-11-14: every chat model is gpt-5-mini for now (embeddings
 * excepted). On prod: OPENAI_DEFAULT_MODEL, OPENAI_MICRO_MODEL and
 * ONBOARDING_CHAT_MODEL all gpt-5-mini.
 *
 * What changes on that swap:
 *   - the micro tier (was gpt-5-nano): same modern shape, a slower model;
 *   - auth onboarding (was gpt-4o-mini, legacy max_tokens + temperature): now
 *     the modern shape, with reasoning headroom on the cap.
 * The risk was a cap sized for a non-reasoning model: reasoning tokens spent
 * inside a small max_completion_tokens and an empty reply. Every one of these
 * calls goes through shapeChatRequest, which adds 2048 of headroom on top of
 * the cap the caller asked for, so none can starve. The slower model did need
 * one timeout raised (knowledge query translation).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ bodies: [] as any[] }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async (req: any) => {
      H.bodies.push(req);
      return { choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    } } };
    responses = { create: async () => { throw new Error("responses must not be called"); } };
    embeddings = { create: async () => ({ data: [] }) };
  },
}));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig() as any), assertAiAllowed: async () => undefined, meterAiUnits: async () => null, trackAIUsage: async () => undefined }));
vi.mock("../services/audit.service", () => ({ logAudit: async () => undefined }));

import { initAIService, generateResponse, getMicroModel } from "../services/ai.service";
import { shapeChatRequest, resetModelCaps } from "@chatcenter/shared/src/lib/model-caps";
import { TRANSLATION_TIMEOUT_MS } from "../services/query-translation.service";

const SRC = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const MSG = [{ role: "user", content: "שלום" }];

/** Every micro call: its file and the maxTokens it asks for (or the expression). */
const MICRO_CALLS: [string, RegExp][] = [
  ["services/widget-text-translation.service.ts", /maxTokens: Math\.min\(4000, /],
  ["services/query-translation.service.ts", /maxTokens: Math\.min\(300, /],
  ["services/wizard-binding.service.ts", /maxTokens: 300,/],
  ["services/knowledge-summary.service.ts", /maxTokens: 120,/],
  ["services/ai-bot.service.ts", /model: getMicroModel\(\),[\s\S]{0,200}maxTokens: 400,/],
  ["services/assistant-threads.service.ts", /model: getMicroModel\(\),[\s\S]{0,200}maxTokens: 40,/],
  ["services/conversation-analysis.service.ts", /maxTokens: 200,/],
  ["services/historical-intelligence/llm.ts", /maxTokens: args\.maxTokens \?\? 2000,/],
];

/** Largest completion (reasoning included) each micro feature produced on prod, 14 days to 2026-11-14, gpt-5-nano. */
const PROD_MAX_OUT: Record<string, [number, number]> = {
  // feature: [its smallest asked cap, max completion tokens seen]
  knowledge_query_translation: [20, 79],
  widget_text_translation: [200, 149],
  ai_bot_knowledge_resolve: [400, 1008],
  summary: [120, 1033],
  wizard_binding: [300, 1315],
};

beforeEach(() => {
  H.bodies = [];
  resetModelCaps();
  delete process.env.OPENAI_REASONING_EFFORT; delete process.env.OPENAI_REASONING_HEADROOM_TOKENS;
  process.env.OPENAI_MICRO_MODEL = "gpt-5-mini";
  initAIService({ apiKey: "test", defaultModel: "gpt-5-mini" } as any);
});
afterEach(() => { delete process.env.OPENAI_MICRO_MODEL; });

describe("★ the micro tier on gpt-5-mini", () => {
  it("OPENAI_MICRO_MODEL=gpt-5-mini is what the micro calls use", () => {
    expect(getMicroModel()).toBe("gpt-5-mini");
  });

  it("every micro call goes through generateResponse (the layer); none builds its own request", () => {
    for (const [file, cap] of MICRO_CALLS) {
      const s = SRC(file);
      expect(s, file).toMatch(cap);
      expect(s, file).toContain("generateResponse(");
      expect(s, file).not.toMatch(/max_tokens|max_completion_tokens|chat\.completions\.create/);
    }
  });

  it("the smallest cap any micro call asks for still gets 2048 of reasoning room on gpt-5-mini", async () => {
    for (const maxTokens of [20, 40, 120]) {
      H.bodies = [];
      await generateResponse({ tenantId: "t", model: getMicroModel(), messages: MSG, temperature: 1, reasoningEffort: "minimal", maxTokens } as any);
      expect(H.bodies[0]).toMatchObject({ model: "gpt-5-mini", max_completion_tokens: maxTokens + 2048, reasoning_effort: "minimal" });
      expect(H.bodies[0]).not.toHaveProperty("max_tokens");
    }
  });

  it("every prod micro output so far, reasoning included, fits the cap it would get on gpt-5-mini with room to spare", () => {
    for (const [feature, [asked, seen]] of Object.entries(PROD_MAX_OUT)) {
      const req = shapeChatRequest({}, "gpt-5-mini", { maxTokens: asked, reasoningHeadroom: 2048, defaultEffort: "low" });
      expect(req.max_completion_tokens, feature).toBeGreaterThan(seen * 1.5);
    }
  });

  it("knowledge query translation waits long enough for gpt-5-mini (2x nano's prod max of 2439 ms)", () => {
    expect(TRANSLATION_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 2439);
    // It runs beside the embedding on the bot's turn: still bounded.
    expect(TRANSLATION_TIMEOUT_MS).toBeLessThanOrEqual(6000);
  });
});

describe("★ auth onboarding on gpt-5-mini: the modern shape, not 4o-mini's", () => {
  const onboarding = readFileSync(join(__dirname, "../../../auth/src/routes/onboarding.ts"), "utf8");

  it("both calls are shaped by the layer and sent through it", () => {
    expect(onboarding.match(/shapeChatRequest\(/g)?.length).toBe(2);
    expect(onboarding.match(/withModelAdaptation\(model, req, /g)?.length).toBe(2);
    expect(onboarding).not.toMatch(/\bmax_tokens:/);
    expect(onboarding).toMatch(/temperature: 0\.7, maxTokens: 512, defaultEffort: process\.env\.OPENAI_REASONING_EFFORT \|\| "low"/);
    expect(onboarding).toMatch(/temperature: 0\.2, maxTokens: 320, defaultEffort: process\.env\.OPENAI_REASONING_EFFORT \|\| "low"/);
  });

  it("the chat (512) and analyze-domain (320): max_completion_tokens with headroom, effort low, no temperature, JSON kept", () => {
    const chat = shapeChatRequest({ model: "gpt-5-mini", response_format: { type: "json_object" }, messages: MSG }, "gpt-5-mini", { temperature: 0.7, maxTokens: 512, defaultEffort: "low" });
    expect(chat).toEqual({ model: "gpt-5-mini", response_format: { type: "json_object" }, messages: MSG, max_completion_tokens: 2560, reasoning_effort: "low" });
    const domain = shapeChatRequest({ model: "gpt-5-mini", response_format: { type: "json_object" }, messages: MSG }, "gpt-5-mini", { temperature: 0.2, maxTokens: 320, defaultEffort: "low" });
    expect(domain).toEqual({ model: "gpt-5-mini", response_format: { type: "json_object" }, messages: MSG, max_completion_tokens: 2368, reasoning_effort: "low" });
  });

  it("control: on gpt-4o-mini (prod today) the same calls keep the legacy shape", () => {
    const chat = shapeChatRequest({ model: "gpt-4o-mini", messages: MSG }, "gpt-4o-mini", { temperature: 0.7, maxTokens: 512, defaultEffort: "low" });
    expect(chat).toEqual({ model: "gpt-4o-mini", messages: MSG, max_tokens: 512, temperature: 0.7 });
  });
});
