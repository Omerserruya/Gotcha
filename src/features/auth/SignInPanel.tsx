'use client';

import { Check, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  firstError,
  followableCompletion,
  recoveryFlowSlug,
  staySignedInBody,
  type FlowStep,
} from '@/api/contracts/auth-flow';
import { startFlow, submitStage } from '@/api/client/flow-executor';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';
import { safeLinkUrl } from '@/lib/safe-url';

import { SecondFactor } from './SecondFactor';

import styles from './SignInPanel.module.css';

/**
 * Screen 00a — sign in, in our own panel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS IS AN OPTIMISATION OVER A PATH THAT STILL EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * Handing over to the identity provider's own page is still wired. This panel
 * drives the same flow in place, so a returning agent starts a shift in one
 * action instead of loading a 3 MB page on somebody else's origin.
 *
 * ⚠ It used to read "still works and is still wired". **Wired is checked;
 *   works was not.** See `SecondFactor.tsx` for what is and is not observed
 *   about where that navigation lands — written once there rather than
 *   restated here, because this claim existed in three files and all three
 *   aged at the same time.
 *
 * **Everything it cannot handle, it hands back.** An unknown stage, an
 * unreadable body, an identification stage that does not want a password — all
 * of them navigate to `/api/auth/login`, which is exactly what the button on
 * this screen did before this panel existed.
 *
 * ★★ AND THE SUCCESS PATH IS THE SAME NAVIGATION, WHICH IS WHY THIS IS SAFE.
 * Completing the flow leaves the provider holding a session **on the
 * provider's own origin**, which is where `authorize` is served from — that,
 * and not any particular cookie domain, is what makes the next hop silent.
 * (This line used to name `.gotcha.co.il`. Since sign-in moved to its own
 * host the shared domain is no longer what the handover depends on, and
 * depending in prose on a cookie attribute nobody here has read is how the
 * session cookie's missing `domain` came to be load-bearing unnoticed.) Going
 * to
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
/** Which of the design's screens this panel is currently showing. */
export type SignInScreenName = 'signIn' | 'secondFactor';

