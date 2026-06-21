/**
 * OBJECTIVE ENGINE — WHAT the employee is trying to achieve.
 *
 * Skills (skills.ts) define HOW the employee behaves. Objectives define the
 * concrete business outcome the turn is driving toward. A role has an ordered
 * objective CHAIN; the ACTIVE objective is the first one in the chain that
 * isn't complete yet, given prospect state + the facts already gathered. The
 * active objective is rendered as an Objective Ledger beside the Knowledge
 * Ledger (BLOCK 5), and gates the runtime passive-closer check: a live sales
 * conversation may not end while a revenue objective is still incomplete.
 *
 * Completion is detected from the same resolved-fact text the Knowledge Ledger
 * uses (CRM + memory + customer block). For action objectives (BOOK_MEETING,
 * CREATE_DEAL) info-presence is a PROXY for completion - the real completion is
 * a tool success, enforced separately by the dispatch path; the proxy is good
 * enough to keep the agent driving toward the action and to gate the closer.
 */

import type { KnowledgeField, SkillName } from "./skills";
import { roleToSkill } from "./skills";
import { computeKnowledgeLedger } from "./knowledge-ledger";
import type { ProspectState } from "./prospect-state";

export type ObjectiveName =
  | "GENERATE_LEAD"
  | "QUALIFY_LEAD"
  | "BOOK_MEETING"
  | "CREATE_DEAL"
  | "RESOLVE_ISSUE"
  | "COLLECT_CONTACT";

export interface ObjectiveModule {
  id: ObjectiveName;
  mission: string;
  /** Info needed to complete the objective - matched against fact text. */
  requiredInformation: KnowledgeField[];
  completionCriteria: string[];
  nextStepLogic: string;
  failureCriteria: string[];
  /**
   * When true, ending the conversation with a passive closer while this
   * objective is incomplete is a runtime VIOLATION (regenerate). Revenue
   * objectives are true; RESOLVE_ISSUE is false (support may close when the
   * customer is genuinely done).
   */
  blockPassiveClose: boolean;
  /** The tool whose success truly completes this objective, if any. */
  completionTool?: string;
}

const GENERATE_LEAD: ObjectiveModule = {
  id: "GENERATE_LEAD",
  mission:
    "Turn an unknown prospect into a lead: learn who they are, how to reach them, and what they need - enough to create a CRM lead.",
  requiredInformation: [
    { key: "contact_name", label: "the person's name", importance: "required", priority: 1, sourceHints: ["name", "contactName", "fullName", "firstName"] },
    { key: "contact_method", label: "a way to reach them (email or phone)", importance: "required", priority: 2, sourceHints: ["email", "phone", "mobile", "contactMethod"] },
    { key: "business_type", label: "what their business does", importance: "required", priority: 3, sourceHints: ["industry", "company", "businessType"] },
    { key: "interest", label: "what they're interested in / why they reached out", importance: "preferred", priority: 4, sourceHints: ["interest", "need", "painPoints"] },
  ],
  completionCriteria: [
    "You know who they are (a name) and how to reach them (email or phone)",
    "You have a rough sense of their business and what they want",
    "Enough is known to create or enrich a CRM lead in the background",
  ],
  nextStepLogic:
    "Weave in ONE natural question for the most valuable missing piece (name → contact → business → interest). Once you have a name + a way to reach them + their interest, the lead can be created silently and you advance to QUALIFY_LEAD.",
  failureCriteria: [
    "Let a NEW prospect leave without learning their name or any way to reach them",
    "Gave a passive close to an unidentified prospect",
    "Treated an interested but anonymous prospect as a finished conversation",
  ],
  blockPassiveClose: true,
  completionTool: "integration_create_lead",
};

