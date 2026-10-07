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

export const MESSAGE_STATES = ['done', 'streaming', 'cancelled', 'failed'] as const;

export const threadMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  status: z.enum(MESSAGE_STATES),
  steps: z.array(threadStepSchema).catch([]).default([]),
  suggestions: z.array(z.string()).catch([]).default([]),
  runId: z.string().nullable().catch(null).default(null),
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
  'run.start': z.object({ runId: z.string(), userMessageId: z.string(), messageId: z.string() }),
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
