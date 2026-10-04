'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import type { TranscriptLine } from '@/api/contracts/calls';
import { displayHandle } from '@/features/customers/phone';
import { Link } from '@/i18n/navigation';
import { useRealtimeEvent } from '@/realtime/realtime-provider';

import { endCall } from './actions';
import styles from './Calls.module.css';
import { TransferPanel } from './TransferPanel';

/**
 * Screen 05e — on a call. Measured.
 *
 * The call's own header (a 44px disc, the person at 18/600, "On the call ·
 * 1:24", who called whom), then the live transcript (818) beside Copilot in
 * the dark (400): what it found, what to say, what to do, and a box to ask.
 *
 * ── WHAT IS LIVE ──
 *   the transcript    `call.transcript`, ordered by `seq`; persisted lines
 *                     first, so a reload mid-call is not blank
 *   "Say this"        `call.suggestions` — things to say, never sent: there
 *                     is no route that speaks on an agent's behalf
 *   the clock         from the call's start, counted here
 *
 * ── DRAWN AND NOT LIVE, AND WHY ──
 *   Transfer, End call   the buttons here were live-looking and did nothing.
 *                        Hanging up or moving a customer's live call waits on
 *                        Omer, like Send; until then they say so.
 *   What it found,       nothing retrieves context during a call yet
 *   Do this now,
 *   Careful, Ask Copilot
 *   stop                 nothing pauses Copilot on a call
 *
 * ── NOT DRAWN, BY STANDING RULINGS (their tests guard them) ──
 *   Mute — nothing implements it, and on a live call a control that fails
 *   fails silently while somebody talks. Translation, inline intent chips,
 *   in-call approval — none exists on the voice path; nothing claims them.
 */
