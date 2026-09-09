import { getTranslations } from 'next-intl/server';

import { Logo } from '@/design-system/brand/Logo';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';

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

  const loginHref = `/api/auth/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;
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
          <div className={styles.intro}>
            <Text role="title" as="h1">
              {t('signIn.title')}
            </Text>
            <Text role="body" tone="muted">
              {t('signIn.body')}
            </Text>
          </div>

          {knownError ? (
            // `role="alert"` so the reason is announced on arrival, not only
            // discovered by someone who happens to read down the page.
            <p className={styles.notice} role="alert">
              {t(`error.${knownError}`)}
            </p>
          ) : null}

          <Button variant="primary" size="lg" fullWidth asChild>
            {/* A plain anchor: this leaves the app for the identity provider,
                so client-side routing must not intercept it. */}
            <a href={loginHref}>{t('signIn.action')}</a>
          </Button>

          <p className={styles.footnote}>{t('signIn.footnote')}</p>
        </div>
      </main>
    </div>
  );
}