const QUALIFY_LEAD: ObjectiveModule = {
  id: "QUALIFY_LEAD",
  mission: "Qualify the opportunity: understand need, authority, timeline, and budget.",
  requiredInformation: [
    { key: "need", label: "the problem they're solving", importance: "required", priority: 1, sourceHints: ["need", "painPoints"] },
    { key: "authority", label: "who owns the decision", importance: "required", priority: 2, sourceHints: ["authority", "title", "role"] },
    { key: "timeline", label: "when they want to act", importance: "required", priority: 3, sourceHints: ["timeline", "timeframe"] },
    { key: "budget", label: "whether budget exists / range", importance: "preferred", priority: 4, sourceHints: ["budget"] },
  ],
  completionCriteria: [
    "You understand their real need",
    "You know who decides and roughly when they'd act",
  ],
  nextStepLogic:
    "Probe one dimension at a time, anchored to what they said. When need + authority + timeline are credible, propose a meeting/demo (BOOK_MEETING).",
  failureCriteria: [
    "Pitched a solution before qualifying",
    "Ended a qualifiable conversation without learning need or decision process",
  ],
  blockPassiveClose: true,
};

const BOOK_MEETING: ObjectiveModule = {
  id: "BOOK_MEETING",
  mission: "Get a qualified meeting (demo/call) on the calendar with the right person.",
  requiredInformation: [
    { key: "meeting_interest", label: "agreement to meet / see a demo", importance: "required", priority: 1, sourceHints: ["meeting", "demo", "call"] },
    { key: "attendee_email", label: "an email to send the invite", importance: "required", priority: 2, sourceHints: ["email"] },
    { key: "preferred_time", label: "a preferred time / availability", importance: "preferred", priority: 3, sourceHints: ["time", "availability", "slot"] },
  ],
  completionCriteria: [
    "The customer agreed to a meeting and a time",
    "The booking tool returned success this turn",
  ],
  nextStepLogic:
    "Propose concrete times; once they agree and you have an email, book it. Never end without at least proposing the meeting as the next step.",
  failureCriteria: [
    "Ended a qualified conversation without proposing a meeting",
    "Claimed a meeting was booked without a tool success",
  ],
  blockPassiveClose: true,
  completionTool: "schedule_meeting",
};

const CREATE_DEAL: ObjectiveModule = {
  id: "CREATE_DEAL",
  mission: "Capture the opportunity as a deal: what they want to buy and rough scope.",
  requiredInformation: [
    { key: "product_interest", label: "the product/plan they want", importance: "required", priority: 1, sourceHints: ["product", "plan", "interest"] },
    { key: "deal_scope", label: "rough scope / size / value", importance: "preferred", priority: 2, sourceHints: ["scope", "seats", "value", "budget"] },
  ],
  completionCriteria: [
    "A deal/opportunity is captured with the product and rough scope",
  ],
  nextStepLogic:
    "Confirm what they want to buy and create the opportunity in the background, then set the next milestone (proposal, contract, follow-up).",
  failureCriteria: [
    "Qualified with a meeting booked but no opportunity captured",
  ],
  blockPassiveClose: true,
  completionTool: "integration_create_deal",
};

const RESOLVE_ISSUE: ObjectiveModule = {
  id: "RESOLVE_ISSUE",
  mission: "Resolve the customer's issue (or escalate cleanly), and verify it's resolved.",
  requiredInformation: [
    { key: "issue", label: "what exactly is going wrong", importance: "required", priority: 1, sourceHints: ["issue", "subject"] },
    { key: "environment", label: "relevant account / order / environment", importance: "required", priority: 2, sourceHints: ["orderId", "account", "plan"] },
  ],
  completionCriteria: [
    "The issue is understood and resolved (or escalated with full context)",
    "The customer confirmed it's resolved",
  ],
  nextStepLogic:
    "Diagnose, resolve or escalate, then verify. Close only after the customer confirms resolution.",
  failureCriteria: ["Closed without verifying the fix"],
  // Support may close when the customer is genuinely done - do NOT hard-block.
  blockPassiveClose: false,
};

const COLLECT_CONTACT: ObjectiveModule = {
  id: "COLLECT_CONTACT",
  mission: "Capture a way to reach the person before the conversation ends.",
  requiredInformation: [
    { key: "contact_name", label: "the person's name", importance: "required", priority: 1, sourceHints: ["name", "contactName", "firstName"] },
    { key: "contact_method", label: "an email or phone to reach them", importance: "required", priority: 2, sourceHints: ["email", "phone", "mobile"] },
  ],
  completionCriteria: ["You have their name and a way to reach them"],
  nextStepLogic: "Before the conversation ends, naturally get a name and an email or phone.",
  failureCriteria: ["Let an interested person leave with no way to reach them"],
  blockPassiveClose: true,
  completionTool: "integration_create_contact",
};

