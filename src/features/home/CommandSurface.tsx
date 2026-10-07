'use client';

import { ArrowUp, Square } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent, type KeyboardEvent } from 'react';

import { Text } from '@/design-system/primitives/text/Text';

import styles from './CommandSurface.module.css';
import { useHomeAsk } from './home-ask';
import { useAgentRun, type AgentStep } from './use-agent-run';

/**
 * Home's ask box.
 *
 * "⌘K covers both finding and doing" - this is the doing half, in place on
 * Home rather than behind a shortcut. It runs `POST /api/agent/run`, which
 * streams, so the answer appears a token at a time and the tools the agent
 * uses appear as they run.
 *
 * The trace is deliberately shallow: tool names and outcomes, never reasoning.
 * The brief is explicit that hidden chain-of-thought is not to be exposed, and
 * what an operator actually needs is "did it look at the order, did the refund
 * go through" - not how it decided.
 */
export function CommandSurface({
  tone = 'busy',
  openQuestions = null,
  initial = '',
}: {
  /** 19's ASK: the question, put in the box - never sent on its own. */
  initial?: string;
  tone?: 'busy' | 'quiet' | 'dayOne';
  /** 01b: questions GOTCHA could not answer, for "Answer the 4 open questions". */
  openQuestions?: number | null;
}) {
  const t = useTranslations('home.command');
  const [message, setMessage] = useState(initial);
  const { state, run: runHere, cancel } = useAgentRun();
  /*
   * On Home (design 7, 01a) the question turns Home into the conversation,
   * in place; anywhere else the box answers under itself, as before.
   */
  const homeAsk = useHomeAsk();
  const run = (question: string) => (homeAsk ? homeAsk(question) : runHere(question));

  const isRunning = state.status === 'running';

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || isRunning) return;
    setMessage('');
    void run(trimmed);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line. This is a command box, and an
    // operator typing one sentence should not have to reach for the mouse.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  /*
    01b: on a quiet day the chips shift from triage to improvement. They
    existed in the catalogue and were never drawn - the busy three showed
    on every day.
  */
  const suggestions =
    tone === 'dayOne'
      ? [t('dayOne.learned'), t('dayOne.test'), t('dayOne.store')]
      : tone === 'quiet'
        ? [
            openQuestions && openQuestions > 0
              ? t('quiet.answerCounted', { count: openQuestions })
              : t('quiet.answer'),
            t('quiet.dormant'),
            t('quiet.recap'),
          ]
        : [t('suggestions.summarise'), t('suggestions.waiting'), t('suggestions.campaign')];

  return (
    <form className={styles.surface} onSubmit={submit}>
      <label className="srOnly" htmlFor="command-input">
        {t('label')}
      </label>
      <textarea
        id="command-input"
        className={styles.input}
        placeholder={t('placeholder')}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
      />

      <div className={styles.footer}>
        <span className={styles.tryLabel}>{tone === 'quiet' ? t('whileQuiet') : t('try')}</span>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className={styles.suggestion}
            onClick={() => {
              setMessage(suggestion);
              void run(suggestion);
            }}
            disabled={isRunning}
          >
            {suggestion} ↗
          </button>
        ))}

        {isRunning ? (
          // "AI work is a visible trace you can stop." Stopping has to be one
          // click, in the place the work is happening.
          <button type="button" className={styles.send} onClick={cancel} aria-label={t('stop')}>
            <Square size={12} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button
            type="submit"
            className={styles.send}
            disabled={message.trim().length === 0}
            aria-label={t('send')}
          >
            <ArrowUp size={16} strokeWidth={2.4} />
          </button>
        )}
      </div>

      {state.status !== 'idle' ? (
        <div className={styles.run}>
          {state.steps.length > 0 ? (
            <ol className={styles.trace}>
              {state.steps.map((step) => (
                <TraceStep key={step.id} step={step} />
              ))}
            </ol>
          ) : null}

          {state.answer ? (
            // `aria-live` so a screen-reader user hears the answer arrive
            // rather than having to go looking for it.
            <p className={styles.answer} aria-live="polite">
              {state.answer}
            </p>
          ) : null}

          {state.awaitingApproval ? (
            <Text role="caption" tone="inherit">
              {t('awaitingApproval', { what: state.awaitingApproval.summary ?? '' })}
            </Text>
          ) : null}

          {state.status === 'failed' ? (
            <Text role="caption" tone="inherit" as="p">
              {t('failed')}
            </Text>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function TraceStep({ step }: { step: AgentStep }) {
  const t = useTranslations('home.command.step');
  const statusClass = {
    running: styles.stepRunning,
    succeeded: styles.stepSucceeded,
    failed: styles.stepFailed,
    denied: styles.stepDenied,
  }[step.status];

  return (
    <li className={[styles.step, statusClass].join(' ')}>
      <span className={styles.stepDot} aria-hidden="true" />
      {/*
        The run's own words for the step (`label`, in the interface language,
        Backend 2026-10-07); the tool's id only from an engine too old to send
        them.
      */}
      <span>{step.label ?? step.name}</span>
      <span>{t(step.status)}</span>
    </li>
  );
}
