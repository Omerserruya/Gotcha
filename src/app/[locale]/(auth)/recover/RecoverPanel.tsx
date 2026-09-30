'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { startFlow, submitStage } from '@/api/client/flow-executor';
import { firstError, type FlowStep } from '@/api/contracts/auth-flow';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';

import styles from './Recover.module.css';

/**
 * Screen one of password recovery: an address, and nothing else.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE DESIGN HAS NO SCREEN FOR THIS. I CHECKED, RATHER THAN ASSUMED.
 * ════════════════════════════════════════════════════════════════════════════
 * `Directions.dc.html` holds 69 rendered frames and not one heading mentions
 * reset, recovery, forgot or password. The design's recovery story is a
 * WhatsApp code — ruled out of scope — so this screen is ours to design inside
 * 00a and 00b's system rather than to copy.
 *
 * ★ Which is why every value here is a token already carrying a mock's number,
 *   and the shell is 00a's: the same frame, the same editorial column, the
 *   same field and button. Nothing new was invented that the design had
 *   already decided.
 *
 * ── WHAT IT DRIVES ──
 * The same executor as sign-in, pointed at a different flow. Its first stage
 * is `ak-stage-identification` with `password_fields: false` — which the
 * contract used to refuse, and which is the whole reason "Forgot it?" landed
 * on the provider's own UI.
 *
 * ⚠ WHAT COMES AFTER IS UNOBSERVED. The flow's bindings suggest an email stage
 *   and then a password prompt, but reaching them means sending real mail, so
 *   their challenge shapes have not been seen. This screen therefore reports
 *   what the executor returns and hands over for anything it does not
 *   recognise, exactly as the sign-in panel does. It does not pretend to know
 *   screen two.
 */
export function RecoverPanel({
  flow,
  signInHref,
}: {
  readonly flow: string;
  readonly signInHref: string;
}) {
  const t = useTranslations('auth.recover');
  const [step, setStep] = useState<FlowStep | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let live = true;
    void startFlow(flow).then((first) => {
      if (live) setStep(first);
    });
    return () => {
      live = false;
    };
  }, [flow]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);

    const outcome = await submitStage({ uid_field: email }, flow);
    setBusy(false);

    if (!outcome.ok) {
      setProblem(t('unreachable'));
      return;
    }

    const said =
      outcome.step.kind === 'identifyOnly' || outcome.step.kind === 'identify'
        ? firstError(outcome.step.challenge.response_errors)
        : null;

    if (said) {
      setProblem(said);
      return;
    }

    /*
     * ★★ ANYTHING THAT IS NOT THE SAME STAGE AGAIN MEANS IT WAS ACCEPTED.
     *
     * We cannot assert what the next challenge looks like — reaching it sends
     * real mail, so it has never been observed. What we CAN say is that the
     * executor stopped asking for an address, and that is exactly the fact
     * this screen needs.
     *
     * ⚠ And the message is the same either way. A recovery form that says
     *   "no such account" tells an attacker which addresses are real; the
     *   stage itself does not distinguish, and neither does this.
     */
    setSent(true);
  }

  if (sent) {
    return (
      <div className={styles.done} data-testid="recover-sent">
        <Text role="title" as="h1">
          {t('sentTitle')}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t('sentBody', { email })}
        </Text>
        <a className={styles.back} href={signInHref}>
          {t('back')}
        </a>
      </div>
    );
  }

  /*
   * ⚠ Until the first challenge arrives there is nothing to draw. Rendering
   *   the form early would let somebody type an address into a flow that has
   *   not started, and the submit would open a fresh one underneath them.
   */
  if (!step) return null;

  return (
    <form className={styles.form} onSubmit={send} data-testid="recover-form" noValidate>
      <Text role="title" as="h1">
        {t('title')}
      </Text>
      <Text role="body" tone="muted" as="p" className={styles.lede}>
        {t('lede')}
      </Text>

      {problem ? (
        <p className={styles.notice} role="alert">
          {problem}
        </p>
      ) : null}

      {/*
        ★ 00a's own field markup, not a new one. There is no `Field` primitive
          in this design system — the sign-in panel writes the label, the
          control wrapper and the input itself, so this screen does the same
          rather than inventing a component the rest of the auth area does not
          use.
      */}
      <label className={styles.field}>
        <span className={styles.label}>{t('email')}</span>
        <span className={styles.fieldControl}>
          <input
            type="email"
            name="email"
            autoComplete="username"
            autoFocus
            required
            className={styles.input}
            data-testid="recover-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </span>
      </label>

      <Button type="submit" disabled={busy} data-testid="recover-submit">
        {busy ? t('sending') : t('submit')}
      </Button>

      <a className={styles.back} href={signInHref} data-testid="recover-back">
        {t('back')}
      </a>
    </form>
  );
}