export const OBJECTIVES: Record<ObjectiveName, ObjectiveModule> = {
  GENERATE_LEAD,
  QUALIFY_LEAD,
  BOOK_MEETING,
  CREATE_DEAL,
  RESOLVE_ISSUE,
  COLLECT_CONTACT,
};

/** Ordered objective chain per skill. The active objective is the first
 * incomplete one. */
export const OBJECTIVE_CHAINS: Record<SkillName, ObjectiveName[]> = {
  SALES: ["GENERATE_LEAD", "QUALIFY_LEAD", "BOOK_MEETING", "CREATE_DEAL"],
  SDR: ["GENERATE_LEAD", "QUALIFY_LEAD", "BOOK_MEETING"],
  SUPPORT: ["RESOLVE_ISSUE"],
  RECEPTIONIST: ["COLLECT_CONTACT"],
  CUSTOMER_SUCCESS: ["BOOK_MEETING"],
  GENERIC: ["COLLECT_CONTACT"],
};

export interface ObjectiveStatus {
  objective: ObjectiveModule;
  stepIndex: number; // 0-based position in the chain
  chain: ObjectiveName[];
  /** Required-info entries for the active objective, ✓/✗. */
  missingRequired: string[];
}

function objectiveComplete(
  obj: ObjectiveModule,
  prospectState: ProspectState,
  factText: string,
): boolean {
  // A lead already exists → GENERATE_LEAD is satisfied by definition.
  if (obj.id === "GENERATE_LEAD" && prospectState !== "NEW_PROSPECT") return true;
  const ledger = computeKnowledgeLedger(obj.requiredInformation, factText);
  return !ledger.hasMissingRequired;
}

// Explicit meeting/scheduling intent in the resolved-fact text (which now
// includes the live transcript). Bilingual; deliberately broad — it only
// PROMOTES booking when identity is ALSO captured, so a false positive can't
// skip lead capture.
const MEETING_INTENT_RE =
  /\b(meeting|meet|call|demo|zoom|schedule|set\s*up\s+a|booking|book a|appointment|availability|calendar)\b|פגיש|להיפגש|לתאם|לקבוע|נקבע|נדבר|זימון|יומן|דמו|(מתי).{0,12}(פנוי|אפשר|נוכל|מתאים)|פנוי\b/i;

function customerRequestedMeeting(factText: string): boolean {
  return MEETING_INTENT_RE.test(factText);
}

// Lead identity = a name AND a way to reach them. Reuses the ledger matcher so
// it reads the same fact text everything else does.
// Value patterns so identity is detected from real VALUES, not just the English
// hint words. A Hebrew chat (or a verbatim email/phone) never contains the token
// "email"/"phone", which wrongly read as "no way to reach them" and blocked the
// BOOK_MEETING promotion (observed: omer gave an email + had a WhatsApp number,
// yet the agent kept qualifying and never offered to book).
const CONTACT_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CONTACT_PHONE_RE = /\+?\d[\d\s().-]{6,}\d/;

function leadIdentityReady(factText: string): boolean {
  const ledger = computeKnowledgeLedger(
    [
      { key: "name", label: "Name", importance: "required", priority: 1, sourceHints: ["name", "contactName", "fullName", "firstName"] },
      { key: "contact", label: "Contact", importance: "required", priority: 2, sourceHints: ["email", "phone", "mobile", "whatsapp"] },
    ],
    factText,
  );
  const known = (k: string) => ledger.entries.find((e) => e.key === k)?.known ?? false;
  // Contact is ready when the hint word OR a real email/phone VALUE is present.
  const hasContact = known("contact") || CONTACT_EMAIL_RE.test(factText) || CONTACT_PHONE_RE.test(factText);
  return known("name") && hasContact;
}

