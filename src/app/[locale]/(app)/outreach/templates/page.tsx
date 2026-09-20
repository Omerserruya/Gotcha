import { getTranslations } from 'next-intl/server';

import { loadTemplates } from '@/features/outreach/load-templates';
import styles from '@/features/outreach/Outreach.module.css';
import { TemplateList } from '@/features/outreach/TemplateList';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/**
 * Outreach · templates — screen 05c.
 *
 * ── WHAT IS ABSENT, AND WHY ──
 * **No ETA beside "being reviewed".** Nothing models how long a provider
 * takes. The state is real; the duration was drawn.
 *
 * **No rewrite suggestion.** `rejectionReason` is stored and nothing proposes
 * a fix, so *"GOTCHA rewrote it to lead with the customer's own request"*
 * describes work that does not happen.
 *
 * **No usage count and no reply rate.** The `broadcasts` relation would join
 * cleanly and `GET /api/templates` has no `include` — unserved, and requested.
 *
 * **No "who may send it".** Nothing records which employees or automations may
 * use a template.
 *
 * ── AND ONE SENTENCE THAT STAYS ──
 * *"Once someone writes to you, WhatsApp lets you reply freely for 24 hours."*
 * That is a fact about WhatsApp, not a claim about our data: **no row in our
 * database can make it false**, which is what separates it from a promise
 * needing a mechanism. It is phrased as something WhatsApp does, never as
 * something GOTCHA does on your behalf, and it is the one line that explains
 * why this screen exists at all.
 */
export default async function Page() {
  const t = await getTranslations('templates');
  const { templates } = await loadTemplates();

  /*
   * The window sentence sits ABOVE every state, including the empty one —
   * which is where it matters most, because a reader with no templates is the
   * one who most needs to know why they would want any.
   */
  const windowNote = (
    <p className={styles.windowNote} data-testid="window-note">
      {t('window')}
    </p>
  );

  return (
    <PageContainer title={t('title')} description={t('description')}>
      {windowNote}

      {templates === null ? (
        <p data-testid="templates-unavailable">{t('unavailable')}</p>
      ) : templates.length === 0 ? (
        <div className={styles.empty} data-testid="templates-empty">
          <p className={styles.emptyLead}>{t('none')}</p>
          {/*
            The consequence, not just the absence. An empty template list is
            not a tidy starting point — it is the reason you cannot start a
            conversation, only continue one.
          */}
          <p className={styles.emptyBody}>{t('noneBody')}</p>
        </div>
      ) : (
        <TemplateList templates={templates} />
      )}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('primary.outreach');
