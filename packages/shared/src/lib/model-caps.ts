/**
 * What a chat model accepts, decided in ONE place (Omer, 2026-11-11: model
 * swaps must be fast and safe).
 *
 * Every chat-completions request in the platform gets its token cap,
 * temperature and reasoning effort through shapeChatRequest(), and is sent
 * through withModelAdaptation(). There is no regex on model names anywhere
 * else.
 *
 * The shape:
 *   - a model known to be legacy (gpt-4*, gpt-3.5*): max_tokens + temperature;
 *   - every other model, including one this code has never heard of: the
 *     modern shape, max_completion_tokens and no temperature, plus
 *     reasoning_effort (with reasoning headroom on the token cap).
 * A new model name therefore never sends max_tokens: gpt-6-luna 400s on it,
 * and the old regex (/^(gpt-5|o[1-9])/) would have sent it on every call.
 *
 * The adaptation: when a model answers 400 "Unsupported parameter" or
 * "Unsupported value" for ONE of the tunable params below, that param is
 * dropped (or the token cap renamed), the call is retried ONCE, and the
 * finding is kept for the process, so every later call to that model is
 * shaped right from the start. Logged once per model and param:
 * "[model-caps] <model>: <param> unsupported, adapted". Any other 400 (a bad
 * message, a tool schema, response_format) is never retried here.
 */

/** The params this layer may drop or rename. Never the messages, tools or response_format. */
export const TUNABLE_PARAMS = ["max_tokens", "max_completion_tokens", "temperature", "top_p", "reasoning_effort", "presence_penalty", "frequency_penalty"] as const;
export type TunableParam = (typeof TUNABLE_PARAMS)[number];

const LEGACY = /^(gpt-4|gpt-3\.5)/i;

/** What this process has learned a model refuses. */
const learned = new Map<string, { tokenParam?: "max_tokens" | "max_completion_tokens"; dropped: Set<TunableParam> }>();
const logged = new Set<string>();

/** Test seam. */
export function resetModelCaps(): void { learned.clear(); logged.clear(); }

export interface ShapeOptions {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  /** Extra room on the cap for hidden reasoning (modern shape only). */
  reasoningHeadroom?: number;
  /** The default effort when the caller names none ("none" omits it). */
  defaultEffort?: string;
}

export function isLegacyModel(model: string): boolean {
  return LEGACY.test(model);
}

/**
 * Put the token cap, temperature and reasoning effort on a chat-completions
 * request in the shape this model accepts. Mutates and returns `req`.
 */
export function shapeChatRequest<T extends Record<string, any>>(req: T, model: string, o: ShapeOptions = {}): T {
  const r = req as Record<string, any>;
  for (const p of TUNABLE_PARAMS) delete r[p];
  const tokens = o.maxTokens ?? 1024;
  const known = learned.get(model);
  if (isLegacyModel(model)) {
    r[known?.tokenParam ?? "max_tokens"] = tokens;
    r.temperature = o.temperature ?? 0.7;
  } else {
    // Hidden reasoning shares max_completion_tokens with the visible reply, so
    // the cap gets headroom: capping at the reply size alone came back '' with
    // finish_reason=length on gpt-5. A ceiling only; generated tokens are billed.
    r[known?.tokenParam ?? "max_completion_tokens"] = tokens + (o.reasoningHeadroom ?? 2048);
    const effort = o.reasoningEffort || o.defaultEffort || "low";
    if (effort !== "none") r.reasoning_effort = effort;
  }
  for (const p of known?.dropped ?? []) delete r[p];
  return req;
}

/** The tunable param an error names as unsupported, or null for any other error. */
export function unsupportedParam(err: any): TunableParam | null {
  const status = err?.status ?? err?.response?.status;
  if (status !== 400) return null;
  const code = String(err?.code ?? err?.error?.code ?? "");
  const message = String(err?.message ?? err?.error?.message ?? "");
  if (!/unsupported_(parameter|value)/i.test(code) && !/unsupported (parameter|value)/i.test(message)) return null;
  const named = String(err?.param ?? err?.error?.param ?? "") || (/'([a-z_]+)'/i.exec(message)?.[1] ?? "");
  return (TUNABLE_PARAMS as readonly string[]).includes(named) ? (named as TunableParam) : null;
}

/** Record what the model refused and fix `req` for the retry. False when nothing could be adapted. */
function adapt(model: string, param: TunableParam, req: Record<string, any>): boolean {
  if (!(param in req)) return false;
  const entry = learned.get(model) ?? { dropped: new Set<TunableParam>() };
  if (param === "max_tokens" || param === "max_completion_tokens") {
    const other = param === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    if (entry.tokenParam === other) return false; // both refused: not ours to fix
    req[other] = req[param];
    delete req[param];
    entry.tokenParam = other;
  } else {
    delete req[param];
    entry.dropped.add(param);
  }
  learned.set(model, entry);
  const key = `${model}:${param}`;
  if (!logged.has(key)) { logged.add(key); console.warn(`[model-caps] ${model}: ${param} unsupported, adapted`); }
  return true;
}

/**
 * Send a chat request; on a 400 for an unsupported tunable param, adapt and
 * retry exactly once. `send` receives the (possibly adapted) request.
 */
export async function withModelAdaptation<T>(model: string, req: Record<string, any>, send: (req: Record<string, any>) => Promise<T>): Promise<T> {
  try {
    return await send(req);
  } catch (err) {
    const param = unsupportedParam(err);
    if (!param || !adapt(model, param, req)) throw err;
    return send(req);
  }
}
