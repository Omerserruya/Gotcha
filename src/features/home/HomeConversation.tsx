'use client';

import { ArrowLeft, ArrowUp, Square } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { UnavailableAction } from '@/design-system/primitives/unavailable/Unavailable';

import styles from './HomeConversation.module.css';
import type { AgentStep } from './use-agent-run';
import { useAgentThread, type Turn } from './use-agent-thread';

/** Home's command box asks through this: the first question turns Home into the chat. */
const AskContext = createContext<((question: string) => void) | null>(null);

/** `null` outside Home's conversation (the box then answers in place, as before). */
export function useHomeAsk(): ((question: string) => void) | null {
  return useContext(AskContext);
}

/**
 * ★★ Home · in conversation (design 7, 01a; Omer, 2026-10-07).
 *
 * Sending the first message transforms Home IN PLACE: the greeting and the
 * snapshot leave, the command box docks at the bottom - no modal, no new
 * page. "← Home" brings the live Home back.
 *
 * Stage 1 is what the run that exists today can say, and nothing it cannot:
 * each answer's steps (running, done, failed, refused) with the time each
 * took as measured here, the text as it streams, and Stop. The title is the
 * first question in the person's own words. Share is a status ("in the next
 * stage"). Not drawn until `/api/assistant/threads` gives them: the scope
 * chip, Recent in the rail, follow-up suggestions, resuming after a reload,
 * and the blocks, sources and actions (stages 2-3).
 */
export function HomeConversation({ children }: { readonly children: ReactNode }) {
  const { turns, ask, cancel, reset } = useAgentThread();

  return (
    <AskContext.Provider value={(question) => void ask(question)}>
      {turns.length === 0 ? (
        children
      ) : (
        <Conversation turns={turns} onAsk={(q) => void ask(q)} onStop={cancel} onHome={reset} />
      )}
    </AskContext.Provider>
  );
}

function Conversation({
  turns,
  onAsk,
  onStop,
  onHome,
}: {
  readonly turns: readonly Turn[];
  readonly onAsk: (question: string) => void;
  readonly onStop: () => void;
  readonly onHome: () => void;
}) {
  const t = useTranslations('home.conversation');
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const running = turns.at(-1)?.status === 'running';
  const last = turns.at(-1);

  // The newest words in view as they arrive.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [last?.answer, last?.steps.length, turns.length]);

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || running) return;
    setDraft('');
    onAsk(question);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <section className={styles.chat} aria-label={t('label')} data-testid="home-conversation">
      <header className={styles.bar}>
        <button
          type="button"
          className={styles.back}
          onClick={onHome}
          data-testid="conversation-home"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {t('home')}
        </button>
        <span className={styles.rule} aria-hidden="true" />
        <h1 className={styles.title} data-testid="conversation-title">
          <bdi dir="auto">{turns[0]!.question}</bdi>
        </h1>
        <span className={styles.barEnd}>
          <UnavailableAction
            label={t('share')}
            tag={t('nextStage')}
            why={t('shareWhy')}
            testid="conversation-share"
          />
        </span>
      </header>

      <div className={styles.scroll}>
        <ol className={styles.turns}>
          {turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} />
          ))}
        </ol>
        <div ref={end} />
      </div>

      <form className={styles.dock} onSubmit={send} data-testid="conversation-dock">
        <label className="srOnly" htmlFor="conversation-input">
          {t('placeholder')}
        </label>
        <textarea
          id="conversation-input"
          className={styles.input}
          value={draft}
          rows={1}
          dir="auto"
          placeholder={t('placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid="conversation-input"
        />
        {running ? (
          <button
            type="button"
            className={styles.send}
            onClick={onStop}
            aria-label={t('stop')}
            data-testid="conversation-stop"
          >
            <Square size={11} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button
            type="submit"
            className={styles.send}
            disabled={draft.trim() === ''}
            aria-label={t('send')}
            data-testid="conversation-send"
          >
            <ArrowUp size={15} strokeWidth={2.4} />
          </button>
        )}
      </form>
    </section>
  );
}

function TurnView({ turn }: { readonly turn: Turn }) {
  const t = useTranslations('home.conversation');
  return (
    <li className={styles.turn} data-testid={`turn-${turn.id}`} data-status={turn.status}>
      <p className={styles.question}>
        <bdi dir="auto">{turn.question}</bdi>
      </p>
      <div className={styles.answerRow}>
        <span className={styles.avatar} aria-hidden="true">
          <span />
        </span>
        <div className={styles.answerBody}>
          {turn.steps.length > 0 ? (
            <ol className={styles.steps} data-testid="turn-steps">
              {turn.steps.map((step) => (
                <StepLine key={step.id} step={step} />
              ))}
            </ol>
          ) : turn.status === 'running' ? (
            <p className={styles.working} role="status">
              {t('working')}
            </p>
          ) : null}
          {turn.answer ? (
            <p className={styles.answer} aria-live="polite" data-testid="turn-answer">
              <bdi dir="auto">{turn.answer}</bdi>
            </p>
          ) : null}
          {turn.awaitingApproval ? (
            <p className={styles.note} data-testid="turn-approval">
              {t('awaitingApproval', { what: turn.awaitingApproval.summary ?? '' })}
            </p>
          ) : null}
          {turn.status === 'failed' ? (
            <p className={styles.problem} role="alert" data-testid="turn-failed">
              {turn.error ? t('failedWith', { why: turn.error }) : t('failed')}
            </p>
          ) : turn.status === 'cancelled' ? (
            <p className={styles.note} data-testid="turn-stopped">
              {t('stopped')}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** "✓ name · 6s" - the step, its state, and the time it took as seen from here. */
function StepLine({ step }: { readonly step: AgentStep }) {
  const t = useTranslations('home.conversation.step');
  const seconds =
    step.startedAt !== undefined && step.endedAt !== undefined
      ? Math.max(0, Math.round((step.endedAt - step.startedAt) / 1000))
      : null;
  return (
    <li className={styles.step} data-status={step.status} data-testid={`step-${step.id}`}>
      <span className={styles.stepMark} aria-hidden="true">
        {step.status === 'running' ? (
          <span className={styles.spinner} />
        ) : step.status === 'succeeded' ? (
          '✓'
        ) : (
          '×'
        )}
      </span>
      {/* Tool names are the backend's identifiers; the state carries the meaning. */}
      <span>{step.name}</span>
      <span className={styles.stepState}>{t(step.status)}</span>
      {seconds !== null ? (
        <span className={styles.stepTime}>{t('seconds', { count: seconds })}</span>
      ) : null}
      {step.detail && step.status !== 'running' ? (
        <bdi dir="auto" className={styles.stepDetail}>
          {step.detail}
        </bdi>
      ) : null}
    </li>
  );
}
