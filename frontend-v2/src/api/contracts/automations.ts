import { z } from 'zod';

import { plainDashes } from '@/lib/plain-dashes';

/**
 * Automations - 09c, 09d, 09e (design 6), over `/api/automations` (Backend
 * 87456663; contract `ChatCenter/docs/api/automations-contract-v1.md`,
 * shapes read from `services/chatbot/src/routes/automations.ts` and
 * `lib/automation-catalog.ts`).
 *
 * An automation is a `ChatbotFlow` with a structured trigger. Created as a
 * draft; activate answers `{ data, warnings }` or 422 with the issues; a PUT
 * on a live one is validated and refused (422, nothing stored); pause
 * records who and when. The list carries `path` (the row's chips), one
 * automation carries its graph.
 *
 * Runs and node stats are real rows (`AutomationRun`, `…Step`) - empty until
 * something has run, and then said as "No runs yet", never a number.
 */

/** Every trigger the route knows (`TRIGGER_TYPES`). */
export const TRIGGER_TYPES = [
  'message_received',
  'new_customer',
  'message_from_ad',
  'button_tapped',
  'comment_received',
  'tag_added',
  'schedule',
  'webhook',
  'call_missed',
  'call_answered',
  'order_event',
  'cart_abandoned',
  'form_submitted',
  'story_mention',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const AUTOMATION_STATUSES = ['draft', 'live', 'paused'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const RUN_STATUSES = ['running', 'waiting', 'completed', 'failed', 'skipped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The route's channels (`CHANNELS`). */
export const AUTOMATION_CHANNELS = [
  'WHATSAPP',
  'MESSENGER',
  'INSTAGRAM',
  'EMAIL',
  'GMAIL',
  'OUTLOOK',
  'SLACK',
  'VOICE',
  'WEBCHAT',
  'SHOPIFY_LIVE_CHAT',
] as const;
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number];

/** Why a catalogue item cannot be used here (`Reason`). */
export const CATALOG_REASONS = [
  'first_step_only',
  'channel_not_supported',
  'no_customer_on_path',
  'needs_24h_window',
  'no_event_source',
  'not_connected',
  'coming_later',
  /** A comment automation: only the comment's own steps run before the customer replies. */
  'after_customer_replies',
  /** The public comment reply exists only in a comment automation. */
  'comment_automation_only',
] as const;
export type CatalogReason = (typeof CATALOG_REASONS)[number];

const text = z.string().nullable().catch(null).default(null);
const who = z
  .looseObject({ id: z.string(), name: z.string().nullable().catch(null).default(null) })
  .nullable()
  .catch(null)
  .default(null);

export const triggerSchema = z.looseObject({
  /** Unknown to this screen: read as `null` and named by the route's label. */
  type: z.enum(TRIGGER_TYPES).nullable().catch(null),
  config: z.record(z.string(), z.unknown()).catch({}).default({}),
});
export type Trigger = z.infer<typeof triggerSchema>;

export const pathStepSchema = z.looseObject({
  nodeId: z.string(),
  type: z.string(),
  /** The author's `data.label`, else the route's ENGLISH catalogue name. */
  label: z.string().catch(''),
});
export type PathStep = z.infer<typeof pathStepSchema>;

export const nodeSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  position: z
    .looseObject({ x: z.number().catch(0), y: z.number().catch(0) })
    .catch({ x: 0, y: 0 })
    .default({ x: 0, y: 0 }),
  data: z.record(z.string(), z.unknown()).catch({}).default({}),
});
export type AutomationNode = z.infer<typeof nodeSchema>;

export const edgeSchema = z.looseObject({
  id: z.string().optional(),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().catch(null).default(null),
});
export type AutomationEdge = z.infer<typeof edgeSchema>;

export const automationSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: text,
  trigger: triggerSchema,
  status: z.enum(AUTOMATION_STATUSES),
  activatedAt: text,
  activatedBy: who,
  pausedAt: text,
  pausedBy: who,
  /** Only on one automation; the list carries `path` instead. */
  nodes: z.array(nodeSchema).optional(),
  edges: z.array(edgeSchema).optional(),
  path: z.array(pathStepSchema).catch([]).default([]),
  stats: z
    .looseObject({
      runsThisWeek: z.number().int().nonnegative().catch(0),
      lastRunAt: text,
      lastRunStatus: z.enum(RUN_STATUSES).nullable().catch(null).default(null),
    })
    .catch({ runsThisWeek: 0, lastRunAt: null, lastRunStatus: null }),
  /** Sent back as `expectedUpdatedAt`: a stale save is a 409. */
  updatedAt: z.string(),
  createdAt: text,
});
export type Automation = z.infer<typeof automationSchema>;

