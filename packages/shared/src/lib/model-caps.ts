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
 * The adaptation: a 400 that refuses ONE of the tunable params below is
 * learned for the model, for the rest of the process, and the call retried:
 *   - an unsupported reasoning_effort VALUE moves to the next supported level
 *     up, read from the error ("minimal" -> "low" on gpt-6-luna). Never
 *     dropped: without it the model uses its own default effort;
 *   - "Function tools with reasoning_effort are not supported" (gpt-6-luna on
 *     /v1/chat/completions) sets reasoning_effort "none" for this model's
 *     calls that carry tools, and only those;
 *   - any other refused tunable param is dropped, or the token cap renamed.
 * Learned facts are applied right before every send (when the request already
 * carries its tools), so a later call is shaped right from the start. At most
 * MAX_ADAPTATIONS retries per call, each for a different fact, so a model
 * that refuses two things still answers its first call. Logged once per model
 * and fact: "[model-caps] <model>: <what> unsupported, adapted". Any other
 * 400 (a bad message, a tool schema, response_format) is never retried here.
 */

/** The params this layer may drop or rename. Never the messages, tools or response_format. */
export const TUNABLE_PARAMS = ["max_tokens", "max_completion_tokens", "temperature", "top_p", "reasoning_effort", "presence_penalty", "frequency_penalty"] as const;
export type TunableParam = (typeof TUNABLE_PARAMS)[number];

const LEGACY = /^(gpt-4|gpt-3\.5)/i;

/** The reasoning levels, lowest first: an unsupported one moves up to the next supported one. */
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

/** At most this many adapted retries per call, each for a different fact. */
export const MAX_ADAPTATIONS = 2;

interface Learned {
  tokenParam?: "max_tokens" | "max_completion_tokens";
  dropped: Set<TunableParam>;
  /** Effort the model refuses -> the effort sent instead. */
  effortMap: Map<string, string>;
  /** The effort this model needs on a call that carries tools ("none" on gpt-6-luna). */
  toolsEffort?: string;
}
/** What this process has learned a model refuses. */
const learned = new Map<string, Learned>();
const entryFor = (model: string): Learned => {
  let e = learned.get(model);
  if (!e) { e = { dropped: new Set<TunableParam>(), effortMap: new Map() }; learned.set(model, e); }
  return e;
};
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
  applyLearned(model, r);
  return req;
}

/** Everything learned about this model, applied to a request about to be sent. */
export function applyLearned(model: string, req: Record<string, any>): void {
  const known = learned.get(model);
  if (!known) return;
  if (known.tokenParam) {
    const other = known.tokenParam === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    if (other in req && !(known.tokenParam in req)) { req[known.tokenParam] = req[other]; delete req[other]; }
  }
  if (typeof req.reasoning_effort === "string" && known.effortMap.has(req.reasoning_effort)) req.reasoning_effort = known.effortMap.get(req.reasoning_effort);
  if (known.toolsEffort && Array.isArray(req.tools) && req.tools.length) req.reasoning_effort = known.toolsEffort;
  for (const p of known.dropped) delete req[p];
}

/** What a refusal teaches, or null when it is not a refusal this layer handles. */
export type Refusal =
  | { kind: "param"; param: TunableParam }
  | { kind: "effort_value"; refused: string; supported: string[] }
  | { kind: "tools_effort"; effort: string };

export function classifyRefusal(err: any, req: Record<string, any> = {}): Refusal | null {
  const status = err?.status ?? err?.response?.status;
  if (status !== 400) return null;
  const message = String(err?.message ?? err?.error?.message ?? "");
  const named = String(err?.param ?? err?.error?.param ?? "");
  // gpt-6-luna: tools and a reasoning effort cannot go together on chat completions.
  if (/function tools with reasoning_effort/i.test(message) && Array.isArray(req.tools) && req.tools.length) {
    return { kind: "tools_effort", effort: /'none'/.test(message) ? "none" : "none" };
  }
  const param = unsupportedParam(err);
  if (param === "reasoning_effort" && /unsupported_value|unsupported value/i.test(String(err?.code ?? "") + " " + message)) {
    const list = /supported values are:([^.]*)/i.exec(message)?.[1] ?? "";
    const supported = [...list.matchAll(/'([a-z]+)'/gi)].map((m) => m[1]!.toLowerCase());
    if (supported.length && typeof req.reasoning_effort === "string") return { kind: "effort_value", refused: req.reasoning_effort, supported };
  }
  return param ? { kind: "param", param } : null;
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

function note(model: string, what: string): void {
  const key = `${model}:${what}`;
  if (!logged.has(key)) { logged.add(key); console.warn(`[model-caps] ${model}: ${what} unsupported, adapted`); }
}

/** Learn what the model refused and fix `req` for the retry. False when nothing could be adapted. */
function adapt(model: string, refusal: Refusal, req: Record<string, any>): boolean {
  const entry = entryFor(model);
  if (refusal.kind === "tools_effort") {
    if (entry.toolsEffort === refusal.effort && req.reasoning_effort === refusal.effort) return false;
    entry.toolsEffort = refusal.effort;
    req.reasoning_effort = refusal.effort;
    note(model, `reasoning_effort with tools (now "${refusal.effort}" on tool calls)`);
    return true;
  }
  if (refusal.kind === "effort_value") {
    const from = EFFORT_LEVELS.indexOf(refusal.refused as any);
    const up = EFFORT_LEVELS.slice(from < 0 ? 0 : from + 1).find((l) => refusal.supported.includes(l))
      ?? refusal.supported.find((l) => l !== "none") ?? refusal.supported[0];
    if (!up || up === refusal.refused) return false;
    entry.effortMap.set(refusal.refused, up);
    req.reasoning_effort = up;
    note(model, `reasoning_effort "${refusal.refused}" (now "${up}")`);
    return true;
  }
  const param = refusal.param;
  if (!(param in req)) return false;
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
  note(model, param);
  return true;
}

/**
 * Send a chat request shaped by everything learned about this model; on a 400
 * this layer understands, adapt and retry, at most MAX_ADAPTATIONS times, each
 * for a different fact. `send` receives the (possibly adapted) request.
 */
export async function withModelAdaptation<T>(model: string, req: Record<string, any>, send: (req: Record<string, any>) => Promise<T>): Promise<T> {
  applyLearned(model, req);
  const seen = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(req);
    } catch (err) {
      const refusal = attempt < MAX_ADAPTATIONS ? classifyRefusal(err, req) : null;
      const fact = refusal ? JSON.stringify(refusal) : "";
      if (!refusal || seen.has(fact) || !adapt(model, refusal, req)) throw err;
      seen.add(fact);
    }
  }
}
