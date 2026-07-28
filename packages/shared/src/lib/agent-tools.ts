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
   * Optional handler for `check_availability` (read-only). Answers "what times
   * are free?", "are you open Saturday?", "what are your working hours?" by
   * inspecting the configured calendar + scheduling policy. NEVER creates an
   * event. Wired alongside scheduleMeeting whenever a calendar is bookable.
   */
  checkAvailability?: (args: CheckAvailabilityArgs) => Promise<CheckAvailabilityResult>;
  /**
   * Optional handler for `reschedule_meeting`. Moves the meeting already booked
   * in THIS conversation to a new time (the existing eventId is resolved
   * server-side from the audit trail, NOT supplied by the model). Wired by the
   * ai service only when a connected calendar AND a prior booking exist.
   */
  rescheduleMeeting?: (args: RescheduleMeetingArgs) => Promise<RescheduleMeetingResult>;
  /**
   * Optional handler for `cancel_meeting`. Cancels the meeting already booked in
   * THIS conversation (eventId resolved server-side). Wired alongside
   * rescheduleMeeting.
   */
  cancelMeeting?: () => Promise<CancelMeetingResult>;
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
   * Cross-identity verification (set by ai-bot.service). The ONLY sanctioned
   * path when the chat participant claims to be a DIFFERENT customer: an OTP
   * goes to the destination already STORED on that customer (never to a
   * chat-supplied destination), and only a confirmed code opens short-lived,
   * customer-scoped access via the backend guard. The handler returns only a
   * MASKED destination - the model never sees the stored phone/email.
   */
  requestIdentityVerification?: (opts: {
    phone?: string;
    email?: string;
  }) => Promise<{ ok: boolean; sent_to?: string; reason?: string }>;
  submitVerificationCode?: (opts: {
    code: string;
  }) => Promise<{ ok: boolean; verified?: boolean; remainingAttempts?: number; reason?: string }>;
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
  /**
   * Shopify product card / carousel handler. Wired by the AI service from
   * its catalog + commerce-message services, so this file stays free of
   * Shopify specifics. Present only on Shopify Live Chat conversations
   * where product messaging is allowed; when absent the tools are not
   * surfaced and a stray call degrades to a clear refusal.
   */
  sendShopifyProducts?: (args: SendShopifyProductsArgs) => Promise<SendShopifyProductsResult>;
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
      /**
       * schedule_meeting is a pure WRITE tool: it never searches for slots. When
       * the chosen time isn't bookable (out of hours, busy, min-notice, or a
       * `slot_taken` race after validation) it sets this flag so the model knows
       * to call `check_availability` for real open slots instead of expecting
       * alternatives in this result.
       */
      needsAvailabilityCheck: true;
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
  | { ok: false; reason: string; needsAvailabilityCheck?: boolean };

export interface RescheduleMeetingArgs {
  /** The NEW time the customer wants, ISO8601 with timezone offset. */
  requested_at_iso: string;
  customer_timezone?: string;
}

/**
 * Reschedule shares schedule_meeting's result shape: VALID on a successful move
 * (new eventId/joinUrl/start/end), INVALID with `needsAvailabilityCheck` when
 * the new time isn't bookable (defer to check_availability), or a bare
 * {ok:false,reason} (e.g. `no_existing_meeting` when there's nothing to move).
 */
export type RescheduleMeetingResult = ScheduleMeetingResult;

export type CancelMeetingResult =
  | { ok: true; cancelled: true; startMs?: number; endMs?: number }
  | { ok: false; reason: string };

export interface CheckAvailabilityArgs {
  /**
   * Which meeting type to check against (its duration + working-hours policy).
   * Optional: the server snaps to the closest configured type, or uses the only
   * one when a single type exists.
   */
  meeting_type?: string;
  /**
   * A SPECIFIC time the customer asked about ("are you free tomorrow at noon?"),
   * ISO8601 with offset. Returns `requestedAvailable` + a `requestedReason` when
   * not free. Mutually exclusive with from_iso/to_iso (point check vs window).
   */
  requested_at_iso?: string;
  /** Window start for "what's free tomorrow / Saturday / next week", ISO8601. */
  from_iso?: string;
  /** Window end for the same windowed question, ISO8601. */
  to_iso?: string;
  customer_timezone?: string;
}

