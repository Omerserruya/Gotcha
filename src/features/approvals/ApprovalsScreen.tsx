'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import {
  decisionStance,
  isDecidable,
  humanizeTag,
  visibleRiskTags,
  isKnownRiskTag,
  isOutcomeUnknown,
  isRetryable,
  type Approval,
} from '@/api/contracts/approvals';

import { approveRequest, rejectRequest, retryExecution } from './actions';
import { Link } from '@/i18n/navigation';

import { MomentAfter } from './MomentAfter';
import styles from './Approvals.module.css';

/**
 * Screen 03 — the queue and the decision.
 *
 * ── THE KEYBOARD MODEL, AND WHY IT IS NOT THE DESIGN'S ──
 * The design specifies `A` as a single keypress that approves. **It was drawn
 * assuming the Undo exists**, and it does not — there is no undo anywhere in
 * this platform. A one-key, no-confirmation, no-undo refund is the most
 * dangerous control in the product.
 *
 * So `A` moves focus to Approve and **Enter commits**. One extra keystroke
 * against an irreversible payment, and the queue keeps its rhythm.
 *
 * **One rule, for every row** — not a carve-out for rows without
 * `IRREVERSIBLE`. A rule that applies sometimes is one nobody can hold in
 * their head, and a queue's whole value is that you stop thinking about the
 * mechanism.
 *
 * `R` focuses the rejection reason rather than rejecting, which is not a
 * safety choice but the contract: the route answers 400 without a reason, so
 * there is nothing for `R` to do except put the cursor where the reason goes.
 *
 * `E` is absent. See `actions.ts` — the permission governing parameter edits
 * is read by nobody, and this is the one control that changes how much money
 * moves.
 *
 * ── WHAT THE LEGEND MAY SAY ──
 * The header legend lists exactly the keys this component honours. It will
 * never advertise a key that does nothing, for the same reason the
 * notifications screen never offers an event nothing raises.
 */

