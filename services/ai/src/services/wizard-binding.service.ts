/**
 * Wizard → Runtime binding: the single STRUCTURED EVALUATION STEP.
 *
 * Converts an agent's free-text Wizard configuration (goal, ideal-customer
 * profile, qualification signals, disqualifiers) + the live conversation into a
 * small, typed `WizardRuntimeFacts` verdict via ONE LLM judgment call.
 *
 * There is NO regex / keyword / fuzzy / heuristic matching of config against the
 * conversation anywhere - interpreting free text is exactly what the model does.
 * The objective engine, readiness logic, recovery, and prioritization then
 * consume ONLY the structured facts this returns; they never see the raw config.
 *
 * Cost: skipped entirely (no LLM call) when the agent has no bindable config.
 * Fail-safe: any error / malformed output → EMPTY_WIZARD_FACTS (evaluated:false),
 * so every consumer behaves exactly as it did before the binding existed.
 *
 * `normalize()` is structural VALIDATION only (whitelist the model's output to
 * configured/allowed values) - it never interprets the conversation itself.
 */

import { generateResponse, getMicroModel } from "./ai.service";
import { roleToSkill } from "./skills";
import {
  OBJECTIVE_CHAINS,
  EMPTY_WIZARD_FACTS,
  type WizardRuntimeFacts,
  type ObjectiveName,
} from "./objectives";

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((s) => s.trim()) : [];

export async function evaluateWizardBinding(opts: {
  tenantId: string;
  conversationId: string;
  role: string | null | undefined;
  goal?: string | null;
  salesContext?: unknown;
  transcript: string;
  signal?: AbortSignal;
}): Promise<WizardRuntimeFacts> {
  const sc = opts.salesContext && typeof opts.salesContext === "object" ? (opts.salesContext as Record<string, unknown>) : {};
  const disqualifiers = asStringArray(sc.disqualifiers);
  const signals = asStringArray(sc.qualificationSignals);
  const icp = typeof sc.idealCustomerProfile === "string" ? sc.idealCustomerProfile.trim() : "";
  const goal = typeof opts.goal === "string" ? opts.goal.trim() : "";

  // Nothing configured to bind → skip the call (no cost), facts stay absent.
  if (!disqualifiers.length && !signals.length && !icp && !goal) return EMPTY_WIZARD_FACTS;
  if (!opts.transcript?.trim()) return EMPTY_WIZARD_FACTS;

  const chain = OBJECTIVE_CHAINS[roleToSkill(opts.role)] ?? [];

  const system = [
    "You convert an AI sales/support employee's CONFIGURATION plus the live conversation into a small JSON verdict.",
    "Judge ONLY from explicit evidence in the conversation. When uncertain, choose the neutral / false / null option - NEVER guess a disqualification or a fit you cannot see.",
    "Respond with ONLY a JSON object (no prose, no code fences) with EXACTLY these keys:",
    '- "fit": one of "qualified" | "disqualified" | "neutral". "disqualified" ONLY when the customer clearly matches a configured disqualifier; "qualified" when they clearly match the ideal customer or a qualification signal; otherwise "neutral".',
    '- "disqualifierMatched": the EXACT configured disqualifier string the customer matched, or null.',
    '- "qualificationMet": boolean - true when enough configured qualification signals are evidenced to justify proposing a demo/meeting; false when not yet established.',
    '- "signalsMet": array of the configured qualification-signal strings (verbatim) that are evidenced; [] if none.',
    `- "goalObjective": which objective the CONFIGURED GOAL targets as its endpoint - one of [${chain.map((c) => `"${c}"`).join(", ")}] - or null if the goal does not clearly map to one.`,
  ].join("\n");

  const user = [
    goal ? `CONFIGURED GOAL: ${goal}` : "CONFIGURED GOAL: (none)",
    icp ? `IDEAL CUSTOMER PROFILE: ${icp}` : "IDEAL CUSTOMER PROFILE: (none)",
    signals.length ? `QUALIFICATION SIGNALS:\n${signals.map((s) => `- ${s}`).join("\n")}` : "QUALIFICATION SIGNALS: (none)",
    disqualifiers.length ? `DISQUALIFIERS:\n${disqualifiers.map((d) => `- ${d}`).join("\n")}` : "DISQUALIFIERS: (none)",
    "",
    "CONVERSATION (resolved facts + recent transcript):",
    opts.transcript.slice(0, 4000),
    "",
    "Return the JSON verdict now.",
  ].join("\n");

  try {
    const resp = await generateResponse({
      tenantId: opts.tenantId,
      model: getMicroModel(),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      maxTokens: 300,
      responseFormat: { type: "json_object" },
      metadata: { type: "wizard_binding", conversationId: opts.conversationId },
      signal: opts.signal,
    });
    const raw = JSON.parse(resp.content ?? "{}");
    return normalize(raw, { signals, disqualifiers, chain });
  } catch (err: any) {
    console.warn("[wizard-binding] eval failed (non-fatal, facts absent):", err?.message);
    return EMPTY_WIZARD_FACTS;
  }
}

function normalize(
  raw: any,
  ctx: { signals: string[]; disqualifiers: string[]; chain: ObjectiveName[] },
): WizardRuntimeFacts {
  const rawFit = raw?.fit;
  let fit: WizardRuntimeFacts["fit"] = rawFit === "disqualified" || rawFit === "qualified" ? rawFit : "neutral";
  // Whitelist: a matched disqualifier must be one we actually configured.
  let disqualifierMatched: string | null = ctx.disqualifiers.includes(raw?.disqualifierMatched)
    ? raw.disqualifierMatched
    : null;
  // Consistency: "disqualified" is only valid with a real matched disqualifier.
  if (fit === "disqualified" && !disqualifierMatched) fit = "neutral";
  if (fit !== "disqualified") disqualifierMatched = null;

  const signalsMet = Array.isArray(raw?.signalsMet)
    ? raw.signalsMet.filter((s: unknown) => typeof s === "string" && ctx.signals.includes(s))
    : [];
  // Only gate readiness when qualification signals are actually configured.
  const qualificationMet = ctx.signals.length ? raw?.qualificationMet === true : true;
  const goalObjective: ObjectiveName | null = ctx.chain.includes(raw?.goalObjective) ? raw.goalObjective : null;

  return { evaluated: true, fit, disqualifierMatched, qualificationMet, signalsMet, goalObjective };
}