/**
 * The active objective for this turn = first incomplete objective in the role's
 * chain. Returns null when every objective in the chain is complete.
 */
export function selectActiveObjective(
  role: string | null | undefined,
  prospectState: ProspectState,
  factText: string,
): ObjectiveStatus | null {
  const skill: SkillName = roleToSkill(role);
  const chain = OBJECTIVE_CHAINS[skill];

  // ── Natural-progression override (do not block a ready buyer) ──
  // When the customer has EXPLICITLY asked to meet AND lead identity (name +
  // contact) is already captured, promote BOOK_MEETING even if an upstream
  // objective (e.g. full QUALIFY_LEAD) isn't complete. Booking is itself how the
  // remaining qualification happens; stalling an eager buyer on a missing
  // `authority`/`timeline`/`business_type` is the regression we're fixing. Only
  // applies when BOOK_MEETING is in this skill's chain and isn't already done.
  const bookIdx = chain.indexOf("BOOK_MEETING");
  if (bookIdx >= 0 && customerRequestedMeeting(factText) && leadIdentityReady(factText)) {
    const book = OBJECTIVES.BOOK_MEETING;
    if (!objectiveComplete(book, prospectState, factText)) {
      const ledger = computeKnowledgeLedger(book.requiredInformation, factText);
      const missingRequired = ledger.entries
        .filter((e) => !e.known && e.importance === "required")
        .map((e) => e.key);
      return { objective: book, stepIndex: bookIdx, chain, missingRequired };
    }
  }

  for (let i = 0; i < chain.length; i++) {
    const obj = OBJECTIVES[chain[i]];
    if (objectiveComplete(obj, prospectState, factText)) continue;
    const ledger = computeKnowledgeLedger(obj.requiredInformation, factText);
    const missingRequired = ledger.entries
      .filter((e) => !e.known && e.importance === "required")
      .map((e) => e.key);
    return { objective: obj, stepIndex: i, chain, missingRequired };
  }
  return null;
}

/**
 * Render the Objective Ledger for BLOCK 5. Returns null when the role has no
 * chain or every objective is complete (caller renders a "may close" note).
 */
export function renderObjectiveLedger(
  status: ObjectiveStatus | null,
  factText: string,
): string | null {
  if (!status) {
    return [
      "# Objective Ledger (this turn)",
      "All objectives for this conversation are complete. You may close naturally - with a clear summary and a concrete next step, never a passive 'anything else?'.",
    ].join("\n");
  }

  const { objective: obj, stepIndex, chain } = status;
  const ledger = computeKnowledgeLedger(obj.requiredInformation, factText);
  const lines: string[] = ["# Objective Ledger (this turn)"];
  lines.push(`Active objective: **${obj.id}** — ${obj.mission}`);
  lines.push("");
  // Hard ordering: everything BEFORE the active step is complete; everything
  // AFTER is LOCKED. The active objective is the only one to pursue this turn.
  lines.push(`Chain progress (step ${stepIndex + 1}/${chain.length}):`);
  for (let i = 0; i < chain.length; i++) {
    if (i < stepIndex) lines.push(`- ✓ ${chain[i]} (done)`);
    else if (i === stepIndex) lines.push(`- ▶ ${chain[i]} (ACTIVE — work this now)`);
    else lines.push(`- 🔒 ${chain[i]} (locked — do not pursue yet)`);
  }
  lines.push("");
  lines.push(
    "⛔ HARD ORDER: pursue ONLY the active objective. Do NOT jump to, propose, or act on a 🔒 locked objective " +
      "(e.g. proposing/booking a meeting, or creating a deal) until every objective above it is complete. " +
      "Premature jumping ahead is a failure.",
  );
  lines.push("");
  lines.push("Required to complete:");
  for (const e of ledger.entries) {
    const mark = e.known ? "✓" : "✗";
    const tag = e.known ? "" : e.importance === "required" ? " — MISSING [required]" : " — missing";
    lines.push(`- ${mark} \`${e.key}\` (${e.label})${tag}`);
  }
  lines.push("");
  lines.push("Completion criteria:");
  for (const c of obj.completionCriteria) lines.push(`- ${c}`);
  lines.push("");
  lines.push(`Next step: ${obj.nextStepLogic}`);
  if (obj.blockPassiveClose) {
    lines.push("");
    lines.push(
      "⛔ This objective is INCOMPLETE. Do NOT end the conversation or use a passive closer ('anything else?', 'I'm here if you need anything'). Make ONE concrete move toward the next missing item above.",
    );
  }
  return lines.join("\n");
}

