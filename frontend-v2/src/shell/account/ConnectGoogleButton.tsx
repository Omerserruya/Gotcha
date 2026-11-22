'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { signOut } from '@/auth/sign-out';
import { Button } from '@/design-system/primitives/button/Button';

import { beginGoogleConnect } from './google-connect-action';

/**
 * The "המשך" of the connected-accounts card's connect confirm: remember who,
 * then sign out (google-connect-action.ts says why it must be both).
 *
 * In the shell because signing out is the session's, and a feature may not
 * reach it; the security page hands it to the card as a slot.
 */
export function ConnectGoogleButton() {
  const t = useTranslations('security.google');
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle');

  return (
    <>
      <Button
        size="sm"
        variant="primary"
        data-testid="google-connect-go"
        disabled={state === 'working'}
        onClick={async () => {
          setState('working');
          // Only once the subject is held: never a sign-out with nothing to come back to.
          if ((await beginGoogleConnect()) !== 'ready') {
            setState('failed');
            return;
          }
          await signOut();
        }}
      >
        {t('connectGo')}
      </Button>
      {state === 'failed' ? (
        <span role="alert" data-testid="google-connect-failed">
          {t('failed')}
        </span>
      ) : null}
    </>
  );
}
