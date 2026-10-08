import { getLocale, getTranslations } from 'next-intl/server';

import type { AuditEntry, AuditFacet, LoginEvent } from '@/api/contracts/security';

import { ExportAuditLog } from './ExportAuditLog';
import styles from './Security.module.css';
import { shortWhen } from './when';
import { auditVerdict, describeAuditAction } from '@/api/contracts/security';

/**
 * Recent sign-ins.
 *
 * *"An unfamiliar session is flagged in the list rather than in an email."*
 * A failed sign-in is the row that matters most here, so it is marked rather
 * than left to be spotted among successes.
 *
 * An empty list is a real answer on this route: the backend already drops
 * server-side noise - logins from private IPs and library user agents, which
 * are token refreshes rather than people - so nothing here is an artefact of
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

  // 24-hour, as the rest of the product writes a time.
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  });

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
 * an AI service reading the log for its own reasoning - the AI could see its
 * own history and the account's owner could not.
 *
 * When the read fails this renders **"we cannot read this"**, never an empty
 * list. On a security screen *"nothing happened"* is reassuring and *"the log
 * is unreadable"* is not, and a section that shows the first when it means the
 * second is actively dangerous.
 *
 * Among what it contains: 22 `adapter.err.shopify.process_refund` rows -
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

  return (
    <>
      <AuditHead facets={facets} truncated={facetsTruncated} exportable t={t} />

      {/*
        02's row: the time (mono), what happened, and its kind at the end -
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
                {shortWhen(at, now, locale, t('audit.yesterday'))}
              </time>
              {/*
                ★★ `succeeded` is `null` on every `adapter.*` row - nothing
                recorded one - while the action name said `err` in so many
                words. `auditVerdict` reads both and prefers the column; a row
                with neither still says nothing rather than guessing (null is
                "not recorded", not "failed").
              */}
              <span className={styles.auditText}>{auditSentence(entry, t)}</span>
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

/** How many facets ride in the head before the rest go under "More". */
const HEAD_FACETS = 4;

/**
 * 16's head: "Everything that happened", the facets as 02's chips, Export.
 *
 * The facets are the log's real action vocabulary, not categories we chose -
 * the log conflates actions that had an effect with lookups the AI made while
 * composing one answer, and the schema does not distinguish them, so any
 * split we invented would be a guess that drifts as tools are added. They
 * read in the same words as the rows; the count rides on the title. "All" is
 * dark because the list below is all of it - nothing filters it yet, so the
 * chips are states, not buttons.
 */