export function LiveCall({
  sessionId,
  conversationId,
  customerNumber,
  initialTranscript,
  contactName = null,
  customerId = null,
  direction = null,
  startedAt = null,
}: {
  /** The voice session: what End call and Transfer act on. */
  readonly sessionId: string;
  readonly conversationId: string;
  readonly customerNumber: string;
  readonly initialTranscript: readonly TranscriptLine[];
  readonly contactName?: string | null;
  /** The contact, when the call was matched to one — for "Add a note". */
  readonly customerId?: string | null;
  readonly direction?: string | null;
  /** When the call started, for the clock and each line's time. */
  readonly startedAt?: string | null;
}) {
  const t = useTranslations('calls');

  const [live, setLive] = useState<
    readonly { seq: number; speaker: 'agent' | 'customer'; text: string; at: number | null }[]
  >([]);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [ended, setEnded] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [endProblem, setEndProblem] = useState<string | null>(null);
  const [isEnding, startEnding] = useTransition();
  /*
    The clock runs only after mount: the server's "now" and the browser's
    differ, and a time computed on both is a hydration mismatch.
  */
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    // The first reading in a callback too: state set in a callback, not the effect body.
    const first = setTimeout(tick, 0);
    const timer = ended ? null : setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, [ended]);

  useRealtimeEvent(
    'call.transcript',
    useCallback(
      (event) => {
        if (event.type !== 'call.transcript') return;
        if (event.conversationId !== conversationId) return;
        setLive((lines) =>
          // `seq` rather than arrival order: the stream reassembles
          // out-of-order fragments upstream and nothing guarantees the socket
          // preserves that. A duplicate seq replaces rather than repeats.
          [
            ...lines.filter((l) => l.seq !== event.seq),
            { seq: event.seq, speaker: event.speaker, text: event.text, at: event.at ?? null },
          ].sort((a, b) => a.seq - b.seq),
        );
      },
      [conversationId],
    ),
  );

  useRealtimeEvent(
    'call.suggestions',
    useCallback(
      (event) => {
        if (event.type !== 'call.suggestions') return;
        if (event.conversationId !== conversationId) return;
        setSuggestions(event.suggestions);
      },
      [conversationId],
    ),
  );

  useRealtimeEvent(
    'call.ended',
    useCallback(
      (event) => {
        if (event.type !== 'call.ended') return;
        if (event.conversationId !== conversationId) return;
        setEnded(true);
      },
      [conversationId],
    ),
  );

  const lines = useMemo(
    () => [
      ...initialTranscript.map((l, i) => ({
        seq: -initialTranscript.length + i,
        speaker: (l.senderName === 'Agent' ? 'agent' : 'customer') as 'agent' | 'customer',
        text: l.body,
        at: l.createdAt ? Date.parse(l.createdAt) : null,
      })),
      ...live,
    ],
    [initialTranscript, live],
  );

  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  /** "1:24" from the call's start; null when either end is unknown. */
  const since = (at: number | null): string | null => {
    if (at === null || !Number.isFinite(start) || at < start) return null;
    const seconds = Math.floor((at - start) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const who = contactName ?? displayHandle('VOICE', customerNumber);
  const initials =
    (contactName ?? '')
      .split(/\s+/)
      .filter((word) => /\p{L}/u.test(word))
      .slice(0, 2)
      .map((word) => word.match(/\p{L}/u)?.[0]?.toUpperCase() ?? '')
      .join('') || '#';
  // 02's lines say "Dana", the header "Dana Cohen".
  const firstName = contactName?.trim().split(/\s+/)[0] || null;
  const elapsed = now === null ? null : since(now);

  return (
    <section className={styles.liveCall} data-testid="live-call" data-ended={ended ? 'yes' : 'no'}>
      <header className={styles.liveHead}>
        <span className={styles.liveDisc} aria-hidden="true">
          {initials}
        </span>
        <span className={styles.liveWhoBlock}>
          <span className={styles.liveTop}>
            <span className={styles.liveWho}>{who}</span>
            <span
              className={styles.liveState}
              data-testid="live-state"
              data-ended={ended ? '' : undefined}
            >
              {ended ? t('live.ended') : t('live.onCall')}
              {!ended && elapsed ? ` · ${elapsed}` : null}
            </span>
          </span>
          <span className={styles.liveLine}>
            {[
              displayHandle('VOICE', customerNumber),
              direction === 'inbound'
                ? t('live.theyCalled')
                : direction === 'outbound'
                  ? t('live.youCalled')
                  : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>

        {/*
          05e: Transfer and End call — live (Omer, 2026-10-04), the old app's
          calls. Mute is absent rather than disabled (its ruling).
        */}
        <div className={styles.liveActions}>
          <button
            type="button"
            className={styles.liveAction}
            data-testid="transfer"
            aria-expanded={transferring}
            disabled={ended}
            onClick={() => setTransferring(!transferring)}
          >
            {t('live.transfer')}
          </button>
          <button
            type="button"
            className={styles.liveEnd}
            data-testid="end-call"
            disabled={ended || isEnding}
            onClick={() => {
              setEndProblem(null);
              startEnding(async () => {
                const result = await endCall(sessionId);
                if (result.ok) setEnded(true);
                else setEndProblem(t('live.endFailed'));
              });
            }}
          >
            {t('live.end')}
          </button>
        </div>
      </header>
      {endProblem ? (
        <p className={styles.transferProblem} role="alert" data-testid="end-problem">
          {endProblem}
        </p>
      ) : null}
      {transferring && !ended ? <TransferPanel sessionId={sessionId} who={who} /> : null}

      <div className={styles.liveBody}>
        <div className={styles.liveMain}>
          <div className={styles.liveMainHead}>
            <h2 className={styles.liveTitle}>{t('live.transcript')}</h2>
            <span
              className={styles.liveWave}
              aria-hidden="true"
              data-ended={ended ? '' : undefined}
            >
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} />
              ))}
            </span>
          </div>

          <div className={styles.transcript} data-testid="transcript">
            {lines.length === 0 ? (
              <p className={styles.transcriptWaiting} data-testid="transcript-waiting">
                {t('live.listening')}
              </p>
            ) : (
              <ol className={styles.transcriptLines}>
                {lines.map((line) => (
                  <li
                    key={line.seq}
                    className={styles.transcriptLine}
                    data-speaker={line.speaker}
                    data-testid={`line-${line.seq}`}
                  >
                    <span className={styles.lineTime}>{since(line.at) ?? ''}</span>
                    <span className={styles.lineBody}>
                      <span className={styles.speaker}>
                        {line.speaker === 'agent' ? t('live.you') : (firstName ?? t('live.them'))}
                      </span>
                      <span className={styles.said}>{line.text}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <footer className={styles.liveFoot}>
            <span>{t('live.kept')}</span>
            {customerId ? (
              <Link
                href={{ pathname: `/customers/${customerId}`, query: { tab: 'notes' } }}
                className={styles.liveNote}
                data-testid="live-note"
              >
                {t('live.addNote')}
              </Link>
            ) : (
              <span className={styles.liveNote} aria-disabled="true">
                {t('live.addNote')}
              </span>
            )}
          </footer>
        </div>

        <aside className={styles.copilot} aria-label={t('live.copilot')}>
          <header className={styles.copilotHead}>
            <span
              className={styles.copilotDot}
              data-ended={ended ? '' : undefined}
              aria-hidden="true"
            />
            <span>{ended ? t('live.copilot') : t('live.copilotListening')}</span>
            {/* 02's "stop": nothing pauses Copilot on a call, so it says so. */}
            <button
              type="button"
              className={styles.copilotStop}
              data-testid="copilot-stop"
              disabled
              title={t('live.notYet')}
            >
              {t('live.stop')}
            </button>
          </header>

          <section className={styles.copilotBlock} data-testid="copilot-found">
            <p className={styles.copilotEyebrow}>{t('live.found')}</p>
            <p className={styles.copilotNone}>{t('live.foundNone')}</p>
          </section>

          {/*
            Suggestions, from the legacy channel — see `events.ts`. Things to
            say, never sent: there is no route that speaks for an agent.
          */}
          <section className={styles.copilotBlock} data-testid="suggestions-block">
            <p className={styles.copilotTitle}>{t('live.sayThis')}</p>
            {suggestions.length > 0 ? (
              <div className={styles.sayCard} data-testid="suggestions">
                <p className={styles.sayLead}>{t('live.suggestions')}</p>
                <ul className={styles.suggestionList}>
                  {suggestions.map((suggestion) => (
                    <li key={suggestion} className={styles.suggestion}>
                      {suggestion}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className={styles.copilotNone}>{t('live.sayNone')}</p>
            )}
          </section>

          <section className={styles.copilotBlock} data-testid="copilot-do">
            <p className={styles.copilotTitle}>{t('live.doNow')}</p>
            <p className={styles.copilotNone}>{t('live.doNone')}</p>
          </section>

          <div className={styles.copilotAsk}>
            {/* 02's "Careful" card — drawn in its shape: nothing produces a warning yet. */}
            <section className={styles.carefulCard} data-testid="copilot-careful">
              <p className={styles.carefulTitle}>{t('live.careful')}</p>
              <p className={styles.carefulBody}>{t('live.carefulNone')}</p>
            </section>
            <label className="srOnly" htmlFor="copilot-ask">
              {t('live.ask')}
            </label>
            <input
              id="copilot-ask"
              className={styles.copilotInput}
              placeholder={t('live.ask')}
              disabled
              title={t('live.notYet')}
            />
          </div>
        </aside>
      </div>
    </section>
  );
}
