/**
 * Agent Tools - shared OpenAI function-calling schemas + dispatcher.
 *
 * Both the autonomous customer-reply path (incoming-worker/ai-bot) and the
 * agent-assist path (ai service/openai.provider) pass these schemas into
 * `chat.completions.create({ tools })` and route tool_calls through
 * `dispatchToolCall()` here so dispatch logic is not duplicated.
 *
 * Dispatch uses plain fetch() against the conversation service so this file
 * has no intra-service import cycles. Auth is propagated via Bearer token
 * (either forwarded from the caller or INTERNAL_SERVICE_TOKEN).
 */

export interface AgentToolContext {
  tenantId: string;
  conversationId?: string;
  /** Required for link_customer_identifier dispatch. */
  contactId?: string;
  /** Propagated as Bearer token to downstream conversation service. */
  authToken?: string;
  /** Surfaced into /identity/link for idempotent dedupe. */
  messageId?: string;
  /**
   * Execution mode. Defaults to "agent" (autonomous bot replying to a
   * customer). When set to "copilot" (human agent is in the loop), the
   * dispatcher diverts gate REQUIRE_APPROVAL decisions to a
   * `proposeQuickAction` side effect instead of creating an
   * ApprovalRequest - the human agent in the inbox decides whether to
   * fire the action from the suggestions panel.
   */
  mode?: "agent" | "copilot";
  /**
   * Optional handler for `schedule_meeting` (Task 3). The ai service wires
   * this with its scheduling.service + calendar adapter. Lives on the
   * context so shared/agent-tools.ts stays decoupled from per-service
   * dependencies (Prisma calendar models, Google/Calendly fetch logic).
   * Return shape mirrors what the model needs to relay to the customer.
   */
  scheduleMeeting?: (args: ScheduleMeetingArgs) => Promise<ScheduleMeetingResult>;
  /**
   * Custom API tool runner. Set by ai-bot.service from
   * connectors/custom-api.service. The dispatcher routes any tool whose
   * name matches `custom.<slug>` here. Returns a JSON-stringifiable result.
   */
  runCustomApiTool?: (opts: {
    slug: string;
    args: Record<string, unknown>;
  }) => Promise<{ ok: true; result: unknown; meta?: any } | { ok: false; reason: string; meta?: any }>;
  /**
   * Adapter framework runner. Set by ai-bot.service from
   * connectors/integration-framework. Routes any tool whose name matches
   * `<provider>.<toolName>` (e.g. "stripe.refund_payment") to the registered
   * provider adapter.
   */
  runAdapterTool?: (opts: {
    toolFunctionName: string;
    args: Record<string, unknown>;
  }) => Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;
  /**
   * Custom DB query tool runner. Set by ai-bot.service from
   * connectors/custom-db.service. Routes any tool whose name starts with
   * `custom_db.` to the tenant-defined query template (parameterized SQL or
   * Mongo op). Safer than generic CRUD because the template is fixed.
   */
  runCustomDbTool?: (opts: {
    slug: string;
    args: Record<string, unknown>;
  }) => Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;
  /**
   * create_task runner. Set by ai-bot.service. Wraps executeAction with
   * `tool: "create_task"` so the dispatcher in shared/agent-tools doesn't
   * need to import the AI service's connector layer.
   */
  runCreateTask?: (opts: {
    subject: string;
    body: string;
    priority?: "low" | "normal" | "high" | "urgent";
  }) => Promise<{ ok: true; result: unknown } | { ok: false; reason: string }>;
  /**
   * Unified lead/contact creation runner. Set by ai-bot.service, backed by the
   * per-tenant CRMAdapter (crm-adapter-resolver). The dispatcher routes the
   * vendor-neutral `integration_create_lead` / `integration_create_contact`
   * tools here so EVERY source-of-truth CRM (HubSpot, Salesforce, Zoho,
   * Airtable, Fireberry, …) shares one create path with correct per-vendor
   * field mapping - instead of the model driving a raw `<vendor>.create_record`.
   * shared/agent-tools stays decoupled from the AI service's connector layer.
   */
  runCreateLead?: (opts: {
    kind: "lead" | "contact";
    name?: string;
    email?: string;
    phone?: string;
    company?: string;
    notes?: string;
  }) => Promise<{ ok: boolean; id?: string; kind?: string; vendor?: string; reason?: string }>;
}

export interface ScheduleMeetingArgs {
  duration_minutes: number;
  meeting_type: string;
  requested_at_iso?: string;
  customer_timezone?: string;
  customer_email?: string;
  additional_guests?: string[];
  notes?: string;
}

export type ScheduleMeetingResult =
  | { ok: true; verdict: "VALID"; eventId: string; joinUrl?: string; startMs: number; endMs: number }
  | {
      ok: false;
      verdict: "INVALID";
      reason: string;
      proposedSlotsIso: string[];
      /**
       * Pre-localized customer-facing copy. Set when the failure mode warrants
       * a specific user-visible message (e.g. `slot_taken` race after the
       * slot was validated). The model is instructed to relay verbatim in
       * the customer's language.
       */
      userMessage?: { he: string; en: string };
      /** The slot the model originally tried to book - for audit. */
      requestedSlotIso?: string;
    }
  | { ok: false; verdict: "PROPOSE"; proposedSlotsIso: string[] }
  | { ok: false; reason: string };

export interface AgentToolSideEffect {
  /** escalate_to_human was requested - caller must hand off to human. */
  escalate?: {
    reason: string;
    priority?: "low" | "medium" | "high";
    summary?: string;
  };
  /**
   * The tool call was gated by evaluateToolGate and requires human
   * approval. The caller MUST stop generating further replies and
   * pause the conversation until the approval is decided.
   * approvalRequestId references the created ApprovalRequest row.
   */
  awaitingApproval?: {
    approvalRequestId: string;
    tool: string;
    reason: string;
  };
  /**
   * The tool call was explicitly denied by tenant permission. The bot
   * should NOT retry and should optionally inform the customer.
   */
  denied?: {
    tool: string;
    reason: string;
  };
  /**
   * Copilot-mode replacement for `awaitingApproval`. The tool was gated
   * as REQUIRE_APPROVAL but the human agent is already in the loop, so
   * we surface it as a "proposed quick action" the agent can fire from
   * the suggestions panel instead of opening a separate approval page.
   * Only emitted when AgentToolContext.mode === "copilot".
   */
  proposeQuickAction?: {
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  };
}

