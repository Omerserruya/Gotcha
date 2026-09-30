import { getLocale, getTranslations } from 'next-intl/server';

import { SignInScreen } from './SignInScreen';
import { FinishSignIn } from './FinishSignIn';
import { isAuthorizeEndpoint } from '@/api/contracts/auth-flow';
import { oidcConfiguration } from '@/auth/oidc';
import { appUrl } from '@/lib/base-path';
import { Logo } from '@/design-system/brand/Logo';
import { Text } from '@/design-system/primitives/text/Text';
import { appPath } from '@/lib/base-path';
import { serverEnv } from '@/config/env.server';
import { FINISH_PARAM, HANDOVER_PARAM } from '@/app/api/auth/login/route';

import styles from './SignIn.module.css';

const KNOWN_ERRORS = ['expired', 'denied', 'exchange_failed'] as const;

/**
 * Sign-in - screen 00a.
 *
 * There is no password field here, and there will not be one: GOTCHA
 * implements no authentication of its own. Authentik owns the credentials, so
 * this screen's whole job is to hand the person over in one action and to
 * explain anything that went wrong on the way back.
 *
 * The design's sign-in draws email, password and alternate methods. Those are
 * the identity provider's surface, not this application's - building them here
 * would mean this app handling passwords, which is precisely the architecture
 * the platform avoids. The frame, the editorial panel and the single primary
 * action are the parts that belong to us, and those are what is built.
 * Recorded in docs/api-gaps.md.
 */
/**
 * One screen's rotating figures.
 *
 * ★ The SHELL is the same on both — 508px column, 250px stage, the 15s cycle,
 *   the reduced-motion hold. Only the three statements differ, so this takes a
 *   key prefix rather than being written twice.
 */
