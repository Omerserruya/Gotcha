/**
 * The model layer (model-caps, 2026-11-11) must not change one byte of what
 * prod sends today on gpt-5-mini (OPENAI_DEFAULT_MODEL), gpt-5-nano (micro)
 * and gpt-4o-mini (onboarding). EXPECTED below is what 43654db9 (prod before
 * the layer) sent for each case, captured from that tree's generateResponse
 * and streamResponse and compared as JSON strings, so key order counts too.
 *
 * The deliberate differences:
 *  - a modern model asked for temperature exactly 1 no longer gets
 *    "temperature": 1 in the body. 1 is the only value gpt-5 accepts and its
 *    default, so the model runs the same;
 *  - (Omer, 2026-11-15) instructions go out as role "developer", not "system".
 *    WIRE() below applies exactly that to what 43654db9 sent: every other byte,
 *    the instructions' content included, is still pinned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ bodies: [] as any[] }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async (req: any) => {
      H.bodies.push(JSON.stringify(req));
      if (req.stream) return (async function* () { yield { choices: [{ delta: { content: "x" } }] }; yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; })();
      return { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    } } };
    responses = { create: async () => { throw new Error("responses must not be called"); } };
    embeddings = { create: async () => ({ data: [] }) };
  },
}));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig() as any), assertAiAllowed: async () => undefined, meterAiUnits: async () => null, trackAIUsage: async () => undefined }));
vi.mock("../services/audit.service", () => ({ logAudit: async () => undefined }));

import { initAIService, generateResponse, streamResponse } from "../services/ai.service";
import { resetModelCaps, withModelAdaptation, usesResponses } from "@chatcenter/shared/src/lib/model-caps";

const TOOLS = [{ type: "function", function: { name: "search_products", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } } }];
const MSG = [{ role: "system", content: "You are Noa." }, { role: "user", content: "אליס ואלכסה כמה זה" }];

/** What 43654db9 sent, with "system" sent as "developer" and nothing else changed. */
const WIRE = (sent: string) => sent.split('"role":"system"').join('"role":"developer"');

/** What 43654db9 sent, verbatim. */
const EXPECTED: Record<string, string> = {
 "mini no tools, default model, no caps": "{\"model\":\"gpt-5-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"max_completion_tokens\":3072,\"reasoning_effort\":\"low\"}",
 "mini no tools, temp 0.7, 500, json": "{\"model\":\"gpt-5-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"max_completion_tokens\":2548,\"reasoning_effort\":\"low\",\"response_format\":{\"type\":\"json_object\"}}",
 "mini tool call, the bot's shape": "{\"model\":\"gpt-5-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"max_completion_tokens\":3072,\"reasoning_effort\":\"low\",\"user\":\"conv-1\",\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"search_products\",\"description\":\"Search\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}}}}}],\"tool_choice\":\"auto\"}",
 "mini tool call, forced tool, effort minimal": "{\"model\":\"gpt-5-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"max_completion_tokens\":3072,\"reasoning_effort\":\"minimal\",\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"search_products\",\"description\":\"Search\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}}}}}],\"tool_choice\":{\"type\":\"function\",\"function\":{\"name\":\"search_products\"}}}",
 "nano micro: no temperature": "{\"model\":\"gpt-5-nano\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"max_completion_tokens\":2168,\"reasoning_effort\":\"minimal\"}",
 "gpt-4o-mini legacy": "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"max_tokens\":320,\"temperature\":0.2}",
 "STREAM mini tools temp 0.4 (agent-runtime)": "{\"model\":\"gpt-5-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true},\"max_completion_tokens\":3072,\"reasoning_effort\":\"low\",\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"search_products\",\"description\":\"Search\",\"parameters\":{\"type\":\"object\",\"properties\":{\"q\":{\"type\":\"string\"}}}}}]}",
 "STREAM mini no tools, session (worker)": "{\"model\":\"gpt-5-mini\",\"messages\":[{\"role\":\"system\",\"content\":\"You are Noa.\"},{\"role\":\"user\",\"content\":\"אליס ואלכסה כמה זה\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true},\"max_completion_tokens\":3072,\"reasoning_effort\":\"low\",\"user\":\"s1\"}"
};

const CASES: [string, any][] = [
    ["mini no tools, default model, no caps", { tenantId: "t", messages: MSG }],
    ["mini no tools, temp 0.7, 500, json", { tenantId: "t", model: "gpt-5-mini", messages: MSG, temperature: 0.7, maxTokens: 500, responseFormat: { type: "json_object" } }],
    ["mini tool call, the bot's shape", { tenantId: "t", model: "gpt-5-mini", messages: MSG, temperature: 0.7, maxTokens: 1024, tools: TOOLS, toolChoice: "auto", sessionId: "conv-1" }],
    ["mini tool call, forced tool, effort minimal", { tenantId: "t", model: "gpt-5-mini", messages: MSG, maxTokens: 1024, tools: TOOLS, toolChoice: { type: "function", function: { name: "search_products" } }, reasoningEffort: "minimal" }],
    ["mini temperature 1 (an agent at 1.0)", { tenantId: "t", model: "gpt-5-mini", messages: MSG, temperature: 1, maxTokens: 400 }],
    ["nano micro: translation shape (temp 1, minimal)", { tenantId: "t", model: "gpt-5-nano", messages: MSG, temperature: 1, maxTokens: 120, reasoningEffort: "minimal" }],
    ["nano micro: no temperature", { tenantId: "t", model: "gpt-5-nano", messages: MSG, maxTokens: 120, reasoningEffort: "minimal" }],
    ["gpt-4o-mini legacy", { tenantId: "t", model: "gpt-4o-mini", messages: MSG, temperature: 0.2, maxTokens: 320 }],
  ];
