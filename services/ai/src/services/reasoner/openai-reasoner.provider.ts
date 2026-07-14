/**
 * OpenAI ReasonerProvider - the FIRST implementation of the vendor-neutral
 * `ReasonerProvider` contract. Everything OpenAI-shaped (prompt construction,
 * JSON coaxing, the SDK call) stays INSIDE this file; the boundary emits only a
 * validated `ReasonerOutput` + neutral telemetry.
 *
 * It reasons THROUGH the platform's metered choke point (`generateResponse`), so
 * billing/credits/enforcement apply automatically - a Reasoner call is an AI
 * call and must never bypass the meter.
 *
 * NOTE: the prompt below is a first draft. The Reasoner runs in SHADOW first
 * (Phase 3); its decisions are compared to the Planner's, never shipped, until
 * the divergence log says it's ready. Prompt tuning happens against that log.
 */

import {
  parseReasonerOutput,
  type ReasonerProvider,
  type ReasonerInput,
  type ReasonerProviderResult,
  type ReasonerCallOptions,
} from "@chatcenter/shared";
import { generateResponse, getDefaultModel } from "../ai.service";

/** Compact, deterministic serialization of the Reasoner input for the prompt. */
export function renderInput(input: ReasonerInput): string {
  const f = input.facts;
  const menu = f.availableOperations
    .map((o) => {
      const params = o.params.map((p) => `${p.name}${p.required ? "" : "?"}: ${p.meaning}`).join(", ");
      const pre = (o.businessPreconditions ?? []).length
        ? `\n  requires: ${o.businessPreconditions!.join("; ")}`
        : "";
      return `- ${o.name} - ${o.meaning}${params ? ` [params: ${params}]` : ""}${pre}`;
    })
    .join("\n");

  const transcript = input.context.transcript
    .slice(-12)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");

  // ── Agent Loop context: prior iterations' observations + evolving scratchpad ──
  const wm = input.context.workingMemory;
  const loopBlock = wm
    ? [
        "",
        `## LOOP STATE (iteration ${input.context.iteration ?? "?"})`,
        wm.iterations.length
          ? "Prior iterations:\n" +
            wm.iterations
              .map((it) => `  ${it.iteration}. ${it.decision.type}${it.observation ? ` → ${it.observation}` : ""}`)
              .join("\n")
          : "No prior iterations.",
        wm.establishedFacts.length ? `Established this loop: ${wm.establishedFacts.join("; ")}` : "",
        wm.ruledOut.length ? `Ruled out (do NOT re-propose): ${wm.ruledOut.map((r) => `${r.operation} (${r.why})`).join("; ")}` : "",
        wm.openQuestions.length ? `Open questions: ${wm.openQuestions.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  // Domain world: rendered GENERICALLY - the Reasoner never learns domain names
  // from code. Each capability self-describes; adding one needs no change here.
  const worldBlock = f.world.length
    ? f.world
        .map((w) =>
          [
            `### ${w.capability} - ${w.summary}`,
            "```json",
            JSON.stringify(w.facts, null, 2),
            "```",
            w.observations && w.observations.length ? `notes: ${w.observations.join("; ")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n")
    : "(no capability world-state this turn)";

  // ORDER MATTERS FOR COST, not meaning: OpenAI prompt caching reuses the longest
  // identical PREFIX (≥1024 tokens). STABLE sections (mission/guidance/menu - fixed
  // per agent, unchanged across iterations and turns) therefore come FIRST, and the
  // per-iteration volatile state (facts/world/loop/memory/transcript) LAST. Same
  // content, cheaper prefix. Do not interleave volatile content above the fold.
  return [
    "## MISSION",
    JSON.stringify(input.context.mission),
    input.context.guidance ? `\n## GUIDANCE (advice you MAY override)\n${input.context.guidance}` : "",
    "",
    "## AVAILABLE OPERATIONS (you may ONLY choose EXECUTE from this menu)",
    menu || "(none available this turn)",
    "",
    // Identity + permissions are FIXED for the whole turn (stable head); only
    // money + world state below are per-iteration volatile.
    "## CUSTOMER & PERMISSIONS (authoritative - never contradict these)",
    "```json",
    JSON.stringify({ customer: f.customer, permissions: f.permissions }, null, 2),
    "```",
    "",
    "## MONEY (authoritative - never contradict these)",
    "```json",
    JSON.stringify({ entitlements: f.entitlements, billing: f.billing }, null, 2),
    "```",
    "",
    "## WORLD (per-capability state)",
    worldBlock,
    loopBlock,
    "",
    "## MEMORY (your prior judgments - advisory; FACTS override MEMORY)",
    "```json",
    JSON.stringify(input.memory, null, 2),
    "```",
    "",
    "## CONVERSATION (most recent last)",
    transcript || "(no messages yet)",
  ].join("\n");
}