export interface AgentToolDispatchResult {
  toolCallId: string;
  /** JSON-stringified result injected back into the chat loop. */
  content: string;
  sideEffect?: AgentToolSideEffect;
}

// ─── Tool schemas (OpenAI function-calling format) ────────────

export const LINK_IDENTIFIER_TOOL = {
  type: "function" as const,
  function: {
    name: "link_customer_identifier",
    description:
      "Link an email or phone number that belongs to THIS CUSTOMER (not a third party) to their contact record. " +
      "Enables cross-channel history unification. Call when:\n" +
      "  1. The user provides the identifier in direct response to YOUR question (you asked for it).\n" +
      "  2. The user uses a self-referential phrase ('my email is...', 'האימייל שלי...', 'send to me at...').\n" +
      "  3. The user volunteers a bare identifier as a clear self-reference.\n" +
      "DO NOT call when the identifier clearly belongs to a third party " +
      "('contact support@...', 'שלח למנהל שלי...', 'forward this to john@...').",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["email", "phone"],
          description: "Which identifier type the customer shared.",
        },
        value: {
          type: "string",
          description:
            "The literal identifier the customer wrote. Copy it verbatim - do not normalize, format, or guess.",
        },
        ownership_evidence: {
          type: "string",
          enum: ["direct_response_to_assistant_question", "self_referential_phrase", "implicit_context", "other"],
          description:
            "Why you believe this identifier belongs to the customer. " +
            "'direct_response_to_assistant_question' when you asked for it and they answered. " +
            "'self_referential_phrase' for 'my X is...'. " +
            "'implicit_context' for a bare identifier with no third-party markers.",
        },
        confidence: {
          type: "number",
          description:
            "0.9 = direct answer to your question. 0.85 = self-referential phrase. 0.7 = implicit. Below 0.7 - do not call.",
        },
      },
      required: ["type", "value", "ownership_evidence", "confidence"],
    },
  },
};

export const CLOSE_CONVERSATION_TOOL = {
  type: "function" as const,
  function: {
    name: "close_conversation",
    description:
      "Mark THIS conversation as resolved. Call ONLY when the goal is achieved AND no follow-up is needed " +
      "(meeting confirmed + customer thanked, issue resolved + customer confirmed, customer explicitly declined). " +
      "Do NOT call mid-conversation or while a follow-up should be scheduled.",
    parameters: {
      type: "object",
      properties: {
        resolution: {
          type: "string",
          enum: ["sale_closed", "info_provided", "issue_resolved", "not_a_fit", "spam", "other"],
        },
        summary: {
          type: "string",
          description: "1–2 sentence outcome for the CRM record. Customer-language not required.",
        },
      },
      required: ["resolution", "summary"],
    },
  },
};

export const SCHEDULE_FOLLOWUP_TOOL = {
  type: "function" as const,
  function: {
    name: "schedule_followup",
    description:
      "Schedule a future outbound message to the customer (WhatsApp). Use when the customer needs more time to think, " +
      "asked for info to be sent later, or you want to re-engage after a deferral. The message body MUST be in the " +
      "customer's language and ready to send as-is.\n\n" +
      "🚫 HARD RULES - break these and the follow-up will be wrong:\n" +
      "  • You MUST have an EXPLICIT timing signal from the customer in THIS conversation before calling this tool. " +
      "Acceptable signals: a concrete duration (\"in 2 hours\", \"tomorrow\", \"next week\"), a specific day/time " +
      "(\"Sunday morning\"), or an explicit deferral with a window (\"call me back later today\", \"ping me in a couple of days\").\n" +
      "  • A vague \"I'm busy\" / \"not now\" / \"let me think\" is NOT a timing signal. In that case you MUST first " +
      "reply with a question in the customer's language - e.g. \"Sure - when would be a good time to reach out again? " +
      "Later today, tomorrow, or sometime next week?\" - and DO NOT call schedule_followup this turn.\n" +
      "  • Never invent a follow-up time. Never default to an arbitrary delay (e.g. 2h, 1d) the customer did not agree to.\n" +
      "  • Confirm the chosen time back to the customer in the SAME turn the tool runs, so they know what to expect.",
    parameters: {
      type: "object",
      properties: {
        delay_iso8601: {
          type: "string",
          description:
            "ISO8601 duration like 'PT2H' (2 hours), 'P1D' (1 day), 'P2D' (2 days). Use this OR send_at_iso, not both.",
        },
        send_at_iso: {
          type: "string",
          description: "Absolute ISO8601 timestamp. Use this OR delay_iso8601, not both.",
        },
        message: {
          type: "string",
          description:
            "The text that will be delivered to the customer AT THE SCHEDULED TIME - not now. " +
            "Write it as if YOU are reaching back out to them in the future. The customer will read this " +
            "WHEN they get it (e.g. tomorrow morning), so use future-arrival tone, NOT present-promise tone.\n\n" +
            "✅ GOOD examples (read these out loud as if it's tomorrow at 8am):\n" +
            "  • \"היי עומר! חוזר אליך כפי שסיכמנו - רוצה להמשיך מאיפה שעצרנו?\"\n" +
            "  • \"Hi Omer! Following up as promised - ready to continue where we left off?\"\n" +
            "  • \"בוקר טוב! מתקשר אליך כמו שסיכמנו אתמול. מתי נוח לדבר?\"\n\n" +
            "❌ BAD examples (these only make sense said NOW, not at the future delivery time):\n" +
            "  • \"אני אחזור אליך מחר ב-8 בבוקר כפי שביקשת\" - at 8am tomorrow this is nonsense.\n" +
            "  • \"I'll get back to you tomorrow at 10am as you requested\" - wrong tense for the future delivery.\n" +
            "  • \"Just confirming I'll follow up later\" - the customer is reading it AT the follow-up time.\n\n" +
            "The customer's confirmation that you HEARD them (e.g. \"מעולה! אחזור אליך מחר ב-8 👍\") is the " +
            "TURN reply you send NOW, AFTER the tool call succeeds - see STEP 4 of the follow-up flow. " +
            "It is NOT the value of this parameter.",
        },
        reason: {
          type: "string",
          description:
            "Why this follow-up exists. For audit + dedupe. Examples: 'post-deferral_2d', 'pre-demo_reminder'.",
        },
      },
      required: ["message", "reason"],
    },
  },
};

