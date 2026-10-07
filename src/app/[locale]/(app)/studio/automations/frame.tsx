import {
  AtSign,
  Bell,
  FileText,
  Megaphone,
  MessagesSquare,
  Moon,
  PhoneMissed,
  ShoppingCart,
  Star,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import styles from '@/features/automations/Automations.module.css';
import { TEMPLATES, type TemplateKey } from '@/features/automations/templates';
import { Link } from '@/i18n/navigation';
import { CanSee } from '@/permissions/CanSee';
import { PERMISSIONS } from '@/permissions/catalogue';
import { PageContainer } from '@/shell/PageContainer';

const TEMPLATE_ICON: Readonly<Record<TemplateKey, LucideIcon>> = {
  fileOnKeyword: FileText,
  afterHours: Moon,
  welcome: UserPlus,
  tagNotify: Bell,
  missedCall: PhoneMissed,
  review: Star,
  cart: ShoppingCart,
  fromAd: Megaphone,
  comment: MessagesSquare,
  storyThanks: AtSign,
};

/**
 * 09c's static frame - the title, the buttons, the deleted note, the
 * templates - shared by the page and its `loading.tsx`.
 */
export function AutomationsFrame({
  deleted,
  children,
}: {
  readonly deleted: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations('automations');
  return (
    <PageContainer
      layout="screen"
      headerPadEnd={22}
      title={t('title')}
      description={t('description')}
      actions={
        // Static, and only for whoever may read automations - known before any read.
        <CanSee permission={PERMISSIONS.ai.workflows.read}>
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
        </CanSee>
      }
    >
      <div className={styles.page}>
        {deleted ? (
          <p className={styles.deletedNote} role="status" data-testid="automations-deleted">
            {t('delete.done')}
          </p>
        ) : null}
        {children}

        <CanSee permission={PERMISSIONS.ai.workflows.read}>
          <section className={styles.templates} id="templates" aria-labelledby="templates-title">
            <h2 className={styles.templatesTitle} id="templates-title">
              {t('templateTitle')} <span className={styles.quiet}>{t('templateNote')}</span>
            </h2>
            <div className={styles.templateCards}>
              {TEMPLATES.map((template) => {
                const Icon = TEMPLATE_ICON[template.key];
                return (
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
                );
              })}
            </div>
          </section>
        </CanSee>
      </div>
    </PageContainer>
  );
}
