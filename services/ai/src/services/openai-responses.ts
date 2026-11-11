/**
 * /v1/responses at the boundary (Omer, 2026-11-11): gpt-6-luna takes function
 * tools AND a reasoning effort only through the Responses API, so a tool call
 * that asks for real reasoning is sent there (the capability layer decides
 * when; see packages/shared lib/model-caps usesResponses).
 *
 * Callers never see it. A chat-completions request goes in, and a
 * chat-completion-shaped result (or stream of chunks) comes out, so
 * generateResponse, streamResponse, metering and usage_logs read exactly what
 * they read from chat completions:
 *   messages     -> input items (assistant tool_calls -> function_call,
 *                   tool results -> function_call_output, image parts -> input_image)
 *   tools        -> the flat function format
 *   tool_choice  -> the flat shape
 *   response_format -> text.format
 *   max_completion_tokens / max_tokens -> max_output_tokens
 *   reasoning_effort -> reasoning.effort
 *   user         -> prompt_cache_key (the prefix-cache routing key)
 *   output + usage -> choices[0].message (content, tool_calls) and usage
 *                   (prompt/completion/total, cached and reasoning tokens)
 * Nothing is stored at OpenAI (store: false).
 */

type ChatMessage = { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string; name?: string };

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  return content == null ? "" : String(content);
}

/** A chat message's content as Responses input content (text and images). */
function inputContent(content: any): any {
  if (!Array.isArray(content)) return textOf(content);
  return content.map((p) => {
    if (p?.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      return { type: "input_image", image_url: url, ...(p.image_url?.detail ? { detail: p.image_url.detail } : {}) };
    }
    return { type: "input_text", text: typeof p === "string" ? p : p?.text ?? "" };
  });
}

export function toResponsesInput(messages: ChatMessage[]): any[] {
  const input: any[] = [];
  for (const m of messages ?? []) {
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: textOf(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      const text = textOf(m.content);
      if (text) input.push({ role: "assistant", content: text });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" });
      }
      continue;
    }
    // system / developer / user
    input.push({ role: m.role, content: m.role === "user" ? inputContent(m.content) : textOf(m.content) });
  }
  return input;
}

export function toResponsesTools(tools: any[] | undefined): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => (t?.type === "function" && t.function
    ? { type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters ?? { type: "object", properties: {} }, ...(t.function.strict != null ? { strict: t.function.strict } : {}) }
    : t));
}

function toResponsesToolChoice(choice: any): any {
  if (!choice || typeof choice === "string") return choice;
  if (choice.type === "function" && choice.function?.name) return { type: "function", name: choice.function.name };
  return choice;
}

function toTextFormat(rf: any): any {
  if (!rf) return undefined;
  if (rf.type === "json_schema" && rf.json_schema) {
    return { format: { type: "json_schema", name: rf.json_schema.name, schema: rf.json_schema.schema, ...(rf.json_schema.strict != null ? { strict: rf.json_schema.strict } : {}) } };
  }
  return { format: { type: rf.type } };
}

/** A chat-completions request (as the capability layer shaped it) as a Responses request. */
export function toResponsesRequest(req: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {
    model: req.model,
    input: toResponsesInput(req.messages),
    store: false,
  };
  const tools = toResponsesTools(req.tools);
  if (tools) out.tools = tools;
  if (req.tool_choice) out.tool_choice = toResponsesToolChoice(req.tool_choice);
  const cap = req.max_completion_tokens ?? req.max_tokens;
  if (cap != null) out.max_output_tokens = cap;
  if (req.reasoning_effort) out.reasoning = { effort: req.reasoning_effort };
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  const text = toTextFormat(req.response_format);
  if (text) out.text = text;
  if (req.user) out.prompt_cache_key = req.user;
  return out;
}

/** Responses usage as chat-completions usage (the fields metering and usage_logs read). */
export function toChatUsage(u: any): any {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 },
  };
}

/** A Responses result as a chat completion: the message, its tool calls, the usage. */
export function fromResponsesResponse(resp: any): any {
  const output: any[] = resp?.output ?? [];
  const content = output
    .filter((o) => o?.type === "message")
    .flatMap((m) => m.content ?? [])
    .filter((c) => c?.type === "output_text")
    .map((c) => c.text ?? "")
    .join("");
  const toolCalls = output
    .filter((o) => o?.type === "function_call")
    .map((o) => ({ id: o.call_id, type: "function", function: { name: o.name, arguments: o.arguments ?? "{}" } }));
  const truncated = resp?.status === "incomplete" && resp?.incomplete_details?.reason === "max_output_tokens";
  return {
    id: resp?.id,
    model: resp?.model,
    object: "chat.completion",
    transport: "responses",
    choices: [{
      index: 0,
      message: { role: "assistant", content: content || (toolCalls.length ? null : ""), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? "tool_calls" : truncated ? "length" : "stop",
    }],
    usage: toChatUsage(resp?.usage),
  };
}

/**
 * A Responses event stream as chat-completion chunks: text deltas as
 * delta.content, each function call as delta.tool_calls (id and name when the
 * item opens, arguments as they stream, one index per call), and the final
 * usage on the completed event.
 */
export async function* chatChunksFromResponsesStream(stream: AsyncIterable<any>): AsyncGenerator<any, void, void> {
  const indexOf = new Map<string, number>();
  for await (const ev of stream) {
    switch (ev?.type) {
      case "response.output_text.delta":
        if (ev.delta) yield { choices: [{ index: 0, delta: { content: ev.delta } }] };
        break;
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          const index = indexOf.size;
          indexOf.set(ev.item.id, index);
          yield { choices: [{ index: 0, delta: { tool_calls: [{ index, id: ev.item.call_id, type: "function", function: { name: ev.item.name, arguments: "" } }] } }] };
        }
        break;
      case "response.function_call_arguments.delta": {
        const index = indexOf.get(ev.item_id);
        if (index != null && ev.delta) yield { choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: ev.delta } }] } }] };
        break;
      }
      case "response.completed":
      case "response.incomplete":
        yield { choices: [], usage: toChatUsage(ev.response?.usage) };
        break;
      case "response.failed":
      case "error": {
        const e = ev.response?.error ?? ev.error ?? ev;
        throw Object.assign(new Error(e?.message ?? "Responses stream failed"), { code: e?.code, status: 400 });
      }
      default:
        break;
    }
  }
}