/**
 * Schedule a TEMPLATE follow-up - for sends that fall OUTSIDE the WhatsApp
 * 24h customer-service window (or any other re-engagement window). The
 * underlying ScheduledMessage row is created with messageType=template;
 * the scheduled-message worker hydrates the template body + variables and
 * sends it through the Meta WhatsApp Cloud API. Quick-reply buttons are
 * declared at template-registration time on Meta's side; we just reference
 * the approved template by name here.
 */
export const SCHEDULE_FOLLOWUP_TEMPLATE_TOOL = {
  type: "function" as const,
  function: {
    name: "schedule_followup_template",
    description:
      "Schedule a future TEMPLATE message to the customer. Use this when the send time is OUTSIDE the WhatsApp " +
      "24h customer-service window (a free-text message would be silently dropped). Also use when re-engaging " +
      "via WhatsApp from a different originating channel. The template_name MUST be one the operator has " +
      "registered + approved on Meta - refer to the list in the # Context block.\n\n" +
      "🚫 HARD RULES - break these and the follow-up will be wrong:\n" +
      "  • You MUST have an EXPLICIT timing signal from the customer in THIS conversation. Vague non-answers " +
      "(\"I'm busy\", \"not now\", \"maybe later\") do NOT count. If timing is unclear, reply with a question in " +
      "the customer's language asking when to follow up, and DO NOT call this tool this turn.\n" +
      "  • Never invent a send time. Never default to an arbitrary delay the customer did not agree to.",
    parameters: {
      type: "object",
      properties: {
        template_name: {
          type: "string",
          description: "Name of the approved WhatsApp template registered with Meta (must match the # Context list).",
        },
        language: {
          type: "string",
          description: "Template language code, e.g. 'he', 'en'. Defaults to the customer's locale when omitted.",
        },
        send_at_iso: {
          type: "string",
          description: "Absolute ISO8601 timestamp when the template should be sent.",
        },
        delay_iso8601: {
          type: "string",
          description: "ISO8601 duration like 'P1D'. Use this OR send_at_iso, not both.",
        },
        variables: {
          type: "object",
          description:
            "Map of template variable values. KEYS MUST BE NUMERIC STRINGS matching the template's positional placeholders ({{1}}, {{2}}, …). Meta's WhatsApp Cloud API does not support named placeholders. Read each template's `variables:` block in the # Context section to know what each numbered slot expects. Example: { \"1\": \"עומר\", \"2\": \"17.05.2026\" }.",
          additionalProperties: { type: "string" },
        },
        reason: {
          type: "string",
          description: "Why this template follow-up exists (audit + dedupe).",
        },
      },
      required: ["template_name", "reason"],
    },
  },
};

/**
 * Create a CRM task for the human team. Use after scheduling a follow-up
 * (so an agent has visibility), when you spot work the team needs to do,
 * or when the conversation surfaces an action item the bot can't complete.
 */
export const CREATE_TASK_TOOL = {
  type: "function" as const,
  function: {
    name: "create_task",
    description:
      "Create a CRM task for the human team. ALWAYS pair this with a successful schedule_followup or " +
      "schedule_followup_template call so the team has visibility into upcoming work. Also use when the " +
      "conversation surfaces an action item the bot itself cannot complete (manual outreach, document " +
      "preparation, internal verification, etc).",
    parameters: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "Short title for the task (the human will scan a list of these).",
        },
        body: {
          type: "string",
          description: "Details: why, what to do, any context the human needs. One short paragraph.",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "Default 'normal'.",
        },
      },
      required: ["subject", "body"],
    },
  },
};

// Vendor-neutral CRM lead/contact creation. The bot NEVER picks a CRM - the AI
// service resolves the tenant's source-of-truth CRM and maps fields. This is the
// ONLY create path surfaced to the model; raw `<vendor>.create_record` /
// `create_lead` tools are stripped for the resolved CRM so there's no ambiguity.
const _CRM_CREATE_PROPS = {
  name: { type: "string", description: "The person's full name, exactly as they gave it. Do not invent." },
  email: { type: "string", description: "Their email - only if they actually provided one this conversation." },
  phone: { type: "string", description: "Their phone - only if known (the conversation's own channel number counts)." },
  company: { type: "string", description: "Their company / business name, if mentioned." },
  notes: { type: "string", description: "One short line on what they want / why they reached out." },
} as const;

export const INTEGRATION_CREATE_LEAD_TOOL = {
  type: "function" as const,
  function: {
    name: "integration_create_lead",
    description:
      "Create a NEW lead in the business's CRM (whichever CRM is connected as the source of truth - " +
      "HubSpot, Salesforce, Zoho, Airtable, Fireberry, etc.). The system routes to the correct CRM and " +
      "maps the fields automatically - you do NOT choose the CRM and you do NOT need to know which one it is.\n" +
      "Call this SILENTLY (never narrate CRM/lead/record to the customer) once you know who the person is and " +
      "how to reach them. Provide everything you've genuinely learned - at minimum a name AND an email or phone.\n" +
      "🚫 HARD RULES: never invent a name/email/phone - pass only what the customer actually gave you. If you " +
      "don't yet have a name and a way to reach them, ASK first (one question) and do NOT call this tool this turn. " +
      "If the customer already exists in CRM this tool is removed from your toolbox - use the update/note tools instead.",
    parameters: { type: "object", properties: { ..._CRM_CREATE_PROPS }, required: [] },
  },
};

export const INTEGRATION_CREATE_CONTACT_TOOL = {
  type: "function" as const,
  function: {
    name: "integration_create_contact",
    description:
      "Create a NEW contact in the business's CRM (whichever CRM is connected as the source of truth). Same " +
      "behavior and HARD RULES as integration_create_lead, but for businesses that capture people as contacts " +
      "rather than leads. The system routes to the correct CRM and maps fields automatically - never tell the " +
      "customer about CRM/contacts/records, and never invent values you weren't given.",
    parameters: { type: "object", properties: { ..._CRM_CREATE_PROPS }, required: [] },
  },
};

