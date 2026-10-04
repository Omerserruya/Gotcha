'use client';

import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { startCall, type StartCallResult } from './actions';
import styles from './Calls.module.css';

/**
 * 05d's "Call {name}" — live (Omer, 2026-10-04): `POST /api/voice-sessions/
 * start-outbound`, from a click and nothing else.
 *
 * The line decides how the call is made:
 *   AGENT_FIRST  the server rings the line's agent; once they answer, the
 *                customer is bridged in. The screen says so.
 *   IN_PLATFORM  the line dials from a browser phone, which this app does
 *                not have. The route creates nothing in this mode, so the
 *                screen says nothing was dialled — never "calling…".
 */
export function CallButton({
  to,
  label,
  conversationId,
  blocked,
}: {
  /** The number to call; `null` when the chosen person has none. */
  readonly to: string | null;
  readonly label: string;
  readonly conversationId?: string;
  /** Why no call can go out from this workspace at all — said on the button, before the click. */
  readonly blocked?: string;
}) {
  const t = useTranslations('calls.dialer');
  const [result, setResult] = useState<StartCallResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const note =
    result === null
      ? null
      : !result.ok
        ? t.has(`error.${result.reason}`)
          ? t(`error.${result.reason}` as 'error.failed')
          : t('error.failed')
        : result.mode === 'AGENT_FIRST'
          ? t('ringing')
          : t('inPlatform');

  return (
    <>
      <button
        type="button"
        className={styles.dialerCall}
        disabled={blocked !== undefined || to === null || isPending}
        title={blocked ?? (to === null ? t('noNumber') : undefined)}
        data-testid="dialer-call"
        onClick={() => {
          if (blocked !== undefined || to === null) return;
          setResult(null);
          startTransition(async () => setResult(await startCall(to, conversationId)));
        }}
      >
        <Phone size={14} strokeWidth={2} aria-hidden="true" />
        {isPending ? t('starting') : label}
      </button>
      {note ? (
        <p
          className={styles.dialerNote}
          role="status"
          data-testid="dialer-note"
          data-kind={result?.ok ? 'ok' : 'problem'}
        >
          {note}
        </p>
      ) : null}
    </>
  );
}
