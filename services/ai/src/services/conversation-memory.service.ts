/**
 * Conversation Memory (Task 5).
 *
 * The AI bot already sees the recent message slice every turn, but when a
 * conversation runs long the model starts:
 *   - re-asking questions whose answer is earlier in the transcript
 *   - forgetting facts the customer has explicitly stated (team size, channel, etc.)
 *   - losing the "last outcome" thread (proposed demo, sent quote, deferral, etc.)
 *
 * This module produces a small, deterministic, auditable memory snapshot
 * the prompt builder injects under [Context]. It is NOT a replacement for
 * the message history - it is a *summary* anchored to extracted facts.
 *
 * Design rules:
 *   - Pure extraction over the message history. No LLM call here.
 *   - Closed schemas: facts have a fixed set of slots; intents and outcomes
 *     come from the same enums BEL uses.
 *   - The renderer emits a compact, fact-shaped block - no prose. Prose
 *     summaries drift; this stays anchored to the transcript.
 *   - BEL stays the only decision layer. Memory is *context*, not policy.
 *
 * Where this is consumed:
 *   - prompt-builder injects `memoryBlock` under # Context.
 *   - The injection format is human-readable so a debug-log reader can
 *     diff what the model saw against the actual transcript.
 */

// ─── Schema ────────────────────────────────────────────────

export interface ConversationFacts {
  /** Customer team size (e.g., "5-10"). Extracted from inbound text. */
  teamSize?: string;
  /** Channel/tooling mentioned ("WhatsApp", "Instagram", etc.). */
  currentChannel?: string;
  /** Free-form statement of stated need, copied verbatim from customer. */
  statedNeed?: string;
  /** Last objection the customer raised, verbatim. */
  lastObjection?: string;
  /** Linked email / phone (post-link_customer_identifier). */
  knownEmail?: string;
  knownPhone?: string;
  /** Timezone the customer mentioned (IANA-style if known). */
  timezone?: string;
}

export type PastIntent = "informational" | "transactional" | "support" | "objection" | "deferral" | "decision";

export type LastOutcome =
  | "demo_proposed"
  | "demo_booked"
  | "quote_sent"
  | "deferred"
  | "objection_raised"
  | "objection_handled"
  | "info_shared"
  | "issue_reported"
  | "issue_resolved"
  | "no_response"
  | "none";

export interface ConversationMemory {
  facts: ConversationFacts;
  /** Past intents seen this conversation, oldest → newest, deduped. */
  pastIntents: PastIntent[];
  /** Last meaningful outcome the BEL/tools recorded. */
  lastOutcome: LastOutcome;
  /** Number of turns the conversation has run. */
  turnCount: number;
}

// ─── Inputs ────────────────────────────────────────────────

export interface MemoryInputMessage {
  /** "INBOUND" = customer; "OUTBOUND" = assistant or human. */
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  /** Optional metadata: tool calls fired, BEL outputs, etc. */
  metadata?: {
    intent?: PastIntent;
    outcome?: LastOutcome;
    toolName?: string;
  } | null;
}

export interface BuildMemoryOpts {
  messages: MemoryInputMessage[];
  /** Last linked email/phone - passed in by caller (CRM record). */
  knownEmail?: string;
  knownPhone?: string;
}

// ─── Builder (deterministic) ───────────────────────────────

const TEAM_SIZE_RE = /\b(\d{1,3})\s*(?:people|users|seats|employees|members|אנשים|עובדים|משתמשים)\b/i;
const CHANNEL_RE = /\b(whatsapp|instagram|messenger|telegram|sms|email|אימייל|וואטסאפ|אינסטגרם)\b/i;
const TZ_RE = /\b(UTC[+-]\d{1,2}|GMT[+-]\d{1,2}|EST|PST|CST|IST|IDT|CET|BST)\b/i;

const OBJECTION_MARKERS = [
  "too expensive", "not sure", "concern", "worried",
  "but ", "however,", "not for us",
  "יקר מדי", "לא בטוח", "לא מתאים",
];
const DEFER_MARKERS = [
  "let me think", "i'll get back", "later", "next week",
  "אחזור אליך", "אחשוב על זה", "בהמשך",
];
const DECIDE_MARKERS = [
  "let's do it", "i'm in", "sign me up", "ready to start",
  "אני בפנים", "אני רוצה", "מוכן להתחיל",
];