// ─── Lead Identity sub-ledger ────────────────────────────────────────────
//
// Makes lead-creation field completion VISIBLE and per-field, so the agent
// naturally drives toward the missing pieces instead of relying on the model to
// remember to collect them. Email and phone are split (the combined
// `contact_method` in GENERATE_LEAD hides which one is missing). Rendered while
// the lead is still being generated (active objective GENERATE_LEAD).

const LEAD_IDENTITY_FIELDS: KnowledgeField[] = [
  { key: "name", label: "Name", importance: "required", priority: 1, sourceHints: ["name", "contactName", "fullName", "firstName"] },
  { key: "email", label: "Email", importance: "required", priority: 2, sourceHints: ["email"] },
  { key: "phone", label: "Phone", importance: "required", priority: 3, sourceHints: ["phone", "mobile", "whatsapp"] },
  { key: "interest", label: "Interest", importance: "preferred", priority: 4, sourceHints: ["interest", "need", "painPoints"] },
];

/** True when the Lead Identity sub-ledger is worth showing — i.e. the active
 * objective is the lead-capture one. */
export function shouldRenderLeadIdentity(status: ObjectiveStatus | null): boolean {
  return !!status && (status.objective.id === "GENERATE_LEAD" || status.objective.id === "COLLECT_CONTACT");
}

/** Render an explicit Name / Email / Phone / Interest checklist from fact text. */
export function renderLeadIdentityLedger(factText: string): string {
  const ledger = computeKnowledgeLedger(LEAD_IDENTITY_FIELDS, factText);
  const byKey = new Map(ledger.entries.map((e) => [e.key, e]));
  const mark = (k: string) => (byKey.get(k)?.known ? "✓" : "✗");
  return [
    "## Lead Identity (capture before the lead can be created)",
    `- ${mark("name")} Name`,
    `- ${mark("email")} Email`,
    `- ${mark("phone")} Phone`,
    `- ${mark("interest")} Interest`,
    "",
    "To create the lead silently you need a Name + at least ONE of (Email / Phone) + their Interest. " +
      "Weave the missing item(s) into the conversation naturally — one at a time, never as a form. " +
      "Do not move toward booking a meeting until the lead identity is captured.",
  ].join("\n");
}

// ─── Runtime passive-closer gate ────────────────────────────────────────
//
// A LAST-LINE, programmatic enforcement (prompt instructions alone don't stop
// the model — see the real WhatsApp regression). When an objective that must
// not be abandoned is still incomplete and the model tried to passive-close a
// live conversation, the caller regenerates once with `buildCloserCorrective`.

