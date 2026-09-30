import { getTranslations } from 'next-intl/server';

import { Logo } from '@/design-system/brand/Logo';
import { Text } from '@/design-system/primitives/text/Text';
import { appPath } from '@/lib/base-path';

import signIn from '../sign-in/SignIn.module.css';
import { RecoverPanel } from './RecoverPanel';

/**
 * Password recovery — the screen "Forgot it?" now reaches.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE FLOW SLUG COMES FROM THE PROVIDER, VIA THE URL, AND IS CHECKED HERE
 * ════════════════════════════════════════════════════════════════════════════
 * `recovery_url` on the sign-in challenge names the recovery flow — the
 * contract's own note says it "is a flow slug an administrator can change, and
 * a stale path here sends somebody who has forgotten their password to a 404",
 * so it must not be a constant in our source.
 *
 * ★ The sign-in panel reads it, takes the slug out of it, and links here with
 *   it. That keeps the provider as the source of the name.
 *
 * ⚠ And it arrives in a query string, which anybody can edit. So it is checked
 *   against the same bounded pattern the contract uses before it is allowed
 *   anywhere near a request. This is NOT an authorisation check: the executor
 *   is the provider's own and a person can reach any of its flows by typing
 *   the URL. What it prevents is OUR code composing a request out of an
 *   arbitrary string.
 *
 * ⚠ With no usable slug there is no flow to drive, so the screen says so and
 *   offers the way back rather than rendering a form that cannot submit.
 */
const FLOW_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default async function RecoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ flow?: string }>;
}) {
  const { locale } = await params;
  const { flow } = await searchParams;
  const t = await getTranslations('auth.recover');

  const slug = typeof flow === 'string' && FLOW_SLUG.test(flow) ? flow : null;
  const signInHref = appPath(`/${locale}/sign-in`);

  return (
    <div className={signIn.frame}>
      <aside className={signIn.editorial}>
        <div className={signIn.brand}>
          <Logo variant="framed" size={38} />
          GOTCHA
        </div>

        {/*
          ★ 00b's refactor made the editorial panel per-screen, so this one gets
            its own statement rather than wearing sign-in's. The design has no
            recovery screen to copy a statement from, so this says the true
            thing about the situation: we cannot tell you your password.
        */}
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

        <div className={signIn.systemStatus}>
          <span className={signIn.editorialRule} aria-hidden="true" />
          <span className={signIn.statusDot} aria-hidden="true" />
          {t('editorial.status')}
        </div>
      </aside>

      <main className={signIn.surface}>
        <div className={signIn.form} data-screen="signIn">
          {slug ? (
            <RecoverPanel flow={slug} signInHref={signInHref} />
          ) : (
            <div data-testid="recover-unavailable">
              <Text role="title" as="h1">
                {t('title')}
              </Text>
              <Text role="body" tone="muted" as="p">
                {t('unreachable')}
              </Text>
              <a className={signIn.footnote} href={signInHref}>
                {t('back')}
              </a>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