function AuditHead({
  facets,
  truncated,
  exportable = false,
  t,
}: {
  readonly facets: readonly AuditFacet[];
  readonly truncated: boolean;
  /** The log was read and has rows - there is something to export. */
  readonly exportable?: boolean;
  readonly t: Awaited<ReturnType<typeof getTranslations<'security'>>>;
}) {
  /*
    One chip per name: the worked and failed halves of a tool are ONE thing
    to a reader, and two chips with the same words read as a duplicate. The
    failures ride on the title.
  */
  const chip = (facet: MergedFacet) => (
    <span
      key={facet.name}
      className={styles.auditChip}
      data-failed={facet.failed > 0 ? 'some' : 'none'}
      title={
        facet.failed > 0
          ? t('audit.timesFailed', { count: facet.count, failed: facet.failed })
          : t('audit.times', { count: facet.count })
      }
    >
      {facet.name}
    </span>
  );
  const merged = mergeFacets(facets, (action) => auditChipLabel(action, t));
  const rest = merged.slice(HEAD_FACETS);

  return (
    <header className={styles.auditHead}>
      <h2 className={styles.cardTitle}>{t('heading.audit')}</h2>
      {facets.length > 0 ? (
        <div className={styles.auditChips} data-testid="audit-facets">
          <span className={styles.auditChip} data-current="yes">
            {t('audit.all')}
          </span>
          {merged.slice(0, HEAD_FACETS).map(chip)}
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
      {/* The whole log as CSV - once it was read and holds something. */}
      {exportable ? <ExportAuditLog /> : null}
    </header>
  );
}

interface MergedFacet {
  readonly name: string;
  readonly count: number;
  readonly failed: number;
}

/** Facets by the words a reader sees, in the order the log ranks them. */
export function mergeFacets(
  facets: readonly AuditFacet[],
  label: (action: string) => string,
): MergedFacet[] {
  const byName = new Map<string, { count: number; failed: number }>();
  for (const facet of facets) {
    const name = label(facet.action);
    const { outcome } = describeAuditAction(facet.action);
    const seen = byName.get(name) ?? { count: 0, failed: 0 };
    seen.count += facet.count;
    if (outcome === 'err') seen.failed += facet.count;
    byName.set(name, seen);
  }
  return [...byName].map(([name, v]) => ({ name, ...v }));
}

/** The connector operations with a verb; any other runs as "ran …". */
const VERBS = ['get', 'search', 'update', 'process', 'summarize', 'create', 'cancel', 'list'];

/** Actions whose sentence is known word for word. */
const KNOWN = {
  'ai.responded': 'responded',
  'message.sent': 'messageSent',
  'ai.bot_turn': 'botTurn',
  'ai.paused_for_approval': 'pausedForApproval',
  'ai.tool_call.escalate_to_human': 'escalated',
  'billing.provisioning_attempted': 'provisioningAttempted',
  'billing.provisioning_request_created': 'provisioningRequested',
  'billing.provisioning_failed': 'provisioningFailed',
  'billing.provisioning_completed': 'provisioningCompleted',
} as const;

/**
 * 02's row is a sentence - who did what. The log carries the actor and the
 * action; the object (which customer, which order, how much) is not on the
 * read, so the sentence stops at the verb. Nothing raw is printed: no ids,
 * no phone numbers.
 */
export function auditSentence(
  entry: AuditEntry,
  t: Awaited<ReturnType<typeof getTranslations<'security'>>>,
): string {
  const actor = ACTORS.includes(entry.actorType as Actor)
    ? t(`audit.who.${entry.actorType as Actor}`)
    : t('audit.who.unknown');
  /*
   * ★ WHO, FOR THE VERB'S GENDER (Omer): GOTCHA is feminine, and so is
   *   "the system" (המערכת) - "GOTCHA ענתה", never "ענה/תה"; a person of
   *   unknown gender keeps the slash; "something" is masculine. English
   *   ignores it.
   */
  const who = ACTORS.includes(entry.actorType as Actor) ? entry.actorType : 'other';
  const adapter = /^adapter\.(?:ok|err)\.([a-z0-9]+)\.([a-z0-9_]+)$/.exec(entry.action);
  if (adapter) {
    const [verb, ...rest] = adapter[2]!.split('_');
    const system = adapter[1]!.charAt(0).toUpperCase() + adapter[1]!.slice(1);
    return VERBS.includes(verb!)
      ? t('audit.sentence.connector', {
          actor,
          who,
          verb: verb!,
          object: objectWords(rest, t),
          system,
        })
      : t('audit.sentence.connectorOther', {
          actor,
          who,
          operation: adapter[2]!.replaceAll('_', ' '),
          system,
        });
  }
  const known = KNOWN[entry.action as keyof typeof KNOWN];
  if (known) return t(`audit.sentence.${known}`, { actor, who });
  return t('audit.sentence.other', { actor, action: describeAuditAction(entry.action).name });
}

/**
 * What a connector operation acts on, in the reader's words: "customer by
 * phone" is "לקוח לפי טלפון", "customer orders" "הזמנות של לקוח" - phrases,
 * not words, because Hebrew does not keep English's order. The catalogue
 * holds the platform's operation names (services/ai connectors); one it does
 * not know is the operation's own words, underscores gone - never raw.
 */
function objectWords(
  parts: readonly string[],
  t: Awaited<ReturnType<typeof getTranslations<'security'>>>,
): string {
  const key = parts.join('_');
  const path = `audit.object.${key}` as 'audit.object.order';
  return key && t.has(path) ? t(path) : parts.join(' ');
}

/** Chip words for the known actions - the rows' sentences, short. */
const CHIPS: Partial<Record<keyof typeof KNOWN, string>> = {
  'ai.responded': 'replies',
  'message.sent': 'messages',
  'ai.bot_turn': 'turns',
  'ai.paused_for_approval': 'approvals',
  'ai.tool_call.escalate_to_human': 'handovers',
  'billing.provisioning_attempted': 'billingSetup',
  'billing.provisioning_request_created': 'billingSetup',
  'billing.provisioning_failed': 'billingSetup',
  'billing.provisioning_completed': 'billingSetup',
};

/**
 * A facet's chip: the row's sentence without its actor, short enough that
 * four sit in the head uncut - "Looked up by phone", "Searched products",
 * "AI replies". A leading "customer" is the connector's subject on every
 * lookup and is dropped when something follows it.
 */
export function auditChipLabel(
  action: string,
  t: Awaited<ReturnType<typeof getTranslations<'security'>>>,
): string {
  const adapter = /^adapter\.(?:ok|err)\.[a-z0-9]+\.([a-z0-9_]+)$/.exec(action);
  if (adapter) {
    const [verb, ...rest] = adapter[1]!.split('_');
    const words = rest[0] === 'customer' && rest.length > 1 ? rest.slice(1) : rest;
    return VERBS.includes(verb!)
      ? t('audit.chip.connector', { verb: verb!, object: objectWords(words, t) })
      : describeAuditAction(action).name;
  }
  const known = CHIPS[action as keyof typeof KNOWN];
  if (known) return t(`audit.chip.${known}`);
  return describeAuditAction(action).name;
}
