/**
 * Post-conversation summarizer.
 *
 * Runs once at end-of-conversation (voice hang-up or chat closed) and produces
 * a STRUCTURED summary the post-conversation pipeline can act on:
 *   - finalSummary text (still human-readable, for the workspace card)
 *   - sparse crm_patch (ONLY fields actually discussed in this conversation —
 *     never touch CRM fields the customer/agent did not mention)
 *   - suggested_tasks   (free-form proposals, surfaced for approval)
 *   - suggested_followup (defers turn into schedule_followup proposals)
 *   - status_change      (optional lead-status transition)
 *
 * The sparse-patch contract is enforced in two layers:
 *   1. Prompt — the LLM is told to OMIT any field not explicitly discussed.
 *   2. Validation — we strip null/empty values before persisting, and we
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

export interface PostConversationSummary {
  summary: string;
  sentiment: Sentiment | null;
  intent: string | null;
  mentioned_fields: string[];
  crm_patch: Record<string, unknown>;
  suggested_tasks: SuggestedTask[];
  suggested_followup: SuggestedFollowup | null;
  status_change: StatusChange | null;
  /** Set true when the LLM call failed or produced no usable output. */
  empty?: boolean;
}

interface BuildPromptArgs {
  transcript: string;
  locale?: string;
  allowedFields?: string[];
  existingActionItems?: ExistingActionItems;
}

function buildSystemPrompt({ allowedFields, locale, existingActionItems }: BuildPromptArgs): string {
  const lines: string[] = [
    "You are a post-conversation analyst. The customer interaction has ENDED.",
    "Your job is to produce a STRUCTURED JSON summary that downstream automations consume.",
    "",
    "CRITICAL — SPARSE PATCH RULE:",
    "- The CRM record already holds information from prior conversations.",
    "- You MUST ONLY include fields in `crm_patch` that were EXPLICITLY discussed in THIS conversation.",
    "- If the customer did not mention their budget in this conversation, do NOT include 'budget' in crm_patch — even if it would be useful.",
    "- Missing/omitted keys = leave the existing record untouched. Never null out a field to 'clear' it.",
    "- Every key in `crm_patch` MUST also appear in `mentioned_fields`.",
    "",
    "Output JSON shape (return EXACTLY this shape — omit a key by setting it to null or []):",
    "{",
    '  "summary": "2-4 sentence plain-text summary of what happened",',
    '  "sentiment": "positive" | "neutral" | "negative" | "mixed" | null,',
    '  "intent": "short label e.g. pricing_inquiry, support_complaint, ready_to_buy, ..." | null,',
    '  "mentioned_fields": ["budget", "timeline", ...],',
    '  "crm_patch": { /* sparse — only keys from mentioned_fields */ },',
    '  "suggested_tasks": [ { "subject": "...", "body": "...", "priority": "low|normal|high|urgent", "reason": "why" } ],',
    '  "suggested_followup": { "send_at_iso": "ISO-8601", "message": "ready-to-send text", "reason": "why" } | null,',
    '  "status_change": { "to": "qualified|disqualified|nurture|...", "reason": "why" } | null',
    "}",
    "",
    "RULES:",
    "- Be conservative. When in doubt, OMIT the field (leave it for a human).",
    "- `suggested_followup` ONLY when the customer explicitly deferred or asked for a callback at a specific time.",
    "- `status_change` ONLY when the conversation gave you direct evidence (explicit buy intent, hard rejection, etc.).",
    "- Tasks should be specific and actionable ('Send Q3 pricing PDF to Acme'), not vague ('follow up').",
  ];

  // Intent-aware dedup: if the bot already created tasks or scheduled
  // follow-ups during the conversation, the analyst LLM gets to see them
  // and must NOT propose new ones that cover the same intent.
  const hasExisting =
    (existingActionItems?.tasks.length ?? 0) > 0 ||
    (existingActionItems?.pendingFollowups.length ?? 0) > 0;
  if (hasExisting) {
    lines.push(
      "",
      "DEDUP RULE — already-covered actions:",
      "- Below is the list of tasks and scheduled follow-ups that were ALREADY created during this conversation (by the bot or a human agent).",
      "- Compare your proposed `suggested_tasks` and `suggested_followup` to that list by INTENT, not by literal wording.",
      "- A task like 'Send pricing PDF' is the SAME as 'Email Q3 pricing document' — DO NOT propose it again.",
      "- A scheduled callback at the same approximate time covers any follow-up you'd otherwise suggest — do NOT propose a duplicate.",
      "- ONLY suggest tasks/follow-ups that are NOT covered by the existing list.",
      "- If everything is already covered, return `suggested_tasks: []` and `suggested_followup: null`.",
    );
  }

  if (allowedFields && allowedFields.length > 0) {
    lines.push("", "ALLOWED CRM FIELD KEYS (use only these names in crm_patch + mentioned_fields):");
    for (const f of allowedFields) lines.push(`- ${f}`);
  }
  if (locale && locale !== "en") {
    lines.push("", `Write \`summary\` and the \`message\` field of \`suggested_followup\` in: ${locale}.`);
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

function validateAndCoerce(raw: unknown): PostConversationSummary {
  const empty: PostConversationSummary = {
    summary: "",
    sentiment: null,
    intent: null,
    mentioned_fields: [],
    crm_patch: {},
    suggested_tasks: [],
    suggested_followup: null,
    status_change: null,
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

  return {
    summary,
    sentiment: coerceSentiment(obj.sentiment),
    intent: isNonEmptyString(obj.intent) ? obj.intent.trim() : null,
    mentioned_fields: mentioned,
    crm_patch,
    suggested_tasks,
    suggested_followup,
    status_change,
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
      empty: true,
    };
  }

  const systemPrompt = buildSystemPrompt({
    transcript,
    locale: params.locale,
    allowedFields: params.allowedFields,
    existingActionItems: params.existingActionItems,
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
      model: params.model || getDefaultModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userParts.join("\n\n") },
      ],
      temperature: 0.2,
      maxTokens: 800,
      responseFormat: { type: "json_object" },
      metadata: { type: "post_conversation_summary", conversationId: params.conversationId },
    });
    if (!result.content) {
      return validateAndCoerce(null);
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
      return validateAndCoerce(null);
    }
    return validateAndCoerce(parsed);
  } catch (err: any) {
    console.error("[post-conversation-summarizer] LLM call failed:", err?.message);
    return validateAndCoerce(null);
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
      const detail = t.body ? ` — ${t.body}` : "";
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
