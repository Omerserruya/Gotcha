import { getFormatter, getTranslations } from 'next-intl/server';

import { documentState, type KnowledgeDocumentDetail } from '@/api/contracts/knowledge';
import drawer from '@/design-system/styles/drawer.module.css';

import type { DocumentRead } from './load-document';
import styles from './DocumentDrawer.module.css';

/**
 * K6 (Omer, 2026-10-11; no design frame - the approved shape): one knowledge
 * item in 02's drawer. Where it came from, when it changed, its state, its
 * text, and what the AI actually searches in it - the stored sections.
 *
 * ── WHAT IS NOT DRAWN ──
 * Facts. The route sends `ai.facts: null`: no per-document facts are
 * extracted. Nothing is said about them - "0 facts" would claim a count of
 * something nobody looked for.
 *
 * Every text from the document is the user's: set apart (`dir="auto"`), so
 * Hebrew in an English drawer, or the reverse, keeps its own order.
 */
export async function DocumentDrawer({ read }: { readonly read: DocumentRead }) {
  const t = await getTranslations('knowledge.doc');
  if (read.state !== 'ok') {
    return (
      <div className={drawer.drawerBody}>
        <p className={styles.problem} role="status" data-testid="doc-problem">
          {t(`problem.${read.state}`)}
        </p>
      </div>
    );
  }
  return documentBody(read.document, t, await getFormatter());
}

/* Called, not rendered: one async component, so a test can render it whole. */
function documentBody(
  document: KnowledgeDocumentDetail,
  t: Awaited<ReturnType<typeof getTranslations<'knowledge.doc'>>>,
  format: Awaited<ReturnType<typeof getFormatter>>,
) {
  const state = documentState(document);
  const updated = document.updatedAt ?? document.createdAt;
  const link = httpAddress(document.sourceUrl);
  const content = document.content ?? '';
  const { ai } = document;

  return (
    <div className={drawer.drawerBody} data-testid="doc-body">
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>{t('source')}</dt>
          <dd data-testid="doc-source">
            {t(`type.${typeKey(document.type)}`)}
            {link ? (
              <>
                {' · '}
                <a
                  className={styles.link}
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  dir="ltr"
                  data-testid="doc-source-link"
                >
                  {link}
                </a>
              </>
            ) : null}
          </dd>
        </div>
        {updated ? (
          <div className={styles.fact}>
            <dt>{t('updated')}</dt>
            <dd data-testid="doc-updated">
              {format.dateTime(new Date(updated), {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </dd>
          </div>
        ) : null}
        <div className={styles.fact}>
          <dt>{t('status')}</dt>
          <dd data-testid="doc-status" data-state={state}>
            {t(`state.${state}`)}
          </dd>
        </div>
      </dl>

      <section className={styles.part} aria-labelledby="doc-content-heading">
        <h3 className={drawer.sectionTitle} id="doc-content-heading">
          {t('content')}
        </h3>
        {content ? (
          <div className={styles.content} dir="auto" data-testid="doc-content">
            {content}
          </div>
        ) : (
          <p className={styles.quiet} data-testid="doc-no-content">
            {t('noContent')}
          </p>
        )}
        {document.truncated ? (
          <p className={styles.quiet} data-testid="doc-truncated">
            {t('truncated', {
              shown: format.number(content.length),
              total: format.number(document.contentLength),
            })}
          </p>
        ) : null}
      </section>

      <section className={styles.part} aria-labelledby="doc-ai-heading" data-testid="doc-ai">
        <h3 className={drawer.sectionTitle} id="doc-ai-heading">
          {t('ai.heading')}
        </h3>
        {ai.sectionCount === 0 ? (
          <p className={styles.quiet} data-testid="doc-ai-none">
            {state === 'reading' ? t('ai.noneYet') : t('ai.none')}
          </p>
        ) : (
          <>
            <p className={styles.quiet} data-testid="doc-ai-count">
              {t('ai.count', { count: ai.sectionCount })}
            </p>
            <ol className={styles.sections}>
              {ai.sections.map((section) => (
                <li
                  key={section.index}
                  className={styles.section}
                  data-testid={`doc-section-${section.index}`}
                >
                  <span className={styles.sectionHead}>
                    {t('ai.section', { n: section.index + 1 })}
                  </span>
                  <span className={styles.preview} dir="auto">
                    {section.preview}
                  </span>
                </li>
              ))}
            </ol>
            {ai.sectionsTruncated ? (
              <p className={styles.quiet} data-testid="doc-ai-more">
                {t('ai.more', { shown: ai.sections.length, count: ai.sectionCount })}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

/** The writers' `sourceType` vocabulary, as the drawer names it. */
function typeKey(
  type: string,
):
  | 'website'
  | 'uploaded'
  | 'typed'
  | 'drive'
  | 'confluence'
  | 'conversations'
  | 'answers'
  | 'other' {
  switch (type) {
    case 'url':
    case 'onboarding_scan':
      return 'website';
    case 'file':
      return 'uploaded';
    case 'text':
      return 'typed';
    case 'google_drive':
    case 'drive':
      return 'drive';
    case 'confluence':
      return 'confluence';
    case 'historical_conversations':
      return 'conversations';
    case 'readiness_answer':
      return 'answers';
    default:
      return 'other';
  }
}

/** An http(s) address to link to, parsed - never a prefix check - or null. */
export function httpAddress(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
