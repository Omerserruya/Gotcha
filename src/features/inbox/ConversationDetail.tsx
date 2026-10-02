import { getTranslations } from 'next-intl/server';

import { CustomerOrders } from '@/features/customers/CustomerOrders';

import { orderCountOf } from './ConversationHeader';
import { CopilotPanel } from './CopilotPanel';
import { IdentityPanel } from './IdentityPanel';
import type { ConversationDetail } from './load-inbox';
import { MessageStream } from './MessageStream';
import { StreamPin } from './StreamPin';
import styles from './Inbox.module.css';

/**
 * The parts of an open conversation that wait for its second round.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ EACH ONE AWAITS THE SAME PROMISE, INSIDE ITS OWN `<Suspense>`
 * ════════════════════════════════════════════════════════════════════════════
 * The page starts `loadConversation` and does not wait for it. These read it,
 * each inside a boundary whose fallback is a skeleton of the same shape, so
 * the frame, the queue, the header and the composer are on screen while the
 * messages are still on their way.
 *
 * ⚠ ABOUT "AN ASYNC COMPONENT NESTED INSIDE ANOTHER RENDERS NOTHING". That
 *   note, on this page and four others, is about the TEST HARNESS: calling a
 *   page as a function leaves a nested async element unresolved in the tree it
 *   inspects. React Server Components render nested async components — this
 *   is Next's documented streaming pattern (`01-getting-started/06-fetching-
 *   data.md`, `<Suspense><BlogList /></Suspense>`). These are tested by
 *   calling them directly.
 */

/** The stream, the Copilot's strip under it, and the pin to its latest message. */
export async function ConversationStream({
  detail,
  conversationId,
  channel,
}: {
  readonly detail: Promise<ConversationDetail>;
  readonly conversationId: string;
  readonly channel: string | null;
}) {
  const { messages, copilot } = await detail;
  return (
    <>
      <MessageStream messages={messages} channel={channel} />
      {/* After the stream, because it scrolls the stream: it must exist. */}
      <StreamPin conversationId={conversationId} />
      <CopilotPanel read={copilot} />
    </>
  );
}

/** The Copilot wall's contents: who this is, and their orders. */
export async function ConversationContext({
  detail,
  conversation,
}: {
  readonly detail: Promise<ConversationDetail>;
  readonly conversation: {
    readonly id: string;
    readonly contactName: string | null;
    readonly channel: string | null;
    readonly customerExternalId: string | null;
  };
}) {
  const { timeline, orders } = await detail;
  return (
    <>
      <IdentityPanel
        timeline={timeline}
        conversation={{
          contactName: conversation.contactName,
          channel: conversation.channel,
          customerExternalId: conversation.customerExternalId,
        }}
      />
      <CustomerOrders orders={orders} conversationId={conversation.id} />
    </>
  );
}

/**
 * 02's "Returning · 6 orders" chip, which needs the order read.
 *
 * Its fallback is nothing: the header paints without it and the chip appears
 * beside the name when the count is known — a chip that might not exist is
 * not worth a placeholder.
 */
export async function OrdersChip({ detail }: { readonly detail: Promise<ConversationDetail> }) {
  const count = orderCountOf((await detail).orders);
  if (count === null) return null;
  const t = await getTranslations('inbox');
  return (
    <span className={styles.openChip} data-testid="conversation-orders">
      {count > 1 ? t('open.orders.returning', { count }) : t('open.orders.count', { count })}
    </span>
  );
}
