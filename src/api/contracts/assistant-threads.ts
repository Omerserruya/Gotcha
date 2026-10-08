import { z } from 'zod';

/**
 * Home's conversations - `/api/assistant/threads` (assistant-threads-v1,
 * Backend aef95f69 + 6a4fd095).
 *
 * Read strictly where a wrong reading would mislead (a status, an event's
 * order key) and forgivingly where a field is decoration (a step's duration,
 * the suggestions): one malformed suggestion must not reject a whole thread.
 */

/** Fired when a thread is created, titled, renamed or deleted - Recent in the rail reads again. */
export const THREADS_CHANGED = 'gotcha:threads-changed';

/**
 * The event's detail when Recent changed one - so Home follows a rename, or
 * a delete of the thread it is showing (back to the live Home). Home's own
 * changes send none: it already knows.
 */
export interface ThreadsChange {
  readonly id: string;
  readonly title?: string;
  readonly deleted?: true;
}

export const SCOPE_RANGES = ['this_week', 'last_7', 'last_30'] as const;
export type ScopeRange = (typeof SCOPE_RANGES)[number];

const rangeSchema = z.union([
  z.enum(SCOPE_RANGES),
  z.object({ custom: z.object({ from: z.string(), to: z.string() }) }),
]);

export const scopeSchema = z.object({
  range: rangeSchema,
  channels: z.union([z.literal('all'), z.array(z.string())]),
});
export type ThreadScope = z.infer<typeof scopeSchema>;

/** The route's own default (§1). */
export const DEFAULT_SCOPE: ThreadScope = { range: 'last_7', channels: 'all' };

export const threadSchema = z.object({
  id: z.string(),
  /** `null` until the first answer titles it. */
  title: z.string().nullable(),
  scope: scopeSchema.catch(DEFAULT_SCOPE),
  /**
   * The scope as the dates the assistant uses today (Backend b7f5faaf): UTC
   * days, `YYYY-MM-DD`. Absent from an older service - then the chip says
   * the range in words only.
   */
  scopeDates: z.object({ from: z.string(), to: z.string() }).nullable().catch(null).default(null),
});
export type Thread = z.infer<typeof threadSchema>;

export const STEP_STATES = ['running', 'done', 'failed', 'waiting_approval'] as const;

export const threadStepSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(STEP_STATES),
  durationMs: z.number().nonnegative().nullable().catch(null).default(null),
  approvalRequestId: z.string().nullable().catch(null).default(null),
});
export type ThreadStep = z.infer<typeof threadStepSchema>;

/* ── Stage 2 (§9): answers that come back as work. Numbers from the server, never the model. ── */

const partialSchema = z
  .union([
    z.object({ reason: z.literal('capped'), cap: z.number() }),
    z.object({ reason: z.literal('store_limit') }),
  ])
  .nullable()
  .catch(null)
  .default(null);
const unitSchema = z.enum(['count', 'currency', 'percent']).catch('count').default('count');
const link = z.string().nullable().catch(null).default(null);

const blockBase = {
  id: z.string(),
  title: z.string(),
  sourceId: z.string().nullable().catch(null).default(null),
  deepLink: link,
  partial: partialSchema,
};

export const chartBlockSchema = z.object({
  ...blockBase,
  type: z.literal('chart'),
  kind: z.enum(['bar', 'line']).catch('bar'),
  x: z.object({ kind: z.enum(['day', 'category']), values: z.array(z.string()) }),
  series: z.array(z.object({ key: z.string(), label: z.string(), values: z.array(z.number()) })),
  unit: unitSchema,
  currency: z.string().nullable().catch(null).default(null),
  highlight: z.array(z.string()).catch([]).default([]),
});

export const breakdownBlockSchema = z.object({
  ...blockBase,
  type: z.literal('breakdown'),
  items: z.array(
    z.object({ key: z.string(), label: z.string(), value: z.number(), share: z.number() }),
  ),
  total: z.number().nullable().catch(null).default(null),
  unit: unitSchema,
  currency: z.string().nullable().catch(null).default(null),
  other: z.object({ label: z.string(), value: z.number() }).nullable().catch(null).default(null),
  /** Intent / sentiment: recorded for `covered` of `of` - never a distribution over all. */
  coverage: z.object({ covered: z.number(), of: z.number() }).nullable().catch(null).default(null),
});

export const recordItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().nullable().catch(null).default(null),
  meta: z.string().nullable().catch(null).default(null),
  /** A conversation row's last message (Backend §9.2) - the customer's words. */
  preview: z.string().nullable().catch(null).default(null),
  deepLink: link,
});
export type RecordItem = z.infer<typeof recordItemSchema>;

export const recordListBlockSchema = z.object({
  ...blockBase,
  type: z.literal('record_list'),
  kind: z.string(),
  items: z.array(recordItemSchema),
  total: z.number().nullable().catch(null).default(null),
  hasMore: z.boolean().catch(false).default(false),
});