/* Strict envelopes: an unreadable answer is "couldn't read", never an empty list. */
export const automationListSchema = z.object({ data: z.array(automationSchema) });
export const automationOneSchema = z.object({ data: automationSchema });

/** The validator's codes (contract v1 §2), each said in the screen's words. */
export const ISSUE_CODES = [
  'no_trigger',
  'trigger_node',
  'no_steps',
  'trigger_no_event_source',
  'trigger_not_connected',
  'missing_config',
  'too_many_buttons',
  'too_many_options',
  'title_too_long',
  'duplicate_button',
  'channel_not_supported',
  'no_customer_on_path',
  'node_unavailable',
  'unknown_node',
  'unknown_branch',
  'no_output',
  'cycle',
  'broken_edge',
  'invalid_delay',
  'needs_24h_window',
  'after_customer_replies',
  'comment_automation_only',
  // AU4 (Backend 0c410009): a cart reminder's channel is its first message's.
  'via_required',
  'via_not_connected',
  'via_mismatch',
  'unreachable_same_channel',
  'unreachable_only_on_first_send',
] as const;

export const issueSchema = z.looseObject({
  severity: z.enum(['error', 'warning']).catch('error'),
  code: z.string(),
  nodeId: z.string().nullable().catch(null).default(null),
  message: z
    .string()
    .transform((s) => plainDashes(s))
    .catch(''),
});
export type Issue = z.infer<typeof issueSchema>;

/** POST /:id/validate: `{ errors, warnings }` for a canvas as it is. */
export const validationSchema = z.object({
  errors: z.array(issueSchema).catch([]).default([]),
  warnings: z.array(issueSchema).catch([]).default([]),
});

/** Activate's answer: live, with what it warned about. */
export const activatedSchema = z.object({
  data: automationSchema,
  warnings: z.array(issueSchema).catch([]).default([]),
});

/** A 422 from activate or a live save: what stopped it. */
export const refusalSchema = z.looseObject({
  error: z.string(),
  errors: z.array(issueSchema).catch([]).default([]),
  warnings: z.array(issueSchema).catch([]).default([]),
});

export const runSchema = z.looseObject({
  id: z.string().min(1),
  automationId: z.string(),
  triggerType: z.string().nullable().catch(null).default(null),
  status: z.enum(RUN_STATUSES).catch('running'),
  conversationId: text,
  contact: z
    .looseObject({ id: z.string(), name: z.string().nullable().catch(null).default(null) })
    .nullable()
    .catch(null)
    .default(null),
  startedAt: text,
  endedAt: text,
  error: z
    .string()
    .transform((s) => plainDashes(s))
    .nullable()
    .catch(null)
    .default(null),
  answeredInbound: z.boolean().catch(false).default(false),
});
export type AutomationRun = z.infer<typeof runSchema>;
export const runListSchema = z.object({
  data: z.array(runSchema),
  nextCursor: z.string().nullable().catch(null).default(null),
});

export const runStepSchema = z.looseObject({
  nodeId: z.string(),
  nodeType: z.string(),
  status: z.enum(['ok', 'failed', 'skipped', 'waiting']).catch('ok'),
  /** "yes" | "btn:call_me" | "timeout" … */
  branch: text,
  output: z.record(z.string(), z.unknown()).nullable().catch(null).default(null),
  at: text,
});
export type RunStep = z.infer<typeof runStepSchema>;
export const runOneSchema = z.object({
  data: runSchema.extend({ steps: z.array(runStepSchema).catch([]).default([]) }),
});

/** `{ data: { [nodeId]: … }, days }` - so read with `raw`. */
export const nodeStatsSchema = z.object({
  data: z.record(
    z.string(),
    z.looseObject({
      reached: z.number().catch(0),
      failed: z.number().catch(0),
      branches: z.record(z.string(), z.number()).catch({}),
    }),
  ),
  days: z.number().catch(7),
});
export type NodeStats = z.infer<typeof nodeStatsSchema>['data'];

