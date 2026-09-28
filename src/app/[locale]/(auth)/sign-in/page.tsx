import { getTranslations } from 'next-intl/server';

import { SignInPanel } from '@/features/auth/SignInPanel';
import { Logo } from '@/design-system/brand/Logo';
import { Text } from '@/design-system/primitives/text/Text';
import { appPath } from '@/lib/base-path';

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
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const { error, returnTo } = await searchParams;
  const t = await getTranslations('auth');

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
  const loginHref = `${appPath('/api/auth/login')}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;
  const knownError = KNOWN_ERRORS.find((candidate) => candidate === error);

  return (
    <div className={styles.frame}>
      <aside className={styles.editorial}>
        <div className={styles.brand}>
          <Logo variant="framed" size={38} />
          GOTCHA
        </div>

        {/*
          Three statements rotating on a 15s cycle, 5s apart.
          `aria-hidden`: it is ambient copy, and a screen reader announcing a
          new sentence every five seconds while somebody is trying to sign in
          would be actively hostile. The panel says nothing needed to proceed.

          ════════════════════════════════════════════════════════════════════
          ★★ THESE NUMBERS ARE INVENTED, DELIBERATELY, BY A RULING ON
             2026-09-28 — AND THE DESIGN SAYS THE OPPOSITE
          ════════════════════════════════════════════════════════════════════
          Screen 00a specifies: *"Real workspace data, not marketing copy"*, and
          lists "the three rotating side-panel figures, fetched once per load,
          unauthenticated and workspace-agnostic" as a backend requirement.

          **There is no such endpoint and Omer ruled there will not be one for
          now** — "let it be static, invent them, make it sensible but not too
          small". That is recorded here rather than left to be rediscovered,
          because building the design as written means publishing **live
          platform-wide business volume on a public page**: a new unauthenticated
          route returning how many people are mid-conversation and how many
          messages were answered since midnight, scrapeable every five seconds by
          anyone, in which a quiet week is legible to a competitor.

          ⚠ SO A FUTURE READER COMPARING THIS FILE TO THE DESIGN WILL FIND A
            DISCREPANCY, AND IT IS NOT A BUG. Changing it back is a commercial
            decision, not a fix.

          ── AND THE THIRD SLIDE IS NOT LIKE THE OTHER TWO ──
          It used to read *"Your team, this week — You answered in four minutes
          instead of forty. The queue never grew past fourteen."* Slides one and
          two invent a number about the PLATFORM, which Omer's ruling covers.
          That one invented a number **about the reader**, on a page where nobody
          has identified themselves, and it was false for every single person who
          ever saw it. A made-up personal statistic is a different object from a
          made-up platform one, and no ruling about the latter licenses it.

          It now says something true about the product instead, keeping the
          rhythm and claiming nothing about whoever is looking.

          ── AND THERE IS DELIBERATELY NO TEST GUARDING THIS ──
          The obvious one — "no editorial string addresses the reader" — fails a
          string that is correct: slide two's *"Every one of them left a trace
          **you** can open, read and undo"* is second person and is a statement
          about the PRODUCT's capability, not about the reader's week. The
          property that matters is semantic and a word-list cannot see it.

          A guard that reddens on correct copy gets weakened by the next person
          until it matches nothing, which is how the `merge` caption guard and
          the `text-transform` sweep each nearly went. The record above is the
          guard; it is prose because the thing being protected is a judgement.
        */}
        <div className={styles.editorialStage} aria-hidden="true">
          {(['scale', 'actions', 'team'] as const).map((slide) => (
            <div key={slide} className={styles.editorialSlide}>
              <Text role="eyebrow" as="p">
                {t(`editorial.${slide}.eyebrow`)}
              </Text>
              {/* The serif, italic. `inherit` because this sits on the dark
                  frame, not the light panel. */}
              <Text role="serif" tone="inherit" as="p">
                {t(`editorial.${slide}.headline`)}
              </Text>
              <Text role="bodySm" tone="inherit" as="p" className={styles.editorialSupport}>
                {t(`editorial.${slide}.support`)}
              </Text>
            </div>
          ))}
        </div>

        <div className={styles.systemStatus}>
          <span className={styles.statusDot} aria-hidden="true" />
          {t('editorial.status')}
        </div>
      </aside>

      <main className={styles.surface}>
        <div className={styles.form}>
          {knownError ? (
            // `role="alert"` so the reason is announced on arrival, not only
            // discovered by someone who happens to read down the page.
            <p className={styles.notice} role="alert">
              {t(`error.${knownError}`)}
            </p>
          ) : null}

          {/*
            ════════════════════════════════════════════════════════════════════
            ★★ THE PANEL DRIVES THE FLOW; `loginHref` IS BOTH ITS FALLBACK AND
               ITS SUCCESS PATH
            ════════════════════════════════════════════════════════════════════
            This used to be a single button handing over to the identity
            provider. That handover still exists and is still correct — it is
            what `handOverHref` is — but it is now the path we take when the
            panel cannot finish, rather than the only path.

            It is also the path we take when it CAN. Completing the flow sets an
            Authentik session on `.gotcha.co.il`; `/api/auth/login` then runs
            OIDC, sees it, and returns silently. One destination, two meanings,
            and guessing wrong between them is harmless.
          */}
          <SignInPanel handOverHref={loginHref} returnTo={returnTo} />

          <p className={styles.footnote}>{t('signIn.footnote')}</p>
        </div>
      </main>
    </div>
  );
}
