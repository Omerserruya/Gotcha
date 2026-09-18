import { getTranslations } from 'next-intl/server';

import { EVENT_FAMILIES, eventsInFamily } from './events';
import styles from './Notifications.module.css';

/**
 * Settings · Notifications — screen 15.
 *
 * ── WHAT THIS SCREEN IS, AFTER THE RULING ──
 * The design drew a personal matrix: *"tell me when"*, eight events by three
 * channels, per user. That store exists and **nothing reads it** — the whole
 * `UserNotificationPreference` table has two references in the repository and
 * both are its own route. Four switches and a quiet-hours window that no
 * dispatcher consults.
 *
 * What the dispatcher does read is `NotificationPreference`: a TENANT rule —
 * *"when X happens, notify these people, on these channels"* — scoped to a
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
 * degraded one — the mistake we nearly made with screen 12's roster.
 *
 * An empty rule table is not a failure and must not read as one. It means
 * GOTCHA is currently telling nobody about anything, which is a real and
 * consequential state, and the screen says so plainly rather than showing a
 * blank with a button in it.
 */
export async function RuleTable({
  rules,
  available,
}: {
  /** Existing rules. Empty is the day-one state, not an error. */
  readonly rules: readonly { id: string; eventType: string }[];
  /** False when the rules could not be read — never the same as "none". */
  readonly available: boolean;
}) {
  // `notifications-settings`, not `notifications` — the latter is screen 01d.
  const t = await getTranslations('notifications-settings');

  if (!available) {
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
          table; "GOTCHA is telling nobody about anything" describes the
          consequence, and the consequence is what an admin needs.
        */}
        <p className={styles.dayOneLead}>{t('rules.noneLead')}</p>
        <p className={styles.dayOneBody}>{t('rules.noneBody')}</p>

        {/*
          The vocabulary, shown before the first rule exists rather than hidden
          behind a form. Someone deciding whether to write a rule needs to know
          what GOTCHA can actually tell them about — and 22 events grouped by
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

  // Rules exist. The table itself waits on the backend contract for its shape.
  return (
    <ul className={styles.rules} data-testid="rule-list">
      {rules.map((rule) => (
        <li key={rule.id} className={styles.rule} data-testid={`rule-${rule.id}`}>
          {t(`event.${rule.eventType}` as 'event.tool.approval_required')}
        </li>
      ))}
    </ul>
  );
}