export const SCHEDULE_MEETING_TOOL = {
  type: "function" as const,
  function: {
    name: "schedule_meeting",
    description:
      "Book a meeting on the assigned agent's calendar. The system enforces working hours, " +
      "buffers, minimum-notice, max-horizon, and existing busy slots - DO NOT assume the time " +
      "you propose is free, the server validates and may reject.\n" +
      "BEFORE calling this tool you MUST do TWO things in order:\n\n" +
      "STEP A - CRM identity reconciliation (silent, no narration):\n" +
      "  • Look up the customer in CRM by their phone first (the conversation's `senderId` / phone is the " +
      "primary channel identifier). Use whatever CRM lookup tool is available (e.g. `integration.zoho_crm.search_lead`, " +
      "`integration.hubspot.get_contact`, etc.).\n" +
      "  • If the customer is FOUND and the on-file email differs from one they just stated this turn → confirm " +
      "with the customer in their language: \"I have you on file as old@x.com - should I send the invite there, " +
      "or use new@x.com?\". Do not proceed until they choose.\n" +
      "  • If the customer is FOUND with no conflict → call `link_customer_identifier` for any new identifier " +
      "they stated (high confidence), then `update_record` to keep the lead fresh.\n" +
      "  • If the customer is NOT FOUND → after gathering essentials below, call `create_lead` (silent) " +
      "with their phone + email + name. The booking happens RIGHT AFTER the lead exists.\n\n" +
      "STEP B - gather meeting essentials in conversation (unless the customer already volunteered them):\n" +
      "  1. Time the customer prefers (date + hour + their timezone if non-obvious).\n" +
      "  2. Whether anyone else should be invited (additional guest emails) - explicitly ask if not stated.\n" +
      "  3. Topic / agenda - one short line, so the calendar event title + notes are useful.\n" +
      "  4. The customer's email (only ask if STEP A didn't surface one and the customer hasn't given it).\n" +
      "Ask one question per turn until you have these.\n\n" +
      "🚫 HARD RULES - break these and the booking will be wrong:\n" +
      "  • If the customer's last inbound did NOT include an explicit time (e.g. \"Tuesday at 11\"), " +
      "you MUST reply with a question (e.g. \"Sure - what day/time works for you?\") and NOT call " +
      "schedule_meeting this turn.\n" +
      "  • If the customer has not been asked about additional guests in THIS conversation, you MUST " +
      "ask before calling schedule_meeting.\n" +
      "  • Even if you can guess from CRM history, never assume guests = none. Confirm with the customer.\n" +
      "  • Never call schedule_meeting on the customer's first booking-intent message. Reconcile + qualify first.\n\n" +
      "Behavior of the tool itself:\n" +
      "  - If the customer suggested a time → pass it via `requested_at_iso` and the server validates.\n" +
      "  - If the customer did NOT suggest a time → omit `requested_at_iso` and the server " +
      "returns 2–3 valid slots in `proposed_slots`; relay them and ask the customer to pick one.\n" +
      "Never invent times. Never claim a slot is available without a successful tool result.\n" +
      "Failure modes:\n" +
      "  - verdict='INVALID' with reason='slot_taken' means another booking landed in the same " +
      "window between validation and creation. DO NOT confirm the meeting. The result includes " +
      "`userMessage.he` / `userMessage.en` - relay that line verbatim in the customer's language, " +
      "then offer the slots in `proposedSlotsIso`.",
    parameters: {
      type: "object",
      properties: {
        duration_minutes: {
          type: "number",
          enum: [15, 30, 45, 60],
          description: "Meeting length. Must match a tenant-allowed meeting type.",
        },
        meeting_type: {
          type: "string",
          description:
            "Tenant-defined meeting type slug (e.g. 'discovery_call', 'demo', 'consultation'). " +
            "Each type has its own working hours / buffer policy.",
        },
        requested_at_iso: {
          type: "string",
          description:
            "Optional ISO8601 timestamp the customer explicitly asked for. Must include timezone offset. " +
            "Omit when proposing slots.",
        },
        customer_timezone: {
          type: "string",
          description:
            "IANA timezone (e.g. 'Asia/Jerusalem', 'America/New_York'). Required if you have it; falls back to tenant default.",
        },
        customer_email: {
          type: "string",
          description:
            "Customer email for the calendar invite. Use the identifier just linked via link_customer_identifier; the server rejects bare unverified emails.",
        },
        additional_guests: {
          type: "array",
          items: { type: "string" },
          description:
            "Extra attendee emails the customer asked you to invite (their teammates, manager, etc.). " +
            "Empty array if none - but you MUST have asked the customer first; do not assume.",
        },
        notes: {
          type: "string",
          description: "Short note to attach to the calendar event (one sentence) - typically the topic / agenda the customer stated.",
        },
      },
      required: ["duration_minutes", "meeting_type"],
    },
  },
};

export const ESCALATE_TOOL = {
  type: "function" as const,
  function: {
    name: "escalate_to_human",
    description:
      "Transfer the conversation to a human agent. Call when the customer explicitly asks for a human, when you cannot resolve their issue, when the customer is very upset, or when escalation rules are triggered.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for escalation.",
        },
        priority: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Urgency level.",
        },
        summary: {
          type: "string",
          description: "Brief summary of the conversation so far for the human agent.",
        },
      },
      required: ["reason"],
    },
  },
};

export interface BuildAgentToolsOptions {
  identityLinking?: boolean;
  escalation?: boolean;
  /** Conversation closure tool (Task 4). Default on for autonomous mode. */
  closure?: boolean;
  /** Schedule-followup tool (Task 4). Default on for autonomous mode. */
  followup?: boolean;
  /**
   * schedule_meeting tool (Task 3). Default OFF - only enable when the
   * tenant has at least one calendar integration connected and a
   * `MeetingType` configured. Surfacing the tool with no backend wired
   * causes the model to confidently propose times it can't actually book.
   */
  scheduleMeeting?: boolean;
  /** Extra tenant-defined function schemas to append. */
  extra?: Array<Record<string, unknown>>;
  /**
   * Filter integration tools by execution mode (CatalogTool.allowedModes).
   * "AUTO" - autonomous bot. "ASSIST" - copilot (human in the loop).
   * Tools whose allowedModes array does not include this mode are dropped.
   * Omit to include every tool the agent has permission for.
   */
  allowedMode?: "AUTO" | "ASSIST";
}

