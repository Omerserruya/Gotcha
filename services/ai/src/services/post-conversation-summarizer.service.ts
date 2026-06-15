/**
 * Post-conversation summarizer.
 *
 * Runs once at end-of-conversation (voice hang-up or chat closed) and produces
 * a STRUCTURED summary the post-conversation pipeline can act on:
 *   - finalSummary text (still human-readable, for the workspace card)
 *   - sparse crm_patch (ONLY fields actually discussed in this conversation -
 *     never touch CRM fields the customer/agent did not mention)
 *   - suggested_tasks   (free-form proposals, surfaced for approval)
 *   - suggested_followup (defers turn into schedule_followup proposals)
 *   - status_change      (optional lead-status transition)
 *
 * The sparse-patch contract is enforced in two layers:
 *   1. Prompt - the LLM is told to OMIT any field not explicitly discussed.
 *   2. Validation - we strip null/empty values before persisting, and we
 *      require mentioned_fields[] to cover every key in crm_patch.
 */

import { prisma } from "@chatcenter/shared";
import { generateResponse, getDefaultModel } from "./ai.service";
import type { ExistingActionItems } from "./existing-action-items.service";

export type Sentiment = "positive" | "neutral" | "negative" | "mixed";

export interface SuggestedTask {
  subject: string;
  body?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  reason: string;
}

export interface SuggestedFollowup {
  send_at_iso: string;
  message: string;
  reason: string;
}

export interface StatusChange {
  to: string;
  reason: string;
}

/**
 * Free-form bonus observation the LLM noticed but couldn't fit into the
 * tenant's structured template (`summaryFields`). The business owner sees
 * these under the freestyle summary; humans decide whether to promote a
 * recurring `label` into the template later. Bonus items are NEVER written
 * to the CRM - they live in `CallAnalysis.meta.structured.bonus_highlights`
 * only, so the sparse-patch invariant is preserved.
 */
export interface BonusHighlight {
  /** Short snake_case label, e.g. "competitor_mentioned", "callback_requested". */
  label: string;
  /** The concrete value or quote, e.g. "Salesforce" or "Thursday afternoon". */
  value: string;
  /** Why this matters - one short sentence. */
  reason: string;
}

/**
 * Pipeline-stage transition the summarizer suggests after evaluating the
 * call against the active stage's exit criteria.
 *
 * Conservative contract:
 *   - `to` must be one of the stage ids supplied as `candidateStageIds`
 *     (typically the active stage's `copilot.nextStageId`).
 *   - `confidence` is 0..1. The advance-worker auto-applies when
 *     confidence ≥ 0.75 AND evidence is non-empty; otherwise it routes the
 *     suggestion to human review as a CRM task.
 *   - `evidence` MUST cite at least one short transcript quote or CRM
 *     field that proves the criteria were satisfied. No evidence → no
 *     auto-apply, regardless of confidence.
 *   - `criteriaMet` / `criteriaMissed` are short labels for the UI badge.
 */
export interface StageTransitionSuggestion {
  to: string;
  confidence: number;
  evidence: string[];
  criteriaMet: string[];
  criteriaMissed: string[];
  reason: string;
}

/** Inputs needed for stage-aware post-call evaluation. */
export interface StageContextForSummary {
  /** Active stage id (matches a FunnelStage.id). */
  currentStageId: string;
  /** Display label for the active stage. */
  currentStageLabel: string;
  /** Free-text goal for the active stage (mirrors copilot.goal). */
  currentStageGoal?: string;
  /** Exit-criteria summary, one short line per criterion. */
  exitCriteria?: {
    mustHaveFields?: string[];
    mustAskQuestions?: string[];
    positiveSignals?: string[];
    negativeSignals?: string[];
  };
  /** Ids the LLM may pick from for `to`. Empty list disables transition. */
  candidateStageIds: string[];
  /** Display labels keyed by id, surfaced to the LLM for clarity. */
  candidateLabels?: Record<string, string>;
}

