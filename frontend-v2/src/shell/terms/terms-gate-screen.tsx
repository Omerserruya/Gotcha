import 'server-only';

import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import { TERMS_PENDING_COOKIE } from '@/auth/google-sign-in';
import { loadMessages } from '@/i18n/load-messages';
import type { Locale } from '@/i18n/locales';

import { readTermsRequired } from './read-terms';
import { TermsGate } from './TermsGate';

/**
 * ★★ THE TERMS BEFORE FIRST ENTRY, AT EVERY SIGNED-IN DOOR (Omer's Q4,
 * 2026-11-22) - the product, the phone, onboarding, checkout and connect,
 * each calling this just BEFORE `mfaGateScreen`.
 *
 * - No marker (google-sign-in.ts): `null`, and no read at all. Only a Google
 *   sign-in with no acceptance on file sets it, so a password person never
 *   pays for this.
 * - Marker: ask Backend. `false` (accepted elsewhere, or a support session,
 *   which the route answers false): the area. `true`, or unread: this screen
 *   - "keep the last answer you hold", and the marker is that answer.
 *
 * ⚠ Consent capture, not security (Supervisor): the server refuses nothing
 *   on this flag. A sign-in whose record failed has no marker, and goes in.
 */
export async function termsGateScreen(locale: Locale): Promise<ReactNode | null> {
  if (!(await cookies()).has(TERMS_PENDING_COOKIE)) return null;
  if ((await readTermsRequired()) === false) return null;
  return (
    <NextIntlClientProvider messages={await loadMessages(locale)}>
      <TermsGate />
    </NextIntlClientProvider>
  );
}
