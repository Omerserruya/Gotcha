/**
 * OBJECTIVE ENGINE - WHAT the employee is trying to achieve.
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
  | "COLLECT_CONTACT"
  | "PRODUCT_RECOMMENDATION";

/**
 * A measurable BUSINESS OUTCOME - the thing the Goal Evaluator checks for. This
 * is deliberately decoupled from tools and from the ledger's low-level
 * action-kinds: a `booking` is a booking whether it happened via schedule_meeting,
 * a workflow engine, an MCP server, or another AI employee. Extend as new
 * employee types ship real outcomes (e.g. "quote" | "ticket" | "order").
 *
 * Only objectives that PRODUCE a real-world record carry one. Navigation
 * objectives (QUALIFY_LEAD, RESOLVE_ISSUE) intentionally have NONE - they are
 * steps, not outcomes, and never report goal achievement (BEL owns "done" when
 * there is no business outcome to measure).
 */
export type BusinessOutcome = "booking" | "crm_lead" | "crm_contact" | "crm_deal";

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
  /**
   * When true, this objective is NOT complete until its `completionTool` has
   * actually SUCCEEDED this conversation - having the required INFO is not
   * enough. This is what makes the engine action-complete instead of info-
   * complete: e.g. BOOK_MEETING stays the active objective (so the resolver
   * keeps surfacing "call schedule_meeting NOW") even after the customer agreed
   * and gave an email, until a booking actually lands. Reserved for objectives
   * whose ACTION is the outcome. CRM-write objectives stay info-complete +
   * best-effort (the post-conversation pipeline is their backstop), so they do
   * NOT set this - a failed CRM write must never stall the chain.
   */
  requiresActionSuccess?: boolean;
  /**
   * The measurable business outcome this objective produces, if any. Set ONLY on
   * outcome-producing objectives - the Goal Evaluator reads it to decide whether
   * the configured goal was ACHIEVED, by checking whether the outcome exists in
   * its runtime home (CRM state / booking store / live ledger). Absent → this is
   * a navigation step, never a goal-achievement criterion.
   */
  outcome?: BusinessOutcome;
}

const GENERATE_LEAD: ObjectiveModule = {
  id: "GENERATE_LEAD",
  mission:
    "Turn an unknown prospect into a lead: learn who they are, how to reach them, and what they need - enough to create a CRM lead.",
  requiredInformation: [
    { key: "contact_name", label: "the person's name", importance: "required", priority: 1, sourceHints: ["name", "contactName", "fullName", "firstName"] },
    { key: "interest", label: "what they're interested in / why they reached out", importance: "preferred", priority: 2, sourceHints: ["interest", "need", "painPoints"] },
    { key: "business_type", label: "what their business does", importance: "required", priority: 3, sourceHints: ["industry", "company", "businessType"] },
    { key: "contact_method", label: "a way to reach them (email or phone)", importance: "required", priority: 4, sourceHints: ["email", "phone", "mobile", "contactMethod"] },
  ],
  completionCriteria: [
    "You understand their business and what they're interested in",
    "You know who they are (a name) and how to reach them (email or phone)",
    "Enough is known to create or enrich a CRM lead in the background",
  ],
  nextStepLogic:
    "Lead with DISCOVERY, not data capture. As a sales rep you FIRST understand their business and what they need (name → their business/need), and only once there is genuine interest do you naturally ask for a way to reach them. NEVER ask for an email or phone, and never create the lead, before you understand what their business does and why they reached out - that feels like a form, not a conversation. Once you have a name + their interest + a contact method, create the lead silently and advance to QUALIFY_LEAD.",
  failureCriteria: [
    "Let a NEW prospect leave without learning their name or any way to reach them",
    "Gave a passive close to an unidentified prospect",
    "Treated an interested but anonymous prospect as a finished conversation",
  ],
  blockPassiveClose: true,
  completionTool: "integration_create_lead",
  outcome: "crm_lead",
};

