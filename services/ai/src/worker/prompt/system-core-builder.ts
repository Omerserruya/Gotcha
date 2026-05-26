/**
 * Builds the SYSTEM_CORE prompt string for a worker session.
 *
 * Section order (FIXED — this is the contract):
 *   1. AI Worker base definition          (constant)
 *   2. Identity                            (per-worker, but session-stable)
 *   3. Skills registry render              (skill fragments composed in id order)
 *   4. Pipeline / Funnel section           (rendered inside pipeline_transitions skill)
 *   5. Guardrails                          (worker.guardrails snapshot)
 *   6. Mode overlay                        (autonomous | copilot | callpilot)
 *
 * Determinism contract: same `(worker, ctx)` MUST produce byte-identical
 * output. No timestamps, request IDs, or per-call data may appear here.
 *
 * Tools are NOT rendered into SYSTEM_CORE — they go into the OpenAI
 * `tools:` parameter directly. Tool POLICY language (when to call vs.
 * when to ask) lives in the `tool_usage_policy` skill.
 */

import type {
  AIWorkerConfig,
  AIWorkerMode,
} from "@chatcenter/shared";
import type { SkillRenderContext } from "../types";
import { composeSkills } from "../skills/registry";
import { renderModeOverlay } from "./mode-overlays";

const WORKER_PREAMBLE = `# AI Worker
You are an AI Worker operating inside the GOTCHA platform. You read state from services, propose actions, and execute them via service APIs. You do NOT store state, hold hidden context, or replace any service's domain logic.`;

export interface BuildSystemCoreInput {
  worker: AIWorkerConfig;
  mode: AIWorkerMode;
  ctx: SkillRenderContext;
}

export interface BuildSystemCoreOutput {
  text: string;
  /** Skill ids that actually rendered (post empty-fragment drop). */
  skillIds: string[];
  /** Skill ids requested but not registered. */
  missingSkillIds: string[];
  /** Tool names granted by the rendered skills. */
  skillToolsAdded: string[];
  /** Tool names skills declared as required. Validation seam for the registry. */
  skillToolsRequired: string[];
}

export function buildSystemCore(input: BuildSystemCoreInput): BuildSystemCoreOutput {
  const { worker, mode, ctx } = input;

  const sections: string[] = [];
  sections.push(WORKER_PREAMBLE);
  sections.push(renderIdentity(worker));

  const composed = composeSkills(ctx, worker.skillIds);
  if (composed.text) sections.push(composed.text);

  const guardrails = renderGuardrails(worker);
  if (guardrails) sections.push(guardrails);

  const overlay = renderModeOverlay(mode);
  if (overlay) sections.push(overlay);

  return {
    text: sections.join("\n\n---\n\n"),
    skillIds: composed.skillIds,
    missingSkillIds: composed.missing,
    skillToolsAdded: composed.toolsAdded,
    skillToolsRequired: composed.toolsRequired,
  };
}

// ─── Helpers ────────────────────────────────────────────────────

function renderIdentity(worker: AIWorkerConfig): string {
  const lines: string[] = [];
  lines.push("# Identity");
  lines.push(`You are **${worker.identity.name}**.`);
  if (worker.identity.persona) lines.push(`Persona: ${worker.identity.persona}.`);
  if (worker.identity.language) lines.push(`Default language: ${worker.identity.language}.`);
  return lines.join("\n");
}

function renderGuardrails(worker: AIWorkerConfig): string {
  const g = worker.guardrails;
  const lines: string[] = ["# Guardrails"];

  if (g.blockedTopics.length > 0) {
    lines.push("Do not discuss the following topics:");
    for (const t of g.blockedTopics) lines.push(`- ${t}`);
  }
  if (g.escalationKeywords.length > 0) {
    lines.push("");
    lines.push("Escalate to a human immediately when the customer says any of:");
    for (const k of g.escalationKeywords) lines.push(`- "${k}"`);
  }
  if (typeof g.maxDiscountPercent === "number") {
    lines.push("");
    lines.push(`Discounts: hard cap at ${g.maxDiscountPercent}%. Anything beyond requires human approval.`);
  }
  if (g.refundRequiresApproval) {
    lines.push("");
    lines.push("Refunds always require human approval. Never confirm a refund yourself.");
  }
  if (g.customRules.length > 0) {
    lines.push("");
    for (const r of g.customRules) lines.push(`- ${r}`);
  }

  // If nothing rendered besides the header, drop the section entirely so
  // the prefix bytes stay minimal.
  if (lines.length === 1) return "";
  return lines.join("\n");
}
