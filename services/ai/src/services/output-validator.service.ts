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

// ─── Tool-output leak protection ────────────────────────────────────────
// Raw tool payloads, tool-call-shaped JSON, internal result formats, or
// fabricated tool blobs must NEVER reach the customer. Observed live: the model
// emitted `{"to":"functions.schedule_meeting","json":{...}}` and a fabricated
// `{"ok":true,"meeting_link":...}` as plain TEXT (a tool-call-as-text leak) and
// it shipped to the customer. These signatures mark a line as machine output;
// any line carrying one is stripped before send. Keys are internal-only and
// never appear in legitimate customer prose.
const TOOL_SHAPE_SIGNATURES = [
  /"to"\s*:\s*"functions?\./i,        // {"to":"functions.schedule_meeting"
  /\bfunctions?\.[a-z_]+/i,            // functions.schedule_meeting token
  /"(tool_call|tool_calls|arguments|function_call)"\s*:/i,
  /"json"\s*:\s*[{[]/i,
  /"ok"\s*:\s*(true|false)\b/i,        // {"ok":true,...} result envelope
  /"(verdict|eventId|event_id|joinUrl|join_url|meeting_link|meetingLink|proposedSlotsIso|start_iso|end_iso|startMs|endMs|duration_minutes)"\s*:/i,
];

/**
 * Remove tool-call / tool-result shaped segments from customer-facing text.
 * Line-oriented (these leaks land on their own lines) plus fenced-code removal.
 * Returns the cleaned text and whether anything was stripped.
 */
export function stripLeakedToolContent(text: string): { cleaned: string; leaked: boolean; sample?: string } {
  if (!text) return { cleaned: text, leaked: false };
  let sample: string | undefined;
  const isToolShaped = (s: string) => TOOL_SHAPE_SIGNATURES.some((re) => re.test(s));

  // 1) Drop fenced code blocks whose body is tool-shaped (```...``` / ~~~...~~~).
  let working = text.replace(/(^|\n)\s*(```|~~~)[\s\S]*?\2\s*(?=\n|$)/g, (block) => {
    if (isToolShaped(block)) { sample = sample ?? block.trim().slice(0, 80); return "\n"; }
    return block;
  });

  // 2) Drop individual lines that look like tool-call / result JSON.
  const kept: string[] = [];
  for (const line of working.split("\n")) {
    const t = line.trim();
    const jsonish = /^[{[].*[}\]]?$/.test(t) || /^[}\]]+,?$/.test(t);
    if (t && isToolShaped(t) && (jsonish || isToolShaped(line))) {
      sample = sample ?? t.slice(0, 80);
      continue; // strip it
    }
    kept.push(line);
  }
  working = kept.join("\n");

  // 3) Collapse the blank gaps the removals leave behind.
  working = working.replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned: working, leaked: working !== text.trim(), sample };
}

// ─── Internal-operations leak protection (role/language-agnostic) ───────────
// The customer must experience OUTCOMES, never internal workflow mechanics.
// Narrating "I'll create a lead / update the CRM / log a ticket / save your
// details in our system" is an internal-ops leak regardless of role or brand.
// We strip the offending CLAUSE (sentence) and keep the rest of the reply.
// Patterns cover the deployment's languages (English + Hebrew); the prompt rule
// remains the language-agnostic first line of defence, this is the deterministic
// backstop for the languages we ship.
const INTERNAL_OPS_PATTERNS: RegExp[] = [
  // EN: <verb> ... <internal object> — "create a lead", "log a ticket", "update the record/CRM"
  /\b(creat(?:e|ing)|log(?:ging)?|sav(?:e|ing)|updat(?:e|ing)|add(?:ing)?|register(?:ing)?|set(?:ting)?\s+up|open(?:ing)?)\b[^.!?\n]{0,40}\b(?:a |an |the |your )?(lead|contact|deal|opportunity|ticket|case|record|profile|entry|crm)\b/i,
  /\b(in|into|on)\s+(?:our|the|your)\s+(system|crm|database|records?|back[\s-]?end)\b/i,
  /\b(internally|behind the scenes|on our end|in our records)\b/i,
  // HE: register/create/update/save (any conjugation) + a CRM object/system,
  // plus the locative "in the system / in the CRM" which is itself the leak.
  /(ליצור|יציר[הת]|אצור|נוצר|לרשום|רישום|א?רשום|נרשום|רושמ|לעדכן|עדכון|א?עדכן|נעדכן|מעדכן|לשמור|שמיר[הת]|א?שמור|נשמור|להזין|א?זין)[^.!?\n]{0,30}(ליד|הובלה|איש[\s-]?קשר|עסק[הת]|כרטיס|טיקט|רשומ[הת]|מערכת)/,
  /(במערכת|אצלנו\s+במערכת|ב-?CRM|ברקע)/,
];

/**
 * Remove customer-facing sentences that narrate internal workflow operations.
 * Sentence-granular so the rest of the reply (the actual answer/next step)
 * survives. Returns cleaned text + whether anything was stripped.
 */
export function stripInternalOpsNarration(text: string): { cleaned: string; leaked: boolean; sample?: string } {
  if (!text || !text.trim()) return { cleaned: text, leaked: false };
  const isLeak = (s: string) => INTERNAL_OPS_PATTERNS.some((re) => re.test(s));
  let sample: string | undefined;
  // Drop offending SENTENCES while PRESERVING line structure (newlines matter to
  // other detectors, e.g. leaked "# Header" lines). Process per line, removing
  // only the internal-ops sentences within it.
  const outLines = text.split("\n").map((line) => {
    const sentences = line.split(/(?<=[.!?])\s+/);
    return sentences
      .filter((s) => {
        if (s.trim() && isLeak(s)) {
          sample = sample ?? s.trim().slice(0, 80);
          return false;
        }
        return true;
      })
      .join(" ");
  });
  const cleaned = outLines.join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, leaked: cleaned !== text.trim(), sample };
}

export interface ValidationContext {
  tenantId: string;
  conversationId: string;
  /** Successful tool calls in this turn, for fabricated-action detection. */
  toolCallLog?: Array<{ tool: string; decision?: string; sideEffect?: string }>;
  /** Tools the Turn Outcome Ledger recorded as COMMITTED this turn (real
   * external ref). The authoritative success set — unioned with the toolCallLog
   * decisions so the final fabrication check shares the single source of truth
   * (e.g. a booking deduped from a prior turn has no fresh "executed" log entry
   * but IS a real commit, and must not be flagged as fabricated). */
  ledgerCommittedTools?: string[];
}

export type ViolationCategory =
  | "section_header"
  | "internal_id"
  | "internal_vendor"
  | "fabricated_action"
  | "tool_output_leak"
  | "internal_ops_leak";

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

  // Tool-output leak protection FIRST: strip machine / tool-shaped content, then
  // run every other check against the CLEANED text. A leaked blob must never
  // count as legitimate content — and must never reach the customer.
  const { cleaned, leaked, sample } = stripLeakedToolContent(text);
  if (leaked) violations.push({ category: "tool_output_leak", match: sample || "tool-shaped output" });
  // Internal-operations leak: strip clauses narrating internal workflow (create a
  // lead / update the CRM / log a ticket / save in our system), any role/brand.
  const ops = stripInternalOpsNarration(cleaned);
  if (ops.leaked) violations.push({ category: "internal_ops_leak", match: ops.sample || "internal-ops narration" });
  const working = ops.cleaned;

  for (const re of FORBIDDEN_HEADERS) {
    const m = working.match(re);
    if (m) violations.push({ category: "section_header", match: m[0].trim() });
  }
  for (const re of FORBIDDEN_IDS) {
    const m = working.match(re);
    if (m) violations.push({ category: "internal_id", match: m[0] });
  }
  for (const re of FORBIDDEN_INTERNALS) {
    const m = working.match(re);
    if (m) violations.push({ category: "internal_vendor", match: m[0] });
  }

  // Fabricated-action heuristic: assistant claims a write action happened
  // ("I've refunded", "scheduled the meeting", "sent the link", "created
  // the lead") but no corresponding successful tool call exists in the log.
  const succeededTools = new Set([
    ...(ctx.toolCallLog || [])
      .filter((c) => c.decision === "executed" || c.decision === "executed_on_retry")
      .map((c) => c.tool.toLowerCase()),
    ...(ctx.ledgerCommittedTools || []).map((t) => t.toLowerCase()),
  ]);
  const FABRICATION_RULES: Array<{ pattern: RegExp; needsTool: RegExp }> = [
    { pattern: /\b(i(?:'ve|\s+have)|just)\s+refunded\b/i, needsTool: /refund/i },
    { pattern: /\b(i(?:'ve|\s+have))\s+scheduled\b/i, needsTool: /(schedule_meeting|schedule_followup|book_)/i },
    { pattern: /\b(i(?:'ve|\s+have))\s+(?:created|added)\s+(?:the\s+)?(?:lead|contact|task)\b/i, needsTool: /(create_lead|create_contact|create_task)/i },
    { pattern: /\b(i(?:'ve|\s+have))\s+sent\s+(?:you\s+)?(?:the\s+)?(?:link|invite|email)\b/i, needsTool: /(send_|email|message|invite|schedule_meeting)/i },
    // A handed-over meeting / join link must be backed by a real booking tool.
    { pattern: /\b(here'?s|join)\b[^.!?\n]*\b(meeting\s+|join\s+)?(link|url)\b/i, needsTool: /(schedule_meeting|reschedule_meeting|book_)/i },
    // Hebrew variants
    { pattern: /\bזה\s+כבר\s+הוחזר\b/i, needsTool: /refund/i },
    { pattern: /\bכבר\s+תיאמתי\b/i, needsTool: /(schedule|book_)/i },
    { pattern: /הצלחתי\s+לקבוע/, needsTool: /(schedule_meeting|book_)/i },          // "I managed to schedule"
    { pattern: /קבעתי[^.!?\n]*(פגישה|שיחה|מחר|בשעה|דמו|לך)/, needsTool: /(schedule_meeting|book_)/i }, // "I scheduled ..."
    { pattern: /(שלחתי|שולח[ת]?)\s+(לך\s+)?(הזמנה|זימון)/, needsTool: /(schedule_meeting|send_|invite|email|book_)/i }, // "I sent an invite"
    { pattern: /(הקישור|הלינק)\s+(ל?פגישה|ל?שיחה|ל?מפגש|להצטרפות|לזום|לדמו)/, needsTool: /(schedule_meeting|reschedule_meeting|book_)/i }, // handed-over meeting link
  ];
  for (const rule of FABRICATION_RULES) {
    const m = working.match(rule.pattern);
    if (!m) continue;
    const ok = Array.from(succeededTools).some((t) => rule.needsTool.test(t));
    if (!ok) violations.push({ category: "fabricated_action", match: m[0] });
  }

  if (violations.length === 0) {
    return { ok: true, violations: [], safeReply: text };
  }
  // Leak-only (stripping already removed the machine content) AND meaningful
  // human text remains → send the CLEANED text. Otherwise (a fabrication /
  // header / id / vendor violation, or nothing intelligible left) → deflect.
  const onlyLeak = violations.every((v) => v.category === "tool_output_leak" || v.category === "internal_ops_leak");
  const meaningful = working.replace(/\s+/g, "").length >= 8;
  return {
    ok: false,
    violations,
    safeReply: onlyLeak && meaningful ? working : makeDeflection(text),
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
