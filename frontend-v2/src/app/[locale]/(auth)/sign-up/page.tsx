import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { Logo } from '@/design-system/brand/Logo';
import { Text } from '@/design-system/primitives/text/Text';
import { loadSignUpConfig } from '@/features/signup/load-signup-config';
import { appPath } from '@/lib/base-path';

import signIn from '../sign-in/SignIn.module.css';
import { SignUpPanel } from './SignUpPanel';

/**
 * Self sign-up (Omer, 2026-11-22) - in the sign-in surface's frame, as
 * /recover is: the editorial side with its own three lines, and the panel.
 *
 * ★ Behind the server's flag: closed (or unread) is a 404, so nothing of
 *   this exists for a visitor until the switch is on.
 * ★ A screen of the auth surface (auth-surface.ts), so on the split layout
 *   it is served from the sign-in origin with the narrowed CSP, as /recover.
 */
export default async function SignUpPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const config = await loadSignUpConfig();
  if (!config.enabled) notFound();
  const t = await getTranslations('auth.signUp');
  const signInHref = appPath(`/${locale}/sign-in`);

  return (
    <div className={signIn.frame}>
      <aside className={signIn.editorial}>
        <div className={signIn.brand}>
          <Logo variant="framed" size={38} />
          GOTCHA
        </div>
        <div className={signIn.editorialStage} aria-hidden="true">
          <div className={signIn.editorialSlide}>
            <Text role="eyebrow" as="p" className={signIn.editorialEyebrow}>
              {t('editorial.eyebrow')}
            </Text>
            <Text role="serif" tone="inherit" as="p">
              {t('editorial.headline')}
            </Text>
            <Text role="bodySm" tone="inherit" as="p" className={signIn.editorialSupport}>
              {t('editorial.support')}
            </Text>
          </div>
        </div>
      </aside>

      <main className={signIn.surface}>
        <div className={signIn.form} data-screen="signIn">
          <SignUpPanel config={config} signInHref={signInHref} />
        </div>
      </main>
    </div>
  );
}