/** A weekly working-hours window in the agent's timezone (empty weekday = closed). */
export interface WorkingHoursWindow {
  /** 0=Sun … 6=Sat (JS Date.getDay()). */
  weekday: number;
  /** "HH:MM" 24h, agent timezone. */
  start: string;
  /** "HH:MM" 24h, agent timezone (exclusive). */
  end: string;
}

/**
 * Read-only availability answer. The single source of truth the model uses for
 * EVERY availability / working-hours question. Never books anything.
 */
export type CheckAvailabilityResult =
  | {
      ok: true;
      /** IANA timezone the working hours + slots are expressed in. */
      timezone: string;
      /** Structured weekly working hours; absence of a weekday = closed that day. */
      workingHours: WorkingHoursWindow[];
      minNoticeHours: number;
      maxHorizonDays: number;
      /** Duration (minutes) of the meeting type these slots were computed for. */
      durationMinutes: number;
      meetingTypeSlug: string;
      /** Set when `requested_at_iso` was given - the point-check verdict. */
      requestedIso?: string;
      requestedAvailable?: boolean;
      /** InvalidReason (e.g. outside_working_hours, agent_busy) when not available. */
      requestedReason?: string;
      /**
       * Valid, bookable open slots (ISO8601). Within [from_iso,to_iso] when a
       * window was given, else soonest-first. The customer picks one of these and
       * THEN the model calls schedule_meeting with it.
       */
      proposedSlotsIso: string[];
      /**
       * Soonest valid slot ignoring the window - populated when the windowed
       * answer is empty (e.g. asked about a closed Saturday) so the model can say
       * "we're closed then; the nearest is …".
       */
      nextAvailableIso?: string;
    }
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

export const REQUEST_IDENTITY_VERIFICATION_TOOL = {
  type: "function" as const,
  function: {
    name: "request_identity_verification",
    description:
      "Start REAL identity verification when the chat participant asks about records of a customer whose " +
      "identity does not match this chat's phone number. A one-time code is sent to the contact details " +
      "ALREADY STORED on that customer's account - never to a phone or email typed in this chat. " +
      "Saying 'yes that's me', repeating a phone number, or knowing an order number is NOT verification - " +
      "when in doubt, call this tool or escalate to a human. You will receive only a masked destination " +
      "(e.g. ***0665) to tell the customer; never reveal the full stored phone or email.",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone the participant CLAIMS identifies the customer (untrusted input, used only to locate the stored account)." },
        email: { type: "string", description: "Email the participant CLAIMS identifies the customer (untrusted input)." },
      },
    },
  },
};

export const SUBMIT_VERIFICATION_CODE_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_verification_code",
    description:
      "Submit the one-time verification code the customer received after request_identity_verification. " +
      "Only a correct, unexpired code opens access - and only to that specific customer's records, for a " +
      "short time, in this conversation.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "The code exactly as the customer typed it." },
      },
      required: ["code"],
    },
  },
};

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

