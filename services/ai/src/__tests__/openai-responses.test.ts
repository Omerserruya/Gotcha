/**
 * /v1/responses at the boundary (2026-11-11): the translation both ways, a
 * multi-step tool loop, a tool error, images, JSON format, usage (cached and
 * reasoning), the stream, and generateResponse end to end on a client that
 * behaves like gpt-6-luna (tools + effort refused on chat completions).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ chatCalls: [] as any[], respCalls: [] as any[], usage: [] as any[], respResult: null as any }));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async (req: any) => {
      H.chatCalls.push(req);
      if (req.tools?.length && req.reasoning_effort && req.reasoning_effort !== "none") {
        throw Object.assign(new Error("400 Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."), { status: 400, code: null, param: "reasoning_effort" });
      }
      return { choices: [{ message: { role: "assistant", content: "chat answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    } } };
    responses = { create: async (req: any) => { H.respCalls.push(req); return H.respResult; } };
    embeddings = { create: async () => ({ data: [] }) };
  },
}));
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    assertAiAllowed: async () => undefined,
    meterAiUnits: async () => null,
    trackAIUsage: async (e: any) => { H.usage.push(e); },
  };
});
vi.mock("../services/audit.service", () => ({ logAudit: async () => undefined }));

import { toResponsesRequest, toResponsesInput, fromResponsesResponse, chatChunksFromResponsesStream } from "../services/openai-responses";
import { initAIService, generateResponse } from "../services/ai.service";
import { resetModelCaps } from "@chatcenter/shared/src/lib/model-caps";

const TOOLS = [{ type: "function", function: { name: "search_products", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } } }];

beforeEach(() => {
  H.chatCalls = []; H.respCalls = []; H.usage = []; H.respResult = null;
  resetModelCaps();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  initAIService({ apiKey: "test", defaultModel: "gpt-6-luna" } as any);
});

describe("the request translation", () => {
  it("a multi-step tool loop: assistant tool calls -> function_call, tool results (an error too) -> function_call_output, in order", () => {
    const input = toResponsesInput([
      { role: "system", content: "You are Noa." },
      { role: "user", content: "יש מעיל?" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search_products", arguments: "{\"q\":\"coat\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"error\":\"store unreachable\"}" },
      { role: "assistant", content: "בודקת שוב", tool_calls: [{ id: "c2", type: "function", function: { name: "search_products", arguments: "{\"q\":\"trench\"}" } }] },
      { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "{\"items\":1}" }] },
    ] as any);
    expect(input).toEqual([
      { role: "system", content: "You are Noa." },
      { role: "user", content: "יש מעיל?" },
      { type: "function_call", call_id: "c1", name: "search_products", arguments: "{\"q\":\"coat\"}" },
      { type: "function_call_output", call_id: "c1", output: "{\"error\":\"store unreachable\"}" },
      { role: "assistant", content: "בודקת שוב" },
      { type: "function_call", call_id: "c2", name: "search_products", arguments: "{\"q\":\"trench\"}" },
      { type: "function_call_output", call_id: "c2", output: "{\"items\":1}" },
    ]);
  });

  it("tools flat, tool_choice flat, JSON format, token cap, effort, cache key, images; nothing stored", () => {
    const r = toResponsesRequest({
      model: "gpt-6-luna",
      messages: [{ role: "user", content: [{ type: "text", text: "logo?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA", detail: "low" } }] }],
      tools: TOOLS, tool_choice: { type: "function", function: { name: "search_products" } },
      response_format: { type: "json_object" }, max_completion_tokens: 3072, reasoning_effort: "low", user: "conv-1", stream_options: { include_usage: true },
    });
    expect(r).toEqual({
      model: "gpt-6-luna",
      input: [{ role: "user", content: [{ type: "input_text", text: "logo?" }, { type: "input_image", image_url: "data:image/png;base64,AA", detail: "low" }] }],
      store: false,
      tools: [{ type: "function", name: "search_products", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } }],
      tool_choice: { type: "function", name: "search_products" },
      max_output_tokens: 3072,
      reasoning: { effort: "low" },
      text: { format: { type: "json_object" } },
      prompt_cache_key: "conv-1",
    });
  });
});

describe("the result translation", () => {
  it("text and function calls back to choices[0].message, usage with cached and reasoning tokens", () => {
    const c = fromResponsesResponse({
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: "בודקת" }] },
        { type: "function_call", call_id: "c9", name: "search_products", arguments: "{\"q\":\"x\"}" },
      ],
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 60 }, total_tokens: 1280 },
    });
    expect(c.choices[0].message).toEqual({ role: "assistant", content: "בודקת", tool_calls: [{ id: "c9", type: "function", function: { name: "search_products", arguments: "{\"q\":\"x\"}" } }] });
    expect(c.choices[0].finish_reason).toBe("tool_calls");
    expect(c.usage).toEqual({ prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 60 } });
  });

  it("the stream: text deltas, each call with its id, name and streamed arguments under its own index, then usage", async () => {
    async function* events() {
      yield { type: "response.output_text.delta", delta: "שלום" };
      yield { type: "response.output_item.added", item: { id: "fc_a", type: "function_call", call_id: "c1", name: "search_products" } };
      yield { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "{\"q\":" };
      yield { type: "response.output_item.added", item: { id: "fc_b", type: "function_call", call_id: "c2", name: "get_stock" } };
      yield { type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "\"coat\"}" };
      yield { type: "response.function_call_arguments.delta", item_id: "fc_b", delta: "{}" };
      yield { type: "response.completed", response: { usage: { input_tokens: 50, output_tokens: 9, total_tokens: 59, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } } } };
    }
    const chunks: any[] = [];
    for await (const c of chatChunksFromResponsesStream(events())) chunks.push(c);
    // Assemble exactly as streamResponse does.
    let text = ""; const acc: Record<number, any> = {}; let usage: any = null;
    for (const ch of chunks) {
      const d = ch.choices?.[0]?.delta;
      if (d?.content) text += d.content;
      for (const t of d?.tool_calls ?? []) {
        const s = (acc[t.index] ||= { function: {} });
        if (t.id) s.id = t.id;
        if (t.function?.name) s.function.name = (s.function.name || "") + t.function.name;
        if (t.function?.arguments) s.function.arguments = (s.function.arguments || "") + t.function.arguments;
      }
      if (ch.usage) usage = ch.usage;
    }
    expect(text).toBe("שלום");
    expect(Object.values(acc)).toEqual([
      { id: "c1", function: { name: "search_products", arguments: "{\"q\":\"coat\"}" } },
      { id: "c2", function: { name: "get_stock", arguments: "{}" } },
    ]);
    expect(usage.completion_tokens_details.reasoning_tokens).toBe(4);
  });

  it("a failed stream throws, it does not end quietly", async () => {
    async function* events() { yield { type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }; }
    await expect((async () => { for await (const _ of chatChunksFromResponsesStream(events())) { /* drain */ } })()).rejects.toThrow("boom");
  });
});

