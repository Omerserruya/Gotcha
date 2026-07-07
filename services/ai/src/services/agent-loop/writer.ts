/**
 * Writer — the loop's expression capability. It runs EXACTLY ONCE, at the end of
 * the loop, turning the terminal `ReplyIntent` into the single customer-facing
 * message. The Writer has NO tools and makes NO decisions — it cannot take an
 * unsafe action by construction.
 *
 * The Reasoner emits a ReplyIntent (purpose + keyPoints) that is a SPEC for what to
 * say, not customer-ready prose. The Writer renders it into ONE natural message in
 * the customer's language. It uses a metered LLM (through the same choke point as
 * every other AI call), and is FAIL-SOFT: any LLM/metering failure degrades to the
 * deterministic renderer so a turn is never broken by expression.
 *
 * Swapping the expression strategy changes only this file — the loop is unaffected.
 */

import type { ReplyIntent, TerminationReason } from "@chatcenter/shared";
import { generateResponse } from "../ai.service";

export interface WriteOptions {
  language?: string;
  /** How the loop ended — lets the Writer frame need-input / escalation honestly. */
  termination: TerminationReason;
  /** Metering owner + session routing (required for the LLM path; absent → deterministic). */
  tenantId?: string;
  conversationId?: string;
  /** Optional brand voice to color the phrasing. */
  brandVoice?: { tone?: string; persona?: string } | undefined;
}

const LANGUAGE_NAMES: Record<string, string> = {
  he: "Hebrew",
  ar: "Arabic",
  en: "English",
};

/**
 * Produce the ONE customer-facing message. LLM-rendered when a tenant is present,
 * else deterministic. Never throws.
 */
export async function writeReply(intent: ReplyIntent, opts: WriteOptions): Promise<string> {
  const deterministic = renderDeterministic(intent, opts);

  // No metering owner → cannot make a billed call. Deterministic render.
  if (!opts.tenantId) return deterministic;

  try {
    const langName = opts.language ? LANGUAGE_NAMES[opts.language] ?? opts.language : "the customer's language";
    const voice = opts.brandVoice?.tone || opts.brandVoice?.persona;
    const system =
      `You are the single voice of an AI employee speaking directly to a customer over chat. ` +
      `Rewrite the internal REPLY INTENT below as ONE natural, warm message in ${langName}. ` +
      `STRICT RULES: say ONLY what the intent authorizes; never invent facts, times, prices, names, or promises; ` +
      `match ${langName} exactly; be concise and human; no meta-commentary; no bullet lists unless natural; ` +
      `do not mention that you are following an intent.` +
      (voice ? ` Brand voice: ${voice}.` : "");
    const user =
      `REPLY INTENT\n` +
      `purpose: ${intent.purpose || "(none)"}\n` +
      `key points to convey:\n` +
      ((intent.keyPoints ?? []).map((p) => `- ${p}`).join("\n") || "- (none)") +
      `\nconversation outcome: ${opts.termination}\n\n` +
      `Write the message now, nothing else.`;

    const res = await generateResponse({
      tenantId: opts.tenantId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      // Own session key: the Writer's prompt family must not pollute the
      // Reasoner's prefix-cache telemetry/routing (they share a conversation).
      sessionId: opts.conversationId ? `${opts.conversationId}:writer` : undefined,
      metadata: { conversationId: opts.conversationId, type: "chat" },
    });
    const text = res.content?.trim();
    return text && text.length > 0 ? text : deterministic;
  } catch {
    // Metering block / provider error / abort — never break the turn on expression.
    return deterministic;
  }
}

/** Honest, zero-LLM render — also the fail-soft fallback. */
function renderDeterministic(intent: ReplyIntent, opts: WriteOptions): string {
  const points = (intent.keyPoints ?? []).map((p) => p.trim()).filter(Boolean);
  if (points.length) return points.join(" ");
  if (intent.purpose && intent.purpose.trim()) return intent.purpose.trim();

  // Honest fallbacks by termination — never claim a false success.
  switch (opts.termination) {
    case "need_input":
      return "Could you share a bit more so I can help with this?";
    case "escalate":
    case "awaiting_approval":
      return "I've flagged this for a team member who'll follow up shortly.";
    case "blocked":
    case "failed":
      return "I hit a snag completing that — a team member will take it from here.";
    default:
      return "Thanks — is there anything else I can help with?";
  }
}
