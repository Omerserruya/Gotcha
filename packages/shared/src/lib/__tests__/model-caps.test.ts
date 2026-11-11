/**
 * The model-capability layer (2026-11-11): the request shape per model, and
 * the one adaptation retry on a 400 for an unsupported tunable param.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { shapeChatRequest, withModelAdaptation, unsupportedParam, resetModelCaps, isLegacyModel, classifyRefusal } from "../model-caps";

/** An OpenAI SDK BadRequestError, as it arrives. */
const unsupported = (param: string, kind: "parameter" | "value" = "parameter") =>
  Object.assign(new Error(`400 Unsupported ${kind}: '${param}' is not supported with this model.`), {
    status: 400, code: `unsupported_${kind}`, param,
  });

beforeEach(() => { resetModelCaps(); vi.restoreAllMocks(); });

describe("the request shape", () => {
  it("a legacy model: max_tokens and temperature, no reasoning effort", () => {
    const r = shapeChatRequest({ model: "gpt-4o-mini" }, "gpt-4o-mini", { temperature: 0.2, maxTokens: 320 });
    expect(r).toEqual({ model: "gpt-4o-mini", max_tokens: 320, temperature: 0.2 });
    expect(isLegacyModel("gpt-3.5-turbo")).toBe(true);
  });

  it("a model never heard of: the modern shape, never max_tokens, never temperature", () => {
    const r = shapeChatRequest({ model: "gpt-6-luna" }, "gpt-6-luna", { temperature: 0.2, maxTokens: 320, reasoningHeadroom: 2048 });
    expect(r).toEqual({ model: "gpt-6-luna", max_completion_tokens: 2368, reasoning_effort: "low" });
    expect("max_tokens" in r).toBe(false);
    expect("temperature" in r).toBe(false);
  });

  it("gpt-5 keeps today's shape; effort 'none' omits it; a stale param on the request is cleared", () => {
    const r = shapeChatRequest({ model: "gpt-5-mini", max_tokens: 9, temperature: 1 }, "gpt-5-mini", { maxTokens: 100, reasoningHeadroom: 0, reasoningEffort: "minimal" });
    expect(r).toEqual({ model: "gpt-5-mini", max_completion_tokens: 100, reasoning_effort: "minimal" });
    expect(shapeChatRequest({}, "gpt-5-mini", { defaultEffort: "none" })).toEqual({ max_completion_tokens: 3072 });
  });
});

