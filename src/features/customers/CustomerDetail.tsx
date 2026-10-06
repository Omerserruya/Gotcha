import { getFormatter, getTranslations } from 'next-intl/server';

import { toolWords as toolWordsOf } from './tool-words';

import {
  coverageCaveats,
  hasBrief,
  hasMemory,
  hasNeverWritten,
  isPartialHistory,
  notesBlockedBy,
  shownOfTotal,
  actionOutcome,
} from '@/api/contracts/customer-detail';
import type { CustomerDetail as Detail } from './load-customer';

import styles from './Customers.module.css';
import { channelName } from '@/api/contracts/inbox';

/**
 * Screen 04b - one customer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ THE DESIGN CALLS THIS "A PERSON WITH A HISTORY". IT IS NOT A HISTORY.
 * ════════════════════════════════════════════════════════════════════════════
 * `GET /api/identity/:id/timeline` takes 50 conversations and the newest 5
 * messages of each, and says so nowhere in its payload. Rendered under the
 * design's words this is a claim of completeness the data cannot support -
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
 * **NOTES - CORRECTED.** They are not absent. This screen first shipped
 * saying so, on the strength of `POST /conversations/:id/notes` being a demo
 * stub. The stub is real; the capability is somewhere else entirely, in the
 * merchant's CRM. The section above reads them and does not offer a write.
 *
 * Worth keeping as the shape: **I read a stub and concluded the capability
 * was absent, without asking whether it existed elsewhere.** The stub was
 * evidence about one endpoint and I took it as evidence about the product.
 *

 *
 * **TENURE.** Three fields look like it and all three are wrong in the same
 * direction. `customer-card.ts` names them itself: `Contact.createdAt` is
 * when WE made the row, `CustomerProfile.firstSeenAt` is `new Date()` when
 * ingestion first processed them, and `lastSeenAt` is rewritten with `now`
 * on every update - *"pipeline activity wearing a customer-activity name"*.
 * A line saying a three-year customer joined today is worse than no line.
 *
 * ── 04d IS A SIBLING, NOT A CHILD ──
 * `CustomerOrders` is mounted by the page beside this component rather than
 * inside it. Both are async server components, and nesting one in the other
 * makes the outer one untestable: awaiting it yields a tree with an
 * unresolved async node and the render produces nothing. Screen 11 hit this
 * with `ScanPanel` and solved it the same way.
 *
 * Found here by 25 tests failing at once on a missing `timeline-count` -
 * the whole tree had stopped rendering, and the symptom named a testid that
 * had nothing to do with the cause.
 *
 * **LIFETIME VALUE, REFUNDS.** Real, and only reachable through
 * `GET /api/customer-card/:approvalId`, which is approval-keyed on purpose:
 * commerce facts are two live calls to the merchant's store per customer
 * with no cache, and *"a queue of twenty approvals would be forty vendor
 * round trips"*. Named as not shown, with the reason, rather than quietly
 * omitted.
 */