const STREAMS: [string, any][] = [
    ["STREAM mini tools temp 0.4 (agent-runtime)", { tenantId: "t", model: "gpt-5-mini", messages: MSG, temperature: 0.4, maxTokens: 1024, tools: TOOLS }],
    ["STREAM mini no tools, session (worker)", { tenantId: "t", messages: MSG, temperature: 0.5, maxTokens: 1024, sessionId: "s1" }],
  ];

beforeEach(() => {
  H.bodies = [];
  resetModelCaps();
  delete process.env.OPENAI_REASONING_EFFORT; delete process.env.OPENAI_REASONING_HEADROOM_TOKENS;
  initAIService({ apiKey: "test", defaultModel: "gpt-5-mini" } as any);
});

describe("★ the request body is the one prod sent before the model layer", () => {
  for (const [name, p] of CASES) {
    if (!(name in EXPECTED)) continue;
    it(name, async () => {
      await generateResponse(p);
      expect(H.bodies).toEqual([WIRE(EXPECTED[name])]);
    });
  }
  for (const [name, p] of STREAMS) {
    it(name, async () => {
      for await (const _ of streamResponse(p)) { /* drain */ }
      expect(H.bodies).toEqual([WIRE(EXPECTED[name])]);
    });
  }
});

describe("the one difference: temperature exactly 1 on a modern model is left to the model's default (1)", () => {
  it("gpt-5-mini and gpt-5-nano at temperature 1: everything else as before, no temperature key", async () => {
    await generateResponse({ tenantId: "t", model: "gpt-5-mini", messages: MSG, temperature: 1, maxTokens: 400 } as any);
    await generateResponse({ tenantId: "t", model: "gpt-5-nano", messages: MSG, temperature: 1, maxTokens: 120, reasoningEffort: "minimal" } as any);
    expect(H.bodies.map((b) => JSON.parse(b))).toEqual([
      { model: "gpt-5-mini", messages: JSON.parse(WIRE(JSON.stringify(MSG))), max_completion_tokens: 2448, reasoning_effort: "low" },
      { model: "gpt-5-nano", messages: JSON.parse(WIRE(JSON.stringify(MSG))), max_completion_tokens: 2168, reasoning_effort: "minimal" },
    ]);
  });
});

describe("★ /v1/responses engages only after gpt-6-luna's own 400, which gpt-5-mini never returns", () => {
  const TOOL_REQ = () => ({ model: "gpt-5-mini", messages: MSG, tools: TOOLS, max_completion_tokens: 3072, reasoning_effort: "low" });
  const err = (status: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });
  const LUNA = "400 Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

  it("a fresh process never routes there: the first send is always chat completions", () => {
    expect(usesResponses("gpt-5-mini", TOOL_REQ())).toBe(false);
  });

  it("every other failure surfaces as before and never reaches /responses", async () => {
    const others = [
      err(400, "400 Invalid schema for function 'search_products'", { code: "invalid_function_parameters" }),
      err(400, "400 'messages' must contain the word 'json'", { code: "invalid_request_error" }),
      err(429, "429 Rate limit reached"),
      err(500, "500 The server had an error"),
      err(429, LUNA), // the luna text on a non-400
    ];
    for (const e of others) {
      resetModelCaps();
      const responses = vi.fn();
      let sends = 0;
      await expect(withModelAdaptation("gpt-5-mini", TOOL_REQ(), async () => { sends++; throw e; }, { responses })).rejects.toBe(e);
      expect(sends, e.message).toBe(1);
      expect(responses, e.message).not.toHaveBeenCalled();
    }
  });

  it("the luna 400 on a call without tools, or with effort none, does not route there either", async () => {
    for (const req of [{ model: "gpt-5-mini", messages: MSG, reasoning_effort: "low" }, { ...TOOL_REQ(), reasoning_effort: "none" }]) {
      resetModelCaps();
      const responses = vi.fn();
      await withModelAdaptation("gpt-5-mini", req, async () => { throw err(400, LUNA, { param: "reasoning_effort" }); }, { responses }).catch(() => undefined);
      expect(responses).not.toHaveBeenCalled();
    }
  });

  it("control: only that exact 400, on a tool call with a real effort, goes there", async () => {
    const responses = vi.fn(async () => "via responses");
    await expect(withModelAdaptation("gpt-6-luna", { ...TOOL_REQ(), model: "gpt-6-luna" }, async () => { throw err(400, LUNA, { param: "reasoning_effort" }); }, { responses })).resolves.toBe("via responses");
    expect(responses).toHaveBeenCalledTimes(1);
    expect(usesResponses("gpt-6-luna", { ...TOOL_REQ(), model: "gpt-6-luna" })).toBe(true);
    // Learned per model: gpt-5-mini is untouched by gpt-6-luna's fact.
    expect(usesResponses("gpt-5-mini", TOOL_REQ())).toBe(false);
  });
});
