/**
 * Conversation Playbooks - structured prompt-time reasoning patterns.
 *
 * IMPORTANT: this is NOT the workflow / automation playbook system.
 * Automation playbooks live in DB (`ChatbotFlow` rows) and run inside
 * `flow-executor`. They have triggers and actions and operate independently
 * of the LLM.
 *
 * Conversation playbooks are PURE PROMPT TEMPLATES that teach the LLM
 * how to handle specific situations (price objection, lead qualification,
 * deferral, etc.). They are:
 *   - Selected by BEL based on BehaviorState (strategy / stage / intent / markers).
 *   - Rendered by Prompt Builder into the [Playbooks] section.
 *   - Frozen, platform-defined data - authors do NOT write them freehand.
 *
 * Each step has an `actionImplied` ActionCategory so the model knows what
 * KIND of move closes that step. The FINAL step of every playbook MUST
 * imply a progress action - never just "close politely".
 */

import type { ActionCategory, StrategyName } from "./behavior-strategies";
import type {
  ConversationStage,
  Intent,
} from "./behavior-engine.service";

export type PlaybookId =
  | "lead_qualification"
  | "price_objection"
  | "deferral_handling"
  | "trust_concern"
  | "demo_request"
  | "support_resolution"
  | "feature_inquiry";

export interface PlaybookStep {
  /** What the model should do conceptually. */
  description: string;
  /** Which action category this step closes with. */
  actionImplied: ActionCategory;
}

export interface ConversationPlaybook {
  id: PlaybookId;
  name: string;
  /** When the playbook fires. ALL conditions present in `trigger` must match. */
  trigger: {
    strategies?: StrategyName[];
    stages?: ConversationStage[];
    intents?: Intent[];
    /** Case-insensitive substring matches on the customer's last message. */
    markers?: string[];
  };
  steps: PlaybookStep[];
  /** Hard rules rendered alongside the steps. */
  hardRules: string[];
}

const LEAD_QUALIFICATION: ConversationPlaybook = {
  id: "lead_qualification",
  name: "Lead Qualification",
  trigger: {
    strategies: ["QUALIFY"],
    stages: ["exploration"],
  },
  steps: [
    { description: "Acknowledge what they just said and reflect the pain back in their own words - before asking anything.", actionImplied: "acknowledge" },
    { description: "Ask what outcome they're trying to reach.", actionImplied: "ask_question" },
    { description: "Surface the biggest unknown about their situation - channels, tools, or scale - as a natural follow-up, not a form field.", actionImplied: "ask_question" },
    { description: "Once the pain is clear, propose one concrete next step (demo / proposal / call).", actionImplied: "schedule_booking" },
  ],
  hardRules: [
    "Acknowledge before you ask - never open a turn with a cold qualifier.",
    "ONE question per turn. A reflection that leads into a single question still counts as one move.",
    "Do NOT pitch features before the pain is identified.",
    "Not every turn must end in a question - an observation or reflection can be the move. Just don't let the conversation stall indefinitely.",
  ],
};

const PRICE_OBJECTION: ConversationPlaybook = {
  id: "price_objection",
  name: "Price Objection",
  trigger: {
    stages: ["objection"],
    markers: ["יקר", "מחיר גבוה", "יותר מדי", "לא יכול להרשות", "expensive", "too much", "can't afford", "out of budget", "too pricey"],
  },
  steps: [
    { description: "Acknowledge the concern in their language. Don't dismiss or defend.", actionImplied: "acknowledge" },
    { description: "Reframe - move from cost to return. Anchor in the pain they already stated.", actionImplied: "explain" },
    { description: "Cite ONE concrete social-proof point (a similar customer + a result number).", actionImplied: "explain" },
    { description: "Close with a SPECIFIC next step - a named time slot for a 15-min demo or a tailored proposal.", actionImplied: "schedule_booking" },
  ],
  hardRules: [
    "Do NOT discount, offer a coupon, or promise a deal that wasn't already on the table.",
    "Do NOT list features here - value over features.",
    "Do NOT skip the social-proof step. \"I understand it's expensive\" alone is not enough.",
  ],
};

const DEFERRAL_HANDLING: ConversationPlaybook = {
  id: "deferral_handling",
  name: "Deferral / \"I'll think about it\"",
  trigger: {
    markers: [
      "אחשוב על זה", "אני אחזור אליכם", "אני צריך לחשוב", "אני בודק עם",
      "i'll think about it", "let me think", "i need to check with", "get back to you", "not sure yet",
    ],
  },
  steps: [
    { description: "Validate the pause without protest. Don't push against thinking time.", actionImplied: "acknowledge" },
    { description: "Ask ONE question that surfaces the actual blocker (price / fit / timing / authority).", actionImplied: "ask_question" },
    { description: "Offer a low-friction next-touch they can opt into NOW - calendar hold, follow-up at a specific time, free trial setup.", actionImplied: "schedule_followup" },
  ],
  hardRules: [
    "Do NOT just say \"sure, let me know when you decide\". That's the failure mode.",
    "Do NOT pile on new value props - they've already heard them.",
    "Do close with ONE concrete commitment-light option.",
  ],
};