const PASSIVE_CLOSER_PATTERNS: RegExp[] = [
  // Hebrew
  /אני כאן(?! כדי לוודא)/,             // "אני כאן בשבילך / לעזור / לכל שאלה"
  /אם יש (לך )?שאלות נוספות/,
  /אם יש משהו (נוסף|אחר)/,
  /אל תהסס[יו]?/,
  /תמיד אפשר לפנות/,
  /נשמח לעמוד לרשות/,
  /לכל שאלה אני (כאן|זמין)/,
  // English
  /\bi'?m here (if|to help|for you|whenever)\b/i,
  /\bfeel free to reach out\b/i,
  /\b(is there )?anything else( i can help| you'?d like)?\b/i,
  /\blet me know if you (need|have)\b/i,
  /\bdon'?t hesitate to\b/i,
  /\bhappy to help (if|whenever|with anything)\b/i,
];

/** True when the reply leans on a generic availability closer instead of
 * advancing. Conservative-but-eager: any closer phrase present trips it. */
export function isPassiveCloser(reply: string | null | undefined): boolean {
  if (!reply || !reply.trim()) return false;
  return PASSIVE_CLOSER_PATTERNS.some((re) => re.test(reply));
}

// Generic service-desk openers that DON'T advance a revenue objective. For a
// sales/SDR rep who still knows nothing about the prospect, opening with "how
// can I help?" is as passive as closing with "anything else?" — it hands the
// lead back to the customer instead of leading. The model defaults to these on
// vague first messages (real GOTCHA regression: "כאן דניאל מצוות GOTCHA. במה
// אוכל לעזור היום?"). Treated as non-advancing so the same regen gate fires.
// Generic "how can I help?" openers in every phrasing (Hebrew: איך/במה/כיצד +
// יכול/אוכל/אפשר/נוכל + לעזור/לסייע; English: how can/may I help/assist, what
// can I do). Matched broadly — the "dominant content" guard below prevents
// false positives on substantive leading replies.
const GENERIC_HELP_OPENER_PATTERNS: RegExp[] = [
  /(איך|במה|כיצד)\s+(אני\s+)?(יכול|אוכל|אפשר|נוכל)\s+(לעזור|לסייע)/,
  /\bhow (can|may) i (help|assist)\b/i,
  /\bwhat can i (do|help)\b/i,
];

/** A reply that hands control back to the customer instead of advancing the
 * objective — either a passive availability CLOSER ("anything else?") or a
 * generic "how can I help?" OPENER that's the whole message. The opener only
 * counts when it's the DOMINANT content (a short greeting with no product
 * explanation or discovery question); a long reply that explains the offer or
 * asks about the customer's business is leading and passes. Used by the runtime
 * gate for blockPassiveClose objectives so a sales rep can't stall on a polite
 * greeting while the lead is still unknown. */
export function isNonAdvancingReply(reply: string | null | undefined): boolean {
  if (!reply || !reply.trim()) return false;
  if (isPassiveCloser(reply)) return true;
  const t = reply.trim();
  // A leading reply ENDS on a discovery question or a concrete next step; a weak
  // one ENDS on a generic "how can I help?" — even when it opened with a good
  // product pitch. Inspect the tail so a long reply that merely tacks "how can I
  // help today?" onto the end is still caught, while one ending in a real
  // discovery question passes.
  const tail = t.slice(-90);
  return GENERIC_HELP_OPENER_PATTERNS.some((re) => re.test(tail));
}

// Genuine customer farewell → a close is legitimate, do NOT force a regenerate.
// Note: "לא" / "no" is NOT a farewell - it's a non-answer the agent must lead past.
const CUSTOMER_FAREWELL = /\b(bye|goodbye|that'?s all|thanks,? bye|no thanks)\b|ביי|להתראות|יום טוב|תודה רבה ביי|סגור תודה|זהו תודה/i;

export function customerIsClosing(lastCustomerMessage: string | null | undefined): boolean {
  if (!lastCustomerMessage) return false;
  return CUSTOMER_FAREWELL.test(lastCustomerMessage);
}

/**
 * The corrective injected before the single regeneration. Names the active
 * objective, what's missing, and the next move - forcing a forward step
 * instead of a passive close. Written to be language-agnostic (the model
 * replies in the customer's language).
 */
export function buildCloserCorrective(status: ObjectiveStatus): string {
  const obj = status.objective;
  const missing = status.missingRequired.length
    ? status.missingRequired.join(", ")
    : "the next completion criterion";
  return (
    `**WEAK REPLY — you handed control back to the customer instead of leading.** ` +
    `Your draft was a passive line (a "how can I help?" opener or an "anything else?" closer), ` +
    `but the active objective \`${obj.id}\` is NOT complete (still missing: ${missing}) and the customer did NOT say goodbye. ` +
    `You are a proactive sales rep for this company — NEVER open or close with a generic "how can I help / what are you looking for / anything else". ` +
    `Rewrite your reply: (1) if the customer asked a question, answer it briefly first in ONE sentence using what you know about your company and product; ` +
    `(2) then make ONE genuine, natural move toward the objective — ${obj.nextStepLogic} ` +
    `Lead the conversation. Reply in the customer's language. One move only.`
  );
}
