import { useTranslations } from 'next-intl';

import { appPath } from '@/lib/base-path';

import styles from './Inbox.module.css';

/**
 * The pane with nothing open (Omer, 2026-10-06: "much like WhatsApp"): the
 * GOTCHA mark, faint, and a line to pick a conversation - with the quiet
 * note that Esc is how one is closed.
 */
export function NothingOpen() {
  const t = useTranslations('inbox.open');
  return (
    <div className={styles.nothingOpen} data-testid="inbox-nothing-open" data-state="pick">
      {/* eslint-disable-next-line @next/next/no-img-element -- a 512px mark, shown faint */}
      <img
        className={styles.nothingOpenMark}
        src={appPath('/brand/gotcha-mark-dark.png')}
        alt=""
        aria-hidden="true"
      />
      <p className={styles.nothingOpenTitle}>{t('pick')}</p>
      <p className={styles.nothingOpenHint}>{t('escHint')}</p>
    </div>
  );
}