export function buildAgentTools(opts: BuildAgentToolsOptions = {}): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  if (opts.identityLinking !== false) tools.push(LINK_IDENTIFIER_TOOL as any);
  if (opts.escalation !== false) tools.push(ESCALATE_TOOL as any);
  if (opts.closure !== false) tools.push(CLOSE_CONVERSATION_TOOL as any);
  if (opts.followup !== false) {
    tools.push(SCHEDULE_FOLLOWUP_TOOL as any);
    tools.push(SCHEDULE_FOLLOWUP_TEMPLATE_TOOL as any);
  }
  // create_task is NOT a built-in: it's a CRM action and should be surfaced
  // as an integration tool (AgentToolPermission), not auto-included here.
  // The schema + dispatcher are kept so a connected CRM can expose it.
  if (opts.scheduleMeeting === true) tools.push(SCHEDULE_MEETING_TOOL as any);
  if (opts.extra?.length) tools.push(...opts.extra);
  return tools;
}

/**
 * Load the tool surface for an autonomous AI agent, merging:
 *   - The static `link_customer_identifier` + `escalate_to_human` helpers
 *   - Integration tools the operator explicitly allowed for THIS ai agent
 *     via AgentToolPermission. Filtered to enabled TenantTool rows on a
 *     CONNECTED integration.
 *
 * The result is shaped as OpenAI function-call tool specs, ready to pass
 * to chat.completions.create({ tools }). Each integration tool is named
 * `integration.<catalogToolSlug>` so the dispatcher can recognise it.
 *
 * Returns the exact same shape as `buildAgentTools` so callers can swap
 * in-place.
 */
export async function buildAgentToolsForAIAgent(
  tenantId: string,
  aiAgentId: string | null | undefined,
  opts: BuildAgentToolsOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const base = buildAgentTools(opts);
  if (!aiAgentId) return base;

  let integrationTools: Array<Record<string, unknown>> = [];
  try {
    const { prisma } = await import("./prisma");
    const rows = await prisma.agentToolPermission.findMany({
      where: {
        tenantId,
        aiAgentId,
        isAllowed: true,
        tenantTool: {
          isEnabled: true,
          tenantIntegration: { status: "CONNECTED" },
          // Calendar tools are surfaced through the PROVIDER-ADAPTER path
          // instead of this HTTP-catalog path, to avoid double-surfacing the
          // same tool under two names. Reads (check_availability/list_events)
          // come from the registered `google_calendar` ProviderAdapter
          // (google-calendar.adapter.ts); writes go ONLY through the validated
          // `schedule_meeting` tool (working hours / buffers / conflicts), so
          // raw create_event is intentionally never surfaced. The connected-AND-
          // allowed authority is identical on both paths — this exclusion is
          // purely routing (which path), not a capability/authorization gate.
          catalogTool: { integration: { category: { not: "CALENDAR" } } },
        },
      },
      include: {
        tenantTool: {
          include: { catalogTool: true },
        },
      },
    });
    const allowedMode = opts.allowedMode;
    const filtered = allowedMode
      ? rows.filter((row: any) => {
          const am = row.tenantTool?.catalogTool?.allowedModes;
          // CatalogTool.allowedModes default is ["AUTO","ASSIST"]; treat
          // missing/malformed as "permits all" so a botched seed doesn't
          // silently drop tools.
          if (!Array.isArray(am)) return true;
          return am.includes(allowedMode);
        })
      : rows;
    integrationTools = filtered.map((row: any) => {
      const ct = row.tenantTool.catalogTool;
      // Prefer the catalog's own inputSchema if it's a JSON-schema object;
      // otherwise emit an empty-object schema so OpenAI will still accept
      // the tool and let the model emit a free-form payload.
      const parameters =
        ct.inputSchema && typeof ct.inputSchema === "object" && !Array.isArray(ct.inputSchema)
          ? ct.inputSchema
          : { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name: `integration_${ct.slug}`,
          description: composeToolDescription(ct, {
            agentDescription: row.description ?? null,
            agentUsageRule: row.usageRule ?? null,
          }),
          parameters,
        },
      };
    });
  } catch (err: any) {
    // Integration tool loading must never break the bot. Fall back to base
    // tools so link_customer_identifier + escalate_to_human still work.
    console.warn("[agent-tools] failed to load integration tools:", err?.message);
  }

  return [...base, ...integrationTools];
}

/**
 * Build the OpenAI tool `description` field for an integration tool.
 *
 * Concatenates (in priority order for the LLM's selection signal):
 *   - the bare `description` (what the tool does),
 *   - `whenToUse` if present (the operator-authored selection rule),
 *   - one worked example from `exampleUsage` if present.
 *
 * This is what gates "should I call this tool right now?" - putting the
 * gating language here, in the tool spec the LLM sees, decouples it from
 * the agent's hand-written system prompt and stops over-firing when the
 * prompt forgets to mention a tool.
 */
function composeToolDescription(
  ct: {
    name: string;
    description: string | null;
    whenToUse?: string | null;
    exampleUsage?: unknown;
  },
  perAgent?: {
    agentDescription?: string | null;
    agentUsageRule?: string | null;
  },
): string {
  const parts: string[] = [];
  // Per-agent description, when present, REPLACES the catalog description -
  // an operator who wrote a per-agent meaning ("For THIS agent: send a
  // follow-up SMS, not an email") is making an authoritative override.
  // Catalog description is kept as a fallback when no override exists.
  const baseDesc =
    perAgent?.agentDescription && perAgent.agentDescription.trim()
      ? perAgent.agentDescription.trim()
      : ct.description || ct.name;
  parts.push(baseDesc);

  // Catalog-level whenToUse is the platform-wide rule. Per-agent
  // usageRule STACKS on top - both render, so a Sales agent's "only
  // after budget confirmed" rule is added alongside the catalog's
  // generic guidance. If the operator wants to fully override, they
  // can blank out the catalog rule via tenant config.
  if (ct.whenToUse && ct.whenToUse.trim()) {
    parts.push(`When to use: ${ct.whenToUse.trim()}`);
  }
  if (perAgent?.agentUsageRule && perAgent.agentUsageRule.trim()) {
    parts.push(`When to use (for this agent): ${perAgent.agentUsageRule.trim()}`);
  }

  const example = pickFirstExample(ct.exampleUsage);
  if (example) parts.push(`Example: ${example}`);
  return parts.join("\n\n");
}

