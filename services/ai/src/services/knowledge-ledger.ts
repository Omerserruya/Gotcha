/**
 * Required-Knowledge Ledger — the deterministic half of the "stop behaving like
 * an FAQ bot" fix.
 *
 * A Skill declares `requiredKnowledge` (machine-readable KnowledgeField[]). Each
 * turn this resolver matches those fields against the resolved facts already in
 * context (CRM snapshot + conversation memory + customer block) and produces a
 * ✓/✗ ledger plus the single most natural next discovery target. That ledger is
 * rendered into the per-TURN block (BLOCK 5) so the model always KNOWS what it
 * still has to learn - instead of hoping the LLM infers it (which is exactly
 * what fails today). The LLM only PHRASES the next question; the gap detection
 * is code.
 *
 * Precision over recall: a field is "known" only when a concrete value for it is
 * present in the resolved-fact text (CRM/memory contain values, not questions).
 * Early in a conversation everything reads as missing → the agent drives
 * discovery. As facts get captured, fields flip to ✓. That is the intended
 * behavior.
 */

import type { KnowledgeField } from "./skills";

export interface LedgerEntry {
  key: string;
  label: string;
  importance: "required" | "preferred";
  /** Discovery priority by business value (lower = chase first). */
  priority: number;
  known: boolean;
}

export interface KnowledgeLedger {
  entries: LedgerEntry[];
  /** First still-missing REQUIRED field, else first missing preferred, else null. */
  nextTarget: LedgerEntry | null;
  hasMissingRequired: boolean;
}

/** Normalize for word-ish substring matching: lowercase, collapse non-alnum. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9֐-׿]+/g, " ");
}

/**
 * Heuristic: a field is "known" if its key, or any of its sourceHints, appears
 * as a token in the resolved-fact text. Matching is conservative on purpose -
 * the fact text (CRM/memory) holds resolved VALUES, so a hit means the concept
 * was actually captured, not merely asked about.
 */
function fieldIsKnown(field: KnowledgeField, factTokens: Set<string>, factText: string): boolean {
  const candidates = [field.key, ...(field.sourceHints ?? [])];
  for (const c of candidates) {
    const tokens = norm(c).split(" ").filter(Boolean);
    if (tokens.length === 0) continue;
    // Single-token hint → token-set membership (fast, precise).
    if (tokens.length === 1) {
      if (factTokens.has(tokens[0])) return true;
    } else {
      // Multi-token hint → require the joined phrase to appear.
      if (factText.includes(tokens.join(" "))) return true;
    }
  }
  return false;
}

export function computeKnowledgeLedger(
  requiredKnowledge: KnowledgeField[],
  factText: string,
): KnowledgeLedger {
  const normalized = norm(factText);
  const factTokens = new Set(normalized.split(" ").filter(Boolean));

  // Sort by business-value priority so the ledger - and the next-target pick -
  // follows what matters most, NOT declaration order.
  const entries: LedgerEntry[] = requiredKnowledge
    .map((f) => ({
      key: f.key,
      label: f.label,
      importance: f.importance,
      priority: f.priority,
      known: fieldIsKnown(f, factTokens, normalized),
    }))
    .sort((a, b) => a.priority - b.priority);

  const missing = entries.filter((e) => !e.known); // already priority-ordered
  const nextTarget =
    missing.find((e) => e.importance === "required") ?? missing[0] ?? null;
  const hasMissingRequired = entries.some((e) => !e.known && e.importance === "required");

  return { entries, nextTarget, hasMissingRequired };
}

/**
 * Render the ledger as the BLOCK 5 markdown the model reads. Returns null when
 * there's nothing to track (no required knowledge for this skill).
 */
export function renderKnowledgeLedger(ledger: KnowledgeLedger): string | null {
  if (ledger.entries.length === 0) return null;

  const lines: string[] = ["# Knowledge Ledger (this turn)"];
  for (const e of ledger.entries) {
    const mark = e.known ? "✓" : "✗";
    const tag = e.known ? "" : e.importance === "required" ? " — MISSING [required]" : " — missing";
    lines.push(`- ${mark} \`${e.key}\` (${e.label})${tag}`);
  }
  if (ledger.nextTarget) {
    lines.push("");
    lines.push(
      `→ Most natural next thing to learn: **${ledger.nextTarget.key}** (${ledger.nextTarget.label}). ` +
        `Weave ONE genuine question toward it into your reply - never dead-end with "anything else?".`,
    );
  }
  return lines.join("\n");
}
