import { getFormatter, getTranslations } from 'next-intl/server';

import {
  hasBrief,
  hasMemory,
  isPartialHistory,
  shownOfTotal,
} from '@/api/contracts/customer-detail';
import type { CustomerDetail as Detail } from './load-customer';

import styles from './Customers.module.css';

/**
 * Screen 04b — one customer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ THE DESIGN CALLS THIS "A PERSON WITH A HISTORY". IT IS NOT A HISTORY.
 * ════════════════════════════════════════════════════════════════════════════
 * `GET /api/identity/:id/timeline` takes 50 conversations and the newest 5
 * messages of each, and says so nowhere in its payload. Rendered under the
 * design's words this is a claim of completeness the data cannot support —
 * and it is the calm wrong value at the scale of a whole screen, because
 * nothing looks broken. The stream reads convincingly and messages six
 * through n are simply absent.
 *
 * So it is called RECENT ACTIVITY, the rule is stated in numbers, and the
 * conversations we are showing only the tail of are counted.
 *
 * ── AND IT IS ONE SOURCE, NOT FIVE ──
 * The design asks for one stream mixing conversations, orders, returns, AI
 * actions and notes. `type: "message"` is the entire event union. The screen
 * names what is in the stream AND what is not, because a merchant who sees
 * only messages will otherwise conclude their customer never ordered
 * anything.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY ABSENT
 * ════════════════════════════════════════════════════════════════════════════
 * **NOTES.** `POST /conversations/:id/notes` is a demo stub that echoes the
 * note back with `Date.now()` as its id and persists nothing; the GET always
 * returns `[]`. A note box here would accept what somebody wrote about a
 * customer, show it saved, and lose it on reload.
 *
 * Not even a disabled box. The 14d shape — show the control, disable it,
 * give the reason — assumes a repair the merchant can perform, and there is
 * none. So the screen says notes are not recorded yet and draws nothing.
 *
 * ★ WORDED AS ABSENT TODAY, NOT AS IMPOSSIBLE. Omer has ruled that a note
 * will live either in GOTCHA or in the system elected on screen 14 — the
 * part→system mapping used for its second purpose, so a note lands in the
 * CRM the merchant actually works in. The section belongs between the brief
 * and the timeline when it arrives, and nothing here has to move for it.
 *
 * **TENURE.** Three fields look like it and all three are wrong in the same
 * direction. `customer-card.ts` names them itself: `Contact.createdAt` is
 * when WE made the row, `CustomerProfile.firstSeenAt` is `new Date()` when
 * ingestion first processed them, and `lastSeenAt` is rewritten with `now`
 * on every update — *"pipeline activity wearing a customer-activity name"*.
 * A line saying a three-year customer joined today is worse than no line.
 *
 * **LIFETIME VALUE, ORDERS, REFUNDS.** Real, and only reachable through
 * `GET /api/customer-card/:approvalId`, which is approval-keyed on purpose:
 * commerce facts are two live calls to the merchant's store per customer
 * with no cache, and *"a queue of twenty approvals would be forty vendor
 * round trips"*. Named as not shown, with the reason, rather than quietly
 * omitted.
 */
