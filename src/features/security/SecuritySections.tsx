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
      <>
        <AuditHead facets={[]} truncated={false} t={t} />
        <p className={styles.unavailable} data-testid="audit-unavailable">
          {t('audit.unavailable')}
        </p>
      </>
    );
  }

  if (entries.length === 0) {
    return (
      <>
        <AuditHead facets={facets} truncated={facetsTruncated} t={t} />
        <p className={styles.empty} data-testid="audit-empty">
          {t('audit.empty')}
        </p>
      </>
    );
  }

  const now = new Date();
  const clock = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <>
      <AuditHead facets={facets} truncated={facetsTruncated} t={t} />

      {/*
        02's row: the time (mono), what happened, and its kind at the end —
        "Failure" in red when it did not work, otherwise who did it.
      */}
      <ul className={styles.auditRows} data-testid="audit-list">
        {entries.map((entry) => {
          const verdict = auditVerdict(entry.succeeded, entry.action);
          const at = new Date(entry.createdAt);
          return (
            <li
              key={entry.id}
              className={styles.auditRow}
              data-testid={`audit-${entry.id}`}
              data-actor={entry.actorType}
              data-succeeded={verdict === true ? 'yes' : verdict === false ? 'no' : 'unrecorded'}
            >
              <time className={styles.auditTime} dateTime={entry.createdAt}>
                {sameDay(at, now)
                  ? clock.format(at)
                  : sameDay(at, new Date(now.getTime() - DAY))
                    ? t('audit.yesterday')
                    : day.format(at)}
              </time>
              {/*
                ★★ `succeeded` is `null` on every `adapter.*` row — nothing
                recorded one — while the action name said `err` in so many
                words. `auditVerdict` reads both and prefers the column; a row
                with neither still says nothing rather than guessing (null is
                "not recorded", not "failed").
              */}
              <span className={styles.auditText}>{describeAuditAction(entry.action).name}</span>
              <span
                className={[styles.auditKind, verdict === false ? styles.failed : '']
                  .join(' ')
                  .trim()}
                data-testid={`audit-kind-${entry.id}`}
              >
                {verdict === false
                  ? t('audit.failure')
                  : ACTORS.includes(entry.actorType as Actor)
                    ? t(`audit.actor.${entry.actorType as Actor}`)
                    : // An actor the vocabulary does not know: no word, never a key.
                      null}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** `actorType` is a free string on the wire; these are the ones with words. */
const ACTORS = ['ai', 'user', 'system'] as const;
type Actor = (typeof ACTORS)[number];

/** Today's rows carry the clock (02's "09:41"); older ones, the date. */
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY = 24 * 60 * 60 * 1000;

/** How many facets ride in the head before the rest go under "More". */
const HEAD_FACETS = 4;

/**
 * 16's head: "Everything that happened", the facets as 02's chips, Export.
 *
 * The facets are the log's real action vocabulary, not categories we chose —
 * the log conflates actions that had an effect with lookups the AI made while
 * composing one answer, and the schema does not distinguish them, so any
 * split we invented would be a guess that drifts as tools are added. They
 * read in the same words as the rows; the count rides on the title. "All" is
 * dark because the list below is all of it — nothing filters it yet, so the
 * chips are states, not buttons.
 */
function AuditHead({
  facets,
  truncated,
  t,
}: {
  readonly facets: readonly AuditFacet[];
  readonly truncated: boolean;
  readonly t: Awaited<ReturnType<typeof getTranslations<'security'>>>;
}) {
  const chip = (facet: AuditFacet) => {
    const { name, outcome } = describeAuditAction(facet.action);
    return (
      <span
        key={facet.action}
        className={styles.auditChip}
        data-outcome={outcome ?? 'unrecorded'}
        title={
          outcome === 'err'
            ? `${t('audit.didNotWork')} · ${t('audit.times', { count: facet.count })}`
            : t('audit.times', { count: facet.count })
        }
      >
        {name}
      </span>
    );
  };
  const rest = facets.slice(HEAD_FACETS);

  return (
    <header className={styles.auditHead}>
      <h2 className={styles.cardTitle}>{t('heading.audit')}</h2>
      {facets.length > 0 ? (
        <div className={styles.auditChips} data-testid="audit-facets">
          <span className={styles.auditChip} data-current="yes">
            {t('audit.all')}
          </span>
          {facets.slice(0, HEAD_FACETS).map(chip)}
          {rest.length > 0 || truncated ? (
            <details className={styles.auditMore} data-testid="audit-facets-more">
              <summary className={styles.auditChip}>{t('audit.more')}</summary>
              <div className={styles.auditMoreList}>
                {rest.map(chip)}
                {truncated ? (
                  <span className={styles.facetNote} data-testid="audit-facets-truncated">
                    {t('audit.moreActions')}
                  </span>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
      {/* Nothing exports the log from here yet. */}
      <span className={styles.export} aria-disabled="true" title={t('audit.exportNotYet')}>
        {t('audit.export')}
      </span>
    </header>
  );
}