function pickFirstExample(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  if (!first || typeof first !== "object") return null;
  const e = first as Record<string, unknown>;
  const segments: string[] = [];
  if (e.input !== undefined) {
    segments.push(`input=${typeof e.input === "string" ? e.input : JSON.stringify(e.input)}`);
  }
  if (e.output !== undefined) {
    segments.push(`output=${typeof e.output === "string" ? e.output : JSON.stringify(e.output)}`);
  }
  if (e.note && typeof e.note === "string") segments.push(`(${e.note})`);
  return segments.length ? segments.join(" → ") : null;
}

// ─── Dispatcher ──────────────────────────────────────────────

async function callConversationService(
  method: "POST",
  path: string,
  body: unknown,
  ctx: AgentToolContext,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const base = process.env.CONVERSATION_SERVICE_URL ?? "http://conversation-service:3000";
  const url = `${base.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = ctx.authToken ?? process.env.INTERNAL_SERVICE_TOKEN;
  if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  headers["x-tenant-id"] = ctx.tenantId;
  try {
    const res = await fetch(url, { method, headers, body: JSON.stringify(body ?? {}) });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const errBody =
        typeof data === "object" && data && "error" in (data as any)
          ? String((data as any).error)
          : `upstream ${res.status}`;
      return { ok: false, status: res.status, data, error: errBody };
    }
    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message ?? "fetch failed" };
  }
}

export interface ToolCallLike {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export async function dispatchToolCall(
  toolCall: ToolCallLike,
  ctx: AgentToolContext,
): Promise<AgentToolDispatchResult> {
  const name = toolCall.function?.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function?.arguments || "{}");
  } catch {
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({ ok: false, error: "invalid JSON arguments" }),
    };
  }

  // ── F4 gate: tenant-scoped tool permission + HITL approval ──
  // Every bot-initiated tool call flows through evaluateToolGate before
  // dispatch. DENY short-circuits with an error the LLM can see and
  // pivot from. REQUIRE_APPROVAL creates an ApprovalRequest row and
  // returns a side-effect that tells the caller to pause the
  // conversation until a human decides.
  //
  // The two tools hardcoded here today (link_customer_identifier,
  // escalate_to_human) are low-risk by default so this is a no-op for
  // them - but it means ANY new tool added to this dispatcher is
  // automatically gated through the same code path. That's the whole
  // point: replace scattered ad-hoc checks with one entry point.
  try {
    const { evaluateToolGate, createApprovalRequest } = await import("./tool-gate").then(
      async (g) => ({
        evaluateToolGate: g.evaluateToolGate,
        createApprovalRequest: (await import("./approval-requests")).createApprovalRequest,
      }),
    );
    const gate = await evaluateToolGate(ctx.tenantId, name);
    if (gate.decision === "DENY") {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: gate.reason, denied: true }),
        sideEffect: { denied: { tool: name, reason: gate.reason } },
      };
    }
    if (gate.decision === "REQUIRE_APPROVAL") {
      // Copilot mode short-circuit: the human agent is already in the
      // loop, so don't burn an approval page. Hand the proposed call back
      // to the route as a quick action - the agent fires it from the
      // suggestions panel if they want it.
      if (ctx.mode === "copilot") {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({
            ok: false,
            proposed_quick_action: true,
            message:
              "Action proposed. The human agent will decide whether to run it from the suggestions panel.",
          }),
          sideEffect: {
            proposeQuickAction: { tool: name, args, reason: gate.reason },
          },
        };
      }
      // Only create an approval row if we have enough context to route
      // a human back to it. Without conversationId there's no inbox
      // surface, so we fail closed with a plain error.
      if (!ctx.conversationId) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({
            ok: false,
            error: "tool requires approval but no conversation context available",
          }),
        };
      }
      // Dedupe - if an approval for this same tool is already pending on
      // this conversation, reuse it. The bot keeps replying to the
      // customer (handledBy="awaiting_approval" no longer blocks the
      // worker), and we don't mint duplicate ApprovalRequest rows every
      // turn the model decides to re-propose the action. The model also
      // gets a "## Pending Approval" notice in its system prompt
      // (ai-bot.service.ts) so it shouldn't be calling here in the first
      // place - this is the belt-and-suspenders.
      try {
        const { prisma: dedupePrisma } = await import("./prisma");
        const existing = await (dedupePrisma as any).approvalRequest.findFirst({
          where: {
            tenantId: ctx.tenantId,
            conversationId: ctx.conversationId,
            tool: name,
            status: "PENDING",
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (existing) {
          return {
            toolCallId: toolCall.id,
            content: JSON.stringify({
              ok: false,
              awaiting_approval: true,
              approval_request_id: existing.id,
              deduped: true,
              status: "pending_human_approval",
              instruction:
                "Approval already pending for this action. Continue the conversation naturally in the customer's language; do not mention approvals, the team, or any internal process.",
            }),
            sideEffect: {
              awaitingApproval: {
                approvalRequestId: existing.id,
                tool: name,
                reason: "duplicate of pending approval",
              },
            },
          };
        }
      } catch (err: any) {
        // Lookup failure must not break the gate - fall through and
        // create a fresh approval. Worst case: a duplicate row.
        console.warn("[agent-tools] pending-approval dedupe lookup failed:", err?.message);
      }
      const approval = await createApprovalRequest({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        messageId: ctx.messageId,
        tool: name,
        params: args,
        summary: summarizeToolCall(name, args),
        reason: gate.reason,
        // riskLevel here is a display field on the ApprovalRequest row, not a
        // gating signal - the gate decision lives in tool-gate.ts. Tag as
        // "approval_required" so the inbox UI groups it correctly.
        riskLevel: "high",
        riskTags: ["REQUIRES_APPROVAL"],
        requestedBy: "bot",
        gate,
      });
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          awaiting_approval: true,
          approval_request_id: approval.id,
          status: "pending_human_approval",
          instruction:
            "Action paused for approval. Continue the conversation naturally in the customer's language; do not mention approvals, queues, the team, or any internal process.",
        }),
        sideEffect: {
          awaitingApproval: {
            approvalRequestId: approval.id,
            tool: name,
            reason: gate.reason,
          },
        },
      };
    }
  } catch (err: any) {
    // Gate failures must NOT silently allow - fail closed.
    console.error("[agent-tools] gate evaluation failed:", err?.message);
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({
        ok: false,
        error: "permission gate unavailable; refusing to run tool",
      }),
    };
  }

  if (name === "link_customer_identifier") {
    if (!ctx.contactId) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "no contactId in conversation context" }),
      };
    }
    const body = {
      contactId: ctx.contactId,
      type: args.type,
      value: args.value,
      confidence: args.confidence,
      messageId: ctx.messageId ?? null,
      reason: "extracted by AI agent from conversation",
    };
    const r = await callConversationService("POST", "/api/identity/link", body, ctx);
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify(
        r.ok ? { ok: true, result: r.data } : { ok: false, error: r.error },
      ),
    };
  }

  if (name === "escalate_to_human") {
    return {
      toolCallId: toolCall.id,
      content: JSON.stringify({ ok: true, escalated: true }),
      sideEffect: {
        escalate: {
          reason: String(args.reason || "AI requested escalation"),
          priority: (args.priority as any) || "medium",
          summary: args.summary ? String(args.summary) : undefined,
        },
      },
    };
  }

  if (name === "schedule_meeting") {
    console.log(`[ai-bot] tool_call schedule_meeting args=${JSON.stringify(args)}`);
    if (!ctx.scheduleMeeting) {
      console.warn(`[ai-bot] schedule_meeting called but ctx.scheduleMeeting handler is not wired`);
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          reason: "scheduling_not_configured",
        }),
      };
    }
    try {
      const result = await ctx.scheduleMeeting(args as unknown as ScheduleMeetingArgs);
      console.log(`[ai-bot] schedule_meeting → ${JSON.stringify(result).slice(0, 240)}`);
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      console.error(`[ai-bot] schedule_meeting threw: ${err?.message}`);
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "schedule_meeting failed" }),
      };
    }
  }

  if (name === "close_conversation") {
    if (!ctx.conversationId) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "no conversation context for close_conversation" }),
      };
    }
    try {
      const { prisma } = await import("./prisma");
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { status: "CLOSED", closedAt: new Date() } as any,
      });
      // Side-effect free; the dispatcher's caller checks toolCallLog and
      // can publish a `conversation.closed` event downstream.
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: true,
          closed: true,
          resolution: String(args.resolution || "other"),
          summary: String(args.summary || ""),
        }),
      };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: err?.message || "close failed" }),
      };
    }
  }

  if (name === "schedule_followup") {
    if (!ctx.conversationId) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "no conversation context for schedule_followup" }),
      };
    }
    try {
      const { prisma } = await import("./prisma");
      const conv = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: { channel: true, channelAccountId: true, customerExternalId: true },
      });
      if (!conv?.channelAccountId) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: false, error: "conversation has no channelAccountId" }),
        };
      }

      // Compute scheduledAt from delay_iso8601 OR send_at_iso. Default 24h.
      let scheduledAt: Date | null = null;
      if (typeof args.send_at_iso === "string") {
        const d = new Date(args.send_at_iso);
        if (!isNaN(d.getTime())) scheduledAt = d;
      } else if (typeof args.delay_iso8601 === "string") {
        const ms = parseISO8601Duration(args.delay_iso8601);
        if (ms !== null) scheduledAt = new Date(Date.now() + ms);
      }
      if (!scheduledAt) scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // Dedupe on (conversationId, reason) - don't double-schedule.
      const reason = String(args.reason || "ai_followup");
      const existing = await (prisma as any).scheduledMessage.findFirst({
        where: {
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          status: "PENDING",
          variables: { path: ["reason"], equals: reason } as any,
        },
        select: { id: true },
      }).catch(() => null);
      if (existing) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: true, scheduled: true, deduped: true, scheduled_message_id: existing.id }),
        };
      }

      const sm = await (prisma as any).scheduledMessage.create({
        data: {
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          channel: conv.channel,
          channelAccountId: conv.channelAccountId,
          recipientExternalId: conv.customerExternalId,
          body: String(args.message || ""),
          messageType: "text",
          sendType: "conversation",
          scheduledAt,
          createdBy: "ai_agent",
          variables: { reason, source: "ai_bot" },
        },
      });
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: true,
          scheduled: true,
          scheduled_message_id: sm.id,
          scheduled_at: scheduledAt.toISOString(),
        }),
      };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: err?.message || "schedule failed" }),
      };
    }
  }

  if (name === "schedule_followup_template") {
    if (!ctx.conversationId) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "no conversation context for schedule_followup_template" }),
      };
    }
    try {
      const { prisma } = await import("./prisma");
      const conv = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: { channel: true, channelAccountId: true, customerExternalId: true },
      });
      if (!conv?.channelAccountId) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: false, error: "conversation has no channelAccountId" }),
        };
      }

      const templateName = String(args.template_name || "").trim();
      if (!templateName) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: false, error: "template_name required" }),
        };
      }
      const language = typeof args.language === "string" && args.language ? args.language : undefined;

      // Resolve the template - must be tenant-scoped, approved/active. Try
      // exact (channel + language) first, then fall back to looser matches.
      const tpl = await (prisma as any).messageTemplate.findFirst({
        where: {
          tenantId: ctx.tenantId,
          name: templateName,
          isActive: true,
          OR: [{ status: "APPROVED" }, { status: "PENDING_APPROVAL" }],
          ...(language ? { language } : {}),
        },
        select: { id: true, language: true },
      }).catch(() => null);
      if (!tpl) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({
            ok: false,
            error: `template "${templateName}" not found / not approved for this tenant`,
          }),
        };
      }

      // Compute scheduledAt from send_at_iso OR delay_iso8601. Default 24h.
      let scheduledAt: Date | null = null;
      if (typeof args.send_at_iso === "string") {
        const d = new Date(args.send_at_iso);
        if (!isNaN(d.getTime())) scheduledAt = d;
      } else if (typeof args.delay_iso8601 === "string") {
        const ms = parseISO8601Duration(args.delay_iso8601);
        if (ms !== null) scheduledAt = new Date(Date.now() + ms);
      }
      if (!scheduledAt) scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const reason = String(args.reason || "ai_followup_template");
      const variables =
        args.variables && typeof args.variables === "object" && !Array.isArray(args.variables)
          ? (args.variables as Record<string, unknown>)
          : {};

      // Dedupe on (conversationId, reason, template).
      const existing = await (prisma as any).scheduledMessage.findFirst({
        where: {
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          status: "PENDING",
          templateId: tpl.id,
          variables: { path: ["reason"], equals: reason } as any,
        },
        select: { id: true },
      }).catch(() => null);
      if (existing) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: true, scheduled: true, deduped: true, scheduled_message_id: existing.id }),
        };
      }

      const sm = await (prisma as any).scheduledMessage.create({
        data: {
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          channel: conv.channel,
          channelAccountId: conv.channelAccountId,
          recipientExternalId: conv.customerExternalId,
          body: "", // body is rendered by the scheduled-message worker from the template
          messageType: "template",
          templateId: tpl.id,
          sendType: "conversation",
          scheduledAt,
          createdBy: "ai_agent",
          variables: { ...variables, reason, source: "ai_bot" },
        },
      });
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: true,
          scheduled: true,
          scheduled_message_id: sm.id,
          scheduled_at: scheduledAt.toISOString(),
          template_name: templateName,
          template_language: tpl.language,
        }),
      };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: err?.message || "template schedule failed" }),
      };
    }
  }

  if (name === "create_task") {
    if (!ctx.runCreateTask) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "create_task not wired in this context" }),
      };
    }
    const subject = String(args.subject || "").trim();
    const body = String(args.body || "").trim();
    if (!subject) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "subject required" }),
      };
    }
    try {
      const priority = (typeof args.priority === "string"
        ? args.priority
        : "normal") as "low" | "normal" | "high" | "urgent";
      const result = await ctx.runCreateTask({ subject, body, priority });
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: err?.message || "create_task failed" }),
      };
    }
  }

  // ── Integration tools - dispatched via the AI service's execute endpoint ──
  // Tool name shape: `integration.<catalogToolSlug>`. We resolve the slug
  // back to a TenantTool row for this tenant, then POST to ai's
  // /api/ai-assist/:conversationId/tools/execute which handles the HTTP
  // call to the third-party API (Zoho/HubSpot/etc.) plus credentials,
  // audit, and usage tracking.
  // OpenAI function names must match ^[a-zA-Z0-9_-]+$ - dots are rejected -
  // so we use underscore as the prefix separator. The catalog slug itself
  // (after the first underscore) is already in snake_case per our seed.
  // Custom API tools - `custom.<slug>` resolves to a tenant-defined HTTP call.
  if (name?.startsWith("custom.") && ctx.runCustomApiTool) {
    const slug = name.slice("custom.".length);
    try {
      const result = await ctx.runCustomApiTool({ slug, args });
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "custom_api_failed" }),
      };
    }
  }

  // Custom DB query tool - `custom_db.<slug>` (must come before the generic
  // adapter routing because both patterns have a single dot).
  if (name?.startsWith("custom_db.") && ctx.runCustomDbTool) {
    try {
      const result = await ctx.runCustomDbTool({ slug: name.slice("custom_db.".length), args });
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "custom_db_failed" }),
      };
    }
  }

  // Adapter framework - `<provider>.<tool>` (e.g. "stripe.refund_payment").
  if (name && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name) && ctx.runAdapterTool) {
    try {
      const result = await ctx.runAdapterTool({ toolFunctionName: name, args });
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "adapter_failed" }),
      };
    }
  }

  // Unified semantic lead/contact creation. Routed through the per-tenant
  // CRMAdapter (via ctx.runCreateLead) so Airtable/Fireberry/HubSpot/… all share
  // ONE create path with correct field mapping. MUST precede the generic
  // `integration_<slug>` branch below (which would otherwise try to resolve a
  // catalog tool literally named "create_lead" and miss generic-record CRMs).
  if ((name === "integration_create_lead" || name === "integration_create_contact") && ctx.runCreateLead) {
    const kind = name === "integration_create_contact" ? "contact" : "lead";
    try {
      const result = await ctx.runCreateLead({
        kind,
        name: typeof args.name === "string" ? args.name : undefined,
        email: typeof args.email === "string" ? args.email : undefined,
        phone: typeof args.phone === "string" ? args.phone : undefined,
        company: typeof args.company === "string" ? args.company : undefined,
        notes: typeof args.notes === "string" ? args.notes : undefined,
      });
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "create_lead_failed" }),
      };
    }
  }

  if (name?.startsWith("integration_")) {
    const slug = name.slice("integration_".length);
    if (!ctx.conversationId) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: "integration tools require a conversation context" }),
      };
    }
    try {
      const { prisma } = await import("./prisma");
      const tenantTool = await prisma.tenantTool.findFirst({
        where: {
          tenantId: ctx.tenantId,
          isEnabled: true,
          tenantIntegration: { status: "CONNECTED" },
          catalogTool: { slug },
        },
        select: { id: true },
      });
      if (!tenantTool) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: false, error: `no connected tool for slug "${slug}"` }),
        };
      }

      const base = (process.env.AI_SERVICE_URL || "http://ai:4006").replace(/\/$/, "");
      const token = ctx.authToken ?? process.env.INTERNAL_SERVICE_TOKEN ?? process.env.INTERNAL_SERVICE_KEY;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
      headers["x-tenant-id"] = ctx.tenantId;

      const res = await fetch(
        `${base}/api/ai-assist/${encodeURIComponent(ctx.conversationId)}/tools/execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ tenantToolId: tenantTool.id, input: args }),
        },
      );
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          toolCallId: toolCall.id,
          content: JSON.stringify({ ok: false, error: json?.error || `upstream ${res.status}` }),
        };
      }
      const exec = json?.data;
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify(
          exec?.ok
            ? { ok: true, result: exec.output }
            : { ok: false, error: exec?.error || "tool execution failed", status: exec?.status },
        ),
      };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, error: err?.message ?? "integration dispatch failed" }),
      };
    }
  }

  return {
    toolCallId: toolCall.id,
    content: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }),
  };
}

/**
 * Parse a subset of ISO 8601 durations: P[nD]T[nH][nM]. Returns ms or null
 * on parse failure. Sufficient for follow-up windows ("PT2H", "P1D", "P2D").
 */
function parseISO8601Duration(input: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(input.trim());
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  const ms = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
  return ms > 0 ? ms : null;
}

/**
 * Lightweight human-readable summary of a tool call for the approval
 * card. Stays a plain string - no LLM call, no localization, no fancy
 * formatting. The rich card in the inbox renders richer UI from the
 * raw (tool, params); this is just the "one-sentence first line"
 * fallback for lists and notifications.
 */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const preview = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return preview ? `${name}(${preview})` : `${name}()`;
}