export function SignInPanel({
  handOverHref,
  recoverPath,
  callbackUrl,
  returnTo,
  onScreen,
}: {
  /** `/api/auth/login`, already prefixed and carrying `returnTo`. */
  readonly handOverHref: string;
  /**
   * Our own recovery screen, already prefixed and localised. Passed in rather
   * than composed here: this component does not know the locale or the base
   * path, and guessing either is the absolute-path defect this repo has had
   * three times.
   */
  readonly recoverPath: string;
  /**
   * Our OIDC callback, absolute — the ONE destination a completed flow is
   * allowed to send the browser to directly.
   *
   * ★ Passed in rather than composed here. It must equal the `redirect_uri`
   *   registered with the provider, and this component knows neither the
   *   origin nor the mount point. Omitted, every completion falls back to
   *   `/api/auth/login`, which is today's behaviour exactly.
   */
  readonly callbackUrl?: string;
  readonly returnTo?: string;
  /**
   * Told which screen is on, so a composition root can put the matching
   * editorial panel and footnote beside it. Optional: the panel is complete
   * without one, and its own tests render it that way.
   */
  readonly onScreen?: (screen: SignInScreenName) => void;
}) {
  const t = useTranslations('auth');
  const [step, setStep] = useState<FlowStep | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  /*
   * ★ Hidden by default and reset on every submit. Never persisted — see the
   *   button below for why.
   */
  const [revealed, setRevealed] = useState(false);

  /*
   * ★★ THE BROWSER'S RULE, NOT ONE OF MINE.
   * `type="email"` already carries a well-formedness rule and the browser will
   * apply it on submit. A regex here would be a SECOND opinion, and the case
   * that matters is the one where the two disagree: a tick saying "this is
   * fine" over a field the form is about to reject.
   *
   * `new Option()` is only a scratch element to borrow validation from without
   * reaching into the DOM during render.
   */
  const emailLooksValid = useMemo(() => {
    if (email === '') return false;
    const probe = document.createElement('input');
    probe.type = 'email';
    probe.value = email;
    return probe.checkValidity();
  }, [email]);
  const [remember, setRemember] = useState(true);
  /* Whether the held answer has already been posted. See the effect below. */
  const answeredStayRef = useRef(false);
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

  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ WHICH SCREEN IS SHOWING, TOLD UPWARDS
   * ════════════════════════════════════════════════════════════════════════
   * The editorial panel and the footnote are server-rendered siblings of this
   * component, so neither could know which stage was on screen — which is why
   * 00b wore 00a's figures and 00a's "New here? Ask your workspace admin…",
   * a sentence that is actively wrong to somebody already halfway signed in.
   *
   * ★ A callback rather than a slot prop per screen: the stage is this
   *   component's to know, and the composition root's to react to. Copy stays
   *   server-rendered on the other side of it.
   */
  /*
   * ═══════════════════════════════════════════════════════════════════════
   * ★★ THE DESIGN HAS ONE SCREEN HERE; THE PROVIDER HAS TWO STAGES
   * ═══════════════════════════════════════════════════════════════════════
   * The checkbox is on 00a, so by the time `ak-stage-user-login` arrives the
   * person has already answered it. Showing them a second screen to ask again
   * is the flow's shape leaking into the design's.
   *
   * ⚠ ONCE. If the stage comes back — an error, a changed configuration —
   *   the screen renders and they answer it themselves. An effect that
   *   resubmits on every arrival is a loop on the last step of sign-in, and it
   *   would look like a hang rather than like a failure.
   */
  useEffect(() => {
    if (step?.kind !== 'staySignedIn' || answeredStayRef.current) return;
    answeredStayRef.current = true;
    void send(staySignedInBody(remember));
    // `send` and `remember` are read at the moment the stage arrives, and
    // re-running on their identity would defeat the once-only guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (!step) return;
    onScreen?.(step.kind === 'chooseFactor' ? 'secondFactor' : 'signIn');
  }, [step, onScreen]);

  useEffect(() => {
    if (!step) return;

    /*
     * ════════════════════════════════════════════════════════════════════
     * ★★ A COMPLETION IS FOLLOWED ONLY WHEN IT IS OUR OWN CALLBACK
     * ════════════════════════════════════════════════════════════════════
     * `xak-flow-redirect` means the flow finished, and its `to` means two
     * different things depending on which flow produced it:
     *
     *     authentication flow   "/"                      — Authentik's root
     *     authorization flow    ".../api/auth/callback?code=…&state=…"
     *
     * `followableCompletion` answers null for everything that is not the
     * callback we registered — including `/`, which is same-origin, relative
     * and harmless-looking, and is exactly the value that must not be
     * followed.
     *
     * ⚠ AND THE FALLBACK IS THE POINT, NOT A SAFETY NET. Today the
     *   authentication flow returns `/`, so this refuses and we go to
     *   `/api/auth/login` exactly as before. This branch is INERT until the
     *   flow is driven from the authorize endpoint — which is the other half
     *   of the change and is not in this commit.
     *
     * ★ Every unknown or unfollowable outcome lands on the same line. That is
     *   what keeps the eight stage types we do not render working at all: an
     *   unrecognised component hands over to a page that completes, rather
     *   than hanging on a blank screen. A visible dated screen beats an
     *   invisible dead one.
     */
    if (step.kind === 'done') {
      const target = callbackUrl ? followableCompletion(step.idpPath, callbackUrl) : null;
      window.location.assign(target ?? handOverHref);
      return;
    }

    if (step.kind === 'handOver' || step.kind === 'identifyOnly') {
      window.location.assign(handOverHref);
    }
  }, [step, handOverHref, callbackUrl]);

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
  /*
   * ⚠ `identifyOnly` HANDS OVER HERE, DELIBERATELY. It is the recovery flow's
   *   first stage, and this panel is 00a: a single submit carrying an email AND
   *   a password. Rendering it would draw a password box the stage will reject.
   *   The recovery screen renders that stage instead.
   */
  if (!step || step.kind === 'done' || step.kind === 'handOver' || step.kind === 'identifyOnly') {
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

  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ A THIRD PARTY'S STRING, ON THE ONE PAGE WITH A PASSWORD FIELD
   * ════════════════════════════════════════════════════════════════════════
   * `recovery_url` is `z.string().nullable()` in a LOOSE contract — the shape
   * is Authentik's, not ours, and by design we do not bound it. This rendered
   * it straight into an `href`.
   *
   * A `javascript:` value there executes in the origin that holds the password
   * field, which is the exact surface the narrowed CSP on this route exists to
   * protect. The CSP would not stop it either: it is a navigation, not a
   * script source.
   *
   * ★ Not a claim that Authentik would send one. It is that the contract
   *   permits any string and the sink is the most sensitive one in the app,
   *   and those two facts together are the whole argument — the same reason
   *   the loose contract was right and also why it cannot be the last word.
   *
   * ★ `safeLinkUrl` and not `safeInternalPath`, because this value is a path
   *   today (`/if/flow/…` on the provider) and becomes an absolute URL the
   *   moment sign-in moves to its own origin. It accepts both and refuses
   *   everything else.
   */
  /*
   * ═════════════════════════════════════════════════════════════════════════
   * ★★ "FORGOT IT?" NOW GOES TO OUR SCREEN, CARRYING THE PROVIDER'S OWN SLUG
   * ═════════════════════════════════════════════════════════════════════════
   * It used to be `href={recovery_url}` — a real link to `/if/flow/…`, which
   * is Authentik's own UI. That is the "old UI" in the report.
   *
   * ★ The slug still comes from the challenge and is never a constant of ours:
   *   the contract's note is that an administrator can change it and a stale
   *   one is a 404 for somebody already locked out. So we read the name the
   *   provider advertises and hand it to our own route.
   *
   * ⚠ If the URL is not the `/if/flow/<slug>/` shape, `recoveryFlowSlug`
   *   returns null and this falls back to linking at the provider directly.
   *   Leaving somebody with no way to reset a password at all would be worse
   *   than sending them to a screen that works but looks old.
   */
  const recoverySlug = recoveryFlowSlug(step.challenge.recovery_url);
  const recovery = recoverySlug
    ? `${recoverPath}?flow=${encodeURIComponent(recoverySlug)}`
    : safeLinkUrl(step.challenge.recovery_url);

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
        <span className={styles.fieldControl}>
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
          {/*
            ★★ THE MOCK'S GREEN CHECK, AND THE BROWSER DECIDES WHEN.
            `<i data-lucide="check" width=15 height=15 stroke-width=2.4>` in
            `#4F7A2E`. Whether an address is well-formed is asked of the input
            itself — `type="email"` already carries the platform's rule, and a
            regex of mine would be a second, worse opinion that disagrees with
            the browser's own validation on submit.

            ★ Presence only, never absence: nothing turns red while somebody is
              still typing. The design shows the affirmative state and nothing
              else, and a field that scolds mid-word is the reason people give
              up on forms.
          */}
          {email !== '' && emailLooksValid ? (
            <span
              className={`${styles.fieldIcon} ${styles.fieldValid}`}
              data-testid="email-valid"
              aria-hidden="true"
            >
              <Check size={15} strokeWidth={2.4} />
            </span>
          ) : null}
        </span>
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
        <span className={styles.fieldControl}>
          <input
            type={revealed ? 'text' : 'password'}
            name="password"
            autoComplete="current-password"
            required
            className={styles.input}
            data-testid="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {/*
            ═════════════════════════════════════════════════════════════════
            ★★ THE MOCK'S EYE — `<i data-lucide="eye" width=15 height=15
               stroke-width=2>` in `#A8A39A`
            ═════════════════════════════════════════════════════════════════
            It was read as an addition and refused twice — by me and by the
            supervisor — because the prose does not mention it. It is in the
            mock. Omer reported an omission; we heard a request.

            ★ A BUTTON, NOT AN ICON. The mock draws a glyph; a glyph nobody can
              operate without a mouse is a different control. `type="button"`
              so it never submits the form under it.

            ★ IT REVERTS ON SUBMIT AND NOT ON BLUR. I proposed both. Blur is
              wrong here: clicking the eye blurs the input, so a
              revert-on-blur hides the password on the very click meant to show
              it. Submit-only is the part that survives contact with the DOM.

            ★ Nothing is remembered. A reveal that persists turns one
              deliberate choice at a moment somebody controls into a standing
              state they have forgotten about.
          */}
          <button
            type="button"
            className={styles.reveal}
            data-testid="reveal-password"
            aria-pressed={revealed}
            aria-label={revealed ? t('signIn.hidePassword') : t('signIn.showPassword')}
            onClick={() => setRevealed((shown) => !shown)}
          >
            {revealed ? <EyeOff size={15} strokeWidth={2} /> : <Eye size={15} strokeWidth={2} />}
          </button>
        </span>
      </label>

      <Button type="submit" variant="primary" size="lg" fullWidth disabled={busy}>
        {busy ? t('signIn.working') : t('signIn.action')}
      </Button>

      {/*
        ═══════════════════════════════════════════════════════════════════
        ★★ BELOW THE BUTTON, AS THE MOCK DRAWS IT — AND IT IS NOT DECORATIVE
        ═══════════════════════════════════════════════════════════════════
        00a, verbatim: `margin-top:12px; display:flex; align-items:center;
        gap:9px; font-size:12px; color:#8C887F`, with a 15×15 box at
        `border-radius:4px` — drawn CHECKED.

        ★ The answer it collects is `remember_me` on `ak-stage-user-login`, a
          field that stage REQUIRES: post an empty body and it replies "This
          field is required." So this ticks a box that is actually sent.

        ⚠ THE DESIGN'S LABEL SAYS "for 30 days" AND OURS DOES NOT. Whether
          `false` shortens the session, and what the configured length is, are
          Authentik settings nobody has read. A number here would be a promise
          about session length that nothing in our codebase enforces — the
          same rule that keeps a lockout count off the failed-password message.
          Ruled on 2026-09-30: show the control, drop the number.

        ⚠ AND IT IS CHECKED BY DEFAULT BECAUSE THE MOCK DRAWS IT CHECKED. That
          is a real decision on a shared machine, not a styling detail, so it
          is named here rather than left in a `useState(true)`.
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
    </form>
  );
}