const QUALIFY_LEAD: ObjectiveModule = {
  id: "QUALIFY_LEAD",
  mission: "Establish enough fit to earn the demo: understand their need; the demo itself does the deeper qualification.",
  requiredInformation: [
    { key: "need", label: "the problem they're solving", importance: "required", priority: 1, sourceHints: ["need", "painPoints"] },
    { key: "authority", label: "who owns the decision", importance: "preferred", priority: 2, sourceHints: ["authority", "title", "role"] },
    { key: "timeline", label: "when they want to act", importance: "preferred", priority: 3, sourceHints: ["timeline", "timeframe"] },
    { key: "budget", label: "whether budget exists / range", importance: "preferred", priority: 4, sourceHints: ["budget"] },
  ],
  completionCriteria: [
    "You understand their real need / what hurts",
  ],
  nextStepLogic:
    "As soon as you understand their need and they're a plausible fit, PROACTIVELY propose the demo (BOOK_MEETING) as the next step - don't wait for them to ask, and don't keep interrogating budget/authority/timeline ('when do you want to start?') before the demo. The demo IS where the deeper qualification happens. Authority/timeline/budget are nice to weave in lightly, never blockers to offering the demo.",
  failureCriteria: [
    "Pitched a solution before understanding the need",
    "Kept qualifying (authority/timeline/budget) instead of offering the demo once the need was clear",
    "Asked 'when do you want to start' before the prospect has even seen a demo",
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
    "Booking is a conversation, not a slot-dump, and you NEVER invent times - availability comes ONLY from `check_availability` (READ), booking ONLY from `schedule_meeting` (WRITE). FLOW: (1) Once they agree to meet, find a real time: either ask their preference first ('morning or afternoon?' / 'when's good for you?'), OR - when they already hinted a time, or you're ready to propose - write a SHORT ack ('רגע אחד, בודק 🙏') AS you call `check_availability` (the ack goes out as its own message while the calendar is read). (2) After `check_availability` returns, your NEXT message gives the REAL result: if they named a time and it's open, confirm it and ask to lock it in ('מצוין, מחר ב-10:00 פנוי. לקבוע?' / 'great, 10:00 tomorrow is open - shall I book it?'); otherwise offer ONLY the real open slots it returned and ask them to pick. Never blast slots `check_availability` didn't return. Don't cram the ack and the result into one message. (3) Once they pick a concrete time AND you have an email, BOOK it by calling `schedule_meeting` with that exact time, then confirm the REAL outcome (day/time + link). If `schedule_meeting` returns `needsAvailabilityCheck`, the slot isn't bookable - call `check_availability` again, offer real slots, and do NOT confirm. Never end a qualified conversation without moving the meeting forward.",
  failureCriteria: [
    "Proposed or confirmed a time that no check_availability result returned (invented availability)",
    "Used schedule_meeting to discover availability instead of check_availability",
    "Crammed the 'checking' ack and the availability result into a single message instead of ack-first then result",
    "Ended a qualified conversation without proposing a meeting",
    "Claimed a meeting was booked without a schedule_meeting success",
  ],
  blockPassiveClose: true,
  completionTool: "schedule_meeting",
  // The booking IS the outcome. Stay active until schedule_meeting succeeds, so
  // the resolver keeps driving the actual booking instead of declaring victory
  // the moment the customer says "yes" and hands over an email.
  requiresActionSuccess: true,
  outcome: "booking",
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
  outcome: "crm_deal",
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
  outcome: "crm_contact",
};

// Product discovery/recommendation: the store-connected sales goal. Its
// ACTION is the outcome - it is not complete until a REAL catalog search has
// run and real candidates were shown this conversation (actionCompletes), so
// the engine keeps steering "search the catalog now" instead of clarifying
// forever. Required info mirrors the PRODUCT_RECOMMENDATION discovery profile's
// required facts; the Discovery State snapshot in BLOCK 5 drives the specifics.
const PRODUCT_RECOMMENDATION: ObjectiveModule = {
  id: "PRODUCT_RECOMMENDATION",
  mission: "Understand what the customer wants, then search the connected store and show REAL products with exact links.",
  requiredInformation: [
    { key: "product_category", label: "what kind of product", importance: "required", priority: 1, sourceHints: ["category", "product", "item"] },
    { key: "budget", label: "approximate budget", importance: "required", priority: 2, sourceHints: ["budget", "price"] },
    { key: "riding_style", label: "general use / style", importance: "required", priority: 3, sourceHints: ["use", "style", "terrain"] },
  ],
  completionCriteria: [
    "The minimum criteria (category, budget, use) are known",
    "A real catalog search executed and real candidates were shown with exact links",
  ],
  nextStepLogic:
    "Collect only the minimum, then run the real product-search tool. Never narrate a search or invent products; refine only after showing real results.",
  failureCriteria: ["Presented generic/imaginary products as store inventory", "Kept asking questions when enough info existed to search"],
  blockPassiveClose: true,
  completionTool: "shopify.search_products",
  // The search IS the outcome: stay active until a real catalog search runs, so
  // the resolver keeps demanding "search now" rather than clarifying forever.
  requiresActionSuccess: true,
};

export const OBJECTIVES: Record<ObjectiveName, ObjectiveModule> = {
  GENERATE_LEAD,
  QUALIFY_LEAD,
  BOOK_MEETING,
  CREATE_DEAL,
  RESOLVE_ISSUE,
  COLLECT_CONTACT,
  PRODUCT_RECOMMENDATION,
};

/** Ordered objective chain per skill. The active objective is the first
 * incomplete one. */
export const OBJECTIVE_CHAINS: Record<SkillName, ObjectiveName[]> = {
  // PRODUCT_RECOMMENDATION leads: a store-shopping request must reach a real
  // catalog search before lead-qualification/booking. It self-completes once a
  // search runs (requiresActionSuccess); if the conversation is not a product
  // request, its minimum criteria never fill and the engine flows to the next
  // objective. The Discovery State + tool-availability gate ensure it only
  // forces a search when a product tool actually exists.
  SALES: ["PRODUCT_RECOMMENDATION", "GENERATE_LEAD", "QUALIFY_LEAD", "BOOK_MEETING", "CREATE_DEAL"],
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

/**
 * GOAL COMMITMENT (Unit A - Persistent Goal Ownership).
 *
 * `selectActiveObjective` is stateless: it re-derives "first incomplete step"
 * from the facts visible THIS turn. That makes the active goal regress whenever
 * a fact transiently drops out of the resolved-fact text (a Hebrew turn that
 * doesn't repeat "demo", a CRM block that didn't hydrate, etc.) - the agent
 * "forgets" it was booking and restarts qualification.
 *
 * The ActiveGoalSnapshot is the durable, cross-turn memory of the goal the agent
 * OWNS. It is persisted in the `ai.bot_turn` audit metadata and reloaded next
 * turn. `commitObjective` reconciles the freshly-derived objective against this
 * committed snapshot with three rules:
 *
 *   1. ADVANCE   - fresh is at/after the committed step (the committed objective
 *                  completed, or an eager forward jump like the BOOK_MEETING
 *                  promotion) → adopt fresh.
 *   2. HOLD      - fresh regressed to an EARLIER step while the committed
 *                  objective is NOT complete → keep the committed objective
 *                  (this is the "never regress on temporary context loss" rule).
 *   3. RELEASE   - if the agent has been stalled on the held objective with no
 *                  gap progress for `stallReleaseAfter` turns, stop forcing it
 *                  and let natural selection take over (escape valve, so a dead
 *                  goal can never trap the conversation forever).
 *
 * `achieved` is sticky: a required field, once satisfied, stays satisfied across
 * turns even if it later drops out of the fact text - so the agent never re-asks
 * for something it already has.
 */
export interface ActiveGoalSnapshot {
  objectiveId: ObjectiveName;
  /** 0-based chain position of the committed objective. */
  stepIndex: number;
  /** Required-info keys ever satisfied for this objective (sticky union). */
  achieved: string[];
  /** Required-info keys still missing (gap), after applying sticky `achieved`. */
  missingRequired: string[];
  /** Consecutive turns held with no reduction in the gap. Drives RELEASE. */
  stalledTurns: number;
}

function requiredKeysOf(obj: ObjectiveModule): string[] {
  return obj.requiredInformation.filter((f) => f.importance === "required").map((f) => f.key);
}

/** Recompute an objective's currently-missing required keys from fact text. */
function missingRequiredFor(obj: ObjectiveModule, factText: string): string[] {
  const ledger = computeKnowledgeLedger(obj.requiredInformation, factText);
  return ledger.entries
    .filter((e) => !e.known && e.importance === "required")
    .map((e) => e.key);
}

/** Build a committed snapshot for `objectiveId`, folding in sticky `achieved`. */
function buildSnapshot(
  objectiveId: ObjectiveName,
  stepIndex: number,
  freshMissing: string[],
  stickyAchieved: string[],
  priorStalled: number,
  priorMissingCount: number | null,
): { snapshot: ActiveGoalSnapshot; missingRequired: string[] } {
  const req = requiredKeysOf(OBJECTIVES[objectiveId]);
  const achieved = [
    ...new Set([
      ...stickyAchieved.filter((k) => req.includes(k)),
      ...req.filter((k) => !freshMissing.includes(k)),
    ]),
  ];
  const missingRequired = req.filter((k) => !achieved.includes(k));
  const progressed = priorMissingCount === null ? true : missingRequired.length < priorMissingCount;
  const stalledTurns = priorMissingCount === null ? 0 : progressed ? 0 : priorStalled + 1;
  return {
    snapshot: { objectiveId, stepIndex, achieved, missingRequired, stalledTurns },
    missingRequired,
  };
}

/**
 * Reconcile the freshly-derived objective (`fresh`) against the committed goal
 * (`prior`) and return BOTH the objective to act on this turn AND the snapshot
 * to persist for next turn. Pure: no I/O. When `prior` is null this is a no-op
 * (returns `fresh` as a fresh commitment) - fully back-compatible.
 */
export function commitObjective(
  prior: ActiveGoalSnapshot | null,
  fresh: ObjectiveStatus | null,
  factText: string,
  opts: { stallReleaseAfter?: number } = {},
): { status: ObjectiveStatus | null; snapshot: ActiveGoalSnapshot | null } {
  const stallReleaseAfter = opts.stallReleaseAfter ?? 3;

  // Chain fully complete this turn → no active goal to own.
  if (!fresh) return { status: null, snapshot: null };

  const adopt = (priorStalled = 0, priorMissingCount: number | null = null, sticky: string[] = []) => {
    const { snapshot, missingRequired } = buildSnapshot(
      fresh.objective.id,
      fresh.stepIndex,
      fresh.missingRequired,
      sticky,
      priorStalled,
      priorMissingCount,
    );
    return { status: { ...fresh, missingRequired }, snapshot };
  };

  // No prior commitment → commit the fresh selection as-is.
  if (!prior) return adopt();

  // Same objective continuing → carry sticky `achieved`, track stall.
  if (prior.objectiveId === fresh.objective.id) {
    return adopt(prior.stalledTurns, prior.missingRequired.length, prior.achieved);
  }

  // ADVANCE: fresh is at/after the committed step (committed objective completed,
  // or an eager forward jump such as the BOOK_MEETING promotion) → adopt fresh.
  if (fresh.stepIndex >= prior.stepIndex) return adopt();

  // RELEASE: stalled on the committed objective too long → stop forcing it.
  if (prior.stalledTurns >= stallReleaseAfter) return adopt();

  // HOLD: fresh regressed to an earlier objective while the committed one is not
  // complete → keep the committed objective (anti-regression). Recompute its gap
  // from current facts and keep `achieved` sticky.
  const heldObj = OBJECTIVES[prior.objectiveId];
  const heldFreshMissing = missingRequiredFor(heldObj, factText);
  const { snapshot, missingRequired } = buildSnapshot(
    prior.objectiveId,
    prior.stepIndex,
    heldFreshMissing,
    prior.achieved,
    prior.stalledTurns,
    prior.missingRequired.length,
  );
  return {
    status: { objective: heldObj, stepIndex: prior.stepIndex, chain: fresh.chain, missingRequired },
    snapshot,
  };
}

function objectiveComplete(
  obj: ObjectiveModule,
  prospectState: ProspectState,
  factText: string,
  completedActionTools: string[] = [],
  // Whether the agent can actually PERFORM action-mandatory completion tools
  // this conversation (e.g. a bookable calendar for BOOK_MEETING). When false,
  // the action-success requirement is waived so a non-bookable agent isn't stuck
  // on an objective it can never complete - it falls back to info-complete.
  canCompleteActions: boolean = true,
): boolean {
  // A lead already exists → GENERATE_LEAD is satisfied by definition.
  if (obj.id === "GENERATE_LEAD" && prospectState !== "NEW_PROSPECT") return true;
  // Action-mandatory objectives (e.g. BOOK_MEETING): the completion TOOL having
  // SUCCEEDED this conversation IS completion - independent of whether the info-
  // field ledger detected the agreement. Info detection is fragile across
  // languages (Hebrew "פגישה"/"דמו" never matches the English "meeting"/"demo"
  // sourceHints), so gating on info would loop the bot into re-booking every
  // turn. Booked → done; not booked → stay active to DRIVE the booking. Skipped
  // when the agent can't perform the action (falls through to info-complete so a
  // non-bookable agent never stalls).
  if (obj.requiresActionSuccess && canCompleteActions && obj.completionTool) {
    return completedActionTools.includes(obj.completionTool);
  }
  // Info-mandatory objectives: complete when every required field is present.
  const ledger = computeKnowledgeLedger(obj.requiredInformation, factText);
  return !ledger.hasMissingRequired;
}

// Explicit meeting/scheduling intent in the resolved-fact text (which now
// includes the live transcript). Bilingual; deliberately broad - it only
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

// The REQUIRED booking inputs are present (BOOK_MEETING.requiredInformation:
// meeting_interest + attendee_email). When a customer is concretely scheduling
// AND an email is on hand, the booking objective is reachable RIGHT NOW - we must
// not block it on delayed qualification extraction or a missing name (the
// trust-eroding window where the model "books" while BOOK_MEETING is still
// locked). A real email value is the gate (no false-positives from hint words).
function bookingInputsReady(factText: string): boolean {
  return CONTACT_EMAIL_RE.test(factText);
}

/**
 * The active objective for this turn = first incomplete objective in the role's
 * chain. Returns null when every objective in the chain is complete.
 */
export function selectActiveObjective(
  role: string | null | undefined,
  prospectState: ProspectState,
  factText: string,
  // Action tools that have already SUCCEEDED this conversation (cross-turn).
  // Lets action-mandatory objectives (BOOK_MEETING) stay active until their
  // tool actually landed. Empty/omitted → info-complete semantics (back-compat).
  completedActionTools: string[] = [],
  // Whether the agent can perform action-mandatory completion tools (e.g. a
  // bookable calendar). False → don't stall on an action the agent can't do.
  canCompleteActions: boolean = true,
  // WIZARD→RUNTIME (structured fact): the configured goal maps to this objective,
  // which becomes the chain's ENDPOINT - objectives beyond it are not pursued
  // (e.g. an SDR configured to "book demos" stops at BOOK_MEETING, never chases
  // CREATE_DEAL). null/absent → role-derived chain unchanged. Never SKIPS earlier
  // capture/qualify steps, so it can't bypass lead capture.
  goalObjective: ObjectiveName | null = null,
): ObjectiveStatus | null {
  const skill: SkillName = roleToSkill(role);
  const fullChain = OBJECTIVE_CHAINS[skill];
  const endIdx = goalObjective ? fullChain.indexOf(goalObjective) : -1;
  const chain = endIdx >= 0 ? fullChain.slice(0, endIdx + 1) : fullChain;

  // ── Natural-progression override (do not block a ready buyer) ──
  // When the customer has EXPLICITLY asked to meet AND lead identity (name +
  // contact) is already captured, promote BOOK_MEETING even if an upstream
  // objective (e.g. full QUALIFY_LEAD) isn't complete. Booking is itself how the
  // remaining qualification happens; stalling an eager buyer on a missing
  // `authority`/`timeline`/`business_type` is the regression we're fixing. Only
  // applies when BOOK_MEETING is in this skill's chain and isn't already done.
  const bookIdx = chain.indexOf("BOOK_MEETING");
  if (
    bookIdx >= 0 &&
    customerRequestedMeeting(factText) &&
    (leadIdentityReady(factText) || bookingInputsReady(factText))
  ) {
    const book = OBJECTIVES.BOOK_MEETING;
    if (!objectiveComplete(book, prospectState, factText, completedActionTools, canCompleteActions)) {
      const ledger = computeKnowledgeLedger(book.requiredInformation, factText);
      const missingRequired = ledger.entries
        .filter((e) => !e.known && e.importance === "required")
        .map((e) => e.key);
      return { objective: book, stepIndex: bookIdx, chain, missingRequired };
    }
  }

  for (let i = 0; i < chain.length; i++) {
    const obj = OBJECTIVES[chain[i]];
    if (objectiveComplete(obj, prospectState, factText, completedActionTools, canCompleteActions)) continue;
    const ledger = computeKnowledgeLedger(obj.requiredInformation, factText);
    const missingRequired = ledger.entries
      .filter((e) => !e.known && e.importance === "required")
      .map((e) => e.key);
    return { objective: obj, stepIndex: i, chain, missingRequired };
  }
  return null;
}

/**
 * Resolve the configured GOAL = the endpoint of the (wizard-truncated) chain.
 * This is the objective whose business outcome (if any) the Goal Evaluator
 * measures. Independent of navigation progress - it's the chain's destination,
 * not its cursor. Returns null when the role has no chain.
 */
export function resolveGoalObjective(
  role: string | null | undefined,
  goalObjective: ObjectiveName | null = null,
): ObjectiveName | null {
  const skill: SkillName = roleToSkill(role);
  const fullChain = OBJECTIVE_CHAINS[skill];
  if (!fullChain?.length) return null;
  const endIdx = goalObjective ? fullChain.indexOf(goalObjective) : -1;
  const chain = endIdx >= 0 ? fullChain.slice(0, endIdx + 1) : fullChain;
  return chain[chain.length - 1] ?? null;
}

// ─── Next-Best-Action resolver (the DECISION layer) ─────────────────
// The objective engine knows WHAT to achieve and WHAT'S MISSING; this turns
// that state into a small, ranked shortlist of concrete next actions. It does
// NOT decide for the model - it NOMINATES 2-4 goal-derived candidates and the
// model picks one (and executes it). That keeps the system an AI employee
// choosing among meaningful options, not a deterministic workflow engine.
//
// Inputs are pure state the turn already computed: the active objective status,
// the dispatchable tool surface (capability), and whether a calendar can book.

export type NextActionKind = "act" | "ask" | "propose" | "escalate";

export interface NextActionCandidate {
  kind: NextActionKind;
  /** Tool to call (kind "act"/"escalate"). */
  tool?: string;
  /** Required-info field to ask for (kind "ask"). */
  field?: string;
  /** Imperative the model reads. */
  label: string;
  /** 0..1 priority; the shortlist is sorted by this. */
  score: number;
  /** Why this advances the active objective. */
  rationale: string;
}

function isCalendarTool(tool: string | undefined): boolean {
  return !!tool && /(schedule_meeting|schedule_demo|book_)/.test(tool);
}

/**
 * Resolve the ranked shortlist of next-best actions for THIS turn. Returns []
 * when every objective is complete (the caller may close). Never throws.
 *
 * Generic by construction: it reads each objective's `requiredInformation`
 * priorities + `completionTool`, so new objectives are supported with no change
 * here. A couple of objective-aware touches (propose-the-demo) ride on top.
 */
export function resolveNextActions(input: {
  status: ObjectiveStatus | null;
  capability: string[]; // tool function names dispatchable this turn
  calendarBookable?: boolean;
  // WIZARD→RUNTIME (structured fact): are the configured qualification signals
  // sufficiently evidenced? `false` suppresses PROACTIVELY proposing the demo
  // (qualify against the configured criteria first). undefined/true → no gating.
  qualificationMet?: boolean;
  // GOAL PROGRESS > INFO COLLECTION: the active objective has STALLED - its
  // missing info has been requested across turns without being supplied. When
  // true, we stop nominating the same ASK (a strong employee doesn't ask the
  // same unanswered question repeatedly) and surface a forward move instead;
  // the missing detail is collected opportunistically later. Role-agnostic.
  stalled?: boolean;
}): NextActionCandidate[] {
  const { status, capability, calendarBookable, qualificationMet, stalled } = input;
  if (!status) return [];

  const obj = status.objective;
  const missing = status.missingRequired;
  const has = (t: string) => capability.includes(t);

  const candidates: NextActionCandidate[] = [];

  // 1) ACT - all required info captured and the completion tool is callable.
  const tool = obj.completionTool;
  const toolCallable =
    !!tool && has(tool) && (!isCalendarTool(tool) || !!calendarBookable);
  if (toolCallable && missing.length === 0) {
    candidates.push({
      kind: "act",
      tool,
      score: 0.95,
      label: `Call \`${tool}\` NOW - every required detail for ${obj.id} is already captured. Act, don't re-ask.`,
      rationale: `${obj.id} completes when ${tool} returns success this turn.`,
    });
  }

  // 2) PROPOSE the demo - the highest-value forward move for a qualified
  //    prospect when booking is possible (objective-aware).
  // WIZARD→RUNTIME: while still QUALIFYING, only PROACTIVELY propose the demo once
  // the configured qualification signals are met. If the judgment fact says they
  // are NOT met, qualify against the configured criteria first (do not pre-empt
  // it). BOOK_MEETING (the customer already wants to book) is never gated here.
  const proposeQualified = !(obj.id === "QUALIFY_LEAD" && qualificationMet === false);
  if (calendarBookable && proposeQualified && (obj.id === "QUALIFY_LEAD" || obj.id === "BOOK_MEETING")) {
    const score = obj.id === "BOOK_MEETING" ? 0.88 : 0.8;
    candidates.push({
      kind: "propose",
      tool: has("schedule_meeting") ? "schedule_meeting" : undefined,
      score,
      label:
        "Proactively propose the demo/meeting and offer 2 concrete times. Don't wait to be asked; the demo is the next step once they're a fit.",
      rationale: "Advancing a qualified prospect toward a booked meeting is the highest-value move.",
    });
  }

  // 3) ASK - the single highest-priority missing required field. Suppressed when
  //    the objective has STALLED (the info was already requested and not given) -
  //    a competent employee stops re-asking and advances instead (see 3b).
  const nextField = [...obj.requiredInformation]
    .sort((a, b) => a.priority - b.priority)
    .find((f) => missing.includes(f.key));
  if (nextField && !stalled) {
    candidates.push({
      kind: "ask",
      field: nextField.key,
      score: 0.7,
      label: `Ask the customer for: ${nextField.label}. This is the next thing ${obj.id} needs - ask it naturally, one thing at a time.`,
      rationale: `Missing required field "${nextField.key}" is blocking ${obj.id}.`,
    });
  }

  // 3b) ADVANCE (goal progress > info collection). When the objective has stalled
  //     on missing info, STOP re-asking and make the best forward move instead.
  //     Generic: the missing detail becomes opportunistic, not a hard blocker.
  if (stalled && nextField) {
    candidates.push({
      kind: "propose",
      score: 0.75, // outranks the (suppressed) ASK so the forward move wins
      label:
        `You've already asked for "${nextField.label}" and it hasn't been provided. Do NOT ask for it again. ` +
        `Make a concrete forward move toward the goal instead - give a relevant, specific piece of value, ` +
        `answer what they care about, or propose the next step - and let that detail come naturally later.`,
      rationale: `${obj.id} stalled on "${nextField.key}"; advancing beats re-asking an unanswered question.`,
    });
  }

  // 4) ESCALATE - always available, deliberately deprioritized (last resort).
  candidates.push({
    kind: "escalate",
    tool: "escalate_to_human",
    score: 0.1,
    label:
      "Escalate to a human ONLY if the customer explicitly asked for one, is clearly upset, or no action above can advance the goal. A failed background tool (e.g. a CRM sync) is NOT a reason to escalate.",
    rationale: "Last resort - prefer advancing the objective yourself.",
  });

  // Sort by score desc, dedupe by (kind+tool+field), cap at 4.
  const seen = new Set<string>();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => {
      const key = `${c.kind}:${c.tool ?? ""}:${c.field ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

/** True when the active objective is still reachable AND there is at least one
 *  advancing (non-escalate) action available. Used by Goal Preservation to
 *  decide whether escalation is premature. */
export function hasViableAdvancingAction(candidates: NextActionCandidate[]): boolean {
  return candidates.some((c) => c.kind !== "escalate");
}

// ─── Guaranteed background actions (CRM integrity) ──────────────────────────
// Objective completion tools that are SILENT background CRM writes. These must
// fire DETERMINISTICALLY the moment their required info exists - never left to
// whether the model "remembered" to call them (the 65 missed create_lead in the
// audit). Generic: keyed off objective.completionTool, never a hardcoded site.
const BACKGROUND_COMPLETION_TOOLS = new Set<string>([
  "integration_create_lead",
  "integration_create_contact",
  "integration_create_deal",
]);

/**
 * Background actions that are RIPE (their objective's required info is present)
 * but have NOT yet committed this conversation - they should be executed
 * silently this turn. Walks the WHOLE chain (a lead must exist even once we've
 * advanced to booking), not just the active objective. Pure.
 */
export function guaranteedBackgroundActions(input: {
  role: string | null | undefined;
  prospectState: ProspectState;
  factText: string;
  committedTools: string[];
}): Array<{ objectiveId: ObjectiveName; tool: string }> {
  const chain = OBJECTIVE_CHAINS[roleToSkill(input.role)] ?? [];
  const committed = new Set(input.committedTools);
  const out: Array<{ objectiveId: ObjectiveName; tool: string }> = [];
  for (const id of chain) {
    const obj = OBJECTIVES[id];
    const tool = obj.completionTool;
    if (!tool || !BACKGROUND_COMPLETION_TOOLS.has(tool)) continue;
    if (committed.has(tool)) continue; // already done this conversation
    // A lead / contact already exists when the prospect is no longer NEW → the
    // record is there, don't re-create it (the create's only job is to make it
    // exist). Deal creation has no such proxy; dedup handles repeats.
    if ((id === "GENERATE_LEAD" || id === "COLLECT_CONTACT") && input.prospectState !== "NEW_PROSPECT") continue;
    const ledger = computeKnowledgeLedger(obj.requiredInformation, input.factText);
    if (!ledger.hasMissingRequired) out.push({ objectiveId: id, tool });
  }
  return out;
}

// ─── Goal prioritization (business-outcome layer above objectives) ──────────
// When more than one move is viable, a strong employee advances the highest-
// value business OUTCOME, not whichever the customer's last message gestured at.
// Higher = pursue first. Generic ordering over objective ids; new objectives
// inherit a default. Booking/conversion/retention/completion all outrank pure
// informational conversation (which has no objective and therefore no weight).
export const OBJECTIVE_PRIORITY: Record<ObjectiveName, number> = {
  BOOK_MEETING: 100,   // booking - highest-value forward motion
  CREATE_DEAL: 95,     // conversion
  PRODUCT_RECOMMENDATION: 90, // real catalog search + real products (store sales)
  RESOLVE_ISSUE: 80,   // retention / resolution
  QUALIFY_LEAD: 60,    // progression toward conversion
  GENERATE_LEAD: 50,   // completion (capture)
  COLLECT_CONTACT: 50, // completion (capture)
};

export function objectivePriority(id: ObjectiveName | undefined): number {
  return id ? (OBJECTIVE_PRIORITY[id] ?? 40) : 0;
}

// ─── Outcome quality > data collection (generic creation gate) ──────────────
// A record (lead/contact/deal/opportunity/ticket/case/quote/…) should be created
// only when creation is MEANINGFUL business progress - never just because enough
// fields exist. Role-agnostic rules, no per-role logic:
//   (1) a poor-fit prospect (judgment fit="disqualified") → create NOTHING;
//   (2) a high-commitment object (deal/opportunity/quote/order/contract/invoice)
//       requires a real, known contact to attach to (prospectState ≠ NEW_PROSPECT).
// Non-creation tools are always allowed; capture objects (lead/contact/ticket)
// stay available for engaged prospects. Matches any creation tool by name shape.
const CREATION_TOOL_RE = /create/i;
const COMMITMENT_OBJECT_RE = /(deal|opportunit|quote|order|contract|invoice)/i;

export function isCreationToolAllowed(
  toolName: string,
  ctx: { fit: "qualified" | "disqualified" | "neutral"; prospectState: ProspectState },
): boolean {
  if (!CREATION_TOOL_RE.test(toolName)) return true; // not a creation tool
  if (ctx.fit === "disqualified") return false; // no records for a poor-fit prospect
  if (COMMITMENT_OBJECT_RE.test(toolName) && ctx.prospectState === "NEW_PROSPECT") return false;
  return true;
}

// ─── Wizard → Runtime binding: structured facts (judgment layer) ────────────
// Free-text Wizard config (goal, ICP, qualificationSignals[], disqualifiers[],
// successCriteria) is converted into these DETERMINISTIC facts by a single
// structured evaluation step (wizard-binding.service.ts) - NO regex / keyword /
// fuzzy matching anywhere. The objective engine, readiness logic, recovery, and
// prioritization consume ONLY this typed object, never the raw config text.
//
// `evaluated:false` means the step did not run (no config) or failed → every
// consumer treats the facts as absent and behaves exactly as before (back-compat).
export interface WizardRuntimeFacts {
  evaluated: boolean;
  /** Fit against configured ICP + disqualifiers. */
  fit: "qualified" | "disqualified" | "neutral";
  /** The configured disqualifier (verbatim) the customer matched, if disqualified. */
  disqualifierMatched: string | null;
  /** Whether the configured qualification signals are sufficiently evidenced. */
  qualificationMet: boolean;
  /** Subset of the configured qualificationSignals evidenced so far. */
  signalsMet: string[];
  /** The objective the configured goal maps to - the chain's ENDPOINT (objectives
   *  beyond it are not pursued). null → use the role-derived chain unchanged. */
  goalObjective: ObjectiveName | null;
}

export const EMPTY_WIZARD_FACTS: WizardRuntimeFacts = {
  evaluated: false,
  fit: "neutral",
  disqualifierMatched: null,
  qualificationMet: true, // absent config never gates readiness
  signalsMet: [],
  goalObjective: null,
};

/** Directive injected when the judgment step flags a configured disqualifier:
 *  steer the model to qualify out gracefully instead of forcing a meeting. */
export function renderQualifyOutDirective(matched: string): string {
  return [
    "# Fit check - qualify out gracefully (configured disqualifier matched)",
    `What the customer described matches a configured poor-fit signal: "${matched}".`,
    "Do NOT push a demo or hard-sell this turn. Acknowledge honestly and, if it's truly a mismatch, " +
      "disengage politely - point them to a better-fit resource or leave the door open - rather than " +
      "forcing a meeting. If they clarify they ARE a fit, continue pursuing the goal normally.",
  ].join("\n");
}

/**
 * Render the business-outcome priority directive for BLOCK 5. Makes the model's
 * decision ordering explicit: advancing the committed outcome outranks open-
 * ended discussion; answer + advance when possible, advance when forced to pick.
 */
export function renderOutcomePriority(status: ObjectiveStatus | null): string | null {
  if (!status) return null;
  const tier =
    objectivePriority(status.objective.id) >= 95
      ? "the highest-value outcome available right now"
      : objectivePriority(status.objective.id) >= 80
        ? "a high-value outcome"
        : "the active outcome";
  return [
    "# Business-outcome priority",
    `Advancing **${status.objective.id}** is ${tier}. Business outcomes - booking, conversion, ` +
      `retention/resolution, then capture - ALWAYS outrank open-ended informational chat.`,
    "When the customer asks something, answer it AND make the outcome-advancing move in the same turn. " +
      "If you must choose, advance the outcome - never let the conversation drift into pure Q&A while a " +
      "concrete next step toward the goal is available.",
  ].join("\n");
}

/**
 * Render the shortlist into the prompt. The model PICKS one and executes it.
 * Action-first framing: prefer calling the tool over talking when an ACT is
 * listed. Returns null when there are no candidates (all objectives complete).
 */
export function renderNextActions(candidates: NextActionCandidate[]): string | null {
  if (!candidates.length) return null;
  const lines: string[] = [
    "# Next best actions (decide and ACT this turn)",
    "These are the goal-derived moves that advance the active objective, best first. Pick the ONE that best fits what the customer just said, then DO it this turn - call the tool or ask the one question. Prefer an [ACT] over talking when it's listed: you already have what you need, so act instead of describing.",
    "",
  ];
  const tag: Record<NextActionKind, string> = {
    act: "ACT",
    propose: "PROPOSE",
    ask: "ASK",
    escalate: "ESCALATE",
  };
  candidates.forEach((c, i) => {
    lines.push(`${i + 1}. [${tag[c.kind]}] ${c.label}`);
  });
  return lines.join("\n");
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
  lines.push(`Active objective: **${obj.id}** - ${obj.mission}`);
  lines.push("");
  // Hard ordering: everything BEFORE the active step is complete; everything
  // AFTER is LOCKED. The active objective is the only one to pursue this turn.
  lines.push(`Chain progress (step ${stepIndex + 1}/${chain.length}):`);
  for (let i = 0; i < chain.length; i++) {
    if (i < stepIndex) lines.push(`- ✓ ${chain[i]} (done)`);
    else if (i === stepIndex) lines.push(`- ▶ ${chain[i]} (ACTIVE - work this now)`);
    else lines.push(`- 🔒 ${chain[i]} (locked - do not pursue yet)`);
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
    const tag = e.known ? "" : e.importance === "required" ? " - MISSING [required]" : " - missing";
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

/** True when the Lead Identity sub-ledger is worth showing - i.e. the active
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
      "Weave the missing item(s) into the conversation naturally - one at a time, never as a form. " +
      "Do not move toward booking a meeting until the lead identity is captured.",
  ].join("\n");
}

// ─── Runtime passive-closer gate ────────────────────────────────────────
//
// A LAST-LINE, programmatic enforcement (prompt instructions alone don't stop
// the model - see the real WhatsApp regression). When an objective that must
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
// can I help?" is as passive as closing with "anything else?" - it hands the
// lead back to the customer instead of leading. The model defaults to these on
// vague first messages (real GOTCHA regression: "כאן דניאל מצוות GOTCHA. במה
// אוכל לעזור היום?"). Treated as non-advancing so the same regen gate fires.
// Generic "how can I help?" openers in every phrasing (Hebrew: איך/במה/כיצד +
// יכול/אוכל/אפשר/נוכל + לעזור/לסייע; English: how can/may I help/assist, what
// can I do). Matched broadly - the "dominant content" guard below prevents
// false positives on substantive leading replies.
const GENERIC_HELP_OPENER_PATTERNS: RegExp[] = [
  /(איך|במה|כיצד)\s+(אני\s+)?(יכול|אוכל|אפשר|נוכל)\s+(לעזור|לסייע)/,
  /\bhow (can|may) i (help|assist)\b/i,
  /\bwhat can i (do|help)\b/i,
];

/** A reply that hands control back to the customer instead of advancing the
 * objective - either a passive availability CLOSER ("anything else?") or a
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
  // one ENDS on a generic "how can I help?" - even when it opened with a good
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
    `**WEAK REPLY - you handed control back to the customer instead of leading.** ` +
    `Your draft was a passive line (a "how can I help?" opener or an "anything else?" closer), ` +
    `but the active objective \`${obj.id}\` is NOT complete (still missing: ${missing}) and the customer did NOT say goodbye. ` +
    `You are a proactive sales rep for this company - NEVER open or close with a generic "how can I help / what are you looking for / anything else". ` +
    `Rewrite your reply: (1) if the customer asked a question, answer it briefly first in ONE sentence using what you know about your company and product; ` +
    `(2) then make ONE genuine, natural move toward the objective - ${obj.nextStepLogic} ` +
    `Lead the conversation. Reply in the customer's language. One move only.`
  );
}