export const recordBlockSchema = z.object({
  ...blockBase,
  type: z.literal('record'),
  kind: z.string(),
  fields: z.array(z.object({ key: z.string(), label: z.string(), value: z.string() })),
});

export const blockSchema = z.discriminatedUnion('type', [
  chartBlockSchema,
  breakdownBlockSchema,
  recordListBlockSchema,
  recordBlockSchema,
]);
export type AnswerBlock = z.infer<typeof blockSchema>;

export const sourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  count: z.number().nullable().catch(null).default(null),
  deepLink: link,
});
export type AnswerSource = z.infer<typeof sourceSchema>;

/**
 * Each block read on its own: one this screen does not know (a type added
 * later) or cannot read is left out - never the whole message rejected.
 */
const eachOf = <T>(schema: z.ZodType<T>) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = schema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),
    );

/** `GET …/sources/:sourceId/records?cursor=` - 25 a page, the caller's current visibility. */
export const sourceRecordsSchema = z.object({
  data: z.array(recordItemSchema),
  nextCursor: z.string().nullable().catch(null).default(null),
});

export const MESSAGE_STATES = ['done', 'streaming', 'cancelled', 'failed'] as const;

/**
 * The language a turn was written in (Backend d43ba57c): the question's, or
 * the request's when the question had none. Its own chrome follows it - the
 * page's stays the interface's. One this screen has no words for is read as
 * absent: the interface's language, as before.
 */
export const TURN_LANGS = ['he', 'en'] as const;
export type TurnLang = (typeof TURN_LANGS)[number];
const turnLang = z.enum(TURN_LANGS).optional().catch(undefined);

export const threadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  status: z.enum(MESSAGE_STATES),
  steps: z.array(threadStepSchema).catch([]).default([]),
  suggestions: z.array(z.string()).catch([]).default([]),
  runId: z.string().nullable().catch(null).default(null),
  blocks: eachOf(blockSchema),
  sources: eachOf(sourceSchema),
  /** On an assistant message; absent when its question had no clear language. */
  lang: turnLang,
});
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

/** `GET /threads` - `data` beside `nextCursor`, so read raw. */
export const threadListSchema = z.object({
  data: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
  nextCursor: z.string().nullable().catch(null).default(null),
});
export type ThreadListItem = z.infer<typeof threadListSchema>['data'][number];

/** `GET /threads/:id` - everything needed to rebuild the screen. */
export const threadDetailSchema = z.object({
  thread: threadSchema,
  messages: z.array(threadMessageSchema),
  activeRun: z
    .object({ runId: z.string(), messageId: z.string(), lastEventId: z.string().nullable() })
    .nullable(),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

/* ── The stream (§3): the event's NAME says what it is; `data` has no type field. ── */

const EVENT_SCHEMAS = {
  'run.start': z.object({
    runId: z.string(),
    userMessageId: z.string(),
    messageId: z.string(),
    lang: turnLang,
  }),
  'step.start': z.object({ stepId: z.string(), text: z.string() }),
  'step.done': z.object({
    stepId: z.string(),
    status: z.enum(['done', 'failed', 'waiting_approval']),
    durationMs: z.number().nonnegative().nullable().catch(null).default(null),
    approvalRequestId: z.string().nullable().catch(null).default(null),
  }),
  'text.delta': z.object({ text: z.string() }),
  suggestions: z.object({ items: z.array(z.string()) }),
  'thread.title': z.object({ title: z.string() }),
  error: z.object({ code: z.string(), message: z.string().optional() }),
  block: z.object({ block: blockSchema }),
  sources: z.object({ items: eachOf(sourceSchema) }),
  'message.done': z.object({
    messageId: z.string(),
    status: z.enum(['done', 'cancelled', 'failed']),
  }),
} as const;

type EventName = keyof typeof EVENT_SCHEMAS;
export type ThreadEvent = {
  [K in EventName]: { readonly name: K; readonly data: z.infer<(typeof EVENT_SCHEMAS)[K]> };
}[EventName];

/** One frame as an event, or `null` for one this screen does not know (the backend may add some). */
export function parseThreadEvent(name: string | undefined, raw: string): ThreadEvent | null {
  if (!name || !(name in EVENT_SCHEMAS)) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = EVENT_SCHEMAS[name as EventName].safeParse(json);
  return parsed.success ? ({ name, data: parsed.data } as ThreadEvent) : null;
}

/**
 * An event id is `<runId>:<seq>`, seq from 1 and gapless (§3). The sequence
 * is what makes a resume safe: anything at or below the last one seen is a
 * replay, and is not applied twice.
 */
export function eventSeq(id: string | undefined): number | null {
  if (!id) return null;
  const seq = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : null;
}
