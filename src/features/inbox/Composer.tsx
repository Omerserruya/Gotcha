'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ArrowUp, Image as ImageIcon, Paperclip, X } from 'lucide-react';

import { composeDraft, type ComposeResult } from './compose-actions';
import {
  FILL_COMPOSER_EVENT,
  REPLY_TO_EVENT,
  type ComposerFill,
  type ReplyTarget,
} from './reply-event';
import { COMPOSE_KINDS, type ComposeKind } from './compose-kinds';
import { sendReply, type SendResult } from './send-actions';
import { MAX_MEDIA_BYTES, sendMedia, type MediaResult } from './send-media';

/** As many as the old app took at once. */
const MAX_FILES = 5;
import { Link } from '@/i18n/navigation';

import styles from './Inbox.module.css';
import { UserText } from '@/design-system/primitives/text/UserText';

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
  const router = useRouter();
  const [text, setText] = useState('');
  /*
   * A chosen file, HELD until Send. The media route sends on upload, so
   * choosing a file must not be the moment it leaves.
   */
  const [files, setFiles] = useState<readonly File[]>([]);
  const file = files[0] ?? null;
  /* Image previews, as object URLs — made once per file, released when it goes. */
  const previews = useMemo(
    () =>
      files.map((f) =>
        f.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(f)
          : null,
      ),
    [files],
  );
  useEffect(
    () => () => {
      for (const url of previews) if (url) URL.revokeObjectURL(url);
    },
    [previews],
  );
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<SendResult | MediaResult | null>(null);
  /*
   * ★ WHAT THE DRAFT WAS BEFORE GOTCHA REWORKED IT. The chips replace
   *   somebody's words; without this they would be gone with no way back.
   */
  const [before, setBefore] = useState<string | null>(null);
  const [composed, setComposed] = useState<ComposeResult | null>(null);
  /* The same plain flag as `isComposing`, for the same reason — see there. */
  const [isPending, setPending] = useState(false);
  /*
   * ⚠ A PLAIN FLAG, NOT A SECOND TRANSITION. As `useTransition`, the pending
   *   state never cleared after the reworked text arrived — the field and
   *   Undo stayed disabled — because updates after an `await` are not part of
   *   the transition. Set before the call, cleared in `finally`.
   */
  const [isComposing, setComposing] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  /*
   * ★ THE MESSAGE BEING ANSWERED — 02's Reply. Set by a message's button in
   *   the stream, shown above the field, sent as `replyToMessageId`.
   */
  const [replying, setReplying] = useState<ReplyTarget | null>(null);

  useEffect(() => {
    const onReply = (event: Event) => {
      setReplying((event as CustomEvent<ReplyTarget>).detail);
      setResult(null);
      body.current?.focus();
    };
    window.addEventListener(REPLY_TO_EVENT, onReply);
    return () => window.removeEventListener(REPLY_TO_EVENT, onReply);
  }, []);

  /*
   * The Copilot wall's "Use this", "Edit" and "Ask": the text into the box,
   * focused — never sent. Edit selects it, to be typed over; the others leave
   * the caret at the end, ready to send. After the frame, so the box holds it.
   */
  useEffect(() => {
    const onFill = (event: Event) => {
      const { text: filled, select } = (event as CustomEvent<ComposerFill>).detail;
      setText(filled);
      setResult(null);
      requestAnimationFrame(() => {
        const box = body.current;
        if (!box) return;
        box.focus();
        if (select) box.select();
        else box.setSelectionRange(box.value.length, box.value.length);
      });
    };
    window.addEventListener(FILL_COMPOSER_EVENT, onFill);
    return () => window.removeEventListener(FILL_COMPOSER_EVENT, onFill);
  }, []);

  const empty = text.trim() === '';
  const busy = isPending || isComposing;
  /*
   * ⚠ A FILE CANNOT BE A REPLY: the media route takes no reply target. Sending
   *   one while quietly dropping the other would be wrong either way, so with
   *   both present Send waits and the box says why.
   */
  const conflict = file !== null && replying !== null;

  /** Adds what was chosen or dropped — up to five, as the old app allowed. */
  const add = (chosen: FileList | readonly File[] | null | undefined) => {
    setResult(null);
    if (!chosen) return;
    setFiles((now) => [...now, ...Array.from(chosen)].slice(0, MAX_FILES));
  };
  const remove = (index: number) => {
    setResult(null);
    setFiles((now) => now.filter((_, i) => i !== index));
  };

  const rework = (kind: ComposeKind) => {
    const draft = text;
    setComposed(null);
    setComposing(true);
    void composeDraft(conversationId, kind, draft)
      .then((outcome) => {
        setComposed(outcome);
        if (outcome.ok) {
          setBefore(draft);
          setText(outcome.text);
        }
      })
      .catch(() => setComposed({ ok: false, reason: 'failed' }))
      .finally(() => setComposing(false));
  };

  return (
    <form
      className={styles.composer}
      data-dragging={dragging ? 'yes' : undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files') || busy) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length || busy) return;
        event.preventDefault();
        setDragging(false);
        add(event.dataTransfer.files);
      }}
      data-testid="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if ((empty && file === null) || busy || conflict) return;
        setPending(true);
        void (async () => {
          try {
            let outcome: SendResult | MediaResult;
            let sent = 0;
            if (files.length === 0) {
              outcome = await sendReply(conversationId, text, replying?.id);
            } else {
              /*
               * One upload per file (the route takes one). The words go with
               * the FIRST only — five copies of a caption is not what was
               * written. A failure stops the rest; what did not go stays held.
               */
              outcome = { ok: true };
              for (const [i, f] of files.entries()) {
                outcome = await sendMedia(conversationId, f, i === 0 ? text : '');
                if (!outcome.ok) break;
                sent += 1;
              }
              if (!outcome.ok && sent > 0) {
                setFiles((now) => now.slice(sent));
                setText('');
                router.refresh();
              }
            }
            setResult(outcome);
            /*
             * Cleared only on success. A failed send that empties the box loses
             * somebody's words and gives them nothing to retry with — and the
             * commonest failure here is recoverable.
             */
            if (outcome.ok) {
              setText('');
              setFiles([]);
              setReplying(null);
              setBefore(null);
              setComposed(null);
              /*
               * A text reply revalidates on the server; a file goes through the
               * BFF, so the page is re-read from here.
               */
              if (file !== null) router.refresh();
            }
          } catch {
            setResult({ ok: false, reason: 'failed' });
          } finally {
            setPending(false);
          }
        })();
      }}
    >
      {/*
        ★ 02's CARD HAS NO VISIBLE LABEL — the placeholder and the channel in
          the bar say what this is. The label stays, for whoever cannot see
          either: a placeholder is not a name.
      */}
      <label className="srOnly" htmlFor="composer-body">
        {channelName ? t('labelOn', { channel: channelName }) : t('label')}
      </label>

      {/* What is being answered, and the way to stop answering it. */}
      {replying === null ? null : (
        <div className={styles.composerQuote} data-testid="composer-replying">
          <span className={styles.quote}>
            <span className={styles.quoteWho}>{t('replyingTo', { who: replying.who })}</span>
            <span className={styles.quoteText}>
              <UserText>{replying.preview}</UserText>
            </span>
          </span>
          <button
            type="button"
            className={styles.composerIcon}
            data-testid="composer-reply-cancel"
            aria-label={t('cancelReply')}
            disabled={busy}
            onClick={() => setReplying(null)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      <textarea
        ref={body}
        id="composer-body"
        className={styles.composerInput}
        data-testid="composer-body"
        value={text}
        rows={1}
        disabled={busy}
        placeholder={t('placeholder')}
        onChange={(event) => setText(event.target.value)}
      />

      {/* The held files — a picture as itself — each with the way to take it back out. */}
      {files.length === 0 ? null : (
        <ul className={styles.composerFiles} data-testid="composer-files">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className={styles.composerFile}
              data-testid={`composer-file-${i}`}
            >
              {previews[i] ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local object URL
                <img className={styles.composerThumb} src={previews[i]!} alt="" />
              ) : (
                <Paperclip size={12} aria-hidden="true" />
              )}
              <span className={styles.composerFileName}>{f.name}</span>
              <button
                type="button"
                className={styles.composerIcon}
                data-testid={`composer-file-remove-${i}`}
                aria-label={t('removeFile', { name: f.name })}
                disabled={busy}
                onClick={() => remove(i)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
          <li className={styles.composerFileNote}>
            {t('attachedCount', { count: files.length, max: MAX_FILES })}
          </li>
        </ul>
      )}

      {/*
        ════════════════════════════════════════════════════════════════════
        ★★ 02's BAR — EVERY CONTROL IN IT DOES SOMETHING
        ════════════════════════════════════════════════════════════════════
        02 draws image · paperclip · mic · bookmark, a divider, Rewrite ·
        Shorter · Translate, the channel and send. The mic and the bookmark
        are not here: there is no voice-note send type and no saved-reply
        model, and a control that does nothing is worse than its absence.
      */}
      <div className={styles.composerBar}>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="composer-image-input"
          onChange={(event) => {
            add(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="composer-file-input"
          onChange={(event) => {
            add(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className={styles.composerIcon}
          data-testid="composer-attach-image"
          aria-label={t('attachImage')}
          title={t('attachImage')}
          disabled={busy || files.length >= MAX_FILES}
          onClick={() => imageInput.current?.click()}
        >
          <ImageIcon size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.composerIcon}
          data-testid="composer-attach-file"
          aria-label={t('attachFile')}
          title={t('attachFile')}
          disabled={busy || files.length >= MAX_FILES}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={15} aria-hidden="true" />
        </button>

        <span className={styles.composerDivider} aria-hidden="true" />

        {/*
          ★ They act on the draft, so with no draft they are not ready —
            the same reasoning as Send.
        */}
        <span role="group" aria-label={t('compose.label')} className={styles.composerChips}>
          {COMPOSE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={styles.composerChip}
              data-testid={`compose-${kind}`}
              disabled={empty || busy}
              onClick={() => rework(kind)}
            >
              {t(`compose.${kind}`)}
            </button>
          ))}
          {before === null ? null : (
            <button
              type="button"
              className={styles.composerChip}
              data-testid="compose-undo"
              disabled={busy}
              onClick={() => {
                setText(before);
                setBefore(null);
                setComposed(null);
              }}
            >
              {t('compose.undo')}
            </button>
          )}
        </span>

        {/*
          Where this goes, named. An agent with four conversations open should
          not have to infer the channel from the thread above.
        */}
        {channelName ? <span className={styles.composerChannel}>{channelName}</span> : null}

        {/*
          Disabled on empty rather than sending and being refused: the route
          answers 400 for an empty body, and a round trip to be told what the
          screen already knew is worse than a control that says it is not ready.
          A held file is something to send, with or without words.

          ⚠ An arrow, as 02 draws it — and the words stay, for a screen
            reader: "Send to the customer" is what pressing it does.
        */}
        <button
          type="submit"
          className={styles.composerSend}
          data-testid="composer-send"
          disabled={(empty && file === null) || busy || conflict}
        >
          <ArrowUp size={15} strokeWidth={2.2} aria-hidden="true" />
          <span className="srOnly">{isPending ? t('sending') : t('send')}</span>
        </button>
      </div>

      {/* Only when there is something to say, so an idle card is 02's height. */}
      {result || composed || isComposing || conflict ? (
        <div className={styles.composerActions} aria-live="polite">
          {conflict ? (
            <p className={styles.composerProblem} data-testid="composer-conflict">
              {t('noFileOnReply')}
            </p>
          ) : null}

          {isComposing ? (
            <p className={styles.composerNote} data-testid="compose-working">
              {t('compose.working')}
            </p>
          ) : null}

          {/*
            ★ A rewrite is said, so nobody sends GOTCHA's words believing they
              are their own.
          */}
          {composed?.ok ? (
            <p className={styles.composerNote} data-testid="compose-done">
              {t('compose.done')}
            </p>
          ) : null}

          {composed && !composed.ok && composed.reason !== 'empty' ? (
            <p className={styles.composerProblem} data-testid="compose-problem">
              {composed.reason === 'units_exhausted' ? (
                <>
                  {t('compose.unitsExhausted')}{' '}
                  {/* Where a top-up happens. Somebody without billing access is told so there. */}
                  <Link href="/settings/billing" data-testid="compose-units-link">
                    {t('compose.unitsLink')}
                  </Link>
                </>
              ) : composed.reason === 'blank' ? (
                t('compose.blank')
              ) : (
                t('compose.failed')
              )}
            </p>
          ) : null}

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
                    : result.reason === 'quote_not_here'
                      ? t('error.quoteGone')
                      : result.reason === 'too_large'
                        ? t('error.tooLarge', { limit: MAX_MEDIA_BYTES / (1024 * 1024) })
                        : t('error.failed')}
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
