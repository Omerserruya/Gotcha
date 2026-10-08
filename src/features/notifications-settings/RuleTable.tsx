import { getTranslations } from 'next-intl/server';

import type { Department, Member } from '@/api/contracts/people';
import type { NotificationRule } from '@/api/contracts/notification-rules';

import { EVENT_FAMILIES, eventsInFamily } from './events';
import { groupRulesByEvent } from './rule-view';
import { RuleList } from './RuleList';
import styles from './Notifications.module.css';

/**
 * Settings · Notifications - screen 15.
 *
 * ── WHAT THIS SCREEN IS, AFTER THE RULING ──
 * The design drew a personal matrix: *"tell me when"*, eight events by three
 * channels, per user. It is the main page now, and the fan-out obeys it
 * (notifications 9164a058) - but it only FILTERS what a person is sent.
 *
 * Who is sent anything is `NotificationPreference`: a TENANT rule -
 * *"when X happens, notify these people, on these channels"* - scoped to a
 * department, with conditions and a priority. Omer chose to build the one that
 * works, so the screen's subject changed from a preference to a rule.
 *
 * The principle line survives that change intact, and it turns out the backend
 * already agrees with it: the emitter for `conversation.assigned` deliberately
 * stays silent on a self-claim because *"telling someone they picked up the
 * conversation they just clicked is the noise this screen exists to prevent."*
 *
 * ── DAY ONE IS THE WHOLE SCREEN ──
 * This tenant has **zero rules**. So the first thing an admin ever sees is an
 * empty table, and it is designed as the primary state rather than as the
 * degraded one - the mistake we nearly made with screen 12's roster.
 *
 * An empty rule table is not a failure and must not read as one. Since
 * 9164a058 it means GOTCHA's own route: in-app only, the assignee for an
 * assignment and the admins for the rest, and no email - a real and
 * consequential state, said plainly rather than a blank with a button in it.
 */
export async function RuleTable({
  rules,
  departments,
  members,
}: {
  /**
   * Existing rules. Empty is the day-one state, not an error; `null` is a
   * failed read, and the two must never render the same.
   */
  readonly rules: readonly NotificationRule[] | null;
  /** For naming the team a rule is scoped to. `null` is a failed read. */
  readonly departments: readonly Department[] | null;
  /** For naming the people a `users` rule addresses. `null` is a failed read. */
  readonly members: readonly Member[] | null;
}) {
  // `notifications-settings`, not `notifications` - the latter is screen 01d.
  const t = await getTranslations('notifications-settings');

  if (rules === null) {
    return (
      <p className={styles.unavailable} data-testid="rules-unavailable">
        {t('rules.unavailable')}
      </p>
    );
  }

  if (rules.length === 0) {
    return (
      <div className={styles.dayOne} data-testid="rules-empty">
        {/*
          What is true right now, stated first. "No rules yet" describes the
          table; who GOTCHA tells instead, and that email waits for a rule,
          is the consequence - and the consequence is what an admin needs.
        */}
        <p className={styles.dayOneLead}>{t('rules.noneLead')}</p>
        <p className={styles.dayOneBody}>{t('rules.noneBody')}</p>

        {/*
          The vocabulary, shown before the first rule exists rather than hidden
          behind a form. Someone deciding whether to write a rule needs to know
          what GOTCHA can actually tell them about - and 22 events grouped by
          family answers that in a way an empty table cannot.
        */}
        <div className={styles.families} data-testid="event-families">
          {EVENT_FAMILIES.map((family) => (
            <section key={family} className={styles.family} data-testid={`family-${family}`}>
              <h3 className={styles.familyName}>{t(`family.${family}` as 'family.work')}</h3>
              <ul className={styles.familyEvents}>
                {eventsInFamily(family).map((event) => (
                  <li key={event.type} className={styles.event} data-testid={`event-${event.type}`}>
                    <span className={styles.eventName}>
                      {t(`event.${event.type}` as 'event.tool.approval_required')}
                    </span>
                    {/*
                      Three events carry their emitter's own caveat, because
                      the design's wording for at least one of them promises
                      something the product does not do. Rendered with the
                      event rather than in a footnote: a reader choosing
                      whether to be notified about "a system check failed"
                      needs to know it is not continuous monitoring at the
                      moment they choose.
                    */}
                    {event.hasSourceCaveat ? (
                      <span className={styles.eventCaveat} data-testid={`caveat-${event.type}`}>
                        {t(`caveat.${event.type}` as 'caveat.integration.check_failed')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.configured} data-testid="rule-list">
      <h2 className={styles.listHeading}>{t('heading')}</h2>
      <RuleList groups={groupRulesByEvent(rules, { departments, members })} />
    </div>
  );
}