export const catalogItemSchema = z.looseObject({
  /** A node type, or `trigger:<type>` in the trigger group. */
  type: z.string(),
  label: z.string().catch(''),
  description: z.string().catch(''),
  channels: z.array(z.string()).catch([]),
  outputs: z.union([z.array(z.string()), z.literal('dynamic')]).catch([]),
  limits: z.record(z.string(), z.number()).optional(),
  synonyms: z.array(z.string()).catch([]),
  available: z.boolean().catch(false),
  reason: z.enum(CATALOG_REASONS).nullable().catch(null).default(null),
  /** AU4: in a cart reminder, the channels this send step can name (filtered by reach). */
  viaOptions: z
    .array(z.enum(['whatsapp', 'email']))
    .optional()
    .catch(undefined),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;

export const catalogSchema = z.object({
  data: z.looseObject({
    context: z.looseObject({
      channel: z.string().nullable().catch(null).default(null),
      firstStep: z.boolean().catch(false),
      hasCustomer: z.boolean().catch(true),
      afterNodeType: text,
      /** AU4: which channels can reach a customer at all (connected). Absent: unknown. */
      reach: z
        .object({ whatsapp: z.boolean().catch(false), email: z.boolean().catch(false) })
        .optional()
        .catch(undefined),
    }),
    groups: z.array(
      z.looseObject({
        key: z.enum(['trigger', 'logic', 'send', 'do']),
        items: z.array(catalogItemSchema),
      }),
    ),
    variables: z.array(z.string()).catch([]),
  }),
});
export type Catalog = z.infer<typeof catalogSchema>['data'];

/**
 * The route's English names, by type (`automation-catalog.ts`). A path
 * step whose label is one of these was named by the catalogue - the screen
 * says it in its own language; any other label is the author's, as written.
 */
export const CATALOG_NAMES: Readonly<Record<string, string>> = {
  'trigger:message_received': 'Message received',
  'trigger:message_from_ad': 'Message from an ad',
  'trigger:button_tapped': 'Button tapped',
  'trigger:comment_received': 'Comment on a post',
  'trigger:call_missed': 'Call missed',
  'trigger:call_answered': 'Call answered',
  'trigger:new_customer': 'New customer',
  'trigger:order_event': 'Order event',
  'trigger:cart_abandoned': 'Cart left behind',
  'trigger:form_submitted': 'Form submitted',
  'trigger:story_mention': 'Story mention',
  'trigger:tag_added': 'Tag added',
  'trigger:schedule': 'On a schedule',
  'trigger:webhook': 'Webhook received',
  condition_group: 'Condition',
  opening_hours: 'Opening hours',
  wait: 'Wait',
  wait_for_reply: 'Wait for reply',
  split_channel: 'Split by channel',
  language: 'Language',
  segment: 'Customer segment',
  ab_split: 'A/B split',
  ai_generate: 'AI writes a message',
  send_comment_reply: 'Reply to the comment',
  send_message_text: 'Message',
  send_message_file: 'File',
  send_buttons: 'Buttons',
  send_list: 'List',
  send_message_template: 'Template',
  send_location: 'Location',
  send_rating: 'Rating request',
  send_sms: 'SMS',
  assign: 'Assign to team or person',
  hand_to_ai: 'Hand to AI employee',
  run_skill: 'Run a skill',
  add_tag: 'Add tag',
  update_customer: 'Update customer field',
  create_task: 'Create task',
  notify_team: 'Notify team',
  close_conversation: 'Close conversation',
  add_sheet_row: 'Add row to Sheets',
  http_request: 'HTTP request',
};

/** A path step's catalogue key: the trigger step is named by the automation's trigger. */
export function stepKey(step: Pick<PathStep, 'type'>, trigger: TriggerType | null): string {
  return step.type === 'automation_trigger' ? `trigger:${trigger ?? 'unknown'}` : step.type;
}

/** `null`: the label is the author's own - show it as written. */
export function catalogNamed(step: PathStep, trigger: TriggerType | null): string | null {
  const key = stepKey(step, trigger);
  const english = CATALOG_NAMES[key];
  return english !== undefined && (step.label === english || step.label === '') ? key : null;
}

/** The channel a trigger's config pins (one channel), for the row's mark. */
export function triggerChannels(trigger: Trigger): readonly string[] {
  const channels = trigger.config.channels;
  return Array.isArray(channels) ? channels.filter((c): c is string => typeof c === 'string') : [];
}

/** `/api/webhook-triggers?workflowId=` - a webhook trigger's address and secret (`null`: none yet). */
export const webhookTriggerSchema = z.object({
  data: z
    .looseObject({
      id: z.string(),
      secret: z.string(),
      enabled: z.boolean().catch(true),
      /** `/webhooks/<token>` - on this host's origin (the gateway routes it). */
      path: z.string(),
    })
    .nullable(),
});
export type WebhookTrigger = NonNullable<z.infer<typeof webhookTriggerSchema>['data']>;
