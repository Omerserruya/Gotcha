import type { ConversationRow } from '@/api/contracts/inbox';

/** The tag under a row: who has it, in the design's tones. */
export type RowOwner =
  | { readonly kind: 'resolved'; readonly tone: 'ok' }
  | { readonly kind: 'waiting'; readonly tone: 'warn' }
  | { readonly kind: 'mine'; readonly tone: 'mute' }
  | { readonly kind: 'colleague'; readonly tone: 'mute'; readonly name: string }
  | { readonly kind: 'gotcha'; readonly tone: 'ai' }
  | { readonly kind: 'flow'; readonly tone: 'mute' };

/**
 * Who is carrying a conversation, as one tag (`GOTCHA Mobile App.dc.html`:
 * "אצלך", "Sales AI", "Flow", "ממתין בתור", "נפתר").
 *
 * ★ ONLY WHAT THE ROW SAYS. The design's first tag is the customer's intent
 *   ("בעיית משלוח"), and a row carries none - per-message intent does not
 *   persist yet (`contracts/inbox.ts`). So the phone draws the owner and no
 *   intent, rather than an intent it would have to guess.
 *
 * `null`: an open conversation nobody holds and nobody was asked to - the
 * row says nothing rather than "unassigned".
 */
export function rowOwner(
  row: Pick<ConversationRow, 'status' | 'handledBy' | 'assignedAgentId' | 'isHandedOver'>,
  meId: string | null,
  colleagues: readonly { readonly id: string; readonly name: string }[],
): RowOwner | null {
  if (row.status === 'CLOSED') return { kind: 'resolved', tone: 'ok' };
  if (row.assignedAgentId !== null) {
    if (row.assignedAgentId === meId) return { kind: 'mine', tone: 'mute' };
    const colleague = colleagues.find((c) => c.id === row.assignedAgentId);
    return colleague === undefined ? null : { kind: 'colleague', tone: 'mute', name: colleague.name };
  }
  if (row.isHandedOver) return { kind: 'waiting', tone: 'warn' };
  if (row.handledBy === 'ai_agent') return { kind: 'gotcha', tone: 'ai' };
  if (row.handledBy === 'flow') return { kind: 'flow', tone: 'mute' };
  return null;
}
