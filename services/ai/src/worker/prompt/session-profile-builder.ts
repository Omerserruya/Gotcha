/**
 * Builds the SESSION_PROFILE prompt string.
 *
 * SESSION_PROFILE is the SECOND system-role message. It carries the
 * customer/conversation snapshot taken ONCE at session start.
 *
 * Why a separate string (not concatenated into SYSTEM_CORE):
 *   - The same SYSTEM_CORE can serve many sessions; only the profile
 *     differs. Keeping them separate lets us cache SYSTEM_CORE across
 *     workers and SESSION_PROFILE per session.
 *   - It also makes the fingerprint debug output easier to read - you
 *     can see at a glance which half changed when drift is reported.
 *
 * NO TIMESTAMPS in the rendered output. Including capturedAt would mean
 * every session has a unique profile string, defeating cross-session
 * caching. capturedAt lives in the metadata for logging only.
 */

import type { AIWorkerSessionProfile } from "@chatcenter/shared";

export function buildSessionProfile(profile: AIWorkerSessionProfile): string {
  const sections: string[] = ["# Session Context"];

  // Customer block - only fields with values render, so two customers
  // with the same shape produce the same bytes.
  const customer = profile.customer ?? {};
  const customerLines: string[] = [];
  if (customer.name) customerLines.push(`Name: ${customer.name}`);
  if (customer.channel) customerLines.push(`Channel: ${customer.channel}`);
  if (customer.email) customerLines.push(`Email: ${customer.email}`);
  if (customer.phone) customerLines.push(`Phone: ${customer.phone}`);
  if (customer.externalId) customerLines.push(`External ID: ${customer.externalId}`);
  if (customerLines.length > 0) {
    sections.push(["## Customer", ...customerLines].join("\n"));
  }

  // Conversation reference - minimal, never includes timestamps.
  if (profile.conversationId) {
    sections.push(`## Conversation\nID: ${profile.conversationId}`);
  }

  // Pipeline snapshot - same fields the pipeline_transitions skill reads,
  // duplicated here as ground truth at the top of the prompt. The skill
  // section explains POLICY; this block is the DATA.
  const p = profile.pipeline ?? {};
  if (p.currentStageId) {
    const lines = ["## Pipeline"];
    if (p.funnelId) lines.push(`Funnel: ${p.funnelId}`);
    lines.push(`Current stage: ${p.currentStageLabel ?? p.currentStageId}`);
    if (p.nextStageId) {
      lines.push(`Next stage: ${p.nextStageLabel ?? p.nextStageId}`);
    }
    sections.push(lines.join("\n"));
  }

  // Behaviour snapshot - the frozen BEL output. Worker-level overlay
  // language ("how aggressively to push") lives here so a per-turn
  // recompute can't drift the cached prefix.
  const b = profile.behavior ?? {};
  if (b.toneIntensity != null || b.outputContractKey || (b.allowedActions?.length ?? 0) > 0) {
    const lines = ["## Behaviour"];
    if (b.outputContractKey) lines.push(`Output contract: ${b.outputContractKey}`);
    if (b.toneIntensity != null) lines.push(`Tone intensity: ${b.toneIntensity}`);
    if ((b.allowedActions?.length ?? 0) > 0) {
      lines.push(`Allowed action categories: ${b.allowedActions!.join(", ")}`);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}
