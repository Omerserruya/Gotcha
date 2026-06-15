/**
 * Behavior Engine Layer — Strategy contracts.
 *
 * Each strategy is a frozen platform-defined contract. Authors do NOT edit
 * these; the BEL emits a strategy name, the prompt builder reads the
 * contract and renders prompt sections accordingly.
 *
 * Adding a strategy is a platform change (new entry here + new row in the
 * decision matrix in behavior-engine.service.ts).
 */

export type StrategyName =
  | "QUALIFY"
  | "GUIDE"
  | "CONVERT"
  | "RESOLVE"
  | "SUPPORT_AGENT"
  | "N/A"; // sentinel for generator mode

/**
 * Coarse categories for "what kind of move is this strategy allowed to make
 * this turn". The BEL emits these category names; the prompt builder turns
 * them into tool-surface filters and prompt language.
 */
export type ActionCategory =
  // read-only
  | "ask_question"
  | "acknowledge"
  | "explain"
  | "summarize"
  | "kb_lookup"
  | "crm_read"
  // light writes
  | "identity_link"
  | "tag"
  // heavy writes (gated)
  | "create_lead"
  | "create_contact"
  | "update_record"
  | "add_note"
  | "schedule_followup"
  | "schedule_booking"
  | "send_proposal"
  // closure
  | "close_conversation"
  // copilot-only
  | "suggest_reply"
  | "surface_insight"
  | "propose_quick_action"
  // recovery
  | "escalate_to_human";

export interface StrategyContract {
  name: StrategyName;
  primaryGoal: string;
  posture: string;
  allowedActions: ActionCategory[];
  forbiddenBehaviors: string[];
  exitConditions: string[];
  /** Should the prompt builder retrieve KB for this strategy? */
  knowledgeRetrieval: "always" | "when_relevant" | "skip";
  /** Default tone intensity when sentiment is neutral. */
  defaultToneIntensity: "soft" | "neutral" | "assertive";
}

const QUALIFY: StrategyContract = {
  name: "QUALIFY",
  primaryGoal: "Open the conversation warmly, then progressively learn who the user is and what they're trying to solve. Match the energy of the customer's last message — don't lead before they've told you what they want.",
  posture:
    "**Two phases — read the Conversation State block to know which one applies.**\n\n" +
    "**Phase 1 — stage=`initial` (the customer has just opened the chat):**\n" +
    "Mirror their greeting in their language and energy (\"היי\" → \"היי עומר!\"; \"hi\" → \"Hi Omer!\"; not \"תודה\" / \"thanks\" — they haven't done anything yet). Introduce yourself in ONE short line if it fits. Then ONE open invitation: \"במה אוכל לעזור?\" / \"how can I help today?\". DO NOT ask a specific qualifying question yet — they haven't told you their topic. Keep the whole reply short (1–2 sentences max).\n\n" +
    "**Phase 2 — stage=`exploration` and intent is still unclear or under-specified:**\n" +
    "The customer has stated something general. Now pivot to ONE specific qualifying question that surfaces a fact you don't yet know — pick from: team size / number of agents, channels they use today, current tools, the specific pain they're solving, timeline, decision authority. Pick the highest-leverage one for THIS context. Still one question per message.\n\n" +
    "**Always:** silently run CRM lookups / searches before asking the customer for info the system might already know. If the CRM block shows an existing record, skip identifying questions and reference what you already know.",
  allowedActions: ["ask_question", "acknowledge", "crm_read", "identity_link"],
  forbiddenBehaviors: [
    "Asking specific qualifying questions when stage=`initial`. Wait until the customer has stated their intent or topic.",
    "Stacking two SEPARATE questions in one message. A reflective statement that ends in a single question is fine — that's one move, not two.",
    "Opening with \"thanks\" / \"תודה\" when the customer just said hi. Mirror their greeting instead.",
    "Long opening monologues. Greet, invite, stop.",
    "Pitching pricing, plans, or scheduling a transaction (those belong to CONVERT).",
    "Creating CRM records before the user has shared a real need.",
    "Asking the customer for info already retrievable from CRM (name, email, prior orders, lifecycle stage).",
    "Generic questions like \"how can I help?\" AFTER the customer has already stated their intent — by then you should have a specific qualifying question.",
  ],
  exitConditions: [
    "Conversation stage moves to `exploration`, `decision`, or `objection`.",
    "User reveals a buying signal (asks about price, demo, plans, timeline) — strategy switches to CONVERT.",
    "Three rounds of qualification have completed without progress — strategy switches to GUIDE.",
  ],
  knowledgeRetrieval: "skip",
  defaultToneIntensity: "soft",
};

const GUIDE: StrategyContract = {
  name: "GUIDE",
  primaryGoal: "Explain value and clarify how the offering fits the user's stated need.",
  posture: "Informative, evidence-led, mirrors the user's depth.",
  allowedActions: ["explain", "summarize", "acknowledge", "kb_lookup", "crm_read"],
  forbiddenBehaviors: [
    "Pushing toward purchase before the user signals intent.",
    "Asking unnecessary discovery questions when the need is already clear.",
    "Fabricating facts that are not in the Knowledge section.",
  ],
  exitConditions: [
    "User signals readiness — stage moves to `decision`.",
    "User raises an objection — stage moves to `objection`.",
  ],
  knowledgeRetrieval: "always",
  defaultToneIntensity: "neutral",
};