export const CHECK_AVAILABILITY_TOOL = {
  type: "function" as const,
  function: {
    name: "check_availability",
    description:
      "READ-ONLY. Inspect the assigned agent's REAL calendar + scheduling rules to answer ANY availability " +
      "or working-hours question. This is the ONLY source of truth for when the agent can meet - you do NOT " +
      "know the calendar yourself, so never state availability, working hours, or specific open times from " +
      "memory or reasoning. This tool NEVER books anything.\n\n" +
      "Call it whenever the customer asks about timing, OR right before you propose any time yourself:\n" +
      "  • \"are you free tomorrow / around noon / next week?\" → pass from_iso/to_iso for that window (or " +
      "requested_at_iso for one exact time).\n" +
      "  • \"what are your working hours?\", \"do you work Saturdays?\", \"are evenings possible?\" → call with " +
      "no time and answer from the returned `workingHours` (structured weekly hours) + `timezone`.\n" +
      "  • YOU want to propose meeting times → call first (with the window you have in mind, or none for " +
      "'soonest') and offer ONLY the returned `proposedSlotsIso`. Never volunteer a clock time this tool " +
      "did not return.\n\n" +
      "Result:\n" +
      "  - `workingHours` + `timezone` + `minNoticeHours` → answer hours / Saturday / evening questions directly.\n" +
      "  - `proposedSlotsIso` → real bookable slots to offer; the customer picks one, THEN you call " +
      "schedule_meeting with that exact slot.\n" +
      "  - `requestedAvailable` + `requestedReason` (only when you passed `requested_at_iso`) → whether that one " +
      "exact time is open, and if not, why.\n" +
      "  - `nextAvailableIso` → the soonest open slot when the window you asked about has none (e.g. a closed " +
      "Saturday): say you're closed then and offer it.",
    parameters: {
      type: "object",
      properties: {
        meeting_type: {
          type: "string",
          description:
            "Configured meeting-type slug to check against (drives duration + working-hours policy). " +
            "Optional - the server snaps to the closest configured type, or uses the only one configured.",
        },
        requested_at_iso: {
          type: "string",
          description:
            "A SINGLE exact time to check ('are you free tomorrow at 12:00?'), ISO8601 with timezone offset. " +
            "Use this OR from_iso/to_iso - not both.",
        },
        from_iso: {
          type: "string",
          description: "Window start for 'what's free tomorrow / Saturday / next week', ISO8601 with offset.",
        },
        to_iso: {
          type: "string",
          description: "Window end for that windowed question, ISO8601 with offset.",
        },
        customer_timezone: {
          type: "string",
          description: "IANA timezone (e.g. 'Asia/Jerusalem'). Provide if known.",
        },
      },
      required: [],
    },
  },
};

export const SCHEDULE_MEETING_TOOL = {
  type: "function" as const,
  function: {
    name: "schedule_meeting",
    description:
      "BOOK a meeting at a SPECIFIC time the customer has ALREADY chosen. This is a pure WRITE action: it " +
      "creates the calendar event, the Meet link, and the invites. It does NOT search for times and does NOT " +
      "decide availability - that is `check_availability`'s job. Never call this to 'see if a time works', and " +
      "never invent a time.\n\n" +
      "PRECONDITION - you only reach this tool once a concrete slot is agreed, obtained one of two ways:\n" +
      "  • the customer named an explicit time AND you confirmed it is open via `check_availability`, or\n" +
      "  • the customer picked one of the slots `check_availability` returned.\n\n" +
      "BEFORE booking, complete these (ask ONE question per turn if anything is missing):\n" +
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
      "STEP B - essentials (unless already volunteered):\n" +
      "  1. Whether anyone else should be invited (additional guest emails) - explicitly ask if not stated.\n" +
      "  2. Topic / agenda - one short line, so the calendar event title + notes are useful.\n" +
      "  3. The customer's email (only ask if STEP A didn't surface one and the customer hasn't given it).\n\n" +
      "🚫 HARD RULES:\n" +
      "  • `requested_at_iso` is REQUIRED - it is the exact agreed slot. If you do NOT have a concrete agreed " +
      "time, call `check_availability` instead; do not call this tool.\n" +
      "  • If the customer has not been asked about additional guests in THIS conversation, ask first; never " +
      "assume guests = none, even from CRM history.\n" +
      "  • Never call schedule_meeting on the customer's first booking-intent message. Reconcile + qualify first.\n\n" +
      "Result handling:\n" +
      "  - verdict='VALID' → booked; confirm the exact day/time + the meeting link.\n" +
      "  - ok:false with `needsAvailabilityCheck:true` (reasons include no_time_selected, outside_working_hours, " +
      "agent_busy, min_notice_violated, slot_taken) → the chosen slot is NOT bookable. Do NOT confirm. Call " +
      "`check_availability` to get real open slots, offer them, and let the customer pick. When a " +
      "`userMessage.he`/`userMessage.en` is present, relay it verbatim in the customer's language first.",
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
            "Slug of one of the business's CONFIGURED meeting types. Do NOT invent a value from the " +
            "customer's wording: if they say 'demo'/'call'/'meeting'/'intro' and that is not an exact " +
            "configured slug, pass the CLOSEST configured type (e.g. their request for a 'demo' → a " +
            "'discovery_call' type). The server snaps to the nearest configured type and, if there is " +
            "only one, uses it. Each type has its own working hours / buffer policy.",
        },
        requested_at_iso: {
          type: "string",
          description:
            "REQUIRED. The exact ISO8601 slot (with timezone offset) the customer has CHOSEN - either a time " +
            "they named that you confirmed open via check_availability, or one of check_availability's returned " +
            "slots. This tool books THIS time; it never searches for one.",
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
      required: ["duration_minutes", "meeting_type", "requested_at_iso"],
    },
  },
};

