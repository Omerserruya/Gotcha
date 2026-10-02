import styles from '@/features/inbox/Inbox.module.css';
import { ConversationSkeleton, QueueSkeleton } from '@/features/inbox/Skeletons';
import { PageContainer } from '@/shell/PageContainer';

/**
 * The inbox before its first read — Omer's "content placeholders".
 *
 * ★ The same frame the page draws (`screen`, the two panels, the bleed), with
 *   placeholders in the shape of each panel's content where the content will
 *   be. It shows the moment the inbox is navigated to, while the server reads
 *   the queue; the page replaces it panel for panel, and nothing moves,
 *   because every placeholder is built to its content's measured box.
 */
export default function Loading() {
  return (
    <PageContainer bleed>
      <div
        className={styles.screen}
        data-testid="inbox-loading"
        data-owns-panels=""
        aria-busy="true"
      >
        <section className={styles.queueColumn}>
          <QueueSkeleton />
        </section>
        <section className={styles.conversationColumn}>
          <ConversationSkeleton />
        </section>
      </div>
    </PageContainer>
  );
}
