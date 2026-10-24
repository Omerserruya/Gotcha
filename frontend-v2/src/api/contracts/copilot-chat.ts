import { z } from 'zod';

import { plainDashes } from '@/lib/plain-dashes';

/**
 * The Copilot side chat - a private thread between ONE agent and the Copilot
 * about one customer conversation (Backend c49f3830, ai-assist.ts
 * `/:conversationId/chat`). Kept on the server, per agent:
 *
 *   GET    → `{ data: { turns, maxTurns } }`
 *   POST   `{ message, locale? }` → `{ data: { reply, text, draft?, turn, turns } }`
 *   DELETE → `{ data: { turns: [] } }`  ("start over")
 *
 * ★ Read-only: the Copilot may look things up, but nothing it says reaches
 *   the customer. A `draft` (copilot turns only) is customer-facing text in
 *   the customer's language; it reaches the composer only through "use as
 *   reply", by a person's click. Never sent, never filled by itself.
 * ★ The server keeps the newest 20 exchanges for 7 days; the client sends
 *   no history (the route ignores it).
 */

/** One unreadable turn is dropped, never the thread. */
const listOf = <T extends z.ZodType>(item: T) =>
  z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((items) =>
      items.flatMap((each) => {
        const read = item.safeParse(each);
        return read.success ? [read.data as z.output<T>] : [];
      }),
    );

const words = z.string().transform((text) => plainDashes(text));

export const copilotTurnSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['agent', 'copilot']),
  text: words,
  /** Copilot turns only: a reply ready to send, in the customer's language. Empty reads as none. */
  draft: words
    .nullish()
    .catch(null)
    .transform((draft) => (draft?.trim() ? draft : null)),
  at: z.string().catch(''),
});
export type CopilotTurn = z.infer<typeof copilotTurnSchema>;

export const copilotThreadSchema = z.object({
  turns: listOf(copilotTurnSchema),
  maxTurns: z.number().int().positive().catch(20).default(20),
});

/** POST's answer: the whole thread after this exchange (the newest at the end). */
export const copilotChatAnswerSchema = z.object({
  turns: listOf(copilotTurnSchema),
});

/** The longest message the route takes (`MAX_MESSAGE_CHARS`). */
export const COPILOT_MESSAGE_MAX = 4000;
