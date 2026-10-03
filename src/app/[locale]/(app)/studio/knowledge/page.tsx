import { getTranslations } from 'next-intl/server';

import { KnowledgeScreen } from '@/features/knowledge/KnowledgeScreen';
import { loadKnowledge } from '@/features/knowledge/load-knowledge';
import styles from '@/features/knowledge/Knowledge.module.css';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · Knowledge — screen 08.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No "Fresh" or "Out of date" labels, and no count of either.** `updatedAt`
 * is real, but there is **no staleness policy anywhere in the platform** — no
 * threshold, no field, no job. The screen states when each source was last
 * refreshed and leaves the verdict to the reader, who knows whether two
 * months is fine for their business.
 *
 * **No topic strength.** *"Answers confidently · 34 topics"* and *"Thin —
 * guesses sometimes · 6"* have no source at all.
 *
 * **No conflict panel yet.** The mechanism is real — `IntelligenceReview`,
 * with both values and a resolve action — and this tenant has zero rows, so
 * there is nothing to show and nothing is invented.
 *
 * ── AND WHAT IS REAL ──
 * The questions GOTCHA could not answer, with `timesAsked` and
 * `distinctAskers` kept apart — which is better than the design's single
 * *"asked 23 times"*, because one person asking twenty times and twenty
 * people asking once need different fixes.
 */
export default async function Page() {
  const t = await getTranslations('knowledge');
  const { sources, unanswered, conflicts, conflictsScannedAt, everImported } =
    await loadKnowledge();

  /*
    08, measured: 02's header with "Add knowledge" on the right, and no
    split — the body is 02's screen body (`24px 40px 30px`, gap 16), filling
    the frame and scrolling inside it.
  */
  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      fill
      title={t('title')}
      description={t('description')}
      actions={
        // 08b (Add knowledge) is not built yet: drawn, and it says so.
        <span
          className={styles.add}
          aria-disabled="true"
          title={t('addNotYet')}
          data-testid="add-knowledge"
        >
          {t('add')}
        </span>
      }
    >
      {/*
        Both halves failed: that is a read failure, not a knowledge base with
        nothing in it, and the two must never look the same.
      */}
      {sources === null && unanswered === null ? (
        <p data-testid="knowledge-unavailable">{t('unavailable')}</p>
      ) : (
        <KnowledgeScreen
          sources={sources}
          unanswered={unanswered}
          conflicts={conflicts}
          conflictsScannedAt={conflictsScannedAt}
          everImported={everImported}
        />
      )}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');
