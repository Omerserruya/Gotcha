'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { TranscriptLine } from '@/api/contracts/calls';
import { useRealtimeEvent } from '@/realtime/realtime-provider';

import styles from './Calls.module.css';

/**
 * Screen 05e — a live call.
 *
 * ── WHAT IS REAL HERE ──
 * The transcript, with speaker separation, is genuinely live: the stream
 * router publishes every **final** utterance and persists it as a `Message`
 * row at the same time, so what is on screen during the call is what remains
 * afterwards. Transfer and End are real routes. Copilot suggestions are real
 * and arrive on `voice.copilot.suggestions`.
 *
 * ── WHAT IS ABSENT, AND THE FIRST ONE MATTERS MOST ──
 * **Mute.** The design puts it in the call header beside Transfer and End.
 * Nothing in the platform implements it — searched across every service, not
 * one. **A dead button in a live call is the "Pause the rest" class**: it
 * exists, it looks operative, and the failure is silent while somebody is
 * speaking. So it is absent rather than greyed.
 *
 * **Translation.** *"Hebrew · translating as she speaks"* has nothing behind
 * it anywhere.
 *
 * **The inline extracted chips** (*"Refund asked for"*, *"Gift · date
 * passed"*) — there is no live intent extraction.
 *
 * **In-call approval routing.** Nothing on the voice path creates an
 * `ApprovalRequest`.
 *
 * ── SCOPING ──
 * Every realtime frame is filtered to this conversation. The tenant-broadcast
 * leak was fixed server-side (D53), so this filter is **defence in depth and
 * not the protection** — if it were the protection, the data would still be
 * arriving in every other agent's browser.
 */
export function LiveCall({
  conversationId,
  customerNumber,
  initialTranscript,
}: {
  readonly conversationId: string;
  readonly customerNumber: string;
  /** Lines already persisted, so a reload mid-call does not start blank. */
  readonly initialTranscript: readonly TranscriptLine[];
}) {
  const t = useTranslations('calls');

  const [live, setLive] = useState<
    readonly { seq: number; speaker: 'agent' | 'customer'; text: string }[]
  >([]);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [ended, setEnded] = useState(false);

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
            { seq: event.seq, speaker: event.speaker, text: event.text },
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
      })),
      ...live,
    ],
    [initialTranscript, live],
  );

  return (
    <section className={styles.liveCall} data-testid="live-call" data-ended={ended ? 'yes' : 'no'}>
      <header className={styles.liveHead}>
        <p className={styles.liveWho}>{customerNumber}</p>
        <p className={styles.liveState} data-testid="live-state">
          {ended ? t('live.ended') : t('live.onCall')}
        </p>

        {/*
          Two controls, not three. Mute is absent rather than disabled: a
          greyed button still says one exists, and on a live call the failure
          would be silent while somebody is talking.
        */}
        <div className={styles.liveActions}>
          <button
            type="button"
            className={styles.liveAction}
            data-testid="transfer"
            disabled={ended}
          >
            {t('live.transfer')}
          </button>
          <button type="button" className={styles.liveEnd} data-testid="end-call" disabled={ended}>
            {t('live.end')}
          </button>
        </div>
      </header>

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
                <span className={styles.speaker}>
                  {line.speaker === 'agent' ? t('live.you') : t('live.them')}
                </span>
                <span className={styles.said}>{line.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/*
        Suggestions, from the legacy channel — see `events.ts`. Rendered as
        suggestions and never auto-sent: the design shows them as something to
        say, and there is no route that would speak on an agent's behalf.
      */}
      {suggestions.length > 0 ? (
        <aside className={styles.suggestions} data-testid="suggestions">
          <p className={styles.suggestionsLead}>{t('live.suggestions')}</p>
          <ul className={styles.suggestionList}>
            {suggestions.map((suggestion) => (
              <li key={suggestion} className={styles.suggestion}>
                {suggestion}
              </li>
            ))}
          </ul>
        </aside>
      ) : null}
    </section>
  );
}
