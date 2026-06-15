/**
 * Output validator - final defence against system-prompt leakage and
 * fabricated execution claims in the assistant's customer-facing text.
 *
 * Runs AFTER the model has produced its final string for THIS turn.
 *
 * Detection categories:
 *
 *   1. Verbatim section headers from our own prompt scaffolding.
 *      These names are internal: their appearance in the assistant's
 *      output is the loudest possible signal of a successful extraction.
 *
 *   2. Raw record IDs that look like Prisma CUIDs (`cm[a-z0-9]{20,}`)
 *      or known UUID shapes. These are never customer-facing - they
 *      should never appear in chat text.
 *
 *   3. Known forbidden vendor/system terms ("Zoho", "HubSpot", "the
 *      CRM", "the database", "my system prompt", "my instructions",
 *      "OpenAI", "GPT", "model").
 *
 *   4. Fabricated-action sentences when no matching successful tool
 *      call exists in the toolCallLog (e.g. "I've refunded your card"
 *      with no `issue_refund` ok=true in the log).
 *
 * On any detection: replace the assistant text with a safe deflection
 * in the same language (best-effort) and emit an audit row. The actual
 * tool-call side effects are not undone - that's the orchestrator's
 * job. We just stop the leaked text from leaving the building.
 */

import { prisma } from "@chatcenter/shared";

const FORBIDDEN_HEADERS = [
  /(^|\n)#\s*Guardrails\b/i,
  /(^|\n)#\s*Conversation Context\b/i,
  /(^|\n)#\s*Conversation State\b/i,
  /(^|\n)##?\s*Conversation State\b/i,
  /(^|\n)#\s*Execution Contract\b/i,
  /(^|\n)#\s*Tools Policy\b/i,
  /(^|\n)#\s*Pipeline Stage\b/i,
  /(^|\n)#\s*Knowledge\b/i,
  /(^|\n)#\s*Decision Layer\b/i,
  /(^|\n)#\s*Active Strategy\b/i,
  /(^|\n)##\s*Active strategy contract\b/i,
  /(^|\n)#\s*Identity\b/i,
  /(^|\n)#\s*Agent Playbook Anchors\b/i,
  /(^|\n)#\s*Goals\b/i,
];

const FORBIDDEN_IDS = [
  /\bcm[a-z0-9]{20,}\b/i, // Prisma CUIDs
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i, // UUID v1-v5
];

const FORBIDDEN_INTERNALS = [
  /\bZoho\b/i,
  /\bHubSpot\b/i,
  /\bthe CRM\b/i,
  /\bour CRM\b/i,
  /\bthe database\b/i,
  /\bmy system prompt\b/i,
  /\bmy instructions\b/i,
  /\bsystem prompt\b/i,
  /\bI am an? (?:AI|large language model|LLM|GPT)\b/i,
];

export interface ValidationContext {
  tenantId: string;
  conversationId: string;
  /** Successful tool calls in this turn, for fabricated-action detection. */
  toolCallLog?: Array<{ tool: string; decision?: string; sideEffect?: string }>;
}

export type ViolationCategory =
  | "section_header"
  | "internal_id"
  | "internal_vendor"
  | "fabricated_action";

export interface ValidationResult {
  ok: boolean;
  violations: Array<{ category: ViolationCategory; match: string }>;
  /** When ok=false, a safe replacement message in best-effort same-language. */
  safeReply: string;
}

/**
 * Pure function. Inspect `text`, return the result. Audit + replacement
 * is the caller's choice (see `validateAndPersist` for the wired path).
 */
export function validateAssistantOutput(
  text: string | null | undefined,
  ctx: ValidationContext,
): ValidationResult {
  if (!text || !text.trim()) {
    return { ok: true, violations: [], safeReply: text || "" };
  }
  const violations: ValidationResult["violations"] = [];

  for (const re of FORBIDDEN_HEADERS) {
    const m = text.match(re);
    if (m) violations.push({ category: "section_header", match: m[0].trim() });
  }
  for (const re of FORBIDDEN_IDS) {
    const m = text.match(re);
    if (m) violations.push({ category: "internal_id", match: m[0] });
  }
  for (const re of FORBIDDEN_INTERNALS) {
    const m = text.match(re);
    if (m) violations.push({ category: "internal_vendor", match: m[0] });
  }

  // Fabricated-action heuristic: assistant claims a write action happened
  // ("I've refunded", "scheduled the meeting", "sent the link", "created
  // the lead") but no corresponding successful tool call exists in the log.
  const succeededTools = new Set(
    (ctx.toolCallLog || [])
      .filter((c) => c.decision === "executed" || c.decision === "executed_on_retry")
      .map((c) => c.tool.toLowerCase()),
  );
  const FABRICATION_RULES: Array<{ pattern: RegExp; needsTool: RegExp }> = [
    { pattern: /\b(i(?:'ve|\s+have)|just)\s+refunded\b/i, needsTool: /refund/i },
    { pattern: /\b(i(?:'ve|\s+have))\s+scheduled\b/i, needsTool: /(schedule_meeting|schedule_followup|book_)/i },
    { pattern: /\b(i(?:'ve|\s+have))\s+(?:created|added)\s+(?:the\s+)?(?:lead|contact|task)\b/i, needsTool: /(create_lead|create_contact|create_task)/i },
    { pattern: /\b(i(?:'ve|\s+have))\s+sent\s+(?:you\s+)?(?:the\s+)?(?:link|invite|email)\b/i, needsTool: /(send_|email|message|invite)/i },
    // Hebrew variants
    { pattern: /\bזה\s+כבר\s+הוחזר\b/i, needsTool: /refund/i },
    { pattern: /\bכבר\s+תיאמתי\b/i, needsTool: /(schedule|book_)/i },
  ];
  for (const rule of FABRICATION_RULES) {
    const m = text.match(rule.pattern);
    if (!m) continue;
    const ok = Array.from(succeededTools).some((t) => rule.needsTool.test(t));
    if (!ok) violations.push({ category: "fabricated_action", match: m[0] });
  }

  if (violations.length === 0) {
    return { ok: true, violations: [], safeReply: text };
  }
  return {
    ok: false,
    violations,
    safeReply: makeDeflection(text),
  };
}

/**
 * Pick a deflection in the same language as the input (Hebrew vs other).
 * Kept conservative - short, warm, doesn't reference the violation.
 */
function makeDeflection(_originalText: string): string {
  // Cheap heuristic: any Hebrew character → Hebrew reply.
  if (/[֐-׿]/.test(_originalText)) {
    return "תודה - אם יש משהו ספציפי שאני יכול לעזור בו, ספר לי בבקשה.";
  }
  return "Thanks - let me know if there's something specific I can help with.";
}

/**
 * Wired path used by the bot: validate, audit-log any violation, and
 * return the safe text the bot should actually send to the customer.
 *
 * Audit row is fire-and-forget; never throws into the bot turn.
 */
export async function validateAndPersist(
  text: string | null | undefined,
  ctx: ValidationContext,
): Promise<string> {
  const result = validateAssistantOutput(text, ctx);
  if (result.ok) return text || "";

  // Audit - non-blocking.
  prisma.auditLog
    .create({
      data: {
        tenantId: ctx.tenantId,
        actorType: "system",
        action: "ai.output_validator.blocked",
        targetType: "conversation",
        targetId: ctx.conversationId,
        metadata: {
          violations: result.violations,
          originalLength: (text || "").length,
          source: "output-validator",
        } as any,
      },
    })
    .catch((err: any) => console.error("[output-validator] audit failed:", err?.message));

  return result.safeReply;
}