export interface PostConversationSummary {
  summary: string;
  sentiment: Sentiment | null;
  intent: string | null;
  mentioned_fields: string[];
  crm_patch: Record<string, unknown>;
  suggested_tasks: SuggestedTask[];
  suggested_followup: SuggestedFollowup | null;
  status_change: StatusChange | null;
  /** Pipeline-stage transition. Null when no funnel was supplied. */
  stage_transition_suggestion: StageTransitionSuggestion | null;
  /**
   * Free-form items the LLM flagged as important but that fall outside the
   * tenant's structured template. Surface-only - never written to CRM, so
   * the sparse-patch invariant for `crm_patch` is preserved.
   */
  bonus_highlights: BonusHighlight[];
  /** Set true when the LLM call failed or produced no usable output. */
  empty?: boolean;
}

interface BuildPromptArgs {
  transcript: string;
  locale?: string;
  allowedFields?: string[];
  existingActionItems?: ExistingActionItems;
  stage?: StageContextForSummary;
}

function buildSystemPrompt({ allowedFields, locale, existingActionItems, stage }: BuildPromptArgs): string {
  const hasStage = !!stage && stage.candidateStageIds.length > 0;
  const lines: string[] = [
    "You are a post-conversation analyst. The customer interaction has ENDED.",
    "Your job is to produce a STRUCTURED JSON summary that downstream automations consume.",
    "",
    "CRITICAL - SPARSE PATCH RULE:",
    "- The CRM record already holds information from prior conversations.",
    "- You MUST ONLY include fields in `crm_patch` that were EXPLICITLY discussed in THIS conversation.",
    "- If the customer did not mention their budget in this conversation, do NOT include 'budget' in crm_patch - even if it would be useful.",
    "- Missing/omitted keys = leave the existing record untouched. Never null out a field to 'clear' it.",
    "- Every key in `crm_patch` MUST also appear in `mentioned_fields`.",
    "",
    "Output JSON shape (return EXACTLY this shape - omit a key by setting it to null or []):",
    "{",
    '  "summary": "2-4 sentence plain-text summary of what happened",',
    '  "sentiment": "positive" | "neutral" | "negative" | "mixed" | null,',
    '  "intent": "short label e.g. pricing_inquiry, support_complaint, ready_to_buy, ..." | null,',
    '  "mentioned_fields": ["budget", "timeline", ...],',
    '  "crm_patch": { /* sparse - only keys from mentioned_fields */ },',
    '  "suggested_tasks": [ { "subject": "...", "body": "...", "priority": "low|normal|high|urgent", "reason": "why" } ],',
    '  "suggested_followup": { "send_at_iso": "ISO-8601", "message": "ready-to-send text", "reason": "why" } | null,',
    '  "status_change": { "to": "qualified|disqualified|nurture|...", "reason": "why" } | null,',
    '  "bonus_highlights": [ { "label": "snake_case_label", "value": "concrete value or short quote", "reason": "why business owner cares" } ],',
    '  "stage_transition_suggestion": {',
    '    "to": "<one of the candidate stage ids>",',
    '    "confidence": 0.0,                          // 0..1; ≥0.75 will auto-apply',
    '    "evidence": ["short transcript quote", "..."], // MUST cite from the transcript',
    '    "criteriaMet": ["budget collected", "..."],',
    '    "criteriaMissed": ["decision_maker still unknown"],',
    '    "reason": "why this stage advance is justified"',
    "  } | null",
    "}",
    "",
    "RULES:",
    "- Be conservative. When in doubt, OMIT the field (leave it for a human).",
    "- `suggested_followup` ONLY when the customer explicitly deferred or asked for a callback at a specific time.",
    "- `status_change` ONLY when the conversation gave you direct evidence (explicit buy intent, hard rejection, etc.).",
    "- Tasks should be specific and actionable ('Send Q3 pricing PDF to Acme'), not vague ('follow up').",
    "",
    "BONUS HIGHLIGHTS RULE (important for the freestyle/template separation):",
    "- `crm_patch` is for STRUCTURED template slots only - never put anything outside the allowed keys there.",
    "- Use `bonus_highlights` for anything materially important the business owner should know that DOESN'T fit the template:",
    "  • a competitor the customer mentioned",
    "  • a specific objection or concern",
    "  • a named decision blocker or stakeholder",
    "  • churn risk signals (frustration, cancellation hints)",
    "  • an opportunity (upsell signal, referral mention)",
    "- DO NOT use `bonus_highlights` for trivia ('greeted politely', 'said hello'). Keep it material.",
    "- `label` MUST be a short snake_case key (so identical observations across calls can be counted later).",
    "- Empty list is fine - most calls won't have bonus items.",
    "- A bonus highlight is NEVER also in crm_patch. If it belongs in the template, it goes ONLY in crm_patch.",
  ];

  if (hasStage) {
    const candList = stage!.candidateStageIds
      .map((id) => `${id}${stage!.candidateLabels?.[id] ? ` (${stage!.candidateLabels[id]})` : ""}`)
      .join(", ");
    const stageBlock: string[] = [
      "",
      "STAGE TRANSITION RULES (only when a funnel is active):",
      `- ACTIVE STAGE: ${stage!.currentStageLabel} (id=${stage!.currentStageId}).`,
    ];
    if (stage!.currentStageGoal) {
      stageBlock.push(`- STAGE GOAL: ${stage!.currentStageGoal}`);
    }
    stageBlock.push(
      `- CANDIDATE NEXT STAGES (only pick \`to\` from this set; null means "do not advance"): ${candList || "(none - keep null)"}.`,
      "- `stage_transition_suggestion` MUST be `null` UNLESS the transcript shows direct evidence that the exit criteria were satisfied.",
      "- `confidence` must reflect strength of evidence. <0.75 → the system will route this for human review.",
      "- `evidence` MUST include at least one short transcript quote OR a CRM field this conversation populated. No evidence → suggestion is rejected.",
      "- If the customer expressed a negative signal (e.g. \"not interested\", \"too expensive\"), DO NOT propose an advance; emit null and explain in `reason`.",
    );
    for (const line of stageBlock) lines.push(line);
    const exit = stage!.exitCriteria;
    if (exit) {
      lines.push("- EXIT CRITERIA for the active stage:");
      if (exit.mustHaveFields?.length) {
        lines.push(`  • data fields required: ${exit.mustHaveFields.join(", ")}`);
      }
      if (exit.mustAskQuestions?.length) {
        lines.push(`  • questions required: ${exit.mustAskQuestions.join(" | ")}`);
      }
      if (exit.positiveSignals?.length) {
        lines.push(`  • positive signals (any-of): ${exit.positiveSignals.join(" | ")}`);
      }
      if (exit.negativeSignals?.length) {
        lines.push(`  • BLOCKING negative signals (any-of): ${exit.negativeSignals.join(" | ")}`);
      }
    }
  } else {
    lines.push(
      "",
      "STAGE TRANSITION: No funnel is configured. `stage_transition_suggestion` MUST be null.",
    );
  }

  // Intent-aware dedup: if the bot already created tasks or scheduled
  // follow-ups during the conversation, the analyst LLM gets to see them
  // and must NOT propose new ones that cover the same intent.
  const hasExisting =
    (existingActionItems?.tasks.length ?? 0) > 0 ||
    (existingActionItems?.pendingFollowups.length ?? 0) > 0;
  if (hasExisting) {
    lines.push(
      "",
      "DEDUP RULE - already-covered actions:",
      "- Below is the list of tasks and scheduled follow-ups that were ALREADY created during this conversation (by the bot or a human agent).",
      "- Compare your proposed `suggested_tasks` and `suggested_followup` to that list by INTENT, not by literal wording.",
      "- A task like 'Send pricing PDF' is the SAME as 'Email Q3 pricing document' - DO NOT propose it again.",
      "- A scheduled callback at the same approximate time covers any follow-up you'd otherwise suggest - do NOT propose a duplicate.",
      "- ONLY suggest tasks/follow-ups that are NOT covered by the existing list.",
      "- If everything is already covered, return `suggested_tasks: []` and `suggested_followup: null`.",
    );
  }

  if (allowedFields && allowedFields.length > 0) {
    lines.push("", "ALLOWED CRM FIELD KEYS (use only these names in crm_patch + mentioned_fields):");
    for (const f of allowedFields) lines.push(`- ${f}`);
  }
  if (locale && locale !== "en") {
    lines.push(
      "",
      `LANGUAGE - write ALL human-facing text in: ${locale}.`,
      "Localized fields:",
      "  • `summary`",
      "  • `suggested_followup.message` AND `suggested_followup.reason`",
      "  • every `suggested_tasks[].subject`, `.body`, `.reason`",
      "  • every `bonus_highlights[].value` AND `.reason`  (but KEEP `.label` in snake_case English so observations can be grouped across tenants)",
      "  • `stage_transition_suggestion.reason`",
      "  • `status_change.reason`",
      "Keep machine-readable enums (`sentiment`, `intent`, `status_change.to`, `priority`, snake_case labels, CRM keys in `crm_patch`) in English - these are not human-facing copy.",
    );
  }
  return lines.join("\n");
}

