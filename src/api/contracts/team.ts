import { z } from 'zod';

/**
 * `GET /api/analytics/agents` — enveloped in `data`.
 *
 * What the design's "Your team right now" asks for and this cannot give:
 * a presence dot, an online count, and "away until 11:00". Those come from
 * `GET /api/agents/presence` instead — see `presence.ts`, which does serve
 * `AWAY` and `awayUntil`. This route carries none of them.
 * There is no away state and no shift model anywhere.
 *
 * `avgResponseTimeMs` is real and Redis-backed, today only. It is the
 * "replies in 3m" figure. `/api/agent-scores` is an AI performance review on a
 * 1–5 scale and is not a duration — using it here would be a category error.
 */
export const teamMemberSchema = z.looseObject({
  agentId: z.string().min(1),
  name: z.string().optional(),
  email: z.email().optional(),
  activeConversations: z.number().default(0),
  claimedToday: z.number().default(0),
  avgResponseTimeMs: z.number().nullable().optional(),
});

export const teamSchema = z.array(teamMemberSchema);

export type TeamMember = z.infer<typeof teamMemberSchema>;
export type Team = z.infer<typeof teamSchema>;
