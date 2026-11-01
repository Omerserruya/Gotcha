'use client';

import { ArrowUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';

import { COPILOT_MESSAGE_MAX, type CopilotTurn } from '@/api/contracts/copilot-chat';

import { fillComposer } from '../reply-event';
import {
  askCopilotChat,
  clearCopilotChat,
  readCopilotChat,
  type CopilotAsk,
} from './copilot-chat-actions';
import styles from './Wall.module.css';

type Problem = Extract<CopilotAsk, { ok: false }>['reason'] | 'read_failed' | 'clear_failed';

/**
 * 02's "Ask Copilot anything…", pinned at the foot of the wall: a private
 * thread between this agent and the Copilot about this conversation (Backend
 * c49f3830). The server keeps it, so it is the same thread after a reload.
 *
 * ★ Nothing here reaches the customer, and the composer is left alone. An
 *   answer may carry a DRAFT - a reply in the customer's language - and only
 *   "use as reply" puts it in the composer, by a person's click. An answer
 *   without a draft offers nothing to send.
 * ★ A round takes seconds: the question shows at once, with "looking into
 *   it" under it. Busy (a round still running) keeps the question to send
 *   again; a failed round stores nothing and offers to try again.
 */
export function AskCopilot({ conversationId }: { readonly conversationId: string | null }) {
  const t = useTranslations('inbox.wall.ask');
  const locale = useLocale();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<readonly CopilotTurn[]>([]);
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notOnPlan, setNotOnPlan] = useState(false);
  const [isPending, startTransition] = useTransition();
  const thread = useRef<HTMLOListElement>(null);
  const off = conversationId === null || notOnPlan;

  // The agent's thread, as the server keeps it. Keyed by the page: one per conversation.
  useEffect(() => {
    if (conversationId === null) return;
    let gone = false;
    void readCopilotChat(conversationId)
      .catch(() => ({ ok: false, reason: 'failed' }) as const)
      .then((read) => {
        if (gone) return;
        if (read.ok) setTurns(read.turns);
        else if (read.reason === 'not_on_plan') setNotOnPlan(true);
        else setProblem('read_failed');
      });
    return () => {
      gone = true;
    };
  }, [conversationId]);

  // The newest line in view.
  useEffect(() => {
    const list = thread.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [turns, asking]);

  const send = (message: string) => {
    if (conversationId === null || off || isPending || message.trim() === '') return;
    setProblem(null);
    setAsking(message.trim());
    setQuestion('');
    startTransition(async () => {
      const answer = await askCopilotChat(conversationId, message, locale).catch(
        (): CopilotAsk => ({ ok: false, reason: 'failed' }),
      );
      setAsking(null);
      if (answer.ok) {
        setTurns(answer.turns);
        return;
      }
      if (answer.reason === 'not_on_plan') setNotOnPlan(true);
      // Never lose what was typed: it goes back in the field.
      setQuestion(message);
      setProblem(answer.reason);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(question);
  };

  const startOver = () => {
    if (conversationId === null || isPending) return;
    startTransition(async () => {
      const cleared = await clearCopilotChat(conversationId).catch(
        () => ({ ok: false, reason: 'failed' }) as const,
      );
      if (cleared.ok) {
        setTurns([]);
        setProblem(null);
      } else setProblem('clear_failed');
    });
  };

  return (
    <form className={styles.ask} onSubmit={submit} data-testid="wall-ask">
      {turns.length > 0 || asking ? (
        <div className={styles.chat} data-testid="wall-chat">
          <div className={styles.chatHead}>
            <span className={styles.chatPrivate}>{t('private')}</span>
            {turns.length > 0 ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={startOver}
                disabled={isPending}
                data-testid="wall-chat-start-over"
              >
                {t('startOver')}
              </button>
            ) : null}
          </div>
          <ol className={styles.chatTurns} ref={thread} aria-live="polite">
            {turns.map((turn) => (
              <Turn key={turn.id} turn={turn} />
            ))}
            {asking ? (
              <>
                <li className={styles.chatTurn} data-role="agent" data-testid="wall-chat-asking">
                  <bdi dir="auto">{asking}</bdi>
                </li>
                <li className={styles.chatThinking} data-testid="wall-chat-thinking">
                  {t('thinking')}
                </li>
              </>
            ) : null}
          </ol>
        </div>
      ) : null}
      {notOnPlan ? (
        <p
          className={styles.note}
          role="status"
          data-testid="wall-ask-note"
          data-reason="not_on_plan"
        >
          {t('failed.not_on_plan')}
        </p>
      ) : problem ? (
        <p className={styles.note} role="status" data-testid="wall-ask-note" data-reason={problem}>
          {t(`failed.${problem}`, { max: COPILOT_MESSAGE_MAX })}{' '}
          {problem === 'failed' && question.trim() ? (
            <button
              type="button"
              className={styles.textButton}
              onClick={() => send(question)}
              data-testid="wall-ask-retry"
            >
              {t('retry')}
            </button>
          ) : null}
        </p>
      ) : null}
      <div className={styles.askField}>
        <input
          className={styles.askInput}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('label')}
          title={conversationId === null ? t('nothingOpen') : t('title')}
          disabled={off}
          maxLength={COPILOT_MESSAGE_MAX}
          dir="auto"
          data-testid="wall-ask-input"
        />
        <button
          type="submit"
          className={styles.askSend}
          aria-label={isPending ? t('asking') : t('send')}
          title={t('title')}
          disabled={off || isPending || question.trim() === ''}
          data-testid="wall-ask-send"
        >
          {/* 02 draws a bare circle; the arrow says what it does, in every state. */}
          <ArrowUp size={13} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

/** One turn: the agent's question, or the Copilot's answer with its draft, if it wrote one. */
function Turn({ turn }: { readonly turn: CopilotTurn }) {
  const t = useTranslations('inbox.wall.ask');
  return (
    <li className={styles.chatTurn} data-role={turn.role} data-testid={`wall-chat-${turn.role}`}>
      <bdi dir="auto" className={styles.chatText}>
        {turn.text}
      </bdi>
      {turn.role === 'copilot' && turn.draft ? (
        <div className={styles.chatDraft} data-testid="wall-chat-draft">
          <span className={styles.chatDraftLabel}>{t('draftLabel')}</span>
          <bdi dir="auto" className={styles.chatText}>
            {turn.draft}
          </bdi>
          {/* The only way a draft reaches the composer: this click. Nothing is sent. */}
          <button
            type="button"
            className={styles.useButton}
            onClick={() => fillComposer(turn.draft ?? '', { select: true })}
            data-testid="wall-chat-use"
          >
            {t('useAsReply')}
          </button>
        </div>
      ) : null}
    </li>
  );
}
