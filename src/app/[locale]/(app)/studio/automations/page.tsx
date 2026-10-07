import {
  Bell,
  FileText,
  Moon,
  PhoneMissed,
  ShoppingCart,
  Star,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { AutomationsList } from '@/features/automations/AutomationsList';
import { NewAutomation } from '@/features/automations/NewAutomation';
import styles from '@/features/automations/Automations.module.css';
import { loadAutomations, loadCatalog } from '@/features/automations/load-automations';
import { TEMPLATES, templateOf, type TemplateKey } from '@/features/automations/templates';
import { Link } from '@/i18n/navigation';
import { PageContainer } from '@/shell/PageContainer';
import { pageMetadata } from '@/shell/page-metadata';

const TEMPLATE_ICON: Readonly<Record<TemplateKey, LucideIcon>> = {
  fileOnKeyword: FileText,
  afterHours: Moon,
  welcome: UserPlus,
  tagNotify: Bell,
  missedCall: PhoneMissed,
  review: Star,
  cart: ShoppingCart,
};

/**
 * 09c - Studio · Automations (design 6), over `/api/automations`.
 *
 * The table is the route's: each automation's trigger and path, this week's
 * runs, the last run, who paused it. New automation opens the trigger
 * picker (09e, first step) over this list (`?new=1`).
 *
 * ★ Templates (Omer, 2026-10-07: anything that looks like an action does
 *   something real): one that runs today opens New automation prefilled
 *   (`?template=`) - a draft with its steps, never turned on; one whose
 *   trigger has no event source yet is a status, unmistakably - "Coming
 *   soon", quiet, no hover, `aria-disabled`, the reason as its line - and
 *   does nothing.
 */
export default async function Page({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly new?: string;
    readonly deleted?: string;
    /** A template chosen: New automation, prefilled. */
    readonly template?: string;
  }>;
} = {}) {
  const t = await getTranslations('automations');
  const params = (await searchParams) ?? {};
  const creating = params.new === '1';
  const chosen = templateOf(params.template);
  const fromTemplate = chosen?.build ? chosen : null;
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
        automations === 'forbidden' ? null : (
          <span className={styles.headerActions}>
            <a href="#templates" className={styles.secondary} data-testid="automations-templates">
              {t('templates')}
            </a>
            <Link
              href={{ pathname: '/studio/automations', query: { new: '1' } }}
              className={styles.primary}
              scroll={false}
              data-testid="automations-new"
            >
              {t('create')}
            </Link>
          </span>
        )
      }
    >
      <div className={styles.page}>
        {params.deleted === '1' ? (
          <p className={styles.deletedNote} role="status" data-testid="automations-deleted">
            {t('delete.done')}
          </p>
        ) : null}
        {automations === 'forbidden' ? (
          <div className={styles.empty} data-testid="automations-forbidden">
            <p className={styles.emptyLead}>{t('forbidden.title')}</p>
            <p className={styles.quiet}>{t('forbidden.lead')}</p>
          </div>
        ) : automations === null ? (
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

        {automations === 'forbidden' ? null : (
          <section className={styles.templates} id="templates" aria-labelledby="templates-title">
            <h2 className={styles.templatesTitle} id="templates-title">
              {t('templateTitle')} <span className={styles.quiet}>{t('templateNote')}</span>
            </h2>
            <div className={styles.templateCards}>
              {TEMPLATES.map((template) => {
                const Icon = TEMPLATE_ICON[template.key];
                return template.build ? (
                  <Link
                    key={template.key}
                    href={{ pathname: '/studio/automations', query: { template: template.key } }}
                    className={styles.template}
                    scroll={false}
                    data-testid={`automations-template-${template.key}`}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span className={styles.templateName}>
                      {t(`template.${template.key}.name`)}
                    </span>
                    <span className={styles.quiet}>{t(`template.${template.key}.line`)}</span>
                  </Link>
                ) : (
                  <div
                    key={template.key}
                    className={styles.template}
                    data-unavailable=""
                    aria-disabled="true"
                    data-testid={`automations-template-${template.key}`}
                  >
                    <span className={styles.templateTop}>
                      <Icon size={15} aria-hidden="true" />
                      <span className={styles.unavailableTag}>{t('comingSoon')}</span>
                    </span>
                    <span className={styles.templateName}>
                      {t(`template.${template.key}.name`)}
                    </span>
                    <span className={styles.quiet}>{t(`template.${template.key}.why`)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
      {automations === 'forbidden' ? null : fromTemplate ? (
        <NewAutomation catalog={null} template={fromTemplate} />
      ) : creating ? (
        <NewAutomation catalog={catalog} />
      ) : null}
    </PageContainer>
  );
}

export const generateMetadata = pageMetadata('studio.automations');
