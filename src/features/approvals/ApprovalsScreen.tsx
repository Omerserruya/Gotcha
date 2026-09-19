'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  decisionStance,
  isDecidable,
  isKnownRiskTag,
  isOutcomeUnknown,
  isRetryable,
  type Approval,
} from '@/api/contracts/approvals';

import { approveRequest, rejectRequest, retryExecution } from './actions';
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
}: {
  readonly pending: readonly Approval[];
  /** `id → who asked`, resolved server-side so no cuid reaches the browser. */
  readonly requesterNames: Readonly<Record<string, string>>;
  /** Epoch ms from the server, so the first client render matches the server's. */
  readonly serverNow: number;
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

  const approveRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const queueRef = useRef<HTMLUListElement>(null);

  const selected = pending.find((a) => a.id === selectedId) ?? pending[0] ?? null;
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
        <ul
          ref={queueRef}
          className={styles.queue}
          data-testid="approval-queue"
          aria-label={t('queue.label')}
        >
          {pending.map((approval) => {
            const lapsed = decisionStance(approval, now) === 'lapsed';
            const current = approval.id === selected?.id;
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
                  <span className={styles.queueSummary}>{approval.summary}</span>
                  <span className={styles.queueMeta}>
                    {lapsed ? t('queue.lapsed') : t('queue.awaiting')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {selected ? (
          <section className={styles.detail} data-testid="approval-detail" aria-live="off">
            <header className={styles.detailHeader}>
              <p className={styles.requestedBy} data-testid="requested-by">
                {requesterNames[selected.id]
                  ? t('detail.requestedBy', { who: requesterNames[selected.id]! })
                  : t('detail.requestedByAutomation')}
              </p>
              <h2 className={styles.detailSummary}>{selected.summary}</h2>
              {/*
                No "Reversible · within 24h" here, and no reversal window
                anywhere on this screen. There is no undo in this platform, and
                that sentence is read BEFORE the irreversible act — it would
                make someone approve a refund they would otherwise question.
                `IRREVERSIBLE` is shown for what it is: a risk label.
              */}
              {selected.riskTags.length > 0 ? (
                <ul className={styles.riskTags} data-testid="risk-tags">
                  {selected.riskTags.map((tag) => (
                    <li key={tag} className={styles.riskTag} data-testid={`risk-${tag}`}>
                      {/*
                        An unrecognised tag renders as itself rather than
                        vanishing. Hiding a risk label because we have no
                        translation for it is the wrong way round here.
                      */}
                      {isKnownRiskTag(tag) ? t(`risk.${tag}` as 'risk.IRREVERSIBLE') : tag}
                    </li>
                  ))}
                </ul>
              ) : null}
            </header>

            {selected.reason ? (
              <p className={styles.reason} data-testid="approval-reason">
                {t('detail.reason', { reason: selected.reason })}
              </p>
            ) : null}

            {selected.policyRuleName ? (
              <p className={styles.policyRule} data-testid="policy-rule">
                {t('detail.policyRule', { rule: selected.policyRuleName })}
              </p>
            ) : null}

            {isOutcomeUnknown(selected) ? (
              <p className={styles.unknownOutcome} data-testid="outcome-unknown">
                {t('detail.outcomeUnknown')}
              </p>
            ) : null}

            {decidable ? (
              <div className={styles.decision}>
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

                <div className={styles.rejectGroup}>
                  <label className={styles.reasonLabel} htmlFor="reject-reason">
                    {t('action.rejectReasonLabel')}
                  </label>
                  <input
                    ref={reasonRef}
                    id="reject-reason"
                    className={styles.reasonInput}
                    data-testid="reject-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.reject}
                    data-testid="reject"
                    disabled={busy}
                    onClick={onReject}
                  >
                    {t('action.reject')}
                  </button>
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