describe("which errors are a refused param", () => {
  it("only a 400 naming a tunable param", () => {
    expect(unsupportedParam(unsupported("reasoning_effort"))).toBe("reasoning_effort");
    expect(unsupportedParam(unsupported("temperature", "value"))).toBe("temperature");
    // The message alone, as some gateways pass it on.
    expect(unsupportedParam({ status: 400, message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." })).toBe("max_tokens");
    expect(unsupportedParam(unsupported("response_format"))).toBeNull();
    expect(unsupportedParam(unsupported("messages"))).toBeNull();
    expect(unsupportedParam({ status: 400, message: "Invalid value for 'messages[0].content'" })).toBeNull();
    expect(unsupportedParam({ ...unsupported("temperature"), status: 500 })).toBeNull();
  });
});

describe("the adaptation", () => {
  it("a refused param: dropped, retried exactly once, and remembered for the next call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: any[] = [];
    const send = vi.fn(async (req: any) => {
      sent.push({ ...req });
      if ("reasoning_effort" in req) throw unsupported("reasoning_effort");
      return "ok";
    });
    const req = shapeChatRequest({ model: "gpt-6-luna" }, "gpt-6-luna", { maxTokens: 100, reasoningHeadroom: 0 });
    expect(await withModelAdaptation("gpt-6-luna", req, send)).toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
    expect("reasoning_effort" in sent[1]).toBe(false);
    // The next request is shaped without it: one call, no 400.
    const next = shapeChatRequest({ model: "gpt-6-luna" }, "gpt-6-luna", { maxTokens: 100, reasoningHeadroom: 0 });
    expect(next).toEqual({ model: "gpt-6-luna", max_completion_tokens: 100 });
    expect(await withModelAdaptation("gpt-6-luna", next, send)).toBe("ok");
    expect(send).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("[model-caps] gpt-6-luna: reasoning_effort unsupported, adapted"))).toHaveLength(1);
  });

  it("a refused token cap is renamed, not dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async (req: any) => { if ("max_tokens" in req) throw unsupported("max_tokens"); return req; });
    const out: any = await withModelAdaptation("gpt-4o-mini", shapeChatRequest({}, "gpt-4o-mini", { maxTokens: 50 }), send);
    expect(out.max_completion_tokens).toBe(50);
    expect(shapeChatRequest({}, "gpt-4o-mini", { maxTokens: 50 })).toMatchObject({ max_completion_tokens: 50 });
  });

  it("bounded: at most two adapted retries per call, then the refusal is thrown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn(async (req: any) => {
      if ("reasoning_effort" in req) throw unsupported("reasoning_effort");
      if ("top_p" in req) throw unsupported("top_p");
      throw unsupported("max_completion_tokens");
    });
    await expect(withModelAdaptation("m-x", { ...shapeChatRequest({}, "m-x", {}), top_p: 1 }, send)).rejects.toMatchObject({ param: "max_completion_tokens" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("any other 400 is never retried", async () => {
    const bad = Object.assign(new Error("400 Invalid schema for function 'x'"), { status: 400, code: "invalid_function_parameters", param: "tools[0]" });
    const send = vi.fn(async () => { throw bad; });
    await expect(withModelAdaptation("gpt-6-luna", shapeChatRequest({}, "gpt-6-luna", {}), send)).rejects.toBe(bad);
    expect(send).toHaveBeenCalledTimes(1);
    const fmt = vi.fn(async () => { throw unsupported("response_format"); });
    await expect(withModelAdaptation("gpt-6-luna", { response_format: { type: "json_object" } }, fmt)).rejects.toMatchObject({ param: "response_format" });
    expect(fmt).toHaveBeenCalledTimes(1);
  });

  it("a refused param the request does not carry is not 'adapted' (thrown, no loop)", async () => {
    const send = vi.fn(async () => { throw unsupported("top_p"); });
    await expect(withModelAdaptation("gpt-6-luna", { max_completion_tokens: 10 }, send)).rejects.toMatchObject({ param: "top_p" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

/** gpt-6-luna's refusals, verbatim from the probe of 2026-11-11. */
const lunaMinimal = () => Object.assign(new Error("400 Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."), { status: 400, code: "unsupported_value", param: "reasoning_effort" });
const lunaTools = () => Object.assign(new Error("400 Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."), { status: 400, code: null, param: "reasoning_effort" });
const TOOLS = [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }];
/** A stand-in for gpt-6-luna as probed: no 'minimal'; with tools only 'none' (or the call fails). */
const luna = vi.fn(async (req: any) => {
  if (req.reasoning_effort === "minimal") throw lunaMinimal();
  if (req.tools?.length && req.reasoning_effort !== "none") throw lunaTools();
  return { sent: { ...req } };
});

describe("gpt-6-luna's reasoning-effort rules", () => {
  beforeEach(() => { luna.mockClear(); vi.spyOn(console, "warn").mockImplementation(() => {}); });

  it("an unsupported effort VALUE moves up to the next supported level, never dropped, and is remembered", async () => {
    const out: any = await withModelAdaptation("gpt-6-luna", shapeChatRequest({}, "gpt-6-luna", { reasoningEffort: "minimal" }), luna);
    expect(out.sent.reasoning_effort).toBe("low");
    expect(luna).toHaveBeenCalledTimes(2);
    const next: any = await withModelAdaptation("gpt-6-luna", shapeChatRequest({}, "gpt-6-luna", { reasoningEffort: "minimal" }), luna);
    expect(next.sent.reasoning_effort).toBe("low");
    expect(luna).toHaveBeenCalledTimes(3);
  });

  it("tools plus an effort: retried with 'none', remembered for tool calls ONLY", async () => {
    const withTools = () => ({ ...shapeChatRequest({}, "gpt-6-luna", { reasoningEffort: "low" }), tools: TOOLS });
    const out: any = await withModelAdaptation("gpt-6-luna", withTools(), luna);
    expect(out.sent.reasoning_effort).toBe("none");
    expect(luna).toHaveBeenCalledTimes(2);
    // The next tool call is sent with "none" at once.
    const again: any = await withModelAdaptation("gpt-6-luna", withTools(), luna);
    expect(again.sent.reasoning_effort).toBe("none");
    expect(luna).toHaveBeenCalledTimes(3);
    // A call without tools keeps its effort.
    const plain: any = await withModelAdaptation("gpt-6-luna", shapeChatRequest({}, "gpt-6-luna", { reasoningEffort: "low" }), luna);
    expect(plain.sent.reasoning_effort).toBe("low");
  });

  it("the first call that hits both (minimal AND tools) still answers: two different facts, two retries", async () => {
    const out: any = await withModelAdaptation("gpt-6-luna", { ...shapeChatRequest({}, "gpt-6-luna", { reasoningEffort: "minimal" }), tools: TOOLS }, luna);
    expect(out.sent.reasoning_effort).toBe("none");
    expect(luna).toHaveBeenCalledTimes(3);
  });

  it("the refusals are told apart; the tools one only counts when the request carries tools", () => {
    expect(classifyRefusal(lunaMinimal(), { reasoning_effort: "minimal" })).toEqual({ kind: "effort_value", refused: "minimal", supported: ["none", "low", "medium", "high", "xhigh"] });
    expect(classifyRefusal(lunaTools(), { tools: TOOLS, reasoning_effort: "low" })).toEqual({ kind: "tools_effort", effort: "none" });
    expect(classifyRefusal(lunaTools(), { reasoning_effort: "low" })).toBeNull();
  });
});

describe("the /v1/responses route for tool calls with reasoning (Omer, 2026-11-11)", () => {
  beforeEach(() => { luna.mockClear(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  const viaResponses = vi.fn(async (req: any): Promise<any> => ({ via: "responses", effort: req.reasoning_effort }));
  const toolCall = (effort = "low") => ({ ...shapeChatRequest({}, "gpt-6-luna", { reasoningEffort: effort }), tools: TOOLS });

  it("the tools refusal, with a responses sender and a real effort: learned, and that call goes to /responses with its effort", async () => {
    viaResponses.mockClear();
    const out: any = await withModelAdaptation("gpt-6-luna", toolCall("low"), luna, { responses: viaResponses });
    expect(out).toEqual({ via: "responses", effort: "low" });
    expect(luna).toHaveBeenCalledTimes(1);
    expect(viaResponses).toHaveBeenCalledTimes(1);
  });

  it("later tool calls go straight to /responses; a call without tools, or with effort none, stays on chat completions", async () => {
    viaResponses.mockClear();
    await withModelAdaptation("gpt-6-luna", toolCall("low"), luna, { responses: viaResponses });
    luna.mockClear(); viaResponses.mockClear();
    expect(await withModelAdaptation("gpt-6-luna", toolCall("medium"), luna, { responses: viaResponses })).toEqual({ via: "responses", effort: "medium" });
    expect(luna).not.toHaveBeenCalled();
    const plain: any = await withModelAdaptation("gpt-6-luna", shapeChatRequest({}, "gpt-6-luna", { reasoningEffort: "low" }), luna, { responses: viaResponses });
    expect(plain.sent.reasoning_effort).toBe("low");
    const none: any = await withModelAdaptation("gpt-6-luna", toolCall("none"), luna, { responses: viaResponses });
    expect(none.sent.reasoning_effort).toBe("none");
    expect(viaResponses).toHaveBeenCalledTimes(1);
  });

  it("a caller without a responses sender keeps the 'none' fallback, even after another caller learned the route", async () => {
    await withModelAdaptation("gpt-6-luna", toolCall("low"), luna, { responses: viaResponses });
    luna.mockClear();
    const out: any = await withModelAdaptation("gpt-6-luna", toolCall("low"), luna);
    expect(out.sent.reasoning_effort).toBe("none");
  });

  it("a 400 from /responses surfaces as it is: no retry, no fallback to chat", async () => {
    const bad = Object.assign(new Error("400 Invalid input"), { status: 400, code: "invalid_request_error", param: "input" });
    const failing = vi.fn(async (): Promise<any> => { throw bad; });
    await expect(withModelAdaptation("gpt-6-luna", toolCall("low"), luna, { responses: failing })).rejects.toBe(bad);
    expect(failing).toHaveBeenCalledTimes(1);
    luna.mockClear(); failing.mockClear();
    // Once learned, a failing /responses is not retried on chat either.
    await expect(withModelAdaptation("gpt-6-luna", toolCall("low"), luna, { responses: failing })).rejects.toBe(bad);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(luna).not.toHaveBeenCalled();
  });
});
