import { getLocale, getTranslations } from 'next-intl/server';

import type { AuditEntry, AuditFacet, LoginEvent } from '@/api/contracts/security';

import styles from './Security.module.css';
import { auditVerdict, describeAuditAction } from '@/api/contracts/security';

/**
 * Recent sign-ins.
 *
 * *"An unfamiliar session is flagged in the list rather than in an email."*
 * A failed sign-in is the row that matters most here, so it is marked rather
 * than left to be spotted among successes.
 *
 * An empty list is a real answer on this route: the backend already drops
 * server-side noise — logins from private IPs and library user agents, which
 * are token refreshes rather than people — so nothing here is an artefact of
 * our own filtering.
 */
export async function LoginHistory({
  events,
  available,
}: {
  readonly events: readonly LoginEvent[];
  readonly available: boolean;
}) {
  const t = await getTranslations('security');
  const locale = await getLocale();

  if (!available) {
    return (
      <p className={styles.unavailable} data-testid="logins-unavailable">
        {t('logins.unavailable')}
      </p>
    );
  }

  if (events.length === 0) {
    return (
      <p className={styles.empty} data-testid="logins-empty">
        {t('logins.empty')}
      </p>
    );
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <ul className={styles.rows} data-testid="login-history">
      {events.map((event) => (
        <li
          key={event.id}
          className={styles.row}
          data-testid={`login-${event.id}`}
          data-failed={event.success ? 'no' : 'yes'}
        >
          <div className={styles.identity}>
            <span className={[styles.name, event.success ? '' : styles.failed].join(' ').trim()}>
              {event.success ? t('logins.signedIn') : t('logins.failed')}
            </span>
            <span className={styles.detail}>
              {[
                [event.city, event.country].filter(Boolean).join(', ') || null,
                event.ip,
                event.userAgent?.trim() || null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <span className={styles.when}>
            {event.timestamp ? when.format(new Date(event.timestamp)) : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything that happened, including everything GOTCHA did.
 *
 * `AuditLog` holds 5,159 rows on this tenant, 5,059 of them written by the AI.
 * Until `GET /api/audit-logs` existed, every one of its eleven read sites was
 * an AI service reading the log for its own reasoning — the AI could see its
 * own history and the account's owner could not.
 *
 * When the read fails this renders **"we cannot read this"**, never an empty
 * list. On a security screen *"nothing happened"* is reassuring and *"the log
 * is unreadable"* is not, and a section that shows the first when it means the
 * second is actively dangerous.
 *
 * Among what it contains: 22 `adapter.err.shopify.process_refund` rows —
 * refunds that failed and that nobody was ever told about, because the
 * notification path emits only on success. This screen does not fix that; it
 * is simply the first place they are visible.
 */
export async function AuditSection({
  entries,
  available,
  facets,
  facetsTruncated,
}: {
  readonly entries: readonly AuditEntry[];
  readonly available: boolean;
  readonly facets: readonly AuditFacet[];
  readonly facetsTruncated: boolean;
}) {
  const t = await getTranslations('security');
  const locale = await getLocale();

  if (!available) {
    return (
      <p className={styles.unavailable} data-testid="audit-unavailable">
        {t('audit.unavailable')}
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <p className={styles.empty} data-testid="audit-empty">
        {t('audit.empty')}
      </p>
    );
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <>
      {/*
        The real action vocabulary, with counts.

        Not a set of categories we invented. The log conflates actions that had
        an effect with lookups the AI made while composing one answer, and the
        schema does not distinguish them — so any split we chose would be a
        guess that drifts as tools are added. Showing what is actually in the
        log lets a reader navigate it on their own terms, and a new tool simply
        appears here with its count.
      */}
      {facets.length > 0 ? (
        <div className={styles.facets} data-testid="audit-facets">
          {facets.slice(0, 8).map((facet) => {
            const { name, outcome } = describeAuditAction(facet.action);
            return (
              <span
                key={facet.action}
                className={styles.facet}
                data-outcome={outcome ?? 'unrecorded'}
              >
                {/*
                  ★★ THIS PRINTED `adapter.err.shopify.get_customer_by_phone`
                  under a heading reading "Everything that happened", on a page
                  an account owner opens.

                  The prefix is consumed rather than spelled out: nobody needs to
                  read the word "adapter", they need the tool and whether it
                  worked. And `err` buried mid-string is how 742 failures read as
                  noise, so it is a state on the row instead of part of its name.
                */}
                <span
                  className={[styles.facetName, outcome === 'err' ? styles.failed : '']
                    .join(' ')
                    .trim()}
                >
                  {name}
                </span>
                {outcome === 'err' ? (
                  <span className={styles.facetOutcome}>{t('audit.didNotWork')}</span>
                ) : null}
                <span className={styles.facetCount}>{facet.count}</span>
              </span>
            );
          })}
          {facetsTruncated ? (
            <span className={styles.facetNote} data-testid="audit-facets-truncated">
              {t('audit.moreActions')}
            </span>
          ) : null}
        </div>
      ) : null}

      <ul className={styles.rows} data-testid="audit-list">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className={styles.row}
            data-testid={`audit-${entry.id}`}
            data-actor={entry.actorType}
            data-succeeded={
              auditVerdict(entry.succeeded, entry.action) === true
                ? 'yes'
                : auditVerdict(entry.succeeded, entry.action) === false
                  ? 'no'
                  : 'unrecorded'
            }
          >
            <div className={styles.identity}>
              {/*
                ★★ AND THE ROWS WERE THROWING A VERDICT AWAY. `succeeded` is
                `null` on every `adapter.*` row — nothing recorded one — while the
                action name said `err` in so many words. So 742 known failures
                were filed as "we did not record whether this worked".

                `auditVerdict` reads both and prefers the column, because an
                explicit field beats a substring. The three states survive: a row
                with neither source still says nothing rather than guessing.
              */}
              <span
                className={[
                  styles.name,
                  auditVerdict(entry.succeeded, entry.action) === false ? styles.failed : '',
                ]
                  .join(' ')
                  .trim()}
              >
                {describeAuditAction(entry.action).name}
              </span>
              <span className={styles.detail}>
                {[
                  t(`audit.actor.${entry.actorType}` as 'audit.actor.ai'),
                  /*
                   * THREE states, not two. `null` means the emitter recorded no
                   * verdict — not that the action failed. Collapsing them would
                   * mark every un-instrumented action as a failure, which is the
                   * reassuring-direction error inverted: alarming a reader about
                   * things that did not go wrong.
                   */
                  auditVerdict(entry.succeeded, entry.action) === false
                    ? t('audit.didNotWork')
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            <span className={styles.when}>{when.format(new Date(entry.createdAt))}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