export const RESCHEDULE_MEETING_TOOL = {
  type: "function" as const,
  function: {
    name: "reschedule_meeting",
    description:
      "MOVE the meeting already booked in THIS conversation to a new, ALREADY-CHOSEN time. Use this - never " +
      "schedule_meeting - when the customer wants to change/move/postpone an existing meeting. Calling " +
      "schedule_meeting again would create a DUPLICATE event and leave the old one on the calendar.\n" +
      "The system already knows which event to move (resolved server-side) - you only provide the NEW time. " +
      "Like schedule_meeting, this is a WRITE action: it does NOT search for replacement times.\n" +
      "HARD RULES:\n" +
      "  • Only call this if a meeting was actually booked earlier in this conversation. If unsure, you don't have one.\n" +
      "  • To find a replacement time, use `check_availability` first (it gives real open slots / working hours); " +
      "call reschedule_meeting only once the customer has CHOSEN the new time. Never invent the new time.\n" +
      "  • If the new time turns out to be unbookable you'll get ok:false with `needsAvailabilityCheck:true` - " +
      "do NOT confirm the move; call check_availability, offer real slots, and let the customer pick.\n" +
      "  • On success the meeting keeps its original meeting link; confirm the new day/time to the customer.",
    parameters: {
      type: "object",
      properties: {
        requested_at_iso: {
          type: "string",
          description: "The NEW ISO8601 time the customer asked for. Must include timezone offset.",
        },
        customer_timezone: {
          type: "string",
          description: "IANA timezone (e.g. 'Asia/Jerusalem'). Provide if known.",
        },
      },
      required: ["requested_at_iso"],
    },
  },
};

