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
  type PlanTarget,
} from '@/api/contracts/approvals';

import { approveRequest, askAboutRequest, rejectRequest, retryExecution } from './actions';
import { Link, useRouter } from '@/i18n/navigation';

import type { ApprovalCustomer } from './approval-customers';
import { MomentAfter, type DecidedTrace, type MomentOutcome } from './MomentAfter';
import {
  approveChain,
  editedValueProblem,
  editTarget,
  queueTitle,
  requestTitle,
  reversibilityOf,
  whyBullets,
  type Words,
} from './request-words';
import styles from './Approvals.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';
import { isolated } from './isolate';

/**
 * Screen 03 - the queue and the decision.
 *
 * ── THE KEYBOARD MODEL, AND WHY IT IS NOT THE DESIGN'S ──
 * The design specifies `A` as a single keypress that approves. **It was drawn
 * assuming the Undo exists**, and it does not - there is no undo anywhere in
 * this platform. A one-key, no-confirmation, no-undo refund is the most
 * dangerous control in the product.
 *
 * So `A` moves focus to Approve and **Enter commits**. One extra keystroke
 * against an irreversible payment, and the queue keeps its rhythm.
 *
 * **One rule, for every row** - not a carve-out for rows without
 * `IRREVERSIBLE`. A rule that applies sometimes is one nobody can hold in
 * their head, and a queue's whole value is that you stop thinking about the
 * mechanism.
 *
 * `R` focuses the rejection reason rather than rejecting, which is not a
 * safety choice but the contract: the route answers 400 without a reason, so
 * there is nothing for `R` to do except put the cursor where the reason goes.
 *
 * `E` is absent. See `actions.ts` - the permission governing parameter edits
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

/** Omer, 2026-10-04: the reasons on offer, and "Other" to type one. */
const REJECT_REASONS = ['policy', 'myself', 'wrongOrder', 'tooGenerous', 'other'] as const;
/** A plan the assistant proposed has no order and no amount: Omer's three. */
const PLAN_REJECT_REASONS = ['wrong', 'myself', 'other'] as const;
type RejectReason = (typeof REJECT_REASONS)[number] | (typeof PLAN_REJECT_REASONS)[number];

/** Where a plan step's target opens: its conversation, its customer, the open questions. */
function stepHref(target: PlanTarget) {
  if (target.conversationId)
    return { pathname: '/inbox' as const, query: { c: target.conversationId } };
  if (target.customerId) return `/customers/${target.customerId}`;
  if (target.questionId)
    return { pathname: '/studio/knowledge' as const, query: { section: 'gaps' } };
  return null;
}