export const SYSTEM_PROMPT = [
  "You are the REASONER - the business brain of an AI employee. You OWN judgment:",
  "customer intent, strategy, which business operation should happen, when none should,",
  "and what information is still missing. You do NOT execute anything and you do NOT",
  "write the customer-facing reply - a runtime executes, and a writer phrases.",
  "",
  "RULES:",
  "1. FACTS are authoritative world-state. Never claim or assume anything they contradict.",
  "2. If you decide to act, you may ONLY pick an operation from AVAILABLE OPERATIONS,",
  "   with meaning-level params. Never invent an operation or a tool.",
  "3. Express uncertainty as a MOVE, not a number: if unsure or missing info, choose",
  "   REQUEST_INPUT or CONVERSE. There is NO confidence score.",
  "4. Prefer acting when FACTS already support it; otherwise ask the ONE thing that unblocks it.",
  "5. LOOP DISCIPLINE: you run in a loop and see prior iterations' OBSERVATIONS. When the",
  "   goal is reached (FACTS confirm it) or nothing more can be done, choose FINISH. If the",
  "   same operation keeps failing or nothing is left to try and a human is needed, choose",
  "   ESCALATE with a reason. NEVER re-propose an operation listed under 'Ruled out'.",
  "",
  "Return ONLY strict JSON with this exact shape:",
  `{`,
  `  "read": { "situation": string, "customerState": string, "goal": string|null,`,
  `            "missingInformation": [{"what":string,"why":string,"source":"customer"|"system"}], "rationale": string },`,
  `  "decision": one of`,
  `      {"type":"EXECUTE","operation":string,"params":object}   // propose an op from the menu`,
  `    | {"type":"REQUEST_INPUT","needed":string}                // ask the customer one thing`,
  `    | {"type":"FINISH","reason":string}                       // goal reached / nothing left`,
  `    | {"type":"ESCALATE","reason":string}                     // stuck → hand to a human`,
  `    | {"type":"CONVERSE"}`,
  `    | {"type":"WAIT"},`,
  `  "replyIntent": { "purpose": string, "keyPoints": string[] },`,
  `  "memoryUpdate": { "committedGoal": string|undefined, "workingHypotheses": string[],`,
  `                    "alreadyAsked": string[], "priorReads": [{"turn":number,"situation":string}], "openCommitments": string[] }`,
  `}`,
].join("\n");

export function createOpenAIReasonerProvider(): ReasonerProvider {
  const model = getDefaultModel();
  return {
    name: "openai",
    model,
    async reason(input: ReasonerInput, opts?: ReasonerCallOptions): Promise<ReasonerProviderResult> {
      const tenantId = opts?.context?.tenantId;
      if (!tenantId) throw new Error("reasoner_provider: context.tenantId required (metering)");

      const started = Date.now();
      // Diagnostic seam: dump each rendered prompt for byte-level prefix diffing.
      if (process.env.REASONER_PROMPT_DUMP) {
        const { appendFileSync } = await import("fs");
        appendFileSync(
          `${process.env.REASONER_PROMPT_DUMP}/reasoner-${opts?.context?.conversationId ?? "x"}-${Date.now()}.txt`,
          renderInput(input),
        );
      }
      const resp = await generateResponse({
        tenantId,
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: renderInput(input) },
        ],
        responseFormat: { type: "json_object" },
        temperature: 0.2,
        sessionId: opts?.context?.sessionId,
        signal: opts?.signal,
        metadata: { conversationId: opts?.context?.conversationId, type: "reasoner" },
      });

      let raw: unknown;
      try {
        raw = JSON.parse(resp.content);
      } catch {
        throw new Error("reasoner_provider: model returned non-JSON");
      }
      const parsed = parseReasonerOutput(raw);
      if (!parsed.ok) throw new Error(`reasoner_provider: ${parsed.error}`);

      return {
        output: parsed.output,
        usage: {
          provider: "openai",
          model,
          inputTokens: resp.usage?.input_tokens,
          outputTokens: resp.usage?.output_tokens,
          latencyMs: Date.now() - started,
        },
      };
    },
  };
}