export const CANCEL_MEETING_TOOL = {
  type: "function" as const,
  function: {
    name: "cancel_meeting",
    description:
      "CANCEL the meeting already booked in THIS conversation. Use when the customer wants to cancel/call off an " +
      "existing meeting (and is NOT asking to move it - to move it, use reschedule_meeting). The system knows which " +
      "event to cancel (resolved server-side); the guests are notified automatically.\n" +
      "HARD RULES:\n" +
      "  • Only call this if a meeting was actually booked earlier in this conversation.\n" +
      "  • Confirm the cancellation to the customer once it succeeds. Do NOT then offer to rebook unless they ask.",
    parameters: { type: "object", properties: {} },
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

/**
 * Shopify Live Chat product messaging.
 *
 * Two tools rather than one because the model's *intent* differs: "here
 * is the one I recommend" and "here are a few to compare" are different
 * answers, and collapsing them into a count parameter reliably produced
 * one-item carousels. Both accept references only — the server re-reads
 * title, price, image and stock from Shopify, so the model cannot invent
 * a product or quote a stale price even if it tries.
 */
export const SEND_PRODUCT_CARD_TOOL = {
  type: "function" as const,
  function: {
    name: "send_product_card",
    description:
      "Show the customer ONE specific product as a rich card with its live price, image, availability and an Add to Cart button. " +
      "Use after you have identified the single best product for them. " +
      "Write your normal reply text as usual — the card is sent alongside it, so do NOT paste the product URL or price into your message.",
    parameters: {
      type: "object",
      properties: {
        product_id: {
          type: "string",
          description: "Shopify product id, from a product search or lookup. Preferred.",
        },
        handle: {
          type: "string",
          description: "Shopify product handle, if you have that instead of an id.",
        },
        variant_id: {
          type: "string",
          description:
            "Specific variant id, ONLY when the customer already chose their size/colour. Leave empty otherwise so they can pick.",
        },
        reason: {
          type: "string",
          description:
            "One short sentence on why this product fits this customer. Shown on the card.",
        },
      },
    },
  },
};

export const SEND_PRODUCT_CAROUSEL_TOOL = {
  type: "function" as const,
  function: {
    name: "send_product_carousel",
    description:
      "Show the customer a small set of products side by side, each with live price, image and availability. " +
      "Use when several products genuinely fit and the customer should choose. " +
      "Prefer 3 items; never send more than 5. Do not use this to list your whole catalogue.",
    parameters: {
      type: "object",
      properties: {
        products: {
          type: "array",
          description: "The products to show, best first.",
          items: {
            type: "object",
            properties: {
              product_id: { type: "string", description: "Shopify product id. Preferred." },
              handle: { type: "string", description: "Shopify product handle." },
              variant_id: { type: "string", description: "Variant id, only if already chosen." },
              reason: { type: "string", description: "One short sentence on why this one fits." },
            },
          },
        },
      },
      required: ["products"],
    },
  },
};

export interface SendShopifyProductsArgs {
  products: Array<{
    productId?: string | null;
    handle?: string | null;
    variantId?: string | null;
    reason?: string | null;
  }>;
}

export type SendShopifyProductsResult =
  | {
      ok: true;
      /** Titles the model may safely refer to — resolved from Shopify. */
      products: Array<{ title: string; price: string | null; currency: string; available: boolean }>;
    }
  | { ok: false; reason: string };

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
  /**
   * check_availability tool (read-only). Surfaced together with scheduleMeeting
   * whenever the agent has a bookable calendar - it's the source of truth for
   * availability + working-hours questions, so the model never invents times.
   */
  checkAvailability?: boolean;
  /**
   * reschedule_meeting / cancel_meeting tools. Default OFF - the ai service
   * enables them ONLY when the agent has a bookable calendar AND a meeting was
   * already booked in this conversation (so the model can't move/cancel a
   * meeting that doesn't exist).
   */
  rescheduleMeeting?: boolean;
  cancelMeeting?: boolean;
  /**
   * Shopify product card / carousel tools. Default OFF - only enable on a
   * Shopify Live Chat conversation whose channel and plan both allow
   * product messaging. Surfacing them elsewhere would let the model
   * promise a card the channel cannot render.
   */
  shopifyProducts?: boolean;
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
  // Cross-identity verification: always offered - the backend guard blocks
  // cross-customer lookups outright, and these two tools are the model's ONLY
  // legitimate way through (OTP to the STORED destination of the claimed
  // customer, confirmed in-chat). Without them the model has no honest path
  // and is more likely to improvise.
  tools.push(REQUEST_IDENTITY_VERIFICATION_TOOL as any);
  tools.push(SUBMIT_VERIFICATION_CODE_TOOL as any);
  if (opts.escalation !== false) tools.push(ESCALATE_TOOL as any);
  if (opts.closure !== false) tools.push(CLOSE_CONVERSATION_TOOL as any);
  if (opts.followup !== false) {
    tools.push(SCHEDULE_FOLLOWUP_TOOL as any);
    tools.push(SCHEDULE_FOLLOWUP_TEMPLATE_TOOL as any);
  }
  // create_task is NOT a built-in: it's a CRM action and should be surfaced
  // as an integration tool (AgentToolPermission), not auto-included here.
  // The schema + dispatcher are kept so a connected CRM can expose it.
  if (opts.checkAvailability === true) tools.push(CHECK_AVAILABILITY_TOOL as any);
  if (opts.scheduleMeeting === true) tools.push(SCHEDULE_MEETING_TOOL as any);
  if (opts.rescheduleMeeting === true) tools.push(RESCHEDULE_MEETING_TOOL as any);
  if (opts.cancelMeeting === true) tools.push(CANCEL_MEETING_TOOL as any);
  if (opts.shopifyProducts === true) {
    tools.push(SEND_PRODUCT_CARD_TOOL as any);
    tools.push(SEND_PRODUCT_CAROUSEL_TOOL as any);
  }
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
          // Calendar tools are NOT surfaced through this HTTP-catalog path, to
          // avoid double-surfacing the same tool under two names. Availability is
          // the first-class `check_availability` built-in (validated against the
          // scheduling policy - working hours / buffers / conflicts), booking is
          // the `schedule_meeting` built-in, and neutral reads (list_events) come
          // from the registered `google_calendar` ProviderAdapter. Raw
          // create_event / free-busy passthroughs are intentionally never
          // surfaced. This exclusion is purely routing (which path), not a
          // capability/authorization gate.
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

  if (name === "request_identity_verification") {
    if (!ctx.requestIdentityVerification) {
      return { toolCallId: toolCall.id, content: JSON.stringify({ ok: false, error: "verification_unavailable" }) };
    }
    const r = await ctx.requestIdentityVerification({
      phone: args.phone != null ? String(args.phone) : undefined,
      email: args.email != null ? String(args.email) : undefined,
    });
    return { toolCallId: toolCall.id, content: JSON.stringify(r) };
  }

  if (name === "submit_verification_code") {
    if (!ctx.submitVerificationCode) {
      return { toolCallId: toolCall.id, content: JSON.stringify({ ok: false, error: "verification_unavailable" }) };
    }
    const r = await ctx.submitVerificationCode({ code: String(args.code ?? "") });
    return { toolCallId: toolCall.id, content: JSON.stringify(r) };
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

  if (name === "check_availability") {
    console.log(`[ai-bot] tool_call check_availability args=${JSON.stringify(args)}`);
    if (!ctx.checkAvailability) {
      console.warn(`[ai-bot] check_availability called but ctx.checkAvailability handler is not wired`);
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: "scheduling_not_configured" }),
      };
    }
    try {
      const result = await ctx.checkAvailability(args as unknown as CheckAvailabilityArgs);
      console.log(`[ai-bot] check_availability → ${JSON.stringify(result).slice(0, 240)}`);
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      console.error(`[ai-bot] check_availability threw: ${err?.message}`);
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "check_availability failed" }),
      };
    }
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

  if (name === "reschedule_meeting") {
    console.log(`[ai-bot] tool_call reschedule_meeting args=${JSON.stringify(args)}`);
    if (!ctx.rescheduleMeeting) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: "reschedule_not_configured" }),
      };
    }
    try {
      const result = await ctx.rescheduleMeeting(args as unknown as RescheduleMeetingArgs);
      console.log(`[ai-bot] reschedule_meeting → ${JSON.stringify(result).slice(0, 240)}`);
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      console.error(`[ai-bot] reschedule_meeting threw: ${err?.message}`);
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "reschedule_meeting failed" }),
      };
    }
  }

  if (name === "cancel_meeting") {
    console.log(`[ai-bot] tool_call cancel_meeting`);
    if (!ctx.cancelMeeting) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: "cancel_not_configured" }),
      };
    }
    try {
      const result = await ctx.cancelMeeting();
      console.log(`[ai-bot] cancel_meeting → ${JSON.stringify(result).slice(0, 240)}`);
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      console.error(`[ai-bot] cancel_meeting threw: ${err?.message}`);
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "cancel_meeting failed" }),
      };
    }
  }

  if (name === "send_product_card" || name === "send_product_carousel") {
    if (!ctx.sendShopifyProducts) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          reason: "product_cards_not_available_on_this_channel",
          instruction:
            "You cannot show a product card here. Describe the product in plain text instead, and never invent a price or stock level.",
        }),
      };
    }
    const refs =
      name === "send_product_card"
        ? [
            {
              productId: str(args.product_id),
              handle: str(args.handle),
              variantId: str(args.variant_id),
              reason: str(args.reason),
            },
          ]
        : (Array.isArray(args.products) ? args.products : []).map((p: any) => ({
            productId: str(p?.product_id),
            handle: str(p?.handle),
            variantId: str(p?.variant_id),
            reason: str(p?.reason),
          }));
    if (!refs.length || refs.every((r) => !r.productId && !r.handle)) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({
          ok: false,
          reason: "no_product_reference",
          instruction:
            "Search the catalogue first and pass the product id you found. Never guess an id.",
        }),
      };
    }
    try {
      const result = await ctx.sendShopifyProducts({ products: refs });
      return { toolCallId: toolCall.id, content: JSON.stringify(result) };
    } catch (err: any) {
      return {
        toolCallId: toolCall.id,
        content: JSON.stringify({ ok: false, reason: err?.message || "send_products_failed" }),
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
/** Model-supplied scalar → trimmed string or null. */
function str(raw: unknown): string | null {
  if (typeof raw === "number") return String(raw);
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return v ? v.slice(0, 200) : null;
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const preview = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return preview ? `${name}(${preview})` : `${name}()`;
}
