import { FileText, PhoneMissed, ShoppingCart, Star } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { AutomationsList } from '@/features/automations/AutomationsList';
import { NewAutomation } from '@/features/automations/NewAutomation';
import styles from '@/features/automations/Automations.module.css';
import { loadAutomations, loadCatalog } from '@/features/automations/load-automations';
import { Link } from '@/i18n/navigation';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

/** 09c's four templates, as the design names them. Templates are Phase 3: drawn, off. */
const TEMPLATES = [
  ['missedCall', PhoneMissed],
  ['fileOnKeyword', FileText],
  ['review', Star],
  ['cart', ShoppingCart],
] as const;

/**
 * 09c - Studio · Automations (design 6), over `/api/automations`.
 *
 * The table is the route's: each automation's trigger and path, this week's
 * runs, the last run, who paused it. New automation opens the trigger
 * picker (09e, first step) over this list (`?new=1`). Templates come with
 * Phase 3: the button and the four cards are drawn, off, saying so.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly new?: string }>;
} = {}) {
  const t = await getTranslations('automations');
  const creating = (await searchParams)?.new === '1';
  // The first step's catalogue - triggers - only when the sheet is open.
  const [automations, catalog] = await Promise.all([
    loadAutomations(),
    creating ? loadCatalog() : Promise.resolve(null),
  ]);

  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      title={t('title')}
      description={t('description')}
      actions={
        <span className={styles.headerActions}>
          <button
            type="button"
            className={styles.secondary}
            disabled
            title={t('templatesWhy')}
            data-testid="automations-templates"
          >
            {t('templates')}
          </button>
          <Link
            href={{ pathname: '/studio/automations', query: { new: '1' } }}
            className={styles.primary}
            scroll={false}
            data-testid="automations-new"
          >
            {t('create')}
          </Link>
        </span>
      }
    >
      <div className={styles.page}>
        {automations === null ? (
          <p className={styles.quiet} role="status" data-testid="automations-unread">
            {t('unavailable')}
          </p>
        ) : automations.length === 0 ? (
          <div className={styles.empty} data-testid="automations-empty">
            <p className={styles.emptyLead}>{t('none')}</p>
            <p className={styles.quiet}>{t('noneBody')}</p>
          </div>
        ) : (
          <AutomationsList automations={automations} />
        )}

        <section className={styles.templates} aria-labelledby="templates-title">
          <h2 className={styles.templatesTitle} id="templates-title">
            {t('templateTitle')} <span className={styles.quiet}>{t('templateNote')}</span>
          </h2>
          <div className={styles.templateCards}>
            {TEMPLATES.map(([key, Icon]) => (
              <button
                key={key}
                type="button"
                className={styles.template}
                disabled
                title={t('templatesWhy')}
                data-testid={`automations-template-${key}`}
              >
                <Icon size={15} aria-hidden="true" />
                <span className={styles.templateName}>{t(`template.${key}.name`)}</span>
                <span className={styles.quiet}>{t(`template.${key}.line`)}</span>
              </button>
            ))}
          </div>
          <p className={styles.why}>{t('templatesWhy')}</p>
        </section>
      </div>
      {creating ? <NewAutomation catalog={catalog} /> : null}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.automations');
