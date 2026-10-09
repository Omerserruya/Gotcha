'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';

import { askCopilot, type ComposeResult } from '../compose-actions';
import { fillComposer } from '../reply-event';
import styles from './Wall.module.css';

/**
 * 02's "Ask Copilot anything…", pinned at the foot of the wall.
 *
 * Into the composer's own route, with no new one (Omer): the instruction
 * goes to the compose endpoint with this conversation, and what comes back
 * lands in the reply box. **Nothing is sent** - the title says so, because
 * a box that answers a question could be read as one that writes to the
 * customer.
 */
export function AskCopilot({ conversationId }: { readonly conversationId: string | null }) {
  const t = useTranslations('inbox.wall.ask');
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<ComposeResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const off = conversationId === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (off || isPending || question.trim() === '') return;
    setResult(null);
    startTransition(async () => {
      const answer = await askCopilot(conversationId, question);
      setResult(answer);
      if (answer.ok) {
        fillComposer(answer.text, { select: true });
        setQuestion('');
      }
    });
  };

  return (
    <form className={styles.ask} onSubmit={submit} data-testid="wall-ask">
      {result && !result.ok ? (
        <p
          className={styles.note}
          role="status"
          data-testid="wall-ask-note"
          data-reason={result.reason}
        >
          {t(`failed.${result.reason}`)}
        </p>
      ) : null}
      <div className={styles.askField}>
        <input
          className={styles.askInput}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('label')}
          title={off ? t('nothingOpen') : t('title')}
          disabled={off}
          maxLength={1000}
          data-testid="wall-ask-input"
        />
        <button
          type="submit"
          className={styles.askSend}
          aria-label={isPending ? t('asking') : t('send')}
          title={t('title')}
          disabled={off || isPending || question.trim() === ''}
          data-testid="wall-ask-send"
        />
      </div>
    </form>
  );
}
