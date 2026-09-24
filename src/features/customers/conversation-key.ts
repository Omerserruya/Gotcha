import type { TimelineEvent } from '@/api/contracts/customer-detail';
import { newestConversationId } from '@/api/contracts/customer-detail';

/**
 * Which conversation a customer-page READ enters through.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE PLATFORM'S CUSTOMER FEATURES ARE KEYED ON A CONVERSATION
 * ════════════════════════════════════════════════════════════════════════════
 * Found by reading 04b, 04d, 04e and 04f as one group rather than one at a
 * time — each would have solved this locally and it would have looked
 * reasonable four times.
 *
 *   CRM notes read   GET  /api/crm/conversation/:id/context
 *   CRM notes write  POST /api/crm/conversation/:id/notes
 *   order context    GET  /api/commerce-context/:conversationId
 *   order actions    POST /api/commerce-context/:conversationId/actions
 *
 * They were built for the **Inbox**, where a conversation is always in hand.
 * A customer PAGE has a person, so it must choose one — and four screens
 * choosing independently is drift that is cheaper to prevent than reconcile.
 *
 * (`POST /api/customer-summary` was on this list until Backend added a
 * `contactId` entry point. That is the shape to ask for, and the brief no
 * longer comes through here.)
 *
 * ── WHY THE NEWEST IS SAFE FOR READS ──
 * For every read above the conversation is a ROUTING KEY, not a scope. The
 * brief was cross-channel regardless of entry point; order context is the
 * customer's orders from Shopify whichever conversation you arrive through.
 * Nothing is narrowed by the choice, so nothing is lost by it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ AND IT IS NOT SAFE FOR WRITES. DO NOT USE IT FOR ONE.
 * ════════════════════════════════════════════════════════════════════════════
 * `createNote` sets `source_interaction_id: conversationId`. A note written
 * from the customer page would be permanently attached to whichever chat
 * happened to be most recent — **in the merchant's own CRM, where we cannot
 * correct it afterwards.** That is not a cosmetic inaccuracy; it is writing a
 * false fact into somebody else's system of record.
 *
 * The same applies to order actions: an action attributed to an unrelated
 * conversation is a wrong audit trail, and the audit trail is the thing those
 * actions exist to leave behind.
 *
 * So this returns a key for READING. A write from a customer page needs a
 * customer-keyed endpoint or correct attribution, and until then it is not
 * offered — which is why 04b's notes are read-only.
 */
export function readKeyFor(events: readonly TimelineEvent[]): string | null {
  return newestConversationId(events);
}