export function ApprovalsScreen({
  pending,
  requesterNames,
  serverNow,
  decidedToday = null,
  decidedHistory = [],
  customers = {},
  handledToday = null,
  aiAsked = [],
  decidedTotal = 0,
  editAmountLive = false,
  refundLimit = null,
  initialId,
  viewerId = null,
}: {
  readonly pending: readonly Approval[];
  /** `/approvals?id=` - the request to open on, as a click on its row would. */
  readonly initialId?: string;
  /** `id → who asked`, resolved server-side so no cuid reaches the browser. */
  readonly requesterNames: Readonly<Record<string, string>>;
  /** Epoch ms from the server, so the first client render matches the server's. */
  readonly serverNow: number;
  /**
   * How many decisions were made today, for 02's "Decided earlier today · 7"
   * row - `null` when the history could not be read, and then no row.
   */
  readonly decidedToday?: number | null;
  /** The decided history, enough to count a run of one kind (03b's pattern). */
  readonly decidedHistory?: readonly DecidedTrace[];
  /** 03's "The customer", per request - every fact null where unknown. */
  readonly customers?: Readonly<Record<string, ApprovalCustomer>>;
  /** What GOTCHA ran on its own today, for the queue's foot; `null` unknown. */
  readonly handledToday?: number | null;
  /** Requests an AI asked for whose employee cannot be named. */
  readonly aiAsked?: readonly string[];
  /** Every decision on record, for "Decided earlier · N" on a day with none yet. */
  readonly decidedTotal?: number;
  /** Backend's `edits.amount` is live: Edit amount becomes a field, not a drawing. */
  readonly editAmountLive?: boolean;
  /** "Refunds under N never reach you" - the REFUND policy's threshold, when set. */
  readonly refundLimit?: number | null;
  /** Who is looking - a plan they asked for reads "You asked GOTCHA in Home". */
  readonly viewerId?: string | null;
}) {
  const t = useTranslations('approvals');

  /*
   * Deadlines move, so "lapsed" is time-dependent - and computing a different
   * answer on the client than the server rendered is a hydration mismatch. So
   * the clock STARTS at the server's value, which makes the first client
   * render identical by construction, and a ticker takes over from there.
   *
   * The screen's idea of "now" is therefore up to one tick stale. That is
   * deliberate and safe: the sweeper flipping PENDING to EXPIRED runs on a
   * five-minute cron, so a fifteen-second lag is well inside it - and the
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

  const [selectedId, setSelectedId] = useState<string | null>(
    initialId && pending.some((a) => a.id === initialId) ? initialId : (pending[0]?.id ?? null),
  );
  /*
   * Opened by its address: its row brought into view and focused - the same
   * place a click leaves you. Once, on arrival.
   */
  useEffect(() => {
    if (!initialId) return;
    const row = [...document.querySelectorAll<HTMLElement>('[data-id]')].find(
      (el) => el.dataset.id === initialId,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);
  const [reason, setReason] = useState('');
  /** Omer, 2026-10-04: a closed choice, and "Other" to type one. */
  const [reasonChoice, setReasonChoice] = useState<RejectReason | null>(null);
  const router = useRouter();
  /** Ask: opening a Home thread about one request; a refusal, kept to that request. */
  const [asking, setAsking] = useState(false);
  const [askProblem, setAskProblem] = useState<{ id: string; text: string } | null>(null);
  const onAsk = async (id: string) => {
    setAsking(true);
    setAskProblem(null);
    const result = await askAboutRequest(id);
    if (result.ok) {
      // The thread knows the request; its box waits for the question - nothing is sent.
      router.push({ pathname: '/home', query: { thread: result.threadId } });
      return;
    }
    setAsking(false);
    setAskProblem({ id, text: t(`detail3.askRefused.${result.reason}`) });
  };
  /** The amount being edited, as typed; `null` when approving as asked. */
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What just happened, for the live region. Never a silent outcome. */
  const [announcement, setAnnouncement] = useState('');
  /**
   * Screen 03b. Held until the next decision rather than dismissed on a timer:
   * the interesting case is a decision that did NOT execute, and a panel that
   * fades after four seconds is a panel that hides exactly that.
   */
  const [moment, setMoment] = useState<
    (MomentOutcome & { readonly id: string; readonly requester: string | null }) | null
  >(null);

  const approveRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const firstReasonRef = useRef<HTMLButtonElement>(null);
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
   * item nobody will look at. `expiresAt` is real on these rows - a request that
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
      // Moving on is leaving the moment: the next request takes the pane.
      setMoment(null);
      setSelectedId(next.id);
      setReason('');
      setReasonChoice(null);
      setEdited(null);
      // Focus follows selection: the roving tabindex stays coherent and the
      // list, not the page, is what scrolls.
      queueRef.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
    },
    [pending, selected],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never while typing a reason, and never when a modifier is held -
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
          // After a decision, the first key opens the next one - 03b's "one
          // keystroke away". It decides nothing.
          if (moment) {
            event.preventDefault();
            setMoment(null);
            break;
          }
          // Focuses. Does NOT decide - Enter on the focused button does.
          if (decidable) {
            event.preventDefault();
            approveRef.current?.focus();
          }
          break;
        case 'e':
        case 'E':
          // Opens Edit amount where the platform allows editing; elsewhere nothing.
          if (!moment && decidable && editAmountLive && selected !== null) {
            const target = editTarget(selected);
            if (target?.original != null) {
              event.preventDefault();
              setEdited((current) => current ?? String(target.original));
            }
          }
          break;
        case 'r':
        case 'R':
          if (moment) {
            event.preventDefault();
            setMoment(null);
            break;
          }
          if (decidable) {
            event.preventDefault();
            firstReasonRef.current?.focus();
          }
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [decidable, move, moment, editAmountLive, selected]);

  async function onApprove() {
    if (!selected || busy) return;
    const target = editTarget(selected);
    if (edited !== null && (target === null || target.original === null)) return;
    if (edited !== null && editedValueProblem(edited, target!.original!, target!.unit)) return;
    setBusy(true);
    const value = edited === null ? null : Number(edited.trim().replace(',', '.'));
    const result =
      value === null
        ? await approveRequest(selected.id)
        : await approveRequest(
            selected.id,
            target!.field === 'amount' ? { amount: value } : { percentage: value },
          );
    setBusy(false);

    if (!result.ok) {
      setAnnouncement(t(`error.${result.reason}` as 'error.stale'));
      return;
    }
    /*
     * A 200 means the DECISION was recorded. Whether the action RAN is
     * `dispatched`, and the two are announced separately because they are
     * separate facts - an approval that was granted and then failed to
     * execute is the case this screen exists for.
     */
    setAnnouncement(
      result.dispatched === false
        ? t('announce.approvedButFailed', { summary: selected.summary })
        : t('announce.approvedAndRan', { summary: selected.summary }),
    );
    /*
      03b: the pane becomes the moment, and the next request is selected
      behind it - "already up", one key or "Open it" away. Not `move`, which
      is leaving the moment.
    */
    const index = pending.findIndex((a) => a.id === selected.id);
    const nextUp = pending[index + 1] ?? pending[index - 1] ?? null;
    setMoment({
      id: selected.id,
      requester: requesterNames[selected.id] ?? null,
      summary: selected.summary,
      dispatched: result.dispatched,
      dispatchError: result.dispatchError,
      approval: result.approval,
    });
    if (nextUp) setSelectedId(nextUp.id);
  }

  async function onReject() {
    if (!selected || busy) return;
    setBusy(true);
    const result = await rejectRequest(selected.id, reason);
    setBusy(false);

    if (!result.ok) {
      setAnnouncement(t(`error.${result.reason}` as 'error.stale'));
      if (result.reason === 'reason_required') firstReasonRef.current?.focus();
      return;
    }
    setAnnouncement(t('announce.rejected', { summary: selected.summary }));
    setMoment(null);
    setReason('');
    setReasonChoice(null);
    setEdited(null);
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

  /** Every tag as words: its label, or - for a value nobody labelled - `humanizeTag`. */
  const riskLabel = (tag: string) =>
    isKnownRiskTag(tag) ? t(`risk.${tag}` as 'risk.IRREVERSIBLE') : humanizeTag(tag);

  /** "2m", "1h", "3d" - 02's row times and deadlines. */
  const short = (ms: number) => {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    if (minutes < 60) return t('time.minutes', { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t('time.hours', { n: hours });
    return t('time.days', { n: Math.round(hours / 24) });
  };
  /** A deadline within the hour is said as one, in red - 02's "38m left". */
  const SOON_MS = 60 * 60 * 1000;

  const index = selected ? pending.findIndex((a) => a.id === selected.id) : -1;
  const after = index < 0 ? 0 : pending.length - index - 1;
  /** `09:39`, or null for a date we cannot read - never a thrown render. */
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
   *   one expiring on Saturday is a time with no day - the history list's
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
  /** An amount in its currency when the call named one; never a symbol nobody stated. */
  const amountOf = (approval: Approval): string | null =>
    approval.facts.amount === null
      ? null
      : new Intl.NumberFormat(
          locale,
          approval.facts.currency
            ? { style: 'currency', currency: approval.facts.currency, maximumFractionDigits: 0 }
            : {},
        ).format(approval.facts.amount);
  const reasonText = (key: RejectReason) =>
    key === 'wrong'
      ? t('plan.reasons.wrong')
      : key === 'tooGenerous' || key === 'other'
        ? t(`reject3.${key}`)
        : t(`action2.reasons.${key}`);
  /**
   * Who asked for a plan, and where (ai ccbd75b8): "You asked GOTCHA in
   * Home", "Matan asked GOTCHA in Home" - never "an automation", which is
   * what `requestedBy: user:<id>` read as. Null for anything but a plan.
   */
  const planAsked = (approval: Approval): string | null => {
    const plan = approval.plan;
    if (!plan) return null;
    const where = plan.source ?? 'unknown';
    const asker = plan.requester;
    if (asker && viewerId && asker.userId === viewerId) return t(`plan.asked.you.${where}`);
    if (asker?.name) return t(`plan.asked.other.${where}`, { name: asker.name });
    return t(`plan.asked.someone.${where}`);
  };
  /** "Edit amount", or "Edit discount" on a coupon. */
  const editLabel = (approval: Approval) =>
    editTarget(approval)?.field === 'percentage'
      ? t('detail3.editDiscount')
      : t('detail3.editAmount');
  /** What was asked, as shown: "₪179", or "20%". */
  const originalShown = (approval: Approval) => {
    const target = editTarget(approval);
    return target?.field === 'percentage'
      ? `${new Intl.NumberFormat(locale).format(target.original ?? 0)}%`
      : (amountOf(approval) ?? '');
  };
  const say = (words: Words | null, fallback: string) =>
    words
      ? t(`request.${words.key}` as 'request.queueRefund', isolated(words.values) as never)
      : fallback;
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
          ★★ 02's QUEUE - `[300]` from the header to the panel's bottom
          ════════════════════════════════════════════════════════════════════
          Rows at `14px 20px`, `#EDE9E1` between them and down the column's
          right edge; the one on screen is white with a 3px `#121212` edge.
          Each: what is asked (13.5px), how long it has waited - or how long
          is left, in red, when the deadline is near - and its risk as a pill.
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
            {/*
              03b: the request just decided stays at the head of the queue,
              green, "done" - or "didn't run" when it did not - until you move
              on. It is not a button: it is no longer waiting on you.
            */}
            {moment ? (
              <li className={styles.queueDay}>
                <div
                  className={styles.queueDone}
                  data-testid="queue-done"
                  data-failed={moment.dispatched === false ? '' : undefined}
                >
                  <span className={styles.queueTop}>
                    <span className={styles.queueSummary}>
                      <UserText>{moment.summary}</UserText>
                    </span>
                    <span className={styles.queueWhen} data-done="">
                      {moment.dispatched === false ? t('queue.didntRun') : t('queue.done')}
                    </span>
                  </span>
                  {moment.requester ? (
                    <span className={styles.queueMeta}>
                      {t('detail.requestedBy', { who: moment.requester })}
                    </span>
                  ) : null}
                </div>
              </li>
            ) : null}
            {days.map((day) => (
              <li key={day.key} className={styles.queueDay}>
                {/*
                  No heading when the whole queue is TODAY's - 02's case, and a
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
                    // A plan's tags (ASSISTANT, PLAN) are not risks: where it was asked is.
                    const tag = approval.plan ? undefined : visibleRiskTags(approval.riskTags)[0];
                    const planChip = approval.plan?.source
                      ? t(`plan.chip.${approval.plan.source}`)
                      : null;
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
                            setMoment(null);
                            setSelectedId(approval.id);
                            setReason('');
                            setReasonChoice(null);
                            setEdited(null);
                          }}
                        >
                          <span className={styles.queueTop}>
                            <span className={styles.queueSummary}>
                              {say(queueTitle(approval, amountOf(approval)), approval.summary)}
                            </span>
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
                          {/* 02's second line: for whom, and the order. */}
                          {customers[approval.id]?.name || approval.facts.order ? (
                            <span
                              className={styles.queueMeta}
                              data-testid={`queue-meta-${approval.id}`}
                            >
                              {[
                                customers[approval.id]?.name,
                                approval.facts.order
                                  ? t('request.order', { order: approval.facts.order })
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          ) : null}
                          {tag ? (
                            <span className={styles.queueTag} data-tag={tag}>
                              {riskLabel(tag)}
                            </span>
                          ) : planChip ? (
                            <span
                              className={styles.queueTag}
                              data-tag="plan"
                              data-testid={`queue-plan-${approval.id}`}
                            >
                              {planChip}
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
            and the way to it - the history this screen keeps (`?view=decided`).
          */}
          {decidedToday === null ? null : (
            <Link
              href={{ pathname: '/approvals', query: { view: 'decided' } }}
              className={styles.decidedLink}
              data-testid="decided-link"
            >
              {/* 02: "Decided earlier today · 7"; none today, every decision and how many. */}
              <span>{decidedToday > 0 ? t('queue.decidedToday') : t('queue.decidedEarlier')}</span>
              {decidedToday > 0 ? (
                <span>{decidedToday}</span>
              ) : decidedTotal > 0 ? (
                <span>{decidedTotal}</span>
              ) : null}
            </Link>
          )}
          {/*
            02's foot: what never reaches you, and where to change it. The
            limit itself is not stated - no policy field carries one.
          */}
          <p className={styles.queueFoot} data-testid="queue-foot">
            {refundLimit !== null ? (
              <span>
                {t('queueFoot.under', {
                  limit: new Intl.NumberFormat(locale).format(refundLimit),
                })}{' '}
              </span>
            ) : null}
            {handledToday !== null && handledToday > 0 ? (
              <span>{t('queueFoot.handled', { count: handledToday })} </span>
            ) : handledToday === 0 && refundLimit === null ? (
              <span>{t('queueFoot.handledNone')} </span>
            ) : null}
            <Link href="/studio/capabilities" className={styles.queueFootLink}>
              {t('queueFoot.change')}
            </Link>
          </p>
        </div>

        {moment ? (
          <section className={styles.detail} data-testid="approval-moment" aria-live="off">
            <MomentAfter
              outcome={moment}
              history={decidedHistory}
              now={now}
              next={
                selected && selected.id !== moment.id
                  ? {
                      summary: selected.summary,
                      eyebrow: (() => {
                        const left = Date.parse(selected.expiresAt) - now.getTime();
                        return Number.isFinite(left) && left > 0
                          ? t('moment.next.eyebrowExpires', { in: short(left) })
                          : t('moment.next.eyebrow');
                      })(),
                      line:
                        [
                          planAsked(selected) ??
                            (requesterNames[selected.id]
                              ? t('detail.requestedBy', { who: requesterNames[selected.id]! })
                              : null),
                          clock(selected.createdAt),
                        ]
                          .filter(Boolean)
                          .join(' · ') || null,
                    }
                  : null
              }
              onOpenNext={() => {
                setMoment(null);
                queueRef.current
                  ?.querySelector<HTMLElement>(`[data-id="${selected?.id}"]`)
                  ?.focus();
              }}
              onRetry={onRetry}
              busy={busy}
            />
          </section>
        ) : selected ? (
          <section className={styles.detail} data-testid="approval-detail" aria-live="off">
            {/*
              02's head: an eyebrow (who asked, when) and the request at 34px.
              02's right-hand "Reversible · Yes - within 24h" is not drawn:
              there is no undo in this platform, and that sentence would be a
              promise read before an irreversible act. IRREVERSIBLE stays what
              it is - a risk label, in the pills under the title.
            */}
            <header className={styles.detailHeader}>
              <div className={styles.detailHeading}>
                <p
                  className={styles.requestedBy}
                  data-testid="requested-by"
                  data-plan={selected.plan ? '' : undefined}
                >
                  {planAsked(selected)
                    ? [planAsked(selected), createdClock].filter(Boolean).join(' · ')
                    : requesterNames[selected.id]
                      ? createdClock
                        ? t('detail2.eyebrow', {
                            who: requesterNames[selected.id]!,
                            time: createdClock,
                          })
                        : t('detail.requestedBy', { who: requesterNames[selected.id]! })
                      : createdClock
                        ? aiAsked.includes(selected.id)
                          ? t('detail3.eyebrowAi', { time: createdClock })
                          : t('detail2.eyebrowAutomation', { time: createdClock })
                        : t('detail.requestedByAutomation')}
                </p>
                <h2 className={styles.detailSummary} data-testid="detail-title">
                  {say(
                    requestTitle(
                      selected,
                      customers[selected.id]?.name ?? null,
                      amountOf(selected),
                    ),
                    selected.summary,
                  )}
                </h2>
                {/*
                  02's line under the title: the order and the call's own note.
                  The risk pills are gone from here - the queue's chip says it.
                */}
                {selected.facts.order || selected.facts.note ? (
                  <p className={styles.detailFacts} data-testid="detail-facts">
                    {[
                      selected.facts.order
                        ? t('request.orderLine', { order: selected.facts.order })
                        : null,
                      selected.facts.note,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
              </div>
              {/* 02's top right - by what the action is; nothing where unknown. No Undo. */}
              {reversibilityOf(selected.tool) ? (
                <p className={styles.reversible} data-testid="reversible">
                  <span>{t('detail3.reversible')}</span>
                  <strong>
                    {reversibilityOf(selected.tool) === 'yes'
                      ? t('detail3.reversibleYes')
                      : t('detail3.reversibleNo')}
                  </strong>
                </p>
              ) : null}
            </header>

            {/*
              02's four cards in two rows: why, the customer, what approving
              does, and what waiting costs. Each fact the platform does not
              hold is "-", never a guess.
            */}
            <div className={styles.detailCards}>
              {/*
                A plan's `reason` and rule name are both "Matan asked GOTCHA in
                Home" - the eyebrow says it; twice more read as a duplicate.
              */}
              {!selected.plan && (selected.reason || selected.policyRuleName) ? (
                <section className={styles.detailCard}>
                  <h3 className={styles.detailCardTitle}>{t('card.why')}</h3>
                  {selected.reason ? (
                    <ul className={styles.whyList} data-testid="approval-reason">
                      {whyBullets(selected.reason).map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                  {selected.policyRuleName ? (
                    <p className={styles.policyRule} data-testid="policy-rule">
                      {t('detail.policyRule', { rule: selected.policyRuleName })}
                    </p>
                  ) : null}
                </section>
              ) : null}
              {(() => {
                const who = customers[selected.id];
                const dash = (value: string | null) =>
                  value ?? (
                    <span title={t('customer.unread')} data-dash="">
                      -
                    </span>
                  );
                /*
                  A plan names its customer only through `contactId`, which an
                  assignment plan does not carry yet (gap with Backend): no
                  card of dashes about nobody - none, until it does.
                */
                if (selected.plan && !selected.contactId) return null;
                return (
                  <section className={styles.detailCard} data-testid="customer-card">
                    <h3 className={styles.detailCardTitle}>{t('customer.title')}</h3>
                    <dl className={styles.customerFacts}>
                      <div>
                        <dt>{t('customer.since')}</dt>
                        <dd data-testid="customer-since">
                          {dash(
                            who?.since
                              ? new Intl.DateTimeFormat(locale, {
                                  month: 'long',
                                  year: 'numeric',
                                }).format(new Date(who.since))
                              : null,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('customer.orders')}</dt>
                        <dd data-testid="customer-orders">
                          {dash(
                            who?.lifetime
                              ? t('customer.lifetime', {
                                  amount: new Intl.NumberFormat(locale, {
                                    style: 'currency',
                                    currency: who.lifetime.currency,
                                    maximumFractionDigits: 0,
                                  }).format(who.lifetime.amount),
                                })
                              : null,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('customer.refunds')}</dt>
                        <dd data-testid="customer-refunds">
                          {dash(
                            who?.refunds == null
                              ? null
                              : who.refunds === 0
                                ? t('customer.refundsNone')
                                : String(who.refunds),
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('customer.mood')}</dt>
                        <dd data-testid="customer-mood">{dash(who?.mood ?? null)}</dd>
                      </div>
                    </dl>
                  </section>
                );
              })()}
              <section className={styles.detailCard} data-testid="approve-chain">
                <h3 className={styles.detailCardTitle}>{t('chain.title')}</h3>
                {selected.plan ? (
                  // A plan: each step's own sentence, linked to what it acts on.
                  selected.plan.steps.length === 0 ? (
                    <p className={styles.reason}>{t('plan.noSteps')}</p>
                  ) : (
                    <ol className={styles.planSteps} data-testid="plan-steps">
                      {selected.plan.steps.map((step, i) => {
                        const href = stepHref(step.target);
                        return (
                          <li key={i} dir="auto" data-testid={`plan-step-${i}`}>
                            {href ? (
                              <Link href={href} className={styles.planStepLink}>
                                {step.summary}
                              </Link>
                            ) : (
                              step.summary
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  )
                ) : (
                  <ol className={styles.chain}>
                    {approveChain(
                      selected,
                      customers[selected.id]?.name ?? null,
                      amountOf(selected),
                    ).map((step, i) => [
                      i > 0 ? (
                        <li key={`arrow-${i}`} className={styles.chainArrow} aria-hidden="true">
                          →
                        </li>
                      ) : null,
                      <li key={step.key + i} className={styles.chainStep}>
                        {say(step, '')}
                      </li>,
                    ])}
                  </ol>
                )}
              </section>
              {decidable && expiresClock ? (
                <section className={styles.detailCard} data-testid="if-you-leave-it">
                  <h3 className={styles.detailCardTitle}>{t('card.leave')}</h3>
                  <p className={styles.reason}>
                    {selected.plan
                      ? t('plan.leaveBody', { when: expiresClock })
                      : t('card.leaveBody', { when: expiresClock })}
                  </p>
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
                    <kbd className={styles.key} aria-hidden="true">
                      A
                    </kbd>
                  </button>
                  {/*
                    02's "Edit amount" - or "Edit discount" on a coupon - only
                    on the tools the platform lets an approver edit (backend
                    05979604, f16a5afa). Nothing to edit (a full refund): drawn,
                    with why. Any other tool: not drawn.
                  */}
                  {editTarget(selected) === null ? null : editTarget(selected)!.original ===
                    null ? (
                    <span
                      className={styles.secondary}
                      aria-disabled="true"
                      title={t(`error.edit_requires_original_${editTarget(selected)!.field}`)}
                      data-testid="edit-amount"
                    >
                      {editLabel(selected)}
                    </span>
                  ) : editAmountLive ? (
                    <button
                      type="button"
                      className={styles.secondary}
                      aria-expanded={edited !== null}
                      data-testid="edit-amount"
                      onClick={() =>
                        setEdited(edited === null ? String(editTarget(selected)!.original) : null)
                      }
                    >
                      {edited === null
                        ? editLabel(selected)
                        : t('detail3.editCancel', { amount: originalShown(selected) })}
                    </button>
                  ) : (
                    <span
                      className={styles.secondary}
                      aria-disabled="true"
                      title={t('detail3.editNotYet')}
                      data-testid="edit-amount"
                    >
                      {editLabel(selected)}
                    </span>
                  )}
                  {/*
                    03's Ask (ai 9a86bfac): a Home thread about this request.
                    GOTCHA answers there - not the employee that asked - and
                    can explain the request, never decide it.
                  */}
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={asking || busy}
                    data-testid="ask-ai"
                    onClick={() => void onAsk(selected.id)}
                  >
                    {asking ? t('detail3.asking') : t('detail3.askGotcha')}
                  </button>
                  <button
                    type="button"
                    className={styles.reject}
                    data-testid="reject"
                    disabled={busy || reason.trim() === ''}
                    onClick={onReject}
                  >
                    {t('action.reject')}
                  </button>
                  <span className={styles.nextHint} data-testid="next-hint">
                    {t('action2.next', { count: after })}
                  </span>
                </div>

                {askProblem?.id === selected.id ? (
                  <p className={styles.askProblem} role="alert" data-testid="ask-problem">
                    {askProblem.text}
                  </p>
                ) : null}

                {editAmountLive && edited !== null && editTarget(selected)?.original != null
                  ? (() => {
                      const target = editTarget(selected)!;
                      const problem = editedValueProblem(edited, target.original!, target.unit);
                      return (
                        <label className={styles.editRow}>
                          <span className={styles.reasonLabel}>
                            {target.field === 'amount'
                              ? t('detail3.editLabel')
                              : t('detail3.editLabelPercent')}
                          </span>
                          <input
                            className={styles.reasonInput}
                            inputMode="decimal"
                            value={edited}
                            aria-invalid={problem !== null}
                            data-testid="edit-amount-input"
                            onChange={(event) => setEdited(event.target.value)}
                          />
                          {problem ? (
                            <span
                              className={styles.editProblem}
                              role="alert"
                              data-testid="edit-problem"
                            >
                              {problem === 'over'
                                ? t('detail3.editOver', { amount: originalShown(selected) })
                                : t(
                                    target.unit === 'minor'
                                      ? 'detail3.editInvalidMinor'
                                      : target.unit === 'percent'
                                        ? 'detail3.editInvalidPercent'
                                        : 'detail3.editInvalid',
                                  )}
                            </span>
                          ) : null}
                        </label>
                      );
                    })()
                  : null}

                {/*
                  02's reject bar, as Omer ruled: a closed choice, and "Other"
                  to type one. A tap CHOOSES the reason - Reject rejects. The
                  route answers 400 without one, so Reject waits for it.
                */}
                <div className={styles.rejectBar} role="group" aria-labelledby="reject-prompt">
                  <span className={styles.reasonLabel} id="reject-prompt">
                    {t('reject3.prompt')}
                  </span>
                  {(selected.plan ? PLAN_REJECT_REASONS : REJECT_REASONS).map((key, i) => (
                    <button
                      key={key}
                      ref={i === 0 ? firstReasonRef : undefined}
                      type="button"
                      className={styles.reasonChip}
                      aria-pressed={reasonChoice === key}
                      data-testid={`reason-${key}`}
                      onClick={() => {
                        setReasonChoice(key);
                        setReason(key === 'other' ? '' : reasonText(key));
                        if (key === 'other') setTimeout(() => reasonRef.current?.focus(), 0);
                      }}
                    >
                      {reasonText(key)}
                    </button>
                  ))}
                  {reasonChoice === 'other' ? (
                    <input
                      ref={reasonRef}
                      className={styles.reasonInput}
                      data-testid="reject-reason"
                      aria-label={t('reject3.otherLabel')}
                      value={reason}
                      placeholder={t('reject3.otherLabel')}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  ) : null}
                </div>
              </div>
            ) : (
              /*
                Past its deadline. The route answers 409, so offering a
                decision here would be offering one that cannot be taken -
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
 * surface, and it is the reassuring direction - which is the one to refuse.
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
