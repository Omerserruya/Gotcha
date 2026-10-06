import { z } from 'zod';

/**
 * `GET /api/agents/presence` - the team panel's status dots.
 *
 * The backend derives presence at read time rather than reaping stale rows: a
 * row nobody has refreshed reads OFFLINE whatever it says, and an away window
 * that has elapsed reads ONLINE again. So the client never has to reason about
 * staleness - what arrives is already true.
 */
export const PRESENCE_STATES = ['ONLINE', 'BUSY', 'AWAY', 'OFFLINE'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const agentPresenceSchema = z.looseObject({
  agentId: z.string().min(1),
  status: z.enum(PRESENCE_STATES).catch('OFFLINE'),
  lastSeenAt: z.string().nullable().optional(),
  /** When an away window ends. Drives "away until 11:00". */
  awayUntil: z.string().nullable().optional(),
  /** Nullable: an agent may belong to several departments. */
  departmentName: z.string().nullable().optional(),
});

export const presenceRosterSchema = z.array(agentPresenceSchema);

export type AgentPresence = z.infer<typeof agentPresenceSchema>;

/**
 * `POST /api/realtime/ticket`.
 *
 * A short-lived, single-use credential for the socket handshake. It exists
 * because the access token lives in an HttpOnly cookie - which is what stops
 * XSS stealing it, and equally what stops JavaScript putting it in a handshake.
 *
 * Redemption is atomic server-side: two sockets racing the same ticket cannot
 * both succeed, which is the whole point of it being single-use.
 */
export const realtimeTicketSchema = z.looseObject({
  ticket: z.string().min(1),
  expiresInSeconds: z.number().default(60),
});

export type RealtimeTicket = z.infer<typeof realtimeTicketSchema>;
