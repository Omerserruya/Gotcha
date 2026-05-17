/**
 * Post-Conversation Rule Engine.
 *
 * Runs AFTER the summarizer produces a structured summary, BEFORE the
 * action-executor consumes it. Two responsibilities:
 *   1. taskRules — append tenant-defined tasks when their `when` clause matches.
 *   2. crmRules  — merge tenant-defined CRM patches when their `when` clause
 *      matches.
 *
 * Sparse-patch contract: rules only ADD entries.
 *   - Task rule appends never deduplicate-then-overwrite: if the AI already
 *     proposed a task with the same subject, the rule is skipped.
 *   - CRM rule patches never overwrite a key the AI already populated (the
 *     AI's evidence-grounded extraction wins over the rule's blanket inference).
 *
 * Audit trail: each applied rule contributes to `applied_rules` on the
 * returned summary so the executor can log which rules fired and why.
 */

import type { PostConversationSummary } from "./post-conversation-summarizer.service";
import type {
  PostConversationConfig,
  TaskRule,
  CrmRule,
} from "./post-conversation-config.service";

export interface RuleApplication {
  ruleId: string;
  kind: "task" | "crm";
  why: string;
}

export interface PostConversationSummaryWithRules extends PostConversationSummary {
  applied_rules?: RuleApplication[];
}

function whenMatches(
  when: TaskRule["when"] | CrmRule["when"],
  summary: PostConversationSummary,
  transcript: string,
): boolean {
  // intent — either equals `when.intent` OR is in `when.intents[]`.
  if (when.intent && summary.intent !== when.intent) return false;
  if (when.intents && when.intents.length > 0) {
    if (!summary.intent || !when.intents.includes(summary.intent)) return false;
  }
  // sentiment — exact match if specified.
  if (when.sentiment && summary.sentiment !== when.sentiment) return false;
  // keywords — case-insensitive substring on the transcript. ALL keywords
  // must appear (AND). Empty/missing array = no keyword constraint.
  if (when.keywords && when.keywords.length > 0) {
    const lower = transcript.toLowerCase();
    for (const kw of when.keywords) {
      if (!lower.includes(kw.toLowerCase())) return false;
    }
  }
  return true;
}

export function applyPostConversationRules(
  summary: PostConversationSummary,
  config: PostConversationConfig,
  opts: { transcript?: string } = {},
): PostConversationSummaryWithRules {
  if (summary.empty) return summary;
  const transcript = opts.transcript ?? "";
  const applied: RuleApplication[] = [];

  // Clone defensively so callers can compare before/after.
  const out: PostConversationSummaryWithRules = {
    ...summary,
    crm_patch: { ...summary.crm_patch },
    suggested_tasks: summary.suggested_tasks.slice(),
    mentioned_fields: summary.mentioned_fields.slice(),
  };

  // Task rules.
  const existingSubjects = new Set(out.suggested_tasks.map((t) => t.subject.toLowerCase().trim()));
  for (const rule of config.taskRules) {
    if (!whenMatches(rule.when, summary, transcript)) continue;
    const key = rule.task.subject.toLowerCase().trim();
    if (!key || existingSubjects.has(key)) {
      applied.push({ ruleId: rule.id, kind: "task", why: "skipped:duplicate" });
      continue;
    }
    existingSubjects.add(key);
    out.suggested_tasks.push({
      subject: rule.task.subject,
      body: rule.task.body,
      priority: rule.task.priority,
      reason: `rule:${rule.id}`,
    });
    applied.push({ ruleId: rule.id, kind: "task", why: "applied" });
  }

  // CRM rules — never overwrite keys the AI populated.
  const aiKeys = new Set(Object.keys(summary.crm_patch));
  const mentionedSet = new Set(out.mentioned_fields);
  for (const rule of config.crmRules) {
    if (!whenMatches(rule.when, summary, transcript)) continue;
    let mergedCount = 0;
    for (const [k, v] of Object.entries(rule.patch ?? {})) {
      if (aiKeys.has(k)) continue; // AI wins
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.trim() === "") continue;
      out.crm_patch[k] = v;
      if (!mentionedSet.has(k)) {
        mentionedSet.add(k);
        out.mentioned_fields.push(k);
      }
      mergedCount++;
    }
    applied.push({
      ruleId: rule.id,
      kind: "crm",
      why: mergedCount > 0 ? `applied:${mergedCount}` : "skipped:all-keys-occupied",
    });
  }

  if (applied.length > 0) out.applied_rules = applied;
  return out;
}
