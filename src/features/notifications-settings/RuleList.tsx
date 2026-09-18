import { getLocale, getTranslations } from 'next-intl/server';

import type { EventGroup, RuleView } from './rule-view';
import styles from './Notifications.module.css';

/**
 * The tenant's notification rules, grouped by the event they answer to.
 *
 * A list and not a matrix. One event can carry several rules with different
 * recipients and different channels, and **all of them apply** — the unique
 * indexes that would have made a grid honest were dropped on purpose so that
 * per-recipient routing works. A grid would have to choose one rule per cell
 * and would misdescribe every event that has two.
 *
 * Four things are called out on a rule rather than left to be discovered,
 * because in every case the platform accepts the rule, lists it, shows it as
 * enabled, and then quietly does nothing:
 *
 *   - an event nothing raises, or an event that does not exist at all
 *   - a channel that passes validation and is dropped at delivery
 *   - a tenant-wide rule displaced by a department rule for the same event
 *   - a rule switched off
 *
 * The first two exist because `eventType` and `channels` are validated against
 * sets that are wider than what the product does. This screen is the only
 * place either can be caught.
 */
export async function RuleList({ groups }: { readonly groups: readonly EventGroup[] }) {
  const t = await getTranslations('notifications-settings');
  const locale = await getLocale();
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });

  return (
    <div className={styles.groups} data-testid="rule-groups">
      {groups.map((group) => (
        <section
          key={group.eventType}
          className={styles.group}
          data-testid={`group-${group.eventType}`}
          data-status={group.status}
        >
          <h3 className={styles.groupName}>
            {/*
              A known event gets its business-language name. The other two get
              the raw type, deliberately: there is no friendly name for a type
              the product does not raise, and the raw string is the thing an
              admin needs in order to find and fix the row.
            */}
            {group.status === 'known'
              ? t(`event.${group.eventType}` as 'event.tool.approval_required')
              : group.eventType}
          </h3>

          {group.status === 'unfiring' ? (
            <p className={styles.groupProblem} data-testid={`unfiring-${group.eventType}`}>
              {t('flag.unfiring')}
            </p>
          ) : null}
          {group.status === 'unknown' ? (
            <p className={styles.groupProblem} data-testid={`unknown-event-${group.eventType}`}>
              {t('flag.unknownEvent')}
            </p>
          ) : null}

          <ul className={styles.rules}>
            {group.rules.map((rule) => (
              <Rule key={rule.id} rule={rule} t={t} list={list} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Rule({
  rule,
  t,
  list,
}: {
  readonly rule: RuleView;
  readonly t: Awaited<ReturnType<typeof getTranslations<'notifications-settings'>>>;
  readonly list: Intl.ListFormat;
}) {
  const who =
    rule.recipientType === 'users'
      ? list.format(rule.recipientNames)
      : t(`recipient.${rule.recipientType}` as 'recipient.tenant_owner');

  const channelNames = rule.channels.map((channel) =>
    channel === 'email' || channel === 'in_app'
      ? t(`channel.${channel}` as 'channel.email')
      : channel,
  );

  return (
    <li
      className={styles.rule}
      data-testid={`rule-${rule.id}`}
      data-enabled={rule.enabled ? 'yes' : 'no'}
    >
      <p className={styles.ruleSentence}>
        {t('rule.tell', { who, channels: list.format(channelNames) })}
      </p>

      <p className={styles.ruleScope} data-testid={`scope-${rule.id}`}>
        {rule.departmentId === null
          ? t('scope.allTeams')
          : rule.departmentMissing
            ? t('scope.unknownTeam')
            : t('scope.team', { team: rule.departmentName ?? '' })}
      </p>

      {rule.conditions.length > 0 ? (
        <p className={styles.ruleCondition}>
          {t('condition.only', { conditions: list.format(rule.conditions) })}
        </p>
      ) : null}

      {/*
        Everything below is a reason this rule does less than it looks like it
        does. Each is stated as a consequence — what does not happen — rather
        than as a status word, because "shadowed" and "undeliverable" mean
        nothing to the person who has to decide what to do about it.
      */}
      {!rule.enabled ? (
        <p className={styles.ruleProblem} data-testid={`disabled-${rule.id}`}>
          {t('flag.disabled')}
        </p>
      ) : null}

      {rule.shadowed ? (
        <p className={styles.ruleProblem} data-testid={`shadowed-${rule.id}`}>
          {t('flag.shadowed')}
        </p>
      ) : null}

      {rule.deliversNothing ? (
        <p className={styles.ruleProblem} data-testid={`delivers-nothing-${rule.id}`}>
          {t('flag.deliversNothing')}
        </p>
      ) : rule.undeliverable.length > 0 ? (
        <p className={styles.ruleProblem} data-testid={`undeliverable-${rule.id}`}>
          {t('flag.undeliverable', {
            count: rule.undeliverable.length,
            channels: list.format(rule.undeliverable),
          })}
        </p>
      ) : null}

      {rule.unresolvedRecipients > 0 ? (
        <p className={styles.ruleProblem} data-testid={`unresolved-${rule.id}`}>
          {t('flag.unresolvedRecipients', { count: rule.unresolvedRecipients })}
        </p>
      ) : null}
    </li>
  );
}
