import { getTranslations } from 'next-intl/server';

import { Logo } from '@/design-system/brand/Logo';
import { Text } from '@/design-system/primitives/text/Text';
import { FINISH_PARAM, HANDOVER_PARAM } from '@/app/api/auth/login/route';
import { Button } from '@/design-system/primitives/button/Button';
import { appPath } from '@/lib/base-path';
import { serverEnv } from '@/config/env.server';

import signIn from '../sign-in/SignIn.module.css';
import styles from './Recover.module.css';
import { RecoverPanel } from './RecoverPanel';
import { ResetPanel, type ResetLink, type ResetPurpose } from './ResetPanel';

/**
 * Password recovery - the screen "Forgot it?" now reaches.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE FLOW SLUG COMES FROM THE PROVIDER, VIA THE URL, AND IS CHECKED HERE
 * ════════════════════════════════════════════════════════════════════════════
 * `recovery_url` on the sign-in challenge names the recovery flow - the
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

/**
 * A link's `flow_token`, as far as the page can judge it: present, and plain.
 * ★ Not its validity - only the executor knows that, and it says so silently
 *   (a dead token restarts the flow). This only refuses a value that cannot be
 *   one, so a truncated link reads "incomplete" rather than "expired".
 */
const FLOW_TOKEN = /^[^\s\p{C}]{8,512}$/u;

/**
 * Which link this is, by its flow (Backend's gateway, 2026-10-22):
 * `gotcha-recovery` is an invited user's setup link (their FIRST password);
 * every other recovery flow is a reset somebody asked for. ⚠ A slug an
 * administrator can rename - a renamed setup flow reads as a reset, which is
 * the wording, not the behaviour.
 */
const SETUP_FLOW = 'gotcha-recovery';
const purposeOf = (flow: string): ResetPurpose => (flow === SETUP_FLOW ? 'setup' : 'reset');

export default async function RecoverPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ flow?: string; flow_token?: string; setup?: string }>;
}) {
  const { locale } = await params;
  const { flow, flow_token: flowToken, setup: setupToken } = await searchParams;
  const t = await getTranslations('auth.recover');

  const slug = typeof flow === 'string' && FLOW_SLUG.test(flow) ? flow : null;
  const signInHref = appPath(`/${locale}/sign-in`);
  const purpose = slug ? purposeOf(slug) : 'reset';
  /*
   * Screen two: the link from the email carries a token - the provider's, or
   * on a setup link our own (`setup`), exchanged for one once the terms are
   * accepted. Only a setup flow takes `setup`.
   */
  const raw =
    typeof flowToken === 'string'
      ? ({ kind: 'flow', token: flowToken } as const)
      : purpose === 'setup' && typeof setupToken === 'string'
        ? ({ kind: 'setup', token: setupToken } as const)
        : null;
  const linked = slug !== null && raw !== null;
  const link: ResetLink | null = raw && FLOW_TOKEN.test(raw.token) ? raw : null;
  const recoverHref =
    purpose === 'reset' && slug ? appPath(`/${locale}/recover?flow=${slug}`) : null;
  /*
   * After the new password, the flow has signed the person in at the provider
   * (user_login), so the app's own sign-in completes without asking again: the
   * same hand-over the sign-in panel makes, with its marker, or it loops.
   */
  const loginHref = `${serverEnv().PRODUCT_LOGIN_URL ?? appPath('/api/auth/login')}?${new URLSearchParams({ [HANDOVER_PARAM]: '1', [FINISH_PARAM]: '1' }).toString()}`;

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
          {linked && link && slug ? (
            <ResetPanel
              flow={slug}
              link={link}
              purpose={purpose}
              loginHref={loginHref}
              signInHref={signInHref}
              recoverHref={recoverHref}
            />
          ) : linked ? (
            <div data-testid="reset-malformed" className={styles.done}>
              <Text role="title" as="h1">
                {t('reset.malformed.title')}
              </Text>
              <Text role="body" tone="muted" as="p">
                {t(recoverHref ? 'reset.malformed.body' : 'reset.malformed.setupBody')}
              </Text>
              {recoverHref ? (
                <Button asChild variant="primary" size="lg" fullWidth>
                  <a href={recoverHref}>{t('reset.expired.resend')}</a>
                </Button>
              ) : null}
              <a className={signIn.footnote} href={signInHref}>
                {t('back')}
              </a>
            </div>
          ) : slug ? (
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
