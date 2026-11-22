'use client';

import { Check, Eye, EyeOff, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { startFlow, submitStage } from '@/api/client/flow-executor';
import { acceptSetupTerms } from '@/api/client/setup-consent';
import {
  consentBody,
  isNewPasswordPrompt,
  newPasswordBody,
  staySignedInBody,
  type FlowStep,
} from '@/api/contracts/auth-flow';
import { GoogleButton } from '@/design-system/brand/GoogleButton';
import { OrRule } from '@/design-system/patterns/OrRule';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';
import { UserText } from '@/design-system/primitives/text/UserText';
import { TermsBox } from '@/shell/terms/TermsBox';

import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  resetProblems,
  rulesMet,
  type ResetProblem,
} from './password-rules';
import styles from './Recover.module.css';

/** Which link this is: a reset someone asked for, or an invited user's first password. */
export type ResetPurpose = 'reset' | 'setup';

/**
 * What the link carried: the provider's flow token, or (a setup link since
 * 2026-10-26) our own setup token, which is exchanged for one only once the
 * terms are accepted.
 */
export type ResetLink =
  | { readonly kind: 'flow'; readonly token: string }
  | { readonly kind: 'setup'; readonly token: string };

type Phase =
  | { readonly name: 'ready'; readonly unreachable: boolean }
  | { readonly name: 'opening' }
  | { readonly name: 'form'; readonly email: string | null }
  | { readonly name: 'done'; readonly signedIn: boolean }
  | { readonly name: 'hasPassword' }
  | { readonly name: 'expired' }
  | { readonly name: 'unexpected' };

/**
 * Password recovery, screen two: the link from the email (and an invited
 * user's setup link), in our own panel - no Authentik page anywhere.
 *
 * The flow, captured on dev (2026-10-22, Authentik 2026.2):
 *   GET executor ?query=flow_token=…  → ak-stage-consent (reset) or the prompt (setup)
 *   POST { token }                    → ak-stage-prompt: password + password_repeat
 *   POST the two                      → the prompt again with errors, or
 *                                       ak-stage-user-login → xak-flow-redirect
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ NOTHING IS ASKED OF THE EXECUTOR UNTIL THE PERSON PRESSES CONTINUE
 * ════════════════════════════════════════════════════════════════════════════
 * The token is spent by the first GET that carries it (`revoke_on_execution`),
 * and a dead token is SILENT: the flow just starts over at identification.
 * Mail scanners open links, and some run the page's script. Starting on mount
 * would let one of them spend the link before its owner sees it - and the
 * owner would then read "expired" on a link they never used. So the page
 * opens on a button, which no scanner presses. Authentik's consent stage
 * exists for the same reason; it is answered for the person once they have.
 *
 * ★ The token is taken out of the address bar as soon as the page has it, so
 *   it is not left in history, in a screenshot or in a copied link.
 *
 * ── A FIRST PASSWORD ACCEPTS THE TERMS FIRST (Omer, 2026-10-26) ──
 * On a setup link the ready screen carries a required checkbox: the Terms of
 * Service and the Privacy Policy, each a link to the trust site in the page's
 * language. Continue stays disabled until it is
 * ticked, and Continue sends the acceptance before anything else: the server
 * records it and only then mints the flow token, so a password cannot be set
 * without it (services/auth setup-link.ts). The label is sent as it was shown,
 * read from the page, as the record's evidence. Everyone who sets a first
 * password accepts - an invitee too: the Terms bind each user (Backend).
 * A box nothing records is never shown: see the initial phase.
 */
