import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

import styles from './Outreach.module.css';

/**
 * 05's "start from a task" — Message, Campaign, Email, Phone call — as 02
 * draws them over the list. Campaign and Email open the draft drawer; Phone
 * call goes to the dialer. Message — a one-off to someone not yet in a
 * conversation — has no flow, so it is drawn with why.
 */
export async function TaskCards({ hasEmail }: { readonly hasEmail: boolean }) {
  const t = await getTranslations('outreach.tasks');
  return (
    <div className={styles.tasks} data-testid="outreach-tasks">
      <span
        className={styles.task}
        aria-disabled="true"
        title={t('message.none')}
        data-testid="task-message"
      >
        <span className={styles.taskName}>{t('message.name')}</span>
        <span className={styles.taskText}>{t('message.text')}</span>
      </span>
      <Link
        href={{ pathname: '/outreach', query: { create: 'campaign' } }}
        className={styles.task}
        scroll={false}
        data-testid="task-campaign"
      >
        <span className={styles.taskName}>{t('campaign.name')}</span>
        <span className={styles.taskText}>{t('campaign.text')}</span>
      </Link>
      {hasEmail ? (
        <Link
          href={{ pathname: '/outreach', query: { create: 'campaign', channel: 'EMAIL' } }}
          className={styles.task}
          scroll={false}
          data-testid="task-email"
        >
          <span className={styles.taskName}>{t('email.name')}</span>
          <span className={styles.taskText}>{t('email.text')}</span>
        </Link>
      ) : (
        <span
          className={styles.task}
          aria-disabled="true"
          title={t('email.none')}
          data-testid="task-email"
        >
          <span className={styles.taskName}>{t('email.name')}</span>
          <span className={styles.taskText}>{t('email.text')}</span>
        </span>
      )}
      <Link href="/outreach/calls" className={styles.task} data-testid="task-call">
        <span className={styles.taskName}>{t('call.name')}</span>
        <span className={styles.taskText}>{t('call.text')}</span>
      </Link>
    </div>
  );
}
