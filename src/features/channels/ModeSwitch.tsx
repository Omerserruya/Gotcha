'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { RESPONSE_MODES, type ResponseMode } from '@/api/contracts/channels';
import { useRouter } from '@/i18n/navigation';

import { setResponseMode } from './actions';
import styles from './Channels.module.css';

/**
 * 13b's "AI mode", as 02 draws it: two segments, the current one dark —
 * Answers on its own · Drafts, a person sends. Live (`PATCH response-mode`),
 * and it asks first: switching changes what customers on this number get,
 * from the next message on. Nothing moves before the server says so.
 */
export function ModeSwitch({
  channelAccountId,
  current,
}: {
  readonly channelAccountId: string;
  readonly current: ResponseMode;
}) {
  const t = useTranslations('channels.whatsapp.rows');
  const router = useRouter();
  const [asking, setAsking] = useState<ResponseMode | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // 02's order: on its own first.
  const order: readonly ResponseMode[] = ['AI_AUTO_REPLY', 'HUMAN_WITH_COPILOT'];

  if (asking) {
    return (
      <span className={styles.modeAsk} data-testid={`mode-ask-${channelAccountId}`}>
        <span>{t(`modeAsk.${asking}`)}</span>
        <button
          type="button"
          className={styles.modeYes}
          disabled={isPending}
          data-testid={`mode-yes-${channelAccountId}`}
          onClick={() =>
            startTransition(async () => {
              const done = await setResponseMode(channelAccountId, asking);
              setAsking(null);
              if (done.ok) router.refresh();
              else setProblem(t('modeFailed'));
            })
          }
        >
          {t('modeYes')}
        </button>
        <button type="button" className={styles.modeNo} onClick={() => setAsking(null)}>
          {t('modeNo')}
        </button>
      </span>
    );
  }
  return (
    <span className={styles.modeSwitch}>
      <span
        className={styles.modeSegments}
        role="radiogroup"
        aria-label={t('aiMode')}
        data-testid={`mode-switch-${channelAccountId}`}
      >
        {order
          .filter((mode) => (RESPONSE_MODES as readonly string[]).includes(mode))
          .map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={mode === current}
              className={styles.modeSegment}
              data-testid={`mode-${mode}-${channelAccountId}`}
              onClick={() => {
                if (mode === current) return;
                setProblem(null);
                setAsking(mode);
              }}
            >
              {t(`mode.${mode}`)}
            </button>
          ))}
      </span>
      {problem ? (
        <span className={styles.modeProblem} role="alert">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
