'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Button } from '@/design-system/primitives/button/Button';

import { sendReply, type SendResult } from './send-actions';
import styles from './Inbox.module.css';

/**
 * The reply box — screen 02's last missing part.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE ONLY CONTROL HERE WHOSE PURPOSE IS TO BE PRESSED
 * ════════════════════════════════════════════════════════════════════════════
 * Every other write in this project is something somebody might press. A
 * composer is something somebody **will** press, by design, and on the dev
 * tenant the first person to press it is one of us during a walk. Dev's WhatsApp
 * channel reaches real handsets and this platform has no undo anywhere.
 *
 * No automated run presses it. No human presses it on dev until Omer says so.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ IT NEVER SAYS "SENT"
 * ════════════════════════════════════════════════════════════════════════════
 * The route writes a row and enqueues it; delivery happens later through a path
 * the response cannot see. So the strongest true word is **queued**, and the
 * message itself reports the rest from the stream, where its `status` runs
 * `PENDING → SENT → DELIVERED` or lands on `FAILED`.
 *
 * The button says what pressing it does, in the present tense of an outward
 * action — not "Save", not "OK". A control that sends a stranger a message
 * should read like one.
 *
 * ── NO ENTER-TO-SEND, AND THE REASON IS THE SAME AS ON APPROVALS ──
 * The approvals screen refuses a one-keypress irreversible action because there
 * is no undo. The same argument applies here and more so: Enter is the key a
 * person presses to start a new line. Enter makes a newline; the button sends.
 *
 * ── AND NO OPTIMISTIC ECHO ──
 * The reply does not appear in the stream until the server has it and the page
 * has re-read. An optimistic bubble is a message on screen that may not exist
 * anywhere else, which is the same lie as "Sent" in a different costume.
 */
export function Composer({
  conversationId,
  channelName,
}: {
  readonly conversationId: string;
  /** Already-named channel, for the sentence about where this goes. */
  readonly channelName: string | null;
}) {
  const t = useTranslations('inbox.composer');
  const [text, setText] = useState('');
  const [result, setResult] = useState<SendResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const empty = text.trim() === '';

  return (
    <form
      className={styles.composer}
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || isPending) return;
        startTransition(async () => {
          const outcome = await sendReply(conversationId, text);
          setResult(outcome);
          /*
           * Cleared only on success. A failed send that empties the box loses
           * somebody's words and gives them nothing to retry with — and the
           * commonest failure here is recoverable.
           */
          if (outcome.ok) setText('');
        });
      }}
    >
      <label className={styles.composerLabel} htmlFor="composer-body">
        {/*
          Where this goes, named. An agent with four conversations open should not
          have to infer the channel from the thread above.
        */}
        {channelName ? t('labelOn', { channel: channelName }) : t('label')}
      </label>

      <textarea
        id="composer-body"
        className={styles.composerInput}
        data-testid="composer-body"
        value={text}
        rows={3}
        disabled={isPending}
        placeholder={t('placeholder')}
        onChange={(event) => setText(event.target.value)}
      />

      <div className={styles.composerActions}>
        {/*
          Disabled on empty rather than sending and being refused: the route
          answers 400 for an empty body, and a round trip to be told what the
          screen already knew is worse than a control that says it is not ready.
        */}
        <Button
          type="submit"
          data-testid="composer-send"
          disabled={empty || isPending}
          variant="primary"
        >
          {isPending ? t('sending') : t('send')}
        </Button>

        {/*
          ★★ "QUEUED", AND IT IS NOT A HEDGE. The route enqueued a row. Saying
          "sent" would be a claim about a phone we have heard nothing from, and
          the operator who believes it stops watching the one message that failed.
        */}
        {result?.ok ? (
          <p className={styles.composerNote} data-testid="composer-queued">
            {t('queued')}
          </p>
        ) : null}

        {result && !result.ok ? (
          <p className={styles.composerProblem} data-testid="composer-problem">
            {result.reason === 'channel_not_configured'
              ? /*
                 * Not "try again". The conversation arrived on a channel whose
                 * credentials have since been removed, and nothing about the
                 * message is at fault — so the sentence points at the channel.
                 */
                t('error.channelGone')
              : result.reason === 'not_found'
                ? t('error.gone')
                : result.reason === 'empty'
                  ? t('error.empty')
                  : t('error.failed')}
          </p>
        ) : null}
      </div>
    </form>
  );
}
