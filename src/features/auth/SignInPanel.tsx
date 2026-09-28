'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { firstError, staySignedInBody, type FlowStep } from '@/api/contracts/auth-flow';
import { startFlow, submitStage } from '@/api/client/flow-executor';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';

import { SecondFactor } from './SecondFactor';

import styles from './SignInPanel.module.css';

/**
 * Screen 00a — sign in, in our own panel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS IS AN OPTIMISATION OVER A PATH THAT STILL EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * Handing over to the identity provider's own page still works and is still
 * wired. This panel drives the same flow in place, so a returning agent starts a
 * shift in one action instead of loading a 3 MB page on somebody else's origin.
 *
 * **Everything it cannot handle, it hands back.** An unknown stage, an
 * unreadable body, an identification stage that does not want a password — all
 * of them navigate to `/api/auth/login`, which is exactly what the button on
 * this screen did before this panel existed.
 *
 * ★★ AND THE SUCCESS PATH IS THE SAME NAVIGATION, WHICH IS WHY THIS IS SAFE.
 * Completing the flow sets an Authentik session on `.gotcha.co.il`; going to
 * `/api/auth/login` then runs OIDC, sees that session, and returns silently with
 * a code. Handing over goes to the same URL with no session, so the identity
 * provider renders its page and the person finishes there. **One destination,
 * two meanings, and the wrong guess about which one we are in is harmless.**
 *
 * So nothing here is reimplemented: PKCE, state, the login-state cookie,
 * `safeReturnPath` and the `returnTo` round trip are untouched. That round trip
 * is already what satisfies the design's *"signing in returns you to the exact
 * conversation you were reading"*.
 *
 * ── WHAT THE DESIGN ASKS FOR THAT IS NOT HERE, AND WHY ──
 * 00a specifies a code by WhatsApp offered after a failed password, a
 * three-attempt fallback, and two-step in this panel. **None of the three is
 * built, and the reason is that nobody can currently show they are possible.**
 *
 * Driven on 2026-09-28 for a user with no enrolled device, the flow is two
 * stages and reports `device_challenges: []`. That is consistent with the flow
 * having no authenticator stage AND with it having one this user skips — the
 * endpoints that would settle it answer 403 without admin credentials. Recovery
 * has only been observed as far as its first stage, because driving it further
 * sends somebody a real password-reset email.
 *
 * ★ So this is not "the capability does not exist". It is **"nobody has seen it,
 *   in either direction"**, and copy that offers a code path or counts attempts
 *   would be a promise made on an unread policy to the one person on this screen
 *   who cannot get in by trying harder.
 *
 * ⚠⚠ AND THE HANDOVER FOR MFA IS A DEVIATION FROM THE DESIGN, NOT A PROPERTY OF
 *   THE PLATFORM. This wording matters, because the first version of this note
 *   read as though Authentik required its own page for two-step. **It does not.**
 *   `ak-stage-authenticator-validate` comes back from the same executor endpoint,
 *   in the same envelope, with the same `response_errors` convention as the two
 *   stages rendered below. **We hand over because we have no renderer, and for no
 *   other reason.**
 *
 *   The design is explicit that this is wrong: *"Two-step sign-in, where the
 *   workspace requires it, happens in this same panel — never on a new page with
 *   a different layout"*, and *"where two-step is required and not yet set up,
 *   this same panel becomes enrolment"*.
 *
 *   ★ THE ONLY BLOCKER IS THAT NOBODY HAS AN ENROLLED ACCOUNT, so nobody has
 *     seen the challenge shape. Not the API, not the architecture, not the
 *     proxy — one missing observation. Enrolling TOTP on the dev test account
 *     removes it, and TOTP needs no SMS gateway and no WhatsApp.
 *
 *   ⚠ Building the renderer from Authentik's documentation instead would be
 *     inventing a challenge shape for the one screen where being wrong locks
 *     somebody out of their own account — and `ak-stage-user-login` already
 *     proved the payload does not describe its own inputs: `remember_me` is
 *     REQUIRED and is named by none of the four keys the challenge returns. A
 *     renderer written from docs would be a guess wearing a schema.
 *
 *   ⚠ AND THE HANDOVER MAY BE WORSE THAN INCOMPLETE. It happens **after** the
 *     password was accepted. Whether the identity provider's page resumes the
 *     in-progress flow from its cookie or asks for the password again is
 *     unobserved, and it is the difference between a seam and losing somebody's
 *     typing. The same enrolment answers it.
 */