const TRUST_CONCERN: ConversationPlaybook = {
  id: "trust_concern",
  name: "Trust / Credibility Concern",
  trigger: {
    markers: [
      "האם אתם", "מי אתם", "אמין", "בטוח", "ספאם", "נוכלים",
      "are you legit", "is this real", "scam", "trustworthy", "who are you", "have you done this before",
    ],
  },
  steps: [
    { description: "Acknowledge the question directly - no defensiveness.", actionImplied: "acknowledge" },
    { description: "Ground credibility in ONE concrete proof point (founder name, customer count, named brand using the product).", actionImplied: "explain" },
    { description: "Offer to share a public reference / case study link.", actionImplied: "send_proposal" },
    { description: "Pivot back to their need with a forward question.", actionImplied: "ask_question" },
  ],
  hardRules: [
    "Do NOT list your whole company history.",
    "Do NOT get defensive.",
    "Do NOT skip the pivot back - trust talk is a detour, not the conversation.",
  ],
};

const DEMO_REQUEST: ConversationPlaybook = {
  id: "demo_request",
  name: "Demo / Booking Request",
  trigger: {
    intents: ["transactional"],
    markers: [
      "דמו", "הדגמה", "לקבוע פגישה", "לקבוע שיחה", "לראות את המערכת",
      "demo", "schedule a call", "book a meeting", "show me the system", "see the platform",
    ],
  },
  steps: [
    { description: "Confirm enthusiasm and propose two concrete time options in their timezone.", actionImplied: "schedule_booking" },
    { description: "Capture / update CRM record silently while booking - never narrate this.", actionImplied: "create_lead" },
  ],
  hardRules: [
    "Do NOT keep qualifying past this point - they asked for a demo, give them a demo.",
    "Do NOT send a generic Calendly link without two anchored options.",
    "Do silently create_lead OR update_record (depending on CRM state) before confirming the booking.",
  ],
};

const SUPPORT_RESOLUTION: ConversationPlaybook = {
  id: "support_resolution",
  name: "Support Resolution",
  trigger: {
    strategies: ["RESOLVE"],
  },
  steps: [
    { description: "Acknowledge the issue and the impact in their words.", actionImplied: "acknowledge" },
    { description: "Run an enrichment lookup (account / order / known-issues) before asking the customer for info.", actionImplied: "crm_read" },
    { description: "Ask ONE diagnostic question if the data is insufficient.", actionImplied: "ask_question" },
    { description: "Apply the fix or escalate cleanly. Always end with a confirmation or a next-step ETA.", actionImplied: "update_record" },
  ],
  hardRules: [
    "Do NOT ask for info already in the CRM block.",
    "Do NOT promise an outcome that requires approval without flagging the approval step.",
    "Do escalate explicitly when the issue is outside policy - \"I'll loop in a teammate now\".",
  ],
};

const FEATURE_INQUIRY: ConversationPlaybook = {
  id: "feature_inquiry",
  name: "Feature / Capability Inquiry",
  trigger: {
    strategies: ["GUIDE"],
    intents: ["informational"],
  },
  steps: [
    { description: "Answer the specific feature question briefly - no monologue.", actionImplied: "explain" },
    { description: "Connect the feature to a concrete use case relevant to their stated context.", actionImplied: "explain" },
    { description: "Pivot forward with ONE question that surfaces buying intent or a remaining concern.", actionImplied: "ask_question" },
  ],
  hardRules: [
    "Do NOT enumerate every feature you have - they asked one question.",
    "Always pivot forward - a question or a next-step proposal - don't trail off.",
  ],
};

export const CONVERSATION_PLAYBOOKS: Readonly<Record<PlaybookId, ConversationPlaybook>> = Object.freeze({
  lead_qualification: LEAD_QUALIFICATION,
  price_objection: PRICE_OBJECTION,
  deferral_handling: DEFERRAL_HANDLING,
  trust_concern: TRUST_CONCERN,
  demo_request: DEMO_REQUEST,
  support_resolution: SUPPORT_RESOLUTION,
  feature_inquiry: FEATURE_INQUIRY,
});

/** All ids in display order - used by the Prompt Builder when rendering. */
export const PLAYBOOK_RENDER_ORDER: PlaybookId[] = [
  "demo_request",
  "price_objection",
  "deferral_handling",
  "trust_concern",
  "support_resolution",
  "lead_qualification",
  "feature_inquiry",
];