describe("generateResponse on a luna-like client", () => {
  it("a tool call at effort low: refused on chat, answered by /responses with its effort; usage logged with reasoning, cached and transport", async () => {
    H.respResult = {
      status: "completed",
      output: [{ type: "function_call", call_id: "c1", name: "search_products", arguments: "{\"q\":\"coat\"}" }],
      usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1536 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 2040 },
    };
    const r = await generateResponse({ tenantId: "T", messages: [{ role: "user", content: "coat?" }], tools: TOOLS, reasoningEffort: "low", sessionId: "conv-1", metadata: { type: "ai_bot", conversationId: "conv-1" } });
    expect(H.chatCalls).toHaveLength(1);
    expect(H.respCalls).toHaveLength(1);
    expect(H.respCalls[0]).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "low" }, prompt_cache_key: "conv-1", store: false });
    expect(r.toolCalls).toEqual([{ id: "c1", type: "function", function: { name: "search_products", arguments: "{\"q\":\"coat\"}" } }]);
    expect(r.usage).toMatchObject({ input_tokens: 2000, output_tokens: 40, cached_tokens: 1536 });
    await new Promise((res) => setTimeout(res, 0));
    expect(H.usage[0]).toMatchObject({ feature: "ai_bot", model: "gpt-6-luna", promptTokens: 2000, completionTokens: 40, metadata: expect.objectContaining({ reasoningTokens: 30, transport: "responses", conversationId: "conv-1" }) });
    // The next tool call goes straight there: no chat attempt.
    await generateResponse({ tenantId: "T", messages: [{ role: "user", content: "again" }], tools: TOOLS, reasoningEffort: "low", metadata: { type: "ai_bot" } });
    expect(H.chatCalls).toHaveLength(1);
    expect(H.respCalls).toHaveLength(2);
  });

  it("a call without tools stays on chat completions", async () => {
    const r = await generateResponse({ tenantId: "T", messages: [{ role: "user", content: "hi" }], reasoningEffort: "low", metadata: { type: "summary" } });
    expect(r.content).toBe("chat answer");
    expect(H.respCalls).toHaveLength(0);
    await new Promise((res) => setTimeout(res, 0));
    expect(H.usage[0].metadata.transport).toBe("chat");
  });
});
