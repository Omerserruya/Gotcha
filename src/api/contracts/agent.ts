import { z } from 'zod';

/**
 * `POST /api/agent/run` - the command surface behind Home's ask box.
 *
 * The endpoint answers `text/event-stream`, not JSON. The OpenAPI document
 * types it as the usual `EnvelopeUnknown`, which is wrong rather than merely
 * vague; these shapes come from the handler and from
 * `agent-runtime.service.ts`.
 *
 * Because it is a POST, `EventSource` cannot be used - it only issues GETs.
 * See `streamServerSentEvents` for the fetch-based reader.
 */

export const agentRunRequestSchema = z.object({
  message: z.string().min(1),
  /**
   * Conversation memory is keyed on `(tenantId, userId, sessionId)`. Reuse the
   * id to continue a thread; mint a new one to start a fresh one.
   */
  sessionId: z.string().min(1),
  /** Free-form UI context passed through to the agent. */
  client: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  /** `true` leaves no trace of the turn in memory. */
  ephemeral: z.boolean().optional(),
  aiAgentId: z.string().optional(),
});

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

/**
 * The event union.
 *
 * Every member is `looseObject`: the backend adds fields without versioning,
 * and an unknown key must never fail a parse mid-stream - losing the rest of
 * a run because of one new property would be the worst possible trade.
 */
export const agentEventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('ready'), sessionId: z.string().optional() }),
  z.looseObject({
    type: z.literal('context_attached'),
    resolved: z
      .looseObject({
        conversationId: z.string().nullable().optional(),
        contactId: z.string().nullable().optional(),
        route: z.string().nullable().optional(),
      })
      .optional(),
  }),
  /** A fragment of the answer. Concatenate in arrival order. */
  z.looseObject({ type: z.literal('token'), text: z.string().default('') }),
  z.looseObject({
    type: z.literal('tool_start'),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
    args: z.unknown().optional(),
  }),
  z.looseObject({
    type: z.literal('tool_end'),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
    ok: z.boolean().optional(),
    resultSummary: z.string().optional(),
  }),
  /** A high-risk plan the operator must accept before anything runs. */
  z.looseObject({
    type: z.literal('plan_proposed'),
    approvalRequestId: z.string().optional(),
    summary: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('awaiting_approval'),
    approvalRequestId: z.string().optional(),
    tool: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('denied'),
    tool: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('round_end'),
    round: z.number().optional(),
    hadToolCalls: z.boolean().optional(),
  }),
  z.looseObject({
    type: z.literal('done'),
    usage: z.looseObject({}).optional(),
    rounds: z.number().optional(),
  }),
  z.looseObject({ type: z.literal('error'), message: z.string().optional() }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];

/** Terminal events: the stream carries nothing useful after one of these. */
export const AGENT_TERMINAL_EVENTS: readonly AgentEventType[] = ['done', 'error'];