export async function CustomerDetail({ detail }: { readonly detail: Detail }) {
  const t = await getTranslations('customers');
  const format = await getFormatter();

  if (!detail.timeline) {
    return (
      <p className={styles.unavailable} data-testid="customer-unavailable">
        {t('detail.unavailable')}
      </p>
    );
  }

  const { events, contact, totals } = detail.timeline;
  const { shown, total } = shownOfTotal(detail.timeline);

  return (
    <div className={styles.detail} data-testid="customer-detail">
      <h1 className={styles.detailName} data-testid="detail-name">
        {contact?.displayName?.trim() || contact?.externalId || t('list.unnamed')}
      </h1>

      {/*
        ── THE WRITTEN SUMMARY ──
        Persisted in `customer_briefs` and rewritten at conversation close,
        which is the design's "regenerated on material change" already built.

        Three states, not two. "No conversations" and "we asked and there is
        no brief" are different facts about a person, and the second is the
        one that means the pipeline has not got to them yet.
      */}
      {hasBrief(detail.brief) ? (
        <section className={styles.brief} data-testid="customer-brief">
          <p className={styles.briefProse}>{detail.brief!.summary}</p>
          {detail.brief!.signals.length > 0 ? (
            <ul className={styles.signals} data-testid="brief-signals">
              {detail.brief!.signals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          ) : null}
          {detail.brief!.generated_at ? (
            <p className={styles.briefWhen} data-testid="brief-generated">
              {t('detail.brief.generated', {
                when: format.dateTime(new Date(detail.brief!.generated_at), {
                  dateStyle: 'medium',
                }),
              })}
            </p>
          ) : null}
        </section>
      ) : detail.noConversations ? (
        <p className={styles.briefNone} data-testid="brief-no-conversations">
          {t('detail.brief.noConversations')}
        </p>
      ) : (
        <p className={styles.briefNone} data-testid="brief-none">
          {t('detail.brief.none')}
        </p>
      )}

      {/*
        ── WHAT GOTCHA REMEMBERS ──
        Read-only, and it says so. There is no correct-or-delete route, so
        drawing an edit affordance would be a control the platform cannot
        honour — and these are statements about a customer that somebody
        might most want to fix.
      */}
      {hasMemory(detail.memory) ? (
        <section className={styles.memory} data-testid="customer-memory">
          <h2 className={styles.detailHeading}>{t('detail.memory.heading')}</h2>
          <ul className={styles.facts}>
            {detail.memory!.context!.facts.map((fact) => (
              <li key={fact.text} className={styles.fact} data-testid="memory-fact">
                <span>{fact.text}</span>
                {fact.category ? <span className={styles.factTag}>{fact.category}</span> : null}
              </li>
            ))}
          </ul>

          {/*
            ★ BLOCK-LEVEL PROVENANCE. This is where the whole set came from
            and when — genuinely useful, and NOT what the design asked for.
          */}
          <p className={styles.memorySource} data-testid="memory-source">
            {t('detail.memory.source', {
              source: detail.memory!.context!.source ?? t('detail.memory.unknownSource'),
              count: detail.memory!.context!.messageCount ?? 0,
            })}
          </p>

          {/* When the evidence window is known, it belongs to the SET. */}
          {detail.memory!.context!.evidenceWindow?.from &&
          detail.memory!.context!.evidenceWindow?.to ? (
            <p className={styles.memorySource} data-testid="memory-window">
              {t('detail.memory.window', {
                from: format.dateTime(new Date(detail.memory!.context!.evidenceWindow!.from!), {
                  dateStyle: 'medium',
                }),
                to: format.dateTime(new Date(detail.memory!.context!.evidenceWindow!.to!), {
                  dateStyle: 'medium',
                }),
              })}
            </p>
          ) : null}

          {/*
            ★★ THE TRACE EXISTS AND IS NOT FOLLOWABLE — A DIFFERENT SENTENCE
            FROM THE ONE THIS SCREEN SHIPPED WITH.

            `evidenceConversationIds` now arrives, and they are real
            `Conversation.id` values. But those conversations carry
            `origin: "HISTORICAL_IMPORT"`, and `applyLiveByDefault` injects
            `origin: "LIVE"` into bulk reads — so a read that does not name an
            origin returns ZERO ROWS.

            A link here would open an empty conversation: the same failure the
            block-level statement was chosen to avoid, arriving from the other
            direction. Not a missing field — a present one whose destination
            is empty unless whatever serves it passes `withHistoricalRecords`.

            Nobody has loaded one and watched messages come back, so no link
            is drawn and the screen says which of the two it is.
          */}
          <p className={styles.memoryLimit} data-testid="memory-no-trace">
            {t('detail.memory.noPerFactTrace')}
          </p>
        </section>
      ) : detail.memory === null ? (
        <p className={styles.unavailable} data-testid="memory-unavailable">
          {t('detail.memory.unavailable')}
        </p>
      ) : (
        <p className={styles.briefNone} data-testid="memory-none">
          {t('detail.memory.none')}
        </p>
      )}

      {/*
        ══════════════════════════════════════════════════════════════════════
        RECENT ACTIVITY — NEVER "HER WHOLE HISTORY"
        ══════════════════════════════════════════════════════════════════════
      */}
      <section className={styles.timeline} data-testid="customer-timeline">
        <h2 className={styles.detailHeading}>{t('detail.timeline.heading')}</h2>

        {/*
          The cross-channel work IS real and is the hard part: the route
          follows `mergedIntoId`, gathers sibling contacts and includes
          aliases preserved from prior merges. So this genuinely is every
          channel on one spine, and that much can be said without hedging.
        */}
        <p className={styles.timelineScope} data-testid="timeline-scope">
          {t('detail.timeline.everyChannel')}
        </p>

        {events.length === 0 ? (
          <p className={styles.briefNone} data-testid="timeline-empty">
            {t('detail.timeline.empty')}
          </p>
        ) : (
          <ol className={styles.events}>
            {events.map((event, i) => (
              <li
                key={`${event.conversationId}-${event.createdAt}-${i}`}
                className={styles.event}
                data-testid="timeline-event"
                data-direction={event.direction}
              >
                <span className={styles.eventMeta}>
                  {format.dateTime(new Date(event.createdAt), { dateStyle: 'medium' })}
                  {' · '}
                  {event.channel}
                  {' · '}
                  {t(`detail.timeline.${event.direction}` as 'detail.timeline.INBOUND')}
                  {/*
                    ★ IMPORTED IS NOT OBSERVED. Something we were TOLD about,
                    not something the product watched happen — and until
                    today these were excluded from the timeline entirely, so
                    a long-standing customer rendered as brand new.
                  */}
                  {event.origin === 'HISTORICAL_IMPORT' ? (
                    <span className={styles.imported} data-testid="event-imported">
                      {' · '}
                      {t('detail.timeline.imported')}
                    </span>
                  ) : null}
                </span>
                <span className={styles.eventBody}>
                  {event.body?.trim() || t('detail.timeline.noBody')}
                </span>
              </li>
            ))}
          </ol>
        )}

        {/*
          ★★ THE COUNT, BOTH HALVES.

          The route now returns `totals.messages` — the real number of this
          person's messages — so the screen can say "50 of 1,284" instead of
          implying it holds everything.

          This replaces a sentence that named 50 conversations × 5 messages,
          which described a shape that no longer exists AND was the wrong
          limit even then: the old route THINNED rather than truncated, so
          the stream had holes in the middle of every conversation and the
          honest-sounding sentence would still have been false.
        */}
        {events.length > 0 ? (
          <p className={styles.timelineLimit} data-testid="timeline-count">
            {isPartialHistory(detail.timeline)
              ? t('detail.timeline.partial', { shown, total })
              : t('detail.timeline.whole', { total })}
          </p>
        ) : null}

        {/*
          A bounded read that discloses its bound is fine; one that quietly
          drops the oldest threads is the defect. This flag is the disclosure.
        */}
        {totals.conversationScanTruncated ? (
          <p className={styles.timelineLimit} data-testid="timeline-scan-truncated">
            {t('detail.timeline.scanTruncated')}
          </p>
        ) : null}

        {/*
          ★ WHAT IS NOT IN THE STREAM. A merchant reading a messages-only
          timeline under the word "activity" would reasonably conclude this
          customer never ordered anything.
        */}
        <p className={styles.timelineLimit} data-testid="timeline-sources">
          {t('detail.timeline.messagesOnly')}
        </p>
      </section>

      {/*
        ── THE TWO THINGS THIS SCREEN WILL NOT SHOW, AND WHY ──
        Named rather than silently missing, the same as 17e's absent fields
        and 14e's write-back list. A merchant who cannot find notes should
        learn that notes are not recorded, not conclude they looked in the
        wrong place.
      */}
      <section className={styles.absent} data-testid="customer-absent">
        <p data-testid="absent-notes">{t('detail.absent.notes')}</p>
        <p data-testid="absent-money">{t('detail.absent.money')}</p>
      </section>
    </div>
  );
}
