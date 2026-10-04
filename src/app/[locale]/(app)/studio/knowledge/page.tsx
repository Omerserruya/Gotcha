import { getFormatter, getTranslations } from 'next-intl/server';

import type { KnowledgeSource } from '@/api/contracts/knowledge';
import { isAddWay, type KnowledgeBaseRef } from '@/features/knowledge/add/add-way';
import { AddKnowledge } from '@/features/knowledge/add/AddKnowledge';
import { KnowledgeScreen, knowledgeSummary } from '@/features/knowledge/KnowledgeScreen';
import { loadKnowledge } from '@/features/knowledge/load-knowledge';
import styles from '@/features/knowledge/Knowledge.module.css';
import { Link } from '@/i18n/navigation';
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
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    /** 08b: the Add knowledge dialog, and the way in it opens on. */
    readonly add?: string;
    readonly way?: string;
  }>;
} = {}) {
  const params = (await searchParams) ?? {};
  const t = await getTranslations('knowledge');
  const { sources, unanswered, conflicts, conflictsScannedAt, everImported } =
    await loadKnowledge();

  /*
    02's line is a SUMMARY from data — "Learned four ways: … Two things need
    your answer." — as 07's is. Built from what was read; when a read failed
    it would have to guess, so the description stays.
  */
  const format = await getFormatter();
  const summary = knowledgeSummary(sources, conflicts, unanswered);
  const line = summary
    ? [
        summary.ways.length > 0
          ? t('summary.learned', {
              count: summary.ways.length,
              ways: format.list(
                summary.ways.map((way) => t(`wayPhrase.${way}` as 'wayPhrase.website')),
                { type: 'conjunction' },
              ),
            })
          : t('summary.learnedNone'),
        t('summary.needs', { count: summary.needAnswer }),
      ].join(' ')
    : t('description');

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
      description={line}
      actions={
        // 08b: the Add knowledge dialog over this screen.
        <Link
          href={{ pathname: '/studio/knowledge', query: { add: '1' } }}
          className={styles.add}
          data-testid="add-knowledge"
          scroll={false}
        >
          {t('add')}
        </Link>
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
      {params.add === '1' ? (
        <AddKnowledge
          initialWay={isAddWay(params.way) ? params.way : undefined}
          base={baseOf(sources)}
        />
      ) : null}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.studio');

/** The newest active base (the route lists newest first); none; or unread. */
function baseOf(sources: readonly KnowledgeSource[] | null): KnowledgeBaseRef {
  if (sources === null) return 'unknown';
  const active = sources.find((source) => source.isActive);
  return active ? { id: active.id } : 'none';
}
