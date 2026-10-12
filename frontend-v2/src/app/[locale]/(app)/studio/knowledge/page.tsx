import { getTranslations } from 'next-intl/server';

import type { KnowledgeSource } from '@/api/contracts/knowledge';
import {
  ADD_KNOWLEDGE_OPENER,
  isAddWay,
  KNOWLEDGE_CONNECT_FAILURES,
  type KnowledgeBaseRef,
  type KnowledgeLanding,
} from '@/features/knowledge/add/add-way';
import { AddKnowledge } from '@/features/knowledge/add/AddKnowledge';
import { DocumentDrawer } from '@/features/knowledge/DocumentDrawer';
import { FocusSection } from '@/features/knowledge/FocusSection';
import { KnowledgeScreen } from '@/features/knowledge/KnowledgeScreen';
import { loadKnowledge } from '@/features/knowledge/load-knowledge';
import { loadKnowledgeDocument } from '@/features/knowledge/load-document';
import styles from '@/features/knowledge/Knowledge.module.css';
import { ScanPanel } from '@/features/knowledge/ScanPanel';
import { loadWorkspaceFacts } from '@/features/workspace/load-workspace';
import { Link } from '@/i18n/navigation';
import { Drawer } from '@/shell/Drawer';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Studio · Knowledge - screen 08.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No "Fresh" or "Out of date" labels, and no count of either.** `updatedAt`
 * is real, but there is **no staleness policy anywhere in the platform** - no
 * threshold, no field, no job. The screen states when each source was last
 * refreshed and leaves the verdict to the reader, who knows whether two
 * months is fine for their business.
 *
 * **No topic strength.** *"Answers confidently · 34 topics"* and *"Thin -
 * guesses sometimes · 6"* have no source at all.
 *
 * **No conflict panel yet.** The mechanism is real - `IntelligenceReview`,
 * with both values and a resolve action - and this tenant has zero rows, so
 * there is nothing to show and nothing is invented.
 *
 * ── AND WHAT IS REAL ──
 * The questions GOTCHA could not answer, with `timesAsked` and
 * `distinctAskers` kept apart - which is better than the design's single
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
    /** The way back from Google or Atlassian (backend df9ee4cd). */
    readonly connected?: string;
    readonly error?: string;
    /** `gaps`: open on the questions GOTCHA could not answer (the assistant links here). */
    readonly section?: string;
    /** K6: one knowledge item's drawer - a document id from "Where it learns from". */
    readonly doc?: string;
  }>;
} = {}) {
  const params = (await searchParams) ?? {};
  const t = await getTranslations('knowledge');
  const [{ sources, unanswered, conflicts, everImported }, workspace] = await Promise.all([
    loadKnowledge(),
    loadWorkspaceFacts(),
  ]);
  /*
    "Scan again" (11b), moved here from Settings · Workspace (Omer,
    2026-10-11). Drawn only when the workspace read answers - the gate it had
    there - and it names the website that read gives.
  */
  const rescan = workspace ? <ScanPanel domain={workspace.websiteDomain ?? null} /> : null;
  /*
    K6: the item's drawer. Its base comes from the list just read - the route
    is scoped by base AND tenant - so an id in no listed source is "not
    found" without a request. Never over the Add sheet.
  */
  const docId = params.add === '1' ? undefined : params.doc?.trim() || undefined;
  const docRead = docId ? await loadKnowledgeDocument(sources, docId) : null;

  /*
    08, measured: 02's header with "Add knowledge" on the right, and no
    split - the body is 02's screen body (`24px 40px 30px`, gap 16), filling
    the frame and scrolling inside it.
  */
  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      fill
      title={t('title')}
      // K2 (Omer, 2026-10-11): one fixed line under the title.
      description={t('subtitle')}
      actions={
        // 08b: the Add knowledge dialog over this screen.
        <Link
          href={{ pathname: '/studio/knowledge', query: { add: '1' } }}
          id={ADD_KNOWLEDGE_OPENER}
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
      {/* `?section=gaps`: the unanswered questions, brought into view and focused. */}
      {params.section === 'gaps' ? <FocusSection testid="gaps-section" /> : null}
      {sources === null && unanswered === null ? (
        <p data-testid="knowledge-unavailable">{t('unavailable')}</p>
      ) : (
        <KnowledgeScreen
          sources={sources}
          unanswered={unanswered}
          conflicts={conflicts}
          everImported={everImported}
          rescan={rescan}
        />
      )}
      {docRead ? (
        <Drawer
          title={
            docRead.state === 'ok' && docRead.document.title
              ? docRead.document.title
              : t('doc.title')
          }
          userTitle={docRead.state === 'ok' && docRead.document.title !== ''}
          closeHref="/studio/knowledge"
          width={600}
          testId="knowledge-doc-drawer"
        >
          <DocumentDrawer read={docRead} />
        </Drawer>
      ) : null}
      {params.add === '1' ? (
        <AddKnowledge
          initialWay={
            params.way === 'confluence' ? 'drive' : isAddWay(params.way) ? params.way : undefined
          }
          base={baseOf(sources)}
          landing={landingOf(params)}
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

/**
 * The way back from a Drive or Confluence connect: which, and how it ended.
 * Confluence has no card of its own - it lives on the Drive card.
 */
function landingOf(params: {
  readonly way?: string;
  readonly connected?: string;
  readonly error?: string;
}): KnowledgeLanding | null {
  const connector =
    params.way === 'drive' ? 'google_drive' : params.way === 'confluence' ? 'confluence' : null;
  if (!connector) return null;
  if (params.connected === '1') return { connector, outcome: 'connected' };
  if (!params.error) return null;
  return {
    connector,
    outcome: (KNOWLEDGE_CONNECT_FAILURES as readonly string[]).includes(params.error)
      ? (params.error as KnowledgeLanding['outcome'])
      : 'other',
  };
}