export async function CustomerDetail({ detail }: { readonly detail: Detail }) {
  const t = await getTranslations('customers');
  const channelNames = await getTranslations('channels');
  const toolWords = await toolWordsOf();
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
        ★ A PERSON WHO HAS NEVER WRITTEN IS A REAL STATE, NOT AN EDGE CASE.

        Somebody imported from a CRM who has never sent a message. Four of
        this page's sections are then UNREACHABLE rather than empty - no
        brief, no orders, no order actions, no CRM notes - and four blank
        panels would read as a broken page.

        Read from the brief's own `meta.reason`, which Backend kept distinct
        from `404 contact_not_found` precisely so a screen could say this.
        NOT inferred from an empty timeline: that can also be empty because
        the read failed, and those two must not share a sentence.
      */}
      {hasNeverWritten(detail.brief) ? (
        <p className={styles.neverWritten} data-testid="never-written">
          {t('detail.neverWritten')}
        </p>
      ) : null}

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
        honour - and these are statements about a customer that somebody
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
            and when - genuinely useful, and NOT what the design asked for.
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
            ★★ THE TRACE EXISTS AND IS NOT FOLLOWABLE - A DIFFERENT SENTENCE
            FROM THE ONE THIS SCREEN SHIPPED WITH.

            `evidenceConversationIds` now arrives, and they are real
            `Conversation.id` values. But those conversations carry
            `origin: "HISTORICAL_IMPORT"`, and `applyLiveByDefault` injects
            `origin: "LIVE"` into bulk reads - so a read that does not name an
            origin returns ZERO ROWS.

            A link here would open an empty conversation: the same failure the
            block-level statement was chosen to avoid, arriving from the other
            direction. Not a missing field - a present one whose destination
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
        RECENT ACTIVITY - NEVER "HER WHOLE HISTORY"
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
                  {/* The seventh renderer, in a timeline row's meta line. */}
                  {channelName(event.channel, channelNames)
                    ? `${channelName(event.channel, channelNames)} · `
                    : ''}
                  {/* Direction is a property of a message, not of an action. */}
                  {event.direction
                    ? t(`detail.timeline.${event.direction}` as 'detail.timeline.INBOUND')
                    : t(`detail.timeline.kind.${event.type}` as 'detail.timeline.kind.handover')}
                  {/*
                    ★ IMPORTED IS NOT OBSERVED. Something we were TOLD about,
                    not something the product watched happen - and until
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
                {/*
                  ★★ EACH KIND FROM ITS OWN FIELD, NEVER FROM `body`.

                  `body` is null on handovers and AI actions. Backend
                  deliberately did not compose summary sentences into it, and
                  the reason is worth copying: a sentence they compose is not
                  data, and in that field it would be indistinguishable from
                  something the customer actually wrote.

                  The legacy `CustomerTimeline.tsx` does `body ?? "(no body)"`
                  and renders both kinds as empty messages.
                */}
                {event.type === 'handover' && event.handover ? (
                  <span className={styles.eventBody} data-testid="event-handover">
                    {event.handover.reason
                      ? t('detail.timeline.handoverWithReason', {
                          to: event.handover.to,
                          reason: event.handover.reason,
                        })
                      : t('detail.timeline.handover', { to: event.handover.to })}
                  </span>
                ) : event.type === 'ai_action' && event.action ? (
                  <span
                    className={styles.eventBody}
                    data-testid="event-action"
                    data-status={actionOutcome(event.action)}
                  >
                    {/* By status (4b7c2e1b): a refund waiting for approval is not a failure. */}
                    {t(`detail.timeline.action.${actionOutcome(event.action)}`, {
                      tool: toolWords(event.action.tool),
                    })}
                  </span>
                ) : (
                  <span className={styles.eventBody}>
                    {event.body?.trim() || t('detail.timeline.noBody')}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}

        {/*
          ★★ THE COUNT, BOTH HALVES.

          The route now returns `totals.messages` - the real number of this
          person's messages - so the screen can say "50 of 1,284" instead of
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
          ★★ WHAT THE STREAM CANNOT FULLY TELL YOU - FROM THE SERVER, NOT
          FROM A HARDCODED SENTENCE.

          `coverage` names both kinds of gap and the screen renders both
          together, because a merchant does not care which is which: a source
          that is ABSENT and a source that is present-but-PARTIAL are equally
          reasons not to read this as the whole story.

          The partial one is the dangerous one. `ai_action` is
          `available: true` and still omits any action taken through an
          adapter - a Shopify refund the AI performed is not in this list.
          Backend's own note says the gap is invisible from the data, so a
          screen that renders the events and drops the detail deletes the
          only warning there is.

          Server-supplied rather than written here, so a source arriving or
          changing its limit updates the screen without an edit - the
          opposite of the hardcoded "messages only" sentence this replaces,
          which was already stale the day the union shipped.
        */}
        {coverageCaveats(detail.timeline.coverage).length > 0 ? (
          <ul className={styles.coverage} data-testid="timeline-coverage">
            {coverageCaveats(detail.timeline.coverage).map((caveat) => (
              <li key={caveat.type} data-testid={`coverage-${caveat.type}`}>
                {caveat.detail}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/*
        ══════════════════════════════════════════════════════════════════════
        NOTES - WHICH LIVE IN THE MERCHANT'S CRM, AND ARE READ-ONLY HERE
        ══════════════════════════════════════════════════════════════════════
        This screen first shipped saying notes were not recorded. That was
        wrong: `POST /conversations/:id/notes` is a demo stub, but
        `crm-panel.ts:690` calls `adapter.createNote` for real. GOTCHA does
        not store notes; the merchant's CRM does.

        ★ SO THE 14d SHAPE APPLIES AFTER ALL, because there IS a repair a
        merchant can perform - connect a CRM, and link this contact to a
        record in it. Two repairs, two sentences: sending somebody to connect
        a CRM they already have is the mistake 14d exists to prevent.

        ⚠ AND WRITING IS NOT OFFERED, even where it would succeed. The write
        sets `source_interaction_id` to whichever conversation this page
        entered through, so a note taken here would be attached to an
        unrelated chat **in the merchant's own CRM, where we cannot correct
        it later.** That is writing a false fact into somebody else's system
        of record, which is worse than not offering the control.

        ⚠ There is also no author. `CrmActivity` carries no actor, so these
        are dated and anonymous - said on screen rather than left for
        somebody to assume the newest note is theirs.
      */}
      <section className={styles.notes} data-testid="customer-notes">
        <h2 className={styles.detailHeading}>{t('detail.notes.heading')}</h2>

        {detail.crm === null ? (
          <p className={styles.unavailable} data-testid="notes-unavailable">
            {t('detail.notes.unavailable')}
          </p>
        ) : notesBlockedBy(detail.crm) === 'no_crm' ? (
          <p className={styles.briefNone} data-testid="notes-no-crm">
            {t('detail.notes.noCrm')}
          </p>
        ) : notesBlockedBy(detail.crm) === 'no_link' ? (
          <p className={styles.briefNone} data-testid="notes-no-link">
            {t('detail.notes.noLink')}
          </p>
        ) : detail.crm.recent_crm_notes.length === 0 ? (
          <p className={styles.briefNone} data-testid="notes-empty">
            {t('detail.notes.empty')}
          </p>
        ) : (
          <>
            <ul className={styles.facts} data-testid="notes-list">
              {detail.crm.recent_crm_notes.map((note) => (
                <li key={note.id} className={styles.fact} data-testid="crm-note">
                  <span>{note.body}</span>
                  {note.occurred_at ? (
                    <span className={styles.factTag}>
                      {format.dateTime(new Date(note.occurred_at), { dateStyle: 'medium' })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className={styles.memoryLimit} data-testid="notes-anonymous">
              {t('detail.notes.anonymous')}
            </p>
          </>
        )}

        {/* Said in every state, because it is true in every state. */}
        <p className={styles.memoryLimit} data-testid="notes-read-only">
          {t('detail.notes.readOnly')}
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
        <p data-testid="absent-money">{t('detail.absent.money')}</p>
      </section>
    </div>
  );
}
