import 'server-only';

import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { loadMessages } from '@/i18n/load-messages';
import type { Locale } from '@/i18n/locales';

import { MfaGate } from './MfaGate';
import { authOrigin, readMfaGate } from './read-mfa-gate';

/**
 * ★★ ONE RULE FOR EVERY SIGNED-IN DOOR (supervisor, 2026-11-09): the product,
 * the phone, onboarding, checkout and connect. Required and not enrolled:
 * this screen INSTEAD of the area, with the full catalogue (checkout's own is
 * a subset). `null`: the area as it was; unread is `null` too (legacy parity:
 * the platform's 403 still refuses every read).
 *
 * Call it only behind a session: signed out there is nothing to enrol.
 */
export async function mfaGateScreen(locale: Locale): Promise<ReactNode | null> {
  const gate = await readMfaGate();
  if (!gate?.mustEnroll) return null;
  return (
    <NextIntlClientProvider messages={await loadMessages(locale)}>
      <MfaGate initial={gate} authOrigin={authOrigin()} />
    </NextIntlClientProvider>
  );
}