export function buildConversationMemory(opts: BuildMemoryOpts): ConversationMemory {
  const facts: ConversationFacts = {};
  const intents: PastIntent[] = [];
  let lastOutcome: LastOutcome = "none";

  if (opts.knownEmail) facts.knownEmail = opts.knownEmail;
  if (opts.knownPhone) facts.knownPhone = opts.knownPhone;

  for (const m of opts.messages) {
    const body = (m.body || "").trim();
    if (!body) continue;

    // BEL/runtime-tagged metadata wins - explicit > heuristic.
    if (m.metadata?.intent && !intents.includes(m.metadata.intent)) intents.push(m.metadata.intent);
    if (m.metadata?.outcome) lastOutcome = m.metadata.outcome;

    if (m.direction !== "INBOUND") continue;

    // Heuristic facts - first occurrence wins (oldest).
    if (!facts.teamSize) {
      const ts = body.match(TEAM_SIZE_RE);
      if (ts) facts.teamSize = ts[1];
    }
    if (!facts.currentChannel) {
      const ch = body.match(CHANNEL_RE);
      if (ch) facts.currentChannel = ch[1];
    }
    if (!facts.timezone) {
      const tz = body.match(TZ_RE);
      if (tz) facts.timezone = tz[1].toUpperCase();
    }

    const lower = body.toLowerCase();

    // Heuristic intents - record only if metadata didn't already say.
    if (!m.metadata?.intent) {
      if (containsAny(lower, OBJECTION_MARKERS)) {
        if (!intents.includes("objection")) intents.push("objection");
        // First objection wins - later "but" matches are weaker signals.
        if (!facts.lastObjection) facts.lastObjection = capLen(body, 140);
      }
      if (containsAny(lower, DEFER_MARKERS)) {
        if (!intents.includes("deferral")) intents.push("deferral");
      }
      if (containsAny(lower, DECIDE_MARKERS)) {
        if (!intents.includes("decision")) intents.push("decision");
      }
    }

    // \b boundaries don't work for Hebrew - match without them on the Hebrew side.
    if (
      !facts.statedNeed &&
      (/\b(i need|i want|i'm looking for)\b/i.test(body) ||
        /(אני צריך|אני רוצה|מחפש|מחפשת)/.test(body))
    ) {
      facts.statedNeed = capLen(body, 160);
    }
  }

  return {
    facts,
    pastIntents: intents,
    lastOutcome,
    turnCount: opts.messages.filter((m) => (m.body || "").trim()).length,
  };
}

// ─── Renderer (prompt-injection format) ────────────────────

/**
 * Compact memory block. Empty fields are dropped. The shape is fact-shaped
 * (key: value) so the model treats it as ground truth, not narrative.
 *
 * Returned string MUST stay short: it's prepended to every turn. If a tenant
 * needs a fuller summary they can run a separate summarizer at session end.
 */
export function renderMemoryBlock(mem: ConversationMemory): string {
  const lines: string[] = ["## Memory"];

  const f = mem.facts;
  const factLines: string[] = [];
  if (f.knownEmail) factLines.push(`- email: ${f.knownEmail}`);
  if (f.knownPhone) factLines.push(`- phone: ${f.knownPhone}`);
  if (f.teamSize) factLines.push(`- team_size: ${f.teamSize}`);
  if (f.currentChannel) factLines.push(`- current_channel: ${f.currentChannel}`);
  if (f.timezone) factLines.push(`- timezone: ${f.timezone}`);
  if (f.statedNeed) factLines.push(`- stated_need: "${f.statedNeed}"`);
  if (f.lastObjection) factLines.push(`- last_objection: "${f.lastObjection}"`);
  if (factLines.length) {
    lines.push("Known facts:");
    lines.push(...factLines);
  }

  if (mem.pastIntents.length) {
    lines.push(`Past intents: ${mem.pastIntents.join(" → ")}`);
  }
  if (mem.lastOutcome !== "none") {
    lines.push(`Last outcome: ${mem.lastOutcome}`);
  }
  lines.push(`Turn count: ${mem.turnCount}`);

  lines.push(
    "",
    "Use these facts as ground truth. Do NOT re-ask questions whose answer is in `Known facts`. " +
      "If a fact appears stale or contradicts the latest message, trust the latest message and " +
      "(silently) update it via the appropriate tool.",
  );

  return lines.join("\n");
}

// ─── Helpers ───────────────────────────────────────────────

function containsAny(text: string, markers: string[]): boolean {
  for (const m of markers) if (text.includes(m)) return true;
  return false;
}

function capLen(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}