async function loadTranscript(conversationId: string, tenantId: string): Promise<string> {
  const messages = await prisma.message.findMany({
    where: { conversationId, tenantId },
    orderBy: { createdAt: "asc" },
    select: { direction: true, body: true, senderName: true, messageType: true, createdAt: true },
  });
  const lines: string[] = [];
  for (const m of messages) {
    const body = (m.body ?? "").trim();
    if (!body) continue;
    if ((m.messageType as unknown as string) === "system") continue;
    const who = m.direction === "INBOUND" ? "Customer" : (m.senderName || "Agent");
    lines.push(`${who}: ${body}`);
  }
  return lines.join("\n");
}

async function loadFrameContext(conversationId: string): Promise<string | null> {
  try {
    const row = await (prisma as any).callAnalysis.findUnique({
      where: { conversationId },
      select: { rollingSummary: true, frames: true },
    });
    if (!row) return null;
    if (row.rollingSummary && typeof row.rollingSummary === "string") {
      return `## Rolling summary so far\n${row.rollingSummary}`;
    }
    if (Array.isArray(row.frames) && row.frames.length > 0) {
      const last = row.frames[row.frames.length - 1] as any;
      const text = last?.summary?.text;
      if (typeof text === "string" && text.trim()) {
        return `## Last live-frame summary\n${text}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function coerceSentiment(v: unknown): Sentiment | null {
  if (v === "positive" || v === "neutral" || v === "negative" || v === "mixed") return v;
  return null;
}

function coercePriority(v: unknown): SuggestedTask["priority"] {
  if (v === "low" || v === "normal" || v === "high" || v === "urgent") return v;
  return undefined;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Strip null/undefined/empty-string values so a downstream
 * `update_contact` call only sends fields the LLM actually populated.
 */
function sparsifyPatch(patch: unknown, mentioned: Set<string>): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!mentioned.has(k)) continue; // enforce: keys MUST be in mentioned_fields
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

function validateAndCoerce(
  raw: unknown,
  stage?: StageContextForSummary,
): PostConversationSummary {
  const empty: PostConversationSummary = {
    summary: "",
    sentiment: null,
    intent: null,
    mentioned_fields: [],
    crm_patch: {},
    suggested_tasks: [],
    suggested_followup: null,
    status_change: null,
    stage_transition_suggestion: null,
    bonus_highlights: [],
    empty: true,
  };
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  const summary = isNonEmptyString(obj.summary) ? obj.summary.trim() : "";
  if (!summary) return empty;

  const mentioned = Array.isArray(obj.mentioned_fields)
    ? (obj.mentioned_fields.filter(isNonEmptyString) as string[])
    : [];
  const mentionedSet = new Set(mentioned);
  const crm_patch = sparsifyPatch(obj.crm_patch, mentionedSet);

  const tasksRaw = Array.isArray(obj.suggested_tasks) ? obj.suggested_tasks : [];
  const suggested_tasks: SuggestedTask[] = [];
  for (const t of tasksRaw) {
    if (!t || typeof t !== "object") continue;
    const tt = t as Record<string, unknown>;
    if (!isNonEmptyString(tt.subject)) continue;
    suggested_tasks.push({
      subject: tt.subject.trim(),
      body: isNonEmptyString(tt.body) ? tt.body.trim() : undefined,
      priority: coercePriority(tt.priority),
      reason: isNonEmptyString(tt.reason) ? tt.reason.trim() : "post-call recommendation",
    });
  }

  let suggested_followup: SuggestedFollowup | null = null;
  if (obj.suggested_followup && typeof obj.suggested_followup === "object") {
    const f = obj.suggested_followup as Record<string, unknown>;
    if (isNonEmptyString(f.send_at_iso) && isNonEmptyString(f.message)) {
      const parsed = new Date(f.send_at_iso);
      if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()) {
        suggested_followup = {
          send_at_iso: parsed.toISOString(),
          message: f.message.trim(),
          reason: isNonEmptyString(f.reason) ? f.reason.trim() : "customer deferred",
        };
      }
    }
  }

  let status_change: StatusChange | null = null;
  if (obj.status_change && typeof obj.status_change === "object") {
    const s = obj.status_change as Record<string, unknown>;
    if (isNonEmptyString(s.to)) {
      status_change = {
        to: s.to.trim(),
        reason: isNonEmptyString(s.reason) ? s.reason.trim() : "post-call status update",
      };
    }
  }

  // ── bonus_highlights - surface-only, never CRM-written ──
  // Lossy on purpose: trim count to keep the workspace card readable, and
  // drop entries with no label/value. Keys are normalized to snake_case so
  // identical observations across calls can be counted later. We DO NOT
  // cross-check against crm_patch keys - the prompt forbids overlap, and
  // if the LLM duplicates anyway, the structured slot remains
  // authoritative; the bonus is just an extra free-form mirror.
  const bonusRaw = Array.isArray(obj.bonus_highlights) ? obj.bonus_highlights : [];
  const bonus_highlights: BonusHighlight[] = [];
  for (const b of bonusRaw) {
    if (!b || typeof b !== "object") continue;
    const bb = b as Record<string, unknown>;
    if (!isNonEmptyString(bb.label) || !isNonEmptyString(bb.value)) continue;
    const label = bb.label.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!label) continue;
    bonus_highlights.push({
      label,
      value: bb.value.trim(),
      reason: isNonEmptyString(bb.reason) ? bb.reason.trim() : "noted by AI",
    });
    if (bonus_highlights.length >= 8) break;
  }

  // ── stage_transition_suggestion - strict validation ──
  // Reject anything outside the candidate set. Reject when evidence is
  // empty (the LLM didn't justify) or confidence is malformed. The
  // advance-worker further gates by threshold + evidence so even a
  // permissive LLM can't drift a customer through the funnel.
  let stage_transition_suggestion: StageTransitionSuggestion | null = null;
  if (
    stage &&
    stage.candidateStageIds.length > 0 &&
    obj.stage_transition_suggestion &&
    typeof obj.stage_transition_suggestion === "object"
  ) {
    const s = obj.stage_transition_suggestion as Record<string, unknown>;
    const to = isNonEmptyString(s.to) ? s.to.trim() : null;
    const confidenceRaw = typeof s.confidence === "number" ? s.confidence : NaN;
    const evidenceArr = Array.isArray(s.evidence)
      ? (s.evidence.filter(isNonEmptyString) as string[]).map((q) => q.trim())
      : [];
    const metArr = Array.isArray(s.criteriaMet)
      ? (s.criteriaMet.filter(isNonEmptyString) as string[]).map((q) => q.trim())
      : [];
    const missedArr = Array.isArray(s.criteriaMissed)
      ? (s.criteriaMissed.filter(isNonEmptyString) as string[]).map((q) => q.trim())
      : [];
    const reason = isNonEmptyString(s.reason)
      ? s.reason.trim()
      : "post-call stage evaluation";

    const inCandidates = !!to && stage.candidateStageIds.includes(to);
    const validConfidence = Number.isFinite(confidenceRaw) && confidenceRaw >= 0 && confidenceRaw <= 1;
    if (to && inCandidates && validConfidence && evidenceArr.length > 0) {
      stage_transition_suggestion = {
        to,
        confidence: Math.max(0, Math.min(1, confidenceRaw)),
        evidence: evidenceArr.slice(0, 6),
        criteriaMet: metArr.slice(0, 8),
        criteriaMissed: missedArr.slice(0, 8),
        reason,
      };
    }
  }

  return {
    summary,
    sentiment: coerceSentiment(obj.sentiment),
    intent: isNonEmptyString(obj.intent) ? obj.intent.trim() : null,
    mentioned_fields: mentioned,
    crm_patch,
    suggested_tasks,
    suggested_followup,
    status_change,
    stage_transition_suggestion,
    bonus_highlights,
  };
}

export async function summarizePostConversation(params: {
  tenantId: string;
  conversationId: string;
  channel: "voice" | "chat";
  locale?: string;
  allowedFields?: string[];
  model?: string;
  existingActionItems?: ExistingActionItems;
  /**
   * Active pipeline stage + the set of candidate next stages. When supplied,
   * the LLM is asked to evaluate the call against the stage's exit criteria
   * and emit a `stage_transition_suggestion`. Omit for unstaged tenants.
   */
  stage?: StageContextForSummary;
}): Promise<PostConversationSummary> {
  const [transcript, frameCtx] = await Promise.all([
    loadTranscript(params.conversationId, params.tenantId),
    loadFrameContext(params.conversationId),
  ]);

  if (!transcript.trim()) {
    return {
      summary: "",
      sentiment: null,
      intent: null,
      mentioned_fields: [],
      crm_patch: {},
      suggested_tasks: [],
      suggested_followup: null,
      status_change: null,
      stage_transition_suggestion: null,
      bonus_highlights: [],
      empty: true,
    };
  }

  const systemPrompt = buildSystemPrompt({
    transcript,
    locale: params.locale,
    allowedFields: params.allowedFields,
    existingActionItems: params.existingActionItems,
    stage: params.stage,
  });

  const userParts: string[] = [];
  if (frameCtx) userParts.push(frameCtx);
  userParts.push(`## Transcript (${params.channel})`);
  userParts.push(transcript);
  const existingBlock = renderExistingActionItemsBlock(params.existingActionItems);
  if (existingBlock) userParts.push(existingBlock);
  userParts.push(`## Now`);
  userParts.push(new Date().toISOString());

  try {
    const result = await generateResponse({
      tenantId: params.tenantId,
      sessionId: params.conversationId,
      model: params.model || getDefaultModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userParts.join("\n\n") },
      ],
      temperature: 0.2,
      maxTokens: 1100,
      responseFormat: { type: "json_object" },
      metadata: { type: "post_conversation_summary", conversationId: params.conversationId },
    });
    if (!result.content) {
      return validateAndCoerce(null, params.stage);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch (err: any) {
      console.warn(
        "[post-conversation-summarizer] JSON parse failed:",
        err?.message,
        result.content.slice(0, 200),
      );
      return validateAndCoerce(null, params.stage);
    }
    return validateAndCoerce(parsed, params.stage);
  } catch (err: any) {
    console.error("[post-conversation-summarizer] LLM call failed:", err?.message);
    return validateAndCoerce(null, params.stage);
  }
}

/**
 * Render the existing tasks + pending follow-ups for the conversation so the
 * analyst LLM can dedup its suggestions against work already done. Returns
 * null when nothing exists to render.
 */
function renderExistingActionItemsBlock(items?: ExistingActionItems): string | null {
  if (!items) return null;
  const hasTasks = items.tasks.length > 0;
  const hasFollowups = items.pendingFollowups.length > 0;
  if (!hasTasks && !hasFollowups) return null;

  const lines: string[] = ["## Already-covered actions (do NOT propose duplicates by intent)"];
  if (hasTasks) {
    lines.push("", "Tasks already created during this conversation:");
    for (const t of items.tasks) {
      const detail = t.body ? ` - ${t.body}` : "";
      lines.push(`- ${t.subject}${detail}`);
    }
  }
  if (hasFollowups) {
    lines.push("", "Follow-up messages already scheduled (PENDING) to this customer:");
    for (const f of items.pendingFollowups) {
      lines.push(`- [${f.scheduledAt}] ${f.body}`);
    }
  }
  return lines.join("\n");
}