export function SignInPanel({
  handOverHref,
  returnTo,
}: {
  /** `/api/auth/login`, already prefixed and carrying `returnTo`. */
  readonly handOverHref: string;
  readonly returnTo?: string;
}) {
  const t = useTranslations('auth');
  const [step, setStep] = useState<FlowStep | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * `void` and a plain effect rather than a transition: this runs once on mount
   * and nothing depends on its timing. A failure to start is a handover, not an
   * error message — the panel has nothing to show if it never got a stage.
   */
  useEffect(() => {
    let live = true;
    void startFlow().then((first) => {
      if (!live) return;
      if (!first) {
        window.location.assign(handOverHref);
        return;
      }
      setStep(first);
    });
    return () => {
      live = false;
    };
  }, [handOverHref]);

  useEffect(() => {
    if (!step) return;
    /*
     * Both of these leave for `/api/auth/login`. On `done` it completes OIDC
     * silently; on `handOver` the identity provider renders its own page.
     *
     * ⚠ `done` carries `idpPath`, which is Authentik's own destination — `/` on
     * its origin. Following it would land somebody who has just signed in
     * successfully on a stranger's home page.
     */
    if (step.kind === 'done' || step.kind === 'handOver') {
      window.location.assign(handOverHref);
    }
  }, [step, handOverHref]);

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await submitStage(body);
    setBusy(false);

    if (!outcome.ok) {
      /*
       * ★ NOT A HANDOVER AND NOT "WRONG PASSWORD". The executor answers 200 with
       * `response_errors` when it refuses, so a transport failure means the proxy
       * or the network — and moving somebody to another screen would throw away
       * what they typed for a problem that a second press often fixes.
       */
      setProblem(t('signIn.unreachable'));
      return;
    }

    const said = firstError(
      outcome.step.kind === 'identify' || outcome.step.kind === 'staySignedIn'
        ? outcome.step.challenge.response_errors
        : undefined,
    );
    /*
     * ★★ THE STAGE'S OWN SENTENCE, NOT OURS. Authentik deliberately does not say
     * whether the email or the password was wrong; inventing a more specific
     * message would undo that, and telling an attacker which half they got right
     * turns an address list into an account list.
     */
    if (said) setProblem(said);
    setStep(outcome.step);
  }

  /* Nothing to show until the first stage lands. */
  if (!step || step.kind === 'done' || step.kind === 'handOver') {
    return <p className={styles.loading}>{t('signIn.starting')}</p>;
  }

  if (step.kind === 'chooseFactor') {
    /*
      ★★ THE SECOND FACTOR, IN THIS PANEL — which is what the design asks for and
      what the handover was a deviation from. It renders `totp` and `static`;
      `webauthn`, `duo` and `sms` call `onHandOver`, because each is a different
      journey nobody has observed and the schema agrees by giving them separate
      fields.

      `email` rather than `pending_user`: the server sends a username — observed
      as `akadmin` — and a screen that names an internal account halfway through
      sign-in is where somebody wonders whether they are in the right place.
      What they typed a moment ago is in this component's state already.
    */
    return (
      <SecondFactor
        challenge={step.challenge}
        email={email}
        busy={busy}
        problem={problem}
        onSubmit={(body) => void send(body)}
        onHandOver={() => window.location.assign(handOverHref)}
      />
    );
  }

  if (step.kind === 'staySignedIn') {
    return (
      <form
        className={styles.form}
        data-testid="stay-signed-in"
        onSubmit={(event) => {
          event.preventDefault();
          void send(staySignedInBody(remember));
        }}
      >
        <div className={styles.intro}>
          <Text role="title" as="h1">
            {t('signIn.title')}
          </Text>
          <Text role="body" tone="muted">
            {t('signIn.body')}
          </Text>
        </div>

        {problem ? (
          <p className={styles.problem} role="alert" data-testid="sign-in-problem">
            {problem}
          </p>
        ) : null}

        {/*
          ★★ THIS CHECKBOX IS NOT DECORATIVE, AND NOTHING IN THE CHALLENGE SAYS
          SO. `ak-stage-user-login` returns four keys and REQUIRES `remember_me`,
          which none of them mention — posting an empty body answers "This field
          is required." So the flow cannot complete without the person's answer,
          and the answer is theirs.

          ⚠ The design's label says "for 30 days". It is not written here,
          because whether `false` shortens the session, and what the configured
          length actually is, are Authentik settings nobody has read. A number in
          this sentence would be a promise about session length that nothing in
          our codebase enforces — the same rule that keeps a lockout count off
          the failed-password message.
        */}
        <label className={styles.remember}>
          <input
            type="checkbox"
            checked={remember}
            data-testid="remember-me"
            onChange={(event) => setRemember(event.target.checked)}
          />
          {t('signIn.remember')}
        </label>

        <Button type="submit" variant="primary" size="lg" fullWidth disabled={busy}>
          {busy ? t('signIn.working') : t('signIn.continue')}
        </Button>
      </form>
    );
  }

  const recovery = step.challenge.recovery_url;

  return (
    <form
      className={styles.form}
      data-testid="sign-in-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send({ uid_field: email, password });
      }}
    >
      <div className={styles.intro}>
        <Text role="title" as="h1">
          {t('signIn.title')}
        </Text>
        {/*
          The design says "You were reading Dana Cohen's conversation." A
          customer's name on a page nobody has authenticated to is a disclosure
          to whoever opens the laptop, so the benefit is kept and the name is
          not: the `returnTo` round trip really does bring them back.
        */}
        <Text role="body" tone="muted">
          {returnTo ? t('signIn.bodyReturning') : t('signIn.body')}
        </Text>
      </div>

      {problem ? (
        <p className={styles.problem} role="alert" data-testid="sign-in-problem">
          {problem}
          {/*
            ★ WHAT TO DO NEXT, AND NOTHING WE CANNOT BACK. The design offers a
            code by WhatsApp after a failed password and a three-attempt
            fallback; neither exists on this tenant. Recovery is email-only, so
            that is what is offered.
          */}
          {recovery ? (
            <>
              {' '}
              <a className={styles.recoveryInline} href={recovery} data-testid="recover-after-fail">
                {t('signIn.forgot')}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>{t('signIn.email')}</span>
        <input
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          required
          className={styles.input}
          data-testid="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.labelRow}>
          <span className={styles.label}>{t('signIn.password')}</span>
          {/*
            `recovery_url` from the challenge, never hardcoded: it is a flow slug
            an administrator can rename, and a stale path sends the one person on
            this screen who cannot get in by trying harder to a 404.

            A plain anchor because it leaves for the identity provider's origin.
          */}
          {recovery ? (
            <a className={styles.forgot} href={recovery} data-testid="forgot">
              {t('signIn.forgot')}
            </a>
          ) : null}
        </span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          className={styles.input}
          data-testid="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <Button type="submit" variant="primary" size="lg" fullWidth disabled={busy}>
        {busy ? t('signIn.working') : t('signIn.action')}
      </Button>
    </form>
  );
}