function Figures({
  slides,
  t,
}: {
  readonly slides: readonly string[];
  readonly t: (key: string) => string;
}) {
  return (
    <div className={styles.editorialStage} aria-hidden="true">
      {slides.map((slide) => (
        <div key={slide} className={styles.editorialSlide}>
          <Text role="eyebrow" as="p">
            {t(`${slide}.eyebrow`)}
          </Text>
          {/* The serif, italic. `inherit` because this sits on the dark frame,
              not the light panel. */}
          <Text role="serif" tone="inherit" as="p">
            {t(`${slide}.headline`)}
          </Text>
          <Text role="bodySm" tone="inherit" as="p" className={styles.editorialSupport}>
            {t(`${slide}.support`)}
          </Text>
        </div>
      ))}
    </div>
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    returnTo?: string;
    authorize?: string;
    finishHold?: string;
  }>;
}) {
  const { error, returnTo, authorize, finishHold } = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations('auth');
  /*
   * Scoped to the editorial block so `Figures` can take a key prefix and be
   * written once for both screens — `scale.eyebrow` and
   * `secondFactor.why.eyebrow` are the same shape from here.
   */
  const editorial = await getTranslations('auth.editorial');

  /*
   * ════════════════════════════════════════════════════════════════════════════
   * ★★ `appPath`, BECAUSE A PLAIN ANCHOR IS NOT PREFIXED AND THIS ONE LEFT THE APP
   * ════════════════════════════════════════════════════════════════════════════
   * Next prefixes `next/link` and `redirect()` with `basePath`. It does NOT
   * touch a raw `<a href>` — the browser resolves that against the origin, so
   * `/api/auth/login` under `/v2` became `https://dev.gotcha.co.il/api/auth/login`.
   *
   * Beside the legacy product that is not a 404. It is the OTHER application's
   * login route, and the button on this screen started the wrong app's OIDC
   * flow: measured on 2026-09-28, the journey ended at
   * `http://localhost:3000/en/sign-in?error=expired`.
   *
   * ★ The anchor is still a plain `<a>` on purpose — this leaves the app for
   *   the identity provider, so client-side routing must not intercept it.
   *   That reasoning was right; what it missed is that opting out of the
   *   router also opts out of the prefix.
   *
   * ★ And this was the LAST unprefixed browser-facing path in the app. Every
   *   other one — `sign-out.ts`, `browser-api.ts`, `login-state.ts`,
   *   `realtime-provider.tsx` — already calls `appPath`. They are all `fetch`
   *   calls. This was the only `href`, so a sweep shaped like "a fetch with a
   *   root path" finds all of them and misses exactly this one.
   */
  /*
   * ═════════════════════════════════════════════════════════════════════════════
   * ★★ A RELATIVE PATH ASSUMES THE PANEL AND THE PRODUCT SHARE A HOST
   * ═════════════════════════════════════════════════════════════════════════════
   * They do today, and `appPath` is right for that. They will not when sign-in
   * moves to its own origin, and the failure is the confusing kind: the
   * password is accepted, the identity provider session is created, and the
   * browser then asks the AUTH host for a route only the PRODUCT host serves.
   * Behind a gateway allowlist that is a **404 at the end of a successful
   * sign-in** — which reads as the panel being broken when the panel has just
   * finished its job.
   *
   * ★ `PRODUCT_LOGIN_URL` is the whole URL rather than an origin, because
   *   `appUrl` would rebuild the path from THIS build’s `BASE_PATH` — empty on
   *   a root-mounted auth build — and produce the product’s origin with the
   *   product’s mount point missing.
   *
   * ★ Unset, nothing changes: this is exactly the string it has always been.
   *   The variable is how the origin move becomes configuration instead of a
   *   code change, and it ships before the move so the move is one edit.
   */
  /*
   * ★★ THE HAND-OVER CARRIES THE MARKER, OR THIS PANEL LOOPS ON ITSELF.
   * `/api/auth/login` now sends anyone WITHOUT it to the sign-in surface,
   * because reaching the OIDC start cold renders the provider's own login page
   * — the screen the separation exists to prevent. This panel is the one
   * legitimate direct caller: by the time it navigates there it has already
   * created the provider session, so `authorize` returns silently.
   *
   * Without the marker: panel → `/api/auth/login` → panel → … on the front
   * door. The constant is imported rather than spelled again for exactly that
   * reason.
   */
  const loginBase = serverEnv().PRODUCT_LOGIN_URL ?? appPath('/api/auth/login');
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ `finish=1` IS THE PARAMETER THAT TURNS THE PROVIDER'S PAGE OFF
   * ══════════════════════════════════════════════════════════════════════════
   * Everything else for this was shipped inert and walked: eight documents,
   * one Authentik page, identical to before. This line is the whole change in
   * behaviour, which is why it is its own commit — it can be reverted without
   * touching the machinery, and the machinery can be read without it.
   *
   * ★ It is sent ONLY on the panel's hand-over. The front door, an expiring
   *   session and every other arrival at `/api/auth/login` are untouched: the
   *   route only inverts its redirect when asked.
   *
   * ⚠ And the cost is real and was approved rather than assumed: ONE EXTRA
   *   302 on every sign-in, in exchange for the provider never drawing a page.
   */
  const handOver = new URLSearchParams({ [HANDOVER_PARAM]: '1', [FINISH_PARAM]: '1' });
  if (returnTo) handOver.set('returnTo', returnTo);
  const loginHref = `${loginBase}?${handOver.toString()}`;
  const knownError = KNOWN_ERRORS.find((candidate) => candidate === error);

  /*
   * ═════════════════════════════════════════════════════════════════════════════
   * ⚠⚠ THE AUTHORIZE URL IS CHECKED HERE, WHERE THE REAL ENDPOINT IS KNOWN
   * ═════════════════════════════════════════════════════════════════════════════
   * It arrives in our own query string, so it is in the address bar and
   * anybody can retype it. Handing an unchecked URL to a component that
   * fetches it with credentials and navigates to the answer would make this
   * page a fetch-and-redirect anyone can aim.
   *
   * ★ Checked on the SERVER, against the endpoint OIDC discovery reports —
   *   not against a constant, and not in the browser. The client never sees a
   *   URL that has not already been compared to the real one.
   *
   * ⚠ A parameter that fails the check is DROPPED, not an error: the panel
   *   renders as usual and the person signs in normally. A forged one
   *   achieves nothing and says nothing.
   */
  let finishing: string | null = null;
  if (typeof authorize === 'string' && authorize !== '') {
    const endpoint = (await oidcConfiguration()).serverMetadata().authorization_endpoint;
    if (endpoint && isAuthorizeEndpoint(authorize, endpoint)) finishing = authorize;
  }

  if (finishing) {
    return (
      <div className={styles.frame}>
        {/*
          ⚠ `?finishHold=1` stops before the navigation so the outcome can be
            READ rather than inferred from where the browser ended up. The
            first walk produced no line of ours anywhere, and "ran and gave
            up" was indistinguishable from "never ran".
        */}
        <FinishSignIn
          authorizeUrl={finishing}
          callbackUrl={appUrl('/api/auth/callback', serverEnv().APP_ORIGIN)}
          hold={finishHold === '1'}
        />
      </div>
    );
  }

  return (
    <SignInScreen
      handOverHref={loginHref}
      recoverPath={appPath(`/${locale}/recover`)}
      returnTo={returnTo}
      brand={
        <div className={styles.brand}>
          <Logo variant="framed" size={38} />
          GOTCHA
        </div>
      }
      /*
        ════════════════════════════════════════════════════════════════════
        ★★ ONE SHELL, TWO SETS OF FIGURES — 00b HAS ITS OWN
        ════════════════════════════════════════════════════════════════════
        The second-factor screen was wearing sign-in's three statements. The
        mock gives it three of its own, and they are an ARGUMENT for why the
        code exists rather than figures about the platform.

        Both are rendered here, on the server, and `SignInScreen` picks. No
        copy crosses into the client bundle and the 508/italic/390 shell is
        written once.
      */
      figures={{
        signIn: <Figures slides={['scale', 'actions', 'team']} t={editorial} />,
        secondFactor: (
          <Figures
            slides={['secondFactor.why', 'secondFactor.behind', 'secondFactor.cost']}
            t={editorial}
          />
        ),
      }}
      ticks={
        /*
          "…with the position marked by three ticks" — 00a, verbatim.
          Decorative and `aria-hidden` like the stage: they mark the position
          of copy a screen reader is deliberately not being read.

          Driven by the same 15s CSS cycle as the slides rather than by state,
          so the two cannot disagree — and they belong inside the status row,
          which is one flex row in the mock.
        */
        <div className={styles.editorialTicks} aria-hidden="true" data-testid="editorial-ticks">
          <span className={styles.editorialTick} />
          <span className={styles.editorialTick} />
          <span className={styles.editorialTick} />
        </div>
      }
      status={{
        signIn: t('editorial.status'),
        secondFactor: t('editorial.secondFactor.status'),
      }}
      notice={
        knownError ? (
          // `role="alert"` so the reason is announced on arrival, not only
          // discovered by someone who happens to read down the page.
          <p className={styles.notice} role="alert">
            {t(`error.${knownError}`)}
          </p>
        ) : null
      }
      /*
        ⚠ SIGN-IN ONLY. "New here? Ask your workspace admin for an invitation"
        was showing on the second factor as well, where it is not merely the
        wrong line but an actively wrong statement: the person reading it has
        already answered that question and is halfway in.
      */
      footnote={<p className={styles.footnote}>{t('signIn.footnote')}</p>}
    />
  );
}