export function ResetPanel({
  flow,
  link,
  purpose,
  loginHref,
  signInHref,
  recoverHref,
  google,
}: {
  readonly flow: string;
  readonly link: ResetLink;
  readonly purpose: ResetPurpose;
  /** The app's own sign-in hand-over: the reset leaves a provider session, so it completes. */
  readonly loginHref: string;
  readonly signInHref: string;
  /**
   * Screen one, for a new link - on a reset only. An invite's new link comes
   * from whoever invited them: screen one mails an EXISTING account, and an
   * invite whose link died may not have one yet.
   */
  readonly recoverHref: string | null;
  /**
   * Google, on a setup link whose state says it is on (Backend's `google`
   * flag), with the address the invitation went to. Absent: no Google here.
   */
  readonly google?: { readonly email: string | null } | null;
}) {
  const t = useTranslations('auth.recover.reset');
  const tg = useTranslations('auth.google');
  const ts = useTranslations('auth.signIn');
  const tr = useTranslations('auth.recover');
  const locale = useLocale() === 'he' ? 'he' : 'en';
  /*
   * A setup link that arrives with the provider's token was minted before the
   * acceptance existed: nothing would record a tick, so it reads expired and
   * the emailed link, opened again, takes the new path (Backend).
   */
  const [phase, setPhase] = useState<Phase>(
    purpose === 'setup' && link.kind === 'flow'
      ? { name: 'expired' }
      : { name: 'ready', unreachable: false },
  );
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [shown, setShown] = useState({ password: false, repeat: false });
  const [problems, setProblems] = useState<readonly ResetProblem[]>([]);
  const [transport, setTransport] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The password the server found in a breach: its row reads failed while the field holds it. */
  const [breached, setBreached] = useState<string | null>(null);
  /** The terms, on a setup link: required before Continue. */
  const [accepted, setAccepted] = useState(false);
  const termsLabel = useRef<HTMLSpanElement>(null);
  const needsTerms = purpose === 'setup';
  /** The flow and its query: from the link, or from the acceptance on a setup link. */
  const [started, setStarted] = useState<{ flow: string; query: string } | null>(
    link.kind === 'flow'
      ? { flow, query: new URLSearchParams({ flow_token: link.token }).toString() }
      : null,
  );
  const active = started ?? { flow, query: '' };

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('flow_token') && !url.searchParams.has('setup')) return;
    url.searchParams.delete('flow_token');
    url.searchParams.delete('setup');
    window.history.replaceState(window.history.state, '', url);
  }, []);

  /** Where a step leaves this screen. */
  function land(step: FlowStep, email: string | null) {
    if (step.kind === 'prompt' && isNewPasswordPrompt(step.challenge)) {
      setPhase({ name: 'form', email });
      return;
    }
    // A spent, expired or unknown token starts the flow over, silently, here.
    if (step.kind === 'identifyOnly' || step.kind === 'identify') {
      setPhase({ name: 'expired' });
      return;
    }
    setPhase({ name: 'unexpected' });
  }

  /* Pressed Google: the Terms are being recorded, then the page leaves. */
  const [leaving, setLeaving] = useState(false);

  /*
   * ═════════════════════════════════════════════════════════════════════════
   * ★★ GOOGLE FROM A SETUP LINK: THE TERMS FIRST, THEN SIGN-IN (2026-11-22)
   * ═════════════════════════════════════════════════════════════════════════
   * The acceptance is what records the consent (Backend), so it runs exactly
   * as Continue runs it - the same call, the same words - before the page
   * leaves. Then our own sign-in with `?google=start`, whose panel follows
   * the Google source from ITS OWN challenge: this page never starts the
   * authentication flow (a second flow deletes the first, Backend) and never
   * holds a source slug.
   *
   * ★ The recovery token the acceptance mints goes unused: single use, about
   *   30 minutes, in this person's browser only (Backend: a clean outcome).
   *   The Google sign-in retires the link, and reopened it reads "used".
   */
  async function continueWithGoogle() {
    if (!google || !accepted || link.kind !== 'setup') return;
    setLeaving(true);
    setPhase({ name: 'opening' });
    if (started === null) {
      const outcome = await acceptSetupTerms(link.token, {
        terms: true,
        privacy: true,
        locale,
        capturedText: termsLabel.current?.textContent?.trim() ?? '',
      });
      if (outcome.kind !== 'recovery') setLeaving(false);
      if (outcome.kind === 'unreachable') return setPhase({ name: 'ready', unreachable: true });
      if (outcome.kind === 'expired') return setPhase({ name: 'expired' });
      if (outcome.kind === 'hasPassword') return setPhase({ name: 'hasPassword' });
      if (outcome.kind === 'refused') return setPhase({ name: 'unexpected' });
    }
    // A full load: the sign-in panel starts its own flow, and nothing of this one may linger.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`${signInHref}?google=start`);
  }

  async function open() {
    if (needsTerms && !accepted) return;
    setPhase({ name: 'opening' });
    let target = started;
    if (link.kind === 'setup' && target === null) {
      const outcome = await acceptSetupTerms(link.token, {
        terms: true,
        privacy: true,
        locale,
        capturedText: termsLabel.current?.textContent?.trim() ?? '',
      });
      if (outcome.kind === 'unreachable') return setPhase({ name: 'ready', unreachable: true });
      if (outcome.kind === 'expired') return setPhase({ name: 'expired' });
      if (outcome.kind === 'hasPassword') return setPhase({ name: 'hasPassword' });
      if (outcome.kind === 'refused') return setPhase({ name: 'unexpected' });
      target = {
        flow: outcome.flow,
        query: new URLSearchParams({ flow_token: outcome.flowToken }).toString(),
      };
      setStarted(target);
    }
    if (target === null) return setPhase({ name: 'unexpected' });
    const { flow: flowSlug, query } = target;
    let step = await startFlow(flowSlug, query);
    if (!step) return setPhase({ name: 'ready', unreachable: true });
    /*
     * A live link opens on consent (a reset) or straight on the prompt (an
     * invite). Anything else, with a token in hand, is the token being dead:
     * the flow restarted (identification) or refused - and says neither.
     */
    if (step.kind !== 'consent' && step.kind !== 'prompt') return setPhase({ name: 'expired' });
    let email: string | null = null;
    if (step.kind === 'consent') {
      email = step.challenge.pending_user.trim() || null;
      const consented = await submitStage(consentBody(step.challenge), flowSlug, query);
      if (!consented.ok) return setPhase({ name: 'ready', unreachable: true });
      step = consented.step;
    }
    land(step, email);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || phase.name !== 'form') return;
    setTransport(false);
    // The server is the authority; these only say early what it would say.
    const early: ResetProblem[] =
      password === '' || repeat === ''
        ? [{ kind: 'required' }]
        : rulesMet(password).size < PASSWORD_RULES.length
          ? [{ kind: 'rules' }]
          : password !== repeat
            ? [{ kind: 'mismatch' }]
            : [];
    setProblems(early);
    if (early.length > 0) return;

    setBusy(true);
    const { flow: flowSlug, query } = active;
    const outcome = await submitStage(newPasswordBody(password, repeat), flowSlug, query);
    if (!outcome.ok) {
      setBusy(false);
      setTransport(true);
      return;
    }
    const step = outcome.step;
    if (step.kind === 'prompt') {
      setBusy(false);
      const refused = resetProblems(step.challenge.response_errors);
      setProblems(refused);
      setBreached(refused.some((p) => p.kind === 'leaked') ? password : null);
      return;
    }
    setShown({ password: false, repeat: false });
    /*
     * An invite's dead token is only found out here: its flow has no
     * identification stage, so a spent link opens on the same prompt as a live
     * one, and the submit is refused (dev, measured 2026-10-22). Nothing was
     * created or changed; what was typed is not kept for a retry.
     */
    if (step.kind === 'handOver' && step.because === 'ak-stage-access-denied') {
      setBusy(false);
      setPassword('');
      setRepeat('');
      setProblems([]);
      setPhase({ name: 'expired' });
      return;
    }
    if (step.kind === 'staySignedIn') {
      // The password is saved. Not "stay signed in for 30 days" on someone's behalf.
      const login = await submitStage(staySignedInBody(false), flowSlug, query);
      setBusy(false);
      setPhase({ name: 'done', signedIn: login.ok && login.step.kind === 'done' });
      return;
    }
    setBusy(false);
    if (step.kind === 'done') return setPhase({ name: 'done', signedIn: true });
    land(step, phase.email);
  }

  if (phase.name === 'done') {
    return (
      <div className={styles.done} data-testid="reset-done">
        <Text role="title" as="h1">
          {t(`purpose.${purpose}.doneTitle`)}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t(`purpose.${purpose}.doneBody`)}
        </Text>
        {/* Signed in at the provider: the app's hand-over completes without a password. */}
        <Button asChild variant="primary" size="lg" fullWidth>
          <a href={phase.signedIn ? loginHref : signInHref} data-testid="reset-continue">
            {phase.signedIn ? t('continueSignedIn') : t('signIn')}
          </a>
        </Button>
      </div>
    );
  }

  if (phase.name === 'hasPassword') {
    return (
      <div className={styles.done} data-testid="reset-has-password">
        <Text role="title" as="h1">
          {t('hasPassword.title')}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t('hasPassword.body')}
        </Text>
        <Button asChild variant="primary" size="lg" fullWidth>
          <a href={signInHref} data-testid="reset-continue">
            {t('signIn')}
          </a>
        </Button>
      </div>
    );
  }

  if (phase.name === 'expired' || phase.name === 'unexpected') {
    const which = phase.name;
    return (
      <div className={styles.done} data-testid={`reset-${which}`}>
        <Text role="title" as="h1">
          {t(`${which}.title`)}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t(recoverHref ? `${which}.body` : `${which}.setupBody`)}
        </Text>
        {recoverHref ? (
          <Button asChild variant="primary" size="lg" fullWidth>
            <a href={recoverHref} data-testid="reset-resend">
              {t('expired.resend')}
            </a>
          </Button>
        ) : null}
        <a className={styles.back} href={signInHref}>
          {tr('back')}
        </a>
      </div>
    );
  }

  if (phase.name !== 'form') {
    return (
      <div className={styles.form} data-testid="reset-ready">
        <Text role="title" as="h1">
          {t(`purpose.${purpose}.title`)}
        </Text>
        <Text role="body" tone="muted" as="p" className={styles.lede}>
          {t(`purpose.${purpose}.lede`)}
        </Text>
        {phase.name === 'ready' && phase.unreachable ? (
          <p className={styles.notice} role="alert" data-testid="reset-unreachable">
            {t('problem.unreachable')}
          </p>
        ) : null}
        {needsTerms ? (
          <TermsBox
            checked={accepted}
            onChange={setAccepted}
            disabled={phase.name === 'opening'}
            labelRef={termsLabel}
            testIdPrefix="reset"
          />
        ) : null}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          disabled={phase.name === 'opening' || (needsTerms && !accepted)}
          onClick={() => void open()}
          data-testid="reset-open"
        >
          {phase.name === 'opening' && !leaving ? t('starting') : t('continue')}
        </Button>
        {needsTerms && google ? (
          <>
            <OrRule word={tg('or')} />
            <GoogleButton
              label={leaving ? tg('busy') : tg('continue')}
              disabled={phase.name === 'opening' || !accepted}
              onClick={() => void continueWithGoogle()}
              testId="reset-google"
            />
            <p className={styles.googleHint} data-testid="reset-google-hint">
              {google.email
                ? tg.rich('setupHint', {
                    email: () => <bdi dir="ltr">{google.email}</bdi>,
                  })
                : tg('setupHintNoEmail')}
            </p>
          </>
        ) : null}
      </div>
    );
  }

  const met = rulesMet(password);
  const has = (kind: ResetProblem['kind']) => problems.some((p) => p.kind === kind);
  const passwordInvalid =
    has('rules') || has('weak') || has('leaked') || (has('required') && password === '');
  const repeatInvalid = has('mismatch') || (has('required') && repeat === '');

  return (
    <form className={styles.form} onSubmit={save} data-testid="reset-form" noValidate>
      <Text role="title" as="h1">
        {t(`purpose.${purpose}.title`)}
      </Text>
      {phase.email ? (
        <Text role="body" tone="muted" as="p" className={styles.lede}>
          {t.rich('formFor', {
            email: phase.email,
            user: (chunks) => <UserText>{chunks}</UserText>,
          })}
        </Text>
      ) : null}

      {problems.length > 0 || transport ? (
        <div className={styles.notice} role="alert" data-testid="reset-problem">
          {transport ? <p className={styles.noticeLine}>{t('problem.unreachable')}</p> : null}
          {problems.map((problem) => (
            <p
              key={problem.kind === 'said' ? `said:${problem.text}` : problem.kind}
              className={styles.noticeLine}
            >
              {problem.kind === 'said' ? problem.text : t(`problem.${problem.kind}`)}
            </p>
          ))}
        </div>
      ) : null}

      <PasswordField
        label={t('password')}
        name="password"
        value={password}
        onChange={setPassword}
        revealed={shown.password}
        onReveal={() => setShown((s) => ({ ...s, password: !s.password }))}
        invalid={passwordInvalid}
        describedBy="reset-rules"
        showLabel={ts('showPassword')}
        hideLabel={ts('hidePassword')}
        autoFocus
      />

      <div className={styles.rules} id="reset-rules" data-testid="reset-rules">
        <p className={styles.rulesTitle}>{t('rules.title')}</p>
        <ul className={styles.ruleList}>
          {PASSWORD_RULES.map((rule) => (
            <li
              key={rule}
              className={styles.rule}
              data-met={met.has(rule) ? 'yes' : 'no'}
              data-testid={`reset-rule-${rule}`}
            >
              <span className={styles.ruleMark} aria-hidden="true">
                {met.has(rule) ? <Check size={13} strokeWidth={2.4} /> : null}
              </span>
              {t(`rules.${rule}`, { min: PASSWORD_MIN_LENGTH })}
              {met.has(rule) ? <span className="srOnly"> ({t('rules.met')})</span> : null}
            </li>
          ))}
          {/* Only the server can check this one, on save. */}
          {/*
            Unknown until the server answers; failed while the field still holds
            the password it found in a breach, so the list agrees with the
            message above it. Any change returns it to unknown.
          */}
          <li
            className={styles.rule}
            data-met={breached !== null && breached === password ? 'failed' : 'unknown'}
            data-testid="reset-rule-leaked"
          >
            <span className={styles.ruleMark} aria-hidden="true">
              {breached !== null && breached === password ? (
                <X size={11} strokeWidth={2.6} />
              ) : null}
            </span>
            {t('rules.leaked')}
            {breached !== null && breached === password ? (
              <span className="srOnly"> ({t('rules.failed')})</span>
            ) : null}
          </li>
        </ul>
      </div>

      <PasswordField
        label={t('confirm')}
        name="password_repeat"
        value={repeat}
        onChange={setRepeat}
        revealed={shown.repeat}
        onReveal={() => setShown((s) => ({ ...s, repeat: !s.repeat }))}
        invalid={repeatInvalid}
        showLabel={ts('showPassword')}
        hideLabel={ts('hidePassword')}
      />

      <Button type="submit" variant="primary" size="lg" fullWidth disabled={busy}>
        {busy ? t('saving') : t('save')}
      </Button>
    </form>
  );
}

/** 00a's password field: the input and its eye, one per field. */
function PasswordField({
  label,
  name,
  value,
  onChange,
  revealed,
  onReveal,
  invalid,
  describedBy,
  showLabel,
  hideLabel,
  autoFocus = false,
}: {
  readonly label: string;
  readonly name: 'password' | 'password_repeat';
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly revealed: boolean;
  readonly onReveal: () => void;
  readonly invalid: boolean;
  readonly describedBy?: string;
  readonly showLabel: string;
  readonly hideLabel: string;
  readonly autoFocus?: boolean;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={styles.fieldControl}>
        <input
          type={revealed ? 'text' : 'password'}
          name={name}
          // Both are the NEW password: a manager offers to generate and save it.
          autoComplete="new-password"
          autoFocus={autoFocus}
          required
          className={styles.input}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          data-testid={`reset-${name}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className={styles.reveal}
          aria-pressed={revealed}
          aria-label={revealed ? hideLabel : showLabel}
          onClick={onReveal}
          data-testid={`reset-reveal-${name}`}
        >
          {revealed ? <EyeOff size={15} strokeWidth={2} /> : <Eye size={15} strokeWidth={2} />}
        </button>
      </span>
    </label>
  );
}