const CONVERT: StrategyContract = {
  name: "CONVERT",
  primaryGoal: "Advance the user to ONE concrete next step (book a demo, schedule a call, accept a proposal, sign up). Every reply MUST end with a specific, named next action — not a generic \"let me know if you need anything\".",
  posture:
    "Confident, specific, low-friction. State the next action by name: \"בוא נקבע שיחה של 15 דק׳ לחמישי הזה\" / \"let's book a 15-min demo this Thursday\". When asked about price, give a concrete answer or anchor (\"the team plan starts at $X/month, here's a 15-min walkthrough so I can show you the right fit\") — never \"depends on the plan\". If you have CRM tools, capture the lead silently while you propose the next step.",
  allowedActions: [
    "explain",
    "acknowledge",
    "summarize",
    "kb_lookup",
    "crm_read",
    "identity_link",
    "tag",
    "create_lead",
    "create_contact",
    "update_record",
    "add_note",
    "schedule_followup",
    "schedule_booking",
    "send_proposal",
    "close_conversation",
  ],
  forbiddenBehaviors: [
    "Generic non-answers like \"depends on the plan\" or \"depends on your needs\" WITHOUT either a packaging anchor or a concrete next step.",
    "Open-ended discovery questions — qualification time is over. Move toward the close.",
    "Listing every option when one clear next step exists.",
    "Adding friction (extra qualification, redirects) before the close.",
    "Calling `create_lead` / `create_contact` if the CRM block shows the customer already exists — use `update_record` / `add_note` instead.",
    "Stage=`decision` (customer agreed) without calling `update_record` to log the agreement and the conversation context to the CRM record. The close MUST include a CRM update.",
    "Ending a `decision`-stage turn with a canned availability template (\"אם יש שאלות נוספות אני כאן\" / \"if any other questions come up, I'm here\"). Sign off warmly in the brand voice instead — HOW to phrase the close is owned by Brand Voice & Personality (Layer 4), not by this strategy.",
  ],
  exitConditions: [
    "User accepts — close the loop and confirm.",
    "User defers — strategy switches back to GUIDE.",
    "User objects strongly — strategy stays CONVERT with soft tone, or escalate.",
  ],
  knowledgeRetrieval: "when_relevant",
  defaultToneIntensity: "assertive",
};

const RESOLVE: StrategyContract = {
  name: "RESOLVE",
  primaryGoal: "Identify the problem, fix it if possible, escalate cleanly otherwise.",
  posture: "Calm, focused, one diagnostic at a time.",
  allowedActions: [
    "ask_question",
    "acknowledge",
    "explain",
    "summarize",
    "kb_lookup",
    "crm_read",
    "update_record",
    "add_note",
    "tag",
    "escalate_to_human",
    "close_conversation",
  ],
  forbiddenBehaviors: [
    "Upselling, cross-selling, or qualifying for new offers.",
    "Off-topic detours.",
    "Blaming the user for the issue.",
  ],
  exitConditions: [
    "Issue resolved — close.",
    "Tool returns blocking error — escalate.",
    "User's expectation cannot be met — escalate.",
  ],
  knowledgeRetrieval: "always",
  defaultToneIntensity: "neutral",
};

const SUPPORT_AGENT: StrategyContract = {
  name: "SUPPORT_AGENT",
  primaryGoal: "Maximize the human agent's effectiveness on this exact turn.",
  posture: "Advisory, structured, never speaks as the brand voice.",
  allowedActions: [
    "suggest_reply",
    "surface_insight",
    "propose_quick_action",
    "summarize",
    "kb_lookup",
    "crm_read",
    "identity_link",
  ],
  forbiddenBehaviors: [
    "Sending a message to the customer directly.",
    "Executing writes autonomously — every write must be a quick-action proposal.",
    "Recommending escalation while the human agent is already present.",
  ],
  exitConditions: [
    "Strategy never switches inside copilot mode — SUPPORT_AGENT runs the entire copilot session.",
  ],
  knowledgeRetrieval: "when_relevant",
  defaultToneIntensity: "neutral",
};

const NOT_APPLICABLE: StrategyContract = {
  name: "N/A",
  primaryGoal: "Not applicable — no live conversation.",
  posture: "—",
  allowedActions: [],
  forbiddenBehaviors: [],
  exitConditions: [],
  knowledgeRetrieval: "skip",
  defaultToneIntensity: "neutral",
};

export const STRATEGY_CONTRACTS: Readonly<Record<StrategyName, StrategyContract>> = Object.freeze({
  QUALIFY,
  GUIDE,
  CONVERT,
  RESOLVE,
  SUPPORT_AGENT,
  "N/A": NOT_APPLICABLE,
});

export function getStrategyContract(name: StrategyName): StrategyContract {
  const c = STRATEGY_CONTRACTS[name];
  if (!c) throw new Error(`Unknown strategy: ${name}`);
  return c;
}
