import { getFormatter, getTranslations } from 'next-intl/server';

import { templateStance, type Template } from '@/api/contracts/templates';
import type { Exclusion, NumberEvent } from '@/api/contracts/whatsapp-numbers';
import { Link } from '@/i18n/navigation';

import { PrivateContacts, type ContactNumber } from './PrivateContacts';
import styles from './Channels.module.css';

const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
const STEPS = [
  'EXCHANGE_TOKEN',
  'SUBSCRIBE_WEBHOOKS',
  'REGISTER_NUMBER',
  'HEALTH_CHECK',
  'REPAIR_WEBHOOKS',
] as const;
const OUTCOMES = ['SUCCESS', 'FAILED', 'SKIPPED', 'ACTION_REQUIRED'] as const;

/**
 * 13b · Templates: the account's WhatsApp templates (`/api/templates`), each
 * with its state in 05c's own words and its category; one opens on 05c.
 * Templates for another channel only are not this panel's.
 */
export async function TemplatesTab({
  templates,
}: {
  readonly templates: readonly Template[] | null;
}) {
  const t = await getTranslations('channels.whatsapp.tabs');
  const tt = await getTranslations('templates');
  if (templates === null) {
    return (
      <p className={styles.tabNote} data-testid="tab-unread">
        {t('unread')}
      </p>
    );
  }
  const mine = templates.filter((tpl) => tpl.channel === null || tpl.channel === 'WHATSAPP');
  if (mine.length === 0) {
    return (
      <p className={styles.tabNote} data-testid="tab-empty">
        {t('templates.none')}{' '}
        <Link href="/outreach/templates" className={styles.numberLink}>
          {t('templates.create')}
        </Link>
      </p>
    );
  }
  return (
    <ul className={styles.tabList} data-testid="tab-templates">
      {mine.map((tpl) => {
        const stance = templateStance(tpl);
        const category = (CATEGORIES as readonly string[]).includes(tpl.category.toUpperCase())
          ? tt(`create.cat.${tpl.category.toUpperCase()}` as 'create.cat.MARKETING')
          : null;
        return (
          <li key={tpl.id}>
            <Link
              href={{ pathname: '/outreach/templates', query: { template: tpl.id } }}
              className={styles.tabRow}
              data-testid={`tab-template-${tpl.id}`}
            >
              <bdi dir="auto" className={styles.tabRowName}>
                {tpl.name}
              </bdi>
              <span className={styles.tabRowMeta}>
                {category ? `${category} · ` : ''}
                {stance === 'exempt'
                  ? tt('stance.exempt', { channel: tpl.channel ?? '' })
                  : tt(`stance.${stance}` as 'stance.ready')}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** 13b · Private contacts: the list, with add and remove (PrivateContacts); unread is said. */
export async function ContactsTab({
  exclusions,
  numbers,
}: {
  readonly exclusions: readonly Exclusion[] | null;
  /** The numbers a rule can be on (each by its channel account). */
  readonly numbers: readonly ContactNumber[];
}) {
  const t = await getTranslations('channels.whatsapp.tabs');
  if (exclusions === null) {
    return (
      <p className={styles.tabNote} data-testid="tab-unread">
        {t('unread')}
      </p>
    );
  }
  return <PrivateContacts exclusions={exclusions} numbers={numbers} />;
}

/** 13b · Activity: what happened to each number, newest first, in our words where we know the step. */
export async function ActivityTab({
  events,
}: {
  readonly events: readonly (NumberEvent & { readonly number: string | null })[] | null;
}) {
  const t = await getTranslations('channels.whatsapp.tabs');
  const format = await getFormatter();
  if (events === null) {
    return (
      <p className={styles.tabNote} data-testid="tab-unread">
        {t('unread')}
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <p className={styles.tabNote} data-testid="tab-empty">
        {t('activity.none')}
      </p>
    );
  }
  return (
    <ul className={styles.tabList} data-testid="tab-activity">
      {events.map((event) => (
        <li
          key={event.id}
          className={styles.tabRow}
          data-outcome={event.outcome}
          data-testid={`tab-event-${event.id}`}
        >
          <span className={styles.tabRowName}>
            {(STEPS as readonly string[]).includes(event.step)
              ? t(`activity.step.${event.step}` as 'activity.step.HEALTH_CHECK')
              : event.step}
            {' · '}
            {(OUTCOMES as readonly string[]).includes(event.outcome)
              ? t(`activity.outcome.${event.outcome}` as 'activity.outcome.SUCCESS')
              : event.outcome}
          </span>
          <span className={styles.tabRowMeta}>
            {event.number ? (
              <>
                <bdi dir="ltr">{event.number}</bdi>
                {' · '}
              </>
            ) : null}
            {format.dateTime(new Date(event.createdAt), {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            })}
          </span>
          {event.message ? (
            <bdi dir="auto" className={styles.tabRowDetail}>
              {event.message}
            </bdi>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
