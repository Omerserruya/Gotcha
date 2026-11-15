/**
 * Omer 2026-11-15: every OpenAI chat request sends its instructions as role
 * "developer", never "system", with no per-model branching. One place does it
 * (model-caps withDeveloperRole, inside withModelAdaptation), so chat
 * completions, the stream and /v1/responses all carry it, and no call site
 * changed. Probed live on our key: gpt-5-mini (chat and /responses, with and
 * without tools), gpt-4o-mini and gpt-6-luna all take it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ chat: [] as any[], responses: [] as any[], toolsNeedResponses: false }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async (req: any) => {
      H.chat.push(JSON.parse(JSON.stringify(req)));
      if (req.stream) return (async function* () { yield { choices: [{ delta: { content: "x" } }] }; yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; })();
      return { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    } } };
    responses = { create: async (req: any) => {
      H.responses.push(JSON.parse(JSON.stringify(req)));
      return { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], output_text: "ok", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    } };
    embeddings = { create: async () => ({ data: [] }) };
  },
}));
vi.mock("@chatcenter/shared", async (orig) => ({ ...(await orig() as any), assertAiAllowed: async () => undefined, meterAiUnits: async () => null, trackAIUsage: async () => undefined }));
vi.mock("../services/audit.service", () => ({ logAudit: async () => undefined }));

import { initAIService, generateResponse, streamResponse } from "../services/ai.service";
import { resetModelCaps, withDeveloperRole, withModelAdaptation } from "@chatcenter/shared/src/lib/model-caps";

// Instructions with every byte that could be mangled: Hebrew, newlines, quotes, emoji, a wide range of whitespace.
const INSTRUCTIONS = "  את נועה, נציגת שירות.\n\n# Rules\n- \"quote\" and 'apos'\t tab  two spaces\n🙂 end\n";
const SECOND = "## Turn context\nקונה חוזר.";
const msgs = () => [
  { role: "system", content: INSTRUCTIONS },
  { role: "system", content: SECOND },
  { role: "user", content: "שלום" },
  { role: "assistant", content: "היי" },
  { role: "user", content: "יש במלאי?" },
];
const TOOLS = [{ type: "function", function: { name: "search_products", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } } }];
const roles = (list: any[]) => list.map((m) => m.role);

beforeEach(() => {
  H.chat = []; H.responses = [];
  resetModelCaps();
  initAIService({ apiKey: "sk-test", defaultModel: "gpt-5-mini" });
});

describe("no request leaves with a system role", () => {
  it("chat completions: every system message is a developer message, content byte for byte, order kept", async () => {
    const sent = msgs();
    await generateResponse({ tenantId: "T", messages: sent as any, metadata: { type: "chat" } } as any);
    const wire = H.chat[0].messages;
    expect(roles(wire)).toEqual(["developer", "developer", "user", "assistant", "user"]);
    expect(wire[0].content).toBe(INSTRUCTIONS);
    expect(wire[1].content).toBe(SECOND);
    expect(JSON.stringify(H.chat[0])).not.toContain('"role":"system"');
    // The caller's own array is untouched (the cache-prefix hash and the guards read it).
    expect(roles(sent)).toEqual(["system", "system", "user", "assistant", "user"]);
  });

  it("with tools too", async () => {
    await generateResponse({ tenantId: "T", messages: msgs() as any, tools: TOOLS as any, toolChoice: "auto", sessionId: "conv-1", metadata: { type: "chat" } } as any);
    expect(roles(H.chat[0].messages).filter((r) => r === "system")).toEqual([]);
    expect(H.chat[0].messages[0]).toEqual({ role: "developer", content: INSTRUCTIONS });
  });

  it("the stream", async () => {
    const out = await streamResponse({ tenantId: "T", messages: msgs() as any, metadata: { type: "chat" } } as any);
    if (out && typeof (out as any)[Symbol.asyncIterator] === "function") for await (const _ of out as any) { /* drain */ }
    expect(H.chat.length).toBeGreaterThan(0);
    expect(JSON.stringify(H.chat[0])).not.toContain('"role":"system"');
    expect(H.chat[0].messages[0]).toEqual({ role: "developer", content: INSTRUCTIONS });
  });

  it("/v1/responses: the input carries developer, never system", async () => {
    // A request routed to /responses (a tool call with a real effort on a model that needs it).
    const req: any = { model: "m-resp", messages: msgs(), tools: TOOLS, reasoning_effort: "low" };
    const seen: any[] = [];
    await withModelAdaptation("m-resp", req, async () => { throw Object.assign(new Error("Function tools with reasoning_effort are not supported for gpt-x in /v1/chat/completions. Please use /v1/responses instead."), { status: 400, error: { message: "Function tools with reasoning_effort are not supported for gpt-x in /v1/chat/completions. Please use /v1/responses instead." } }); }, {
      responses: async (r) => { seen.push(JSON.parse(JSON.stringify(r))); return "ok"; },
    }).catch(() => undefined);
    const sentReq = seen[0] ?? req;
    expect(roles(sentReq.messages).includes("system")).toBe(false);
    expect(sentReq.messages[0]).toEqual({ role: "developer", content: INSTRUCTIONS });
  });
});

describe("withDeveloperRole", () => {
  it("copies, never mutates, and leaves every other message and field as it was", () => {
    const original = msgs();
    const tool = { role: "tool", tool_call_id: "t1", content: "{}" };
    const req: any = { model: "x", messages: [...original, tool], temperature: 1 };
    withDeveloperRole(req);
    expect(original[0].role).toBe("system");
    expect(req.messages[2]).toBe(original[2]);
    expect(req.messages[5]).toBe(tool);
    expect(req.temperature).toBe(1);
    expect(req.messages[0]).not.toBe(original[0]);
    expect({ ...req.messages[0], role: "system" }).toEqual(original[0]);
  });
  it("a request with no system message, or no messages (embeddings, /responses input), is not touched", () => {
    const req: any = { model: "x", messages: [{ role: "user", content: "hi" }] };
    const before = req.messages;
    withDeveloperRole(req);
    expect(req.messages).toBe(before);
    const emb: any = { model: "text-embedding-3-small", input: ["a"] };
    expect(withDeveloperRole(emb)).toEqual({ model: "text-embedding-3-small", input: ["a"] });
  });
});
