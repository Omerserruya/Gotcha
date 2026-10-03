import { getTranslations } from 'next-intl/server';

import type { RolePart } from '@/api/contracts/business-core';
import drawer from '@/design-system/styles/drawer.module.css';

import styles from './BusinessCore.module.css';

/**
 * 14e, measured: "Across both · what goes where" — who a customer is, asked
 * in order, and what is written where.
 *
 * Who: the system holding customer records is asked first; when nobody
 * matches, GOTCHA makes a new record — and one match is filled in, two or
 * more wait for a person. What goes where: write-back is decided by the
 * kind of action, the same way every time, so 02's per-event rows and their
 * Edit are drawn without an Edit; the boards are one per workspace. Every
 * line here is a sentence this screen already holds as true.
 */
export async function AcrossDrawer({
  crm,
  language = null,
}: {
  readonly crm: RolePart | null;
  /** The workspace language, by name — what GOTCHA writes its own words in. */
  readonly language?: string | null;
}) {
  const t = await getTranslations('business-core');
  const first = crm?.elected?.name ?? null;

  /*
    02: cards and rows, no paragraphs. Every sentence this screen holds as
    true rides on the title of the thing it explains. The order is numbered;
    no drag handle, because nothing reorders it from here.
  */
  return (
    <div className={drawer.drawerBody} data-testid="across-drawer">
      <h3 className={drawer.sectionTitle}>{t('both.identity')}</h3>
      <ol className={styles.acrossChain} data-testid="across-order">
        <li className={styles.acrossStep}>
          <span className={styles.acrossNumber}>1</span>
          <span className={styles.acrossName}>{first ?? '—'}</span>
          <span className={styles.acrossSub}>{t('drawer.askedFirst')}</span>
        </li>
        <li
          className={styles.acrossStep}
          title={`${t('writeback.identityOneMatch')} ${t('writeback.identityManyMatches')}`}
          data-testid="across-gotcha"
        >
          <span className={styles.acrossNumber}>2</span>
          <span className={styles.acrossName}>GOTCHA</span>
          <span className={styles.acrossSub}>{t('drawer.newRecord')}</span>
        </li>
      </ol>

      <h3 className={drawer.sectionTitle}>{t('drawer.whatWhere')}</h3>
      <div
        className={styles.acrossRow}
        title={`${t('writeback.perRule')} ${t('writeback.oneBoard')}`}
        data-testid="across-writeback"
      >
        <span className={styles.acrossEvent}>{t('both.writeback')}</span>
        <span className={styles.acrossName}>{first ?? '—'}</span>
        <span className={styles.acrossSub} title={t('writeback.language')}>
          {language ? t('drawer.summaryIn', { language }) : t('drawer.summary')}
        </span>
      </div>
    </div>
  );
}