/** Typing a rejection reason must never fire a shortcut. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function ApprovalsScreen({
  pending,
  requesterNames,
  serverNow,
  decidedToday = null,
}: {
  readonly pending: readonly Approval[];
  /** `id → who asked`, resolved server-side so no cuid reaches the browser. */
  readonly requesterNames: Readonly<Record<string, string>>;
  /** Epoch ms from the server, so the first client render matches the server's. */
  readonly serverNow: number;
  /**
   * How many decisions were made today, for 02's "Decided earlier today · 7"
   * row — `null` when the history could not be read, and then no row.
   */
  readonly decidedToday?: number | null;
}) {
  const t = useTranslations('approvals');

  /*
   * Deadlines move, so "lapsed" is time-dependent — and computing a different
   * answer on the client than the server rendered is a hydration mismatch. So
   * the clock STARTS at the server's value, which makes the first client
   * render identical by construction, and a ticker takes over from there.
   *
   * The screen's idea of "now" is therefore up to one tick stale. That is
   * deliberate and safe: the sweeper flipping PENDING to EXPIRED runs on a
   * five-minute cron, so a fifteen-second lag is well inside it — and the
   * route's 409 is the real backstop either way. **This computation decides
   * what to OFFER; it never decides what is permitted.**
   */
  const locale = useLocale();
  const [nowMs, setNowMs] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const now = useMemo(() => new Date(nowMs), [nowMs]);

  const [selectedId, setSelectedId] = useState<string | null>(pending[0]?.id ?? null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  /** What just happened, for the live region. Never a silent outcome. */
  const [announcement, setAnnouncement] = useState('');
  /**
   * Screen 03b. Held until the next decision rather than dismissed on a timer:
   * the interesting case is a decision that did NOT execute, and a panel that
   * fades after four seconds is a panel that hides exactly that.
   */
  const [moment, setMoment] = useState<{
    summary: string;
    dispatched: boolean | undefined;
    dispatchError: string | null | undefined;
    approval: Approval | undefined;
  } | null>(null);

  const approveRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<HTMLUListElement>(null);

  const selected = pending.find((a) => a.id === selectedId) ?? pending[0] ?? null;

  /*
   * ════════════════════════════════════════════════════════════════════════════
   * ★★ DAY SEPARATORS, AND DELIBERATELY NOT PAGINATION
   * ════════════════════════════════════════════════════════════════════════════
   * A browser walk found 28 rows in one unbroken column and reported two things
   * missing: separators and paging. **Only one of them belongs on this screen.**
   *
   * Paging a reference list is kind. Paging a WORK QUEUE hides work: the oldest
   * request is the one that most needs deciding, it sorts to the far end, and
   * putting it behind "show more" means the item nobody has looked at is the
   * item nobody will look at. `expiresAt` is real on these rows — a request that
   * lapses because it was on page two is a defect we would have built.
   *
   * So the list stays whole and gains structure instead: a count at the top, so
   * the size is a fact rather than a scroll bar, and a heading per day, so "this
   * has been sitting here since Tuesday" is legible without reading timestamps.
   *
   * ⚠ The groups are cut in the order the queue already has. Re-sorting by date
   * would fight whatever ranking the server applied and silently reorder a
   * decision queue, which is a worse thing to do than leaving a day split in two.
   */
  const days = useMemo(() => {
    const groups: { key: string; label: string; items: Approval[] }[] = [];
    for (const approval of pending) {
      const key = dayKey(approval.createdAt);
      const last = groups.at(-1);
      if (last?.key === key) last.items.push(approval);
      else
        groups.push({
          key,
          label: dayLabel(approval.createdAt, now, locale, t),
          items: [approval],
        });
    }
    return groups;
  }, [pending, now, locale, t]);
  const decidable = selected !== null && isDecidable(selected, now);

  const move = useCallback(
    (delta: number) => {
      if (pending.length === 0) return;
      const index = pending.findIndex((a) => a.id === selected?.id);
      const next = pending[Math.min(pending.length - 1, Math.max(0, index + delta))];
      if (!next || next.id === selected?.id) return;
      setSelectedId(next.id);
      setReason('');
      // Focus follows selection: the roving tabindex stays coherent and the
      // list, not the page, is what scrolls.
      queueRef.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
    },
    [pending, selected],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never while typing a reason, and never when a modifier is held —
      // Cmd-R must still reload the page.
      if (isTypingTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          break;
        case 'a':
        case 'A':
          // Focuses. Does NOT decide — Enter on the focused button does.
          if (decidable) {
            event.preventDefault();
            approveRef.current?.focus();
          }
          break;
        case 'r':
        case 'R':
          if (decidable) {
            event.preventDefault();
            reasonRef.current?.focus();
          }
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [decidable, move]);

  async function onApprove() {
    if (!selected || busy) return;
    setBusy(true);
    const result = await approveRequest(selected.id);
    setBusy(false);

    if (!result.ok) {
      setAnnouncement(t(`error.${result.reason}` as 'error.stale'));
      return;
    }
    /*
     * A 200 means the DECISION was recorded. Whether the action RAN is
     * `dispatched`, and the two are announced separately because they are
     * separate facts — an approval that was granted and then failed to
     * execute is the case this screen exists for.
     */
    setAnnouncement(
      result.dispatched === false
        ? t('announce.approvedButFailed', { summary: selected.summary })
        : t('announce.approvedAndRan', { summary: selected.summary }),
    );
    setMoment({
      summary: selected.summary,
      dispatched: result.dispatched,
      dispatchError: result.dispatchError,
      approval: result.approval,
    });
    move(1);
  }

  async function onReject() {
    if (!selected || busy) return;
    setBusy(true);
    const result = await rejectRequest(selected.id, reason);
    setBusy(false);

    if (!result.ok) {
      setAnnouncement(t(`error.${result.reason}` as 'error.stale'));
      if (result.reason === 'reason_required') reasonRef.current?.focus();
      return;
    }
    setAnnouncement(t('announce.rejected', { summary: selected.summary }));
    setMoment(null);
    setReason('');
    move(1);
  }

  async function onRetry(id: string) {
    if (busy) return;
    setBusy(true);
    const result = await retryExecution(id);
    setBusy(false);
    setAnnouncement(
      !result.ok
        ? t(`error.${result.reason}` as 'error.stale')
        : result.dispatched
          ? t('announce.retryWorked')
          : t('announce.retryFailedAgain'),
    );
  }

  const showDays = days.length > 1 || days[0]?.key !== dayKey(now.toISOString());

  /** Every tag as words: its label, or — for a value nobody labelled — `humanizeTag`. */
  const riskLabel = (tag: string) =>
    isKnownRiskTag(tag) ? t(`risk.${tag}` as 'risk.IRREVERSIBLE') : humanizeTag(tag);

  /** "2m", "1h", "3d" — 02's row times and deadlines. */
  const short = (ms: number) => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) return t('time.minutes', { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t('time.hours', { n: hours });
    return t('time.days', { n: Math.round(hours / 24) });
  };
  /** A deadline within the hour is said as one, in red — 02's "38m left". */
  const SOON_MS = 60 * 60 * 1000;

  const index = selected ? pending.findIndex((a) => a.id === selected.id) : -1;
  const after = index < 0 ? 0 : pending.length - index - 1;
  /** `09:39`, or null for a date we cannot read — never a thrown render. */
  const clock = (iso: string): string | null => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  };
  /*
   * ⚠⚠ A DEADLINE DAYS AWAY READ AS TODAY. "If nobody decides by 13:02" for
   *   one expiring on Saturday is a time with no day — the history list's
   *   defect again. A time for today, a weekday and time this week, a date
   *   beyond it.
   */
  const dayClock = (iso: string): string | null => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    if (at.toDateString() === now.toDateString()) return clock(iso);
    const days = (at.getTime() - now.getTime()) / 86_400_000;
    const options: Intl.DateTimeFormatOptions =
      days > 0 && days < 6
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
        : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
    return new Intl.DateTimeFormat(locale, options).format(at);
  };
  const createdClock = selected ? clock(selected.createdAt) : null;
  const expiresClock = selected ? dayClock(selected.expiresAt) : null;

  return (
    <div className={styles.screen} data-testid="approvals-screen">
      {/*
        Everything that happens on this screen happens after a keystroke, and
        a queue that advances silently leaves a screen-reader user with no idea
        whether the one action that mattered took effect.
      */}
      <p aria-live="polite" className={styles.liveRegion} data-testid="approvals-announcement">
        {announcement}
      </p>

      <div className={styles.layout}>
        {/*
          ════════════════════════════════════════════════════════════════════
          ★★ 02's QUEUE — `[300]` from the header to the panel's bottom
          ════════════════════════════════════════════════════════════════════
          Rows at `14px 20px`, `#EDE9E1` between them and down the column's
          right edge; the one on screen is white with a 3px `#121212` edge.
          Each: what is asked (13.5px), how long it has waited — or how long
          is left, in red, when the deadline is near — and its risk as a pill.
        */}
        <div className={styles.queueColumn}>
          {/* The size as a fact: in the title for the eye, here for the ear. */}
          <p className="srOnly" data-testid="approval-queue-count">
            {t('queue.waiting', { count: pending.length })}
          </p>

          <ul
            ref={queueRef}
            className={styles.queue}
            data-testid="approval-queue"
            aria-label={t('queue.label')}
          >
            {days.map((day) => (
              <li key={day.key} className={styles.queueDay}>
                {/*
                  No heading when the whole queue is TODAY's — 02's case, and a
                  lone "Today" says nothing. Any other day, or a date we cannot
                  read, is still said: those are what the headings are for.
                */}
                {showDays ? (
                  <h3 className={styles.queueDayLabel} data-testid={`queue-day-${day.key}`}>
                    {day.label}
                  </h3>
                ) : null}
                <ul className={styles.queueDayItems} aria-label={day.label}>
                  {day.items.map((approval) => {
                    const lapsed = decisionStance(approval, now) === 'lapsed';
                    const current = approval.id === selected?.id;
                    const left = Date.parse(approval.expiresAt) - now.getTime();
                    const soon = !lapsed && Number.isFinite(left) && left < SOON_MS;
                    const tag = visibleRiskTags(approval.riskTags)[0];
                    return (
                      <li key={approval.id} className={styles.queueItem}>
                        <button
                          type="button"
                          data-id={approval.id}
                          data-testid={`queue-${approval.id}`}
                          data-lapsed={lapsed ? 'yes' : 'no'}
                          aria-current={current ? 'true' : undefined}
                          tabIndex={current ? 0 : -1}
                          className={styles.queueButton}
                          onClick={() => {
                            setSelectedId(approval.id);
                            setReason('');
                          }}
                        >
                          <span className={styles.queueTop}>
                            <span className={styles.queueSummary}>{approval.summary}</span>
                            <span
                              className={styles.queueWhen}
                              data-soon={soon || lapsed ? '' : undefined}
                            >
                              {lapsed
                                ? t('queue.lapsed')
                                : soon
                                  ? t('time.left', { in: short(left) })
                                  : short(now.getTime() - Date.parse(approval.createdAt))}
                            </span>
                          </span>
                          {requesterNames[approval.id] ? (
                            <span className={styles.queueMeta}>
                              {t('detail.requestedBy', { who: requesterNames[approval.id]! })}
                            </span>
                          ) : null}
                          {tag ? (
                            <span className={styles.queueTag} data-tag={tag}>
                              {riskLabel(tag)}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          {/*
            02's quiet row at the foot of the queue: what was already decided,
            and the way to it — the history this screen keeps (`?view=decided`).
          */}
          {decidedToday === null ? null : (
            <Link
              href={{ pathname: '/approvals', query: { view: 'decided' } }}
              className={styles.decidedLink}
              data-testid="decided-link"
            >
              <span>{decidedToday > 0 ? t('queue.decidedToday') : t('queue.decidedEarlier')}</span>
              {decidedToday > 0 ? <span>{decidedToday}</span> : null}
            </Link>
          )}
        </div>

        {selected ? (
          <section className={styles.detail} data-testid="approval-detail" aria-live="off">
            {moment ? <MomentAfter outcome={moment} onRetry={onRetry} busy={busy} /> : null}

            {/*
              02's head: an eyebrow (who asked, when) and the request at 34px.
              02's right-hand "Reversible · Yes — within 24h" is not drawn:
              there is no undo in this platform, and that sentence would be a
              promise read before an irreversible act. IRREVERSIBLE stays what
              it is — a risk label, in the pills under the title.
            */}
            <header className={styles.detailHeader}>
              <div className={styles.detailHeading}>
                <p className={styles.requestedBy} data-testid="requested-by">
                  {requesterNames[selected.id]
                    ? createdClock
                      ? t('detail2.eyebrow', {
                          who: requesterNames[selected.id]!,
                          time: createdClock,
                        })
                      : t('detail.requestedBy', { who: requesterNames[selected.id]! })
                    : createdClock
                      ? t('detail2.eyebrowAutomation', { time: createdClock })
                      : t('detail.requestedByAutomation')}
                </p>
                <h2 className={styles.detailSummary}>{selected.summary}</h2>
                {visibleRiskTags(selected.riskTags).length > 0 ? (
                  <ul className={styles.riskTags} data-testid="risk-tags">
                    {visibleRiskTags(selected.riskTags).map((tag) => (
                      <li key={tag} className={styles.riskTag} data-testid={`risk-${tag}`}>
                        {/*
                          An unrecognised tag renders as itself rather than
                          vanishing. Hiding a risk label because we have no
                          translation for it is the wrong way round here.
                        */}
                        {riskLabel(tag)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </header>

            {/*
              02's cards, the two this platform can fill: why GOTCHA asks, and
              what happens if nobody decides. "The customer" and "What happens
              if you approve" need a customer summary and a consequence chain
              that nothing records; they are not drawn.
            */}
            <div className={styles.detailCards}>
              {selected.reason || selected.policyRuleName ? (
                <section className={styles.detailCard}>
                  <h3 className={styles.detailCardTitle}>{t('card.why')}</h3>
                  {selected.reason ? (
                    <p className={styles.reason} data-testid="approval-reason">
                      {selected.reason}
                    </p>
                  ) : null}
                  {selected.policyRuleName ? (
                    <p className={styles.policyRule} data-testid="policy-rule">
                      {t('detail.policyRule', { rule: selected.policyRuleName })}
                    </p>
                  ) : null}
                </section>
              ) : null}
              {decidable && expiresClock ? (
                <section className={styles.detailCard} data-testid="if-you-leave-it">
                  <h3 className={styles.detailCardTitle}>{t('card.leave')}</h3>
                  <p className={styles.reason}>{t('card.leaveBody', { when: expiresClock })}</p>
                </section>
              ) : null}
            </div>

            {isOutcomeUnknown(selected) ? (
              <p className={styles.unknownOutcome} data-testid="outcome-unknown">
                {t('detail.outcomeUnknown')}
              </p>
            ) : null}

            {decidable ? (
              <div className={styles.decision}>
                <div className={styles.decisionRow}>
                  <button
                    ref={approveRef}
                    type="button"
                    className={styles.approve}
                    data-testid="approve"
                    disabled={busy}
                    onClick={onApprove}
                  >
                    {t('action.approve')}
                  </button>
                  <button
                    type="button"
                    className={styles.reject}
                    data-testid="reject"
                    disabled={busy}
                    onClick={onReject}
                  >
                    {t('action.reject')}
                  </button>
                  <span className={styles.nextHint} data-testid="next-hint">
                    {t('action2.next', { count: after })}
                  </span>
                </div>

                {/*
                  02's reject bar: the question, and one-tap reasons. A tap
                  FILLS the reason — it does not reject; Reject does. The route
                  answers 400 without a reason, and a reason somebody chose by
                  accident is worse than one they typed.
                */}
                <div className={styles.rejectBar}>
                  <label className={styles.reasonLabel} htmlFor="reject-reason">
                    {t('action2.rejectPrompt')}
                  </label>
                  <input
                    ref={reasonRef}
                    id="reject-reason"
                    className={styles.reasonInput}
                    data-testid="reject-reason"
                    value={reason}
                    placeholder={t('action.rejectReasonLabel')}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  {(['policy', 'myself', 'wrongOrder'] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={styles.reasonChip}
                      data-testid={`reason-${key}`}
                      onClick={() => setReason(t(`action2.reasons.${key}`))}
                    >
                      {t(`action2.reasons.${key}`)}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              /*
                Past its deadline. The route answers 409, so offering a
                decision here would be offering one that cannot be taken —
                and the countdown reaches zero while `status` is still PENDING
                every single time, because the sweeper runs every five minutes.
              */
              <p className={styles.lapsed} data-testid="approval-lapsed">
                {t('detail.lapsed')}
              </p>
            )}

            {isRetryable(selected) ? (
              <button
                type="button"
                className={styles.retry}
                data-testid="retry"
                disabled={busy}
                onClick={() => onRetry(selected.id)}
              >
                {t('action.retry')}
              </button>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Which of the reader's days this timestamp falls on.
 *
 * Local date components on purpose: "which day is this?" is a question about the
 * reader's calendar, and `getFullYear`/`getMonth`/`getDate` answer it in their
 * timezone without an `Intl` round-trip whose output format I would then be
 * parsing.
 *
 * An unparseable date gets its own key rather than being folded into today.
 */
function dayKey(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

/**
 * The heading for a day: "Today", "Yesterday", or the date.
 *
 * ⚠ A date we cannot read says so. Labelling it "Today" would put an old request
 * at the top of today's group and hide exactly the thing these headings exist to
 * surface, and it is the reassuring direction — which is the one to refuse.
 */
function dayLabel(iso: string, now: Date, locale: string, t: (key: string) => string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return t('queue.dayUnknown');

  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((midnight(now) - midnight(at)) / 86_400_000);
  if (daysAgo === 0) return t('queue.today');
  if (daysAgo === 1) return t('queue.yesterday');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at);
}
