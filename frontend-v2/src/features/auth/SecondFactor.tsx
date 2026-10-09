'use client';

import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';

import {
  devicesByRecency,
  factorEntry,
  validateBody,
  type AuthenticatorValidateChallenge,
  type DeviceChallenge,
} from '@/api/contracts/auth-flow';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';
import { safeLinkUrl } from '@/lib/safe-url';

import styles from './SecondFactor.module.css';

/**
 * The second factor, in the same panel - screen 00b's first half.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT IS BUILT, AND WHAT DELIBERATELY IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 * The flow permits five device classes. **Two are a code somebody types -
 * `totp` and `static` - and those are built here.** `webauthn` is a browser
 * credential prompt, `duo` is a push waiting for approval, `sms` is an
 * out-of-band message; the schema agrees by giving each its own field
 * (`code` string, `webauthn` object, `duo` integer) rather than one polymorphic
 * value.
 *
 * None of those three is configured on this tenant, none has been observed on
 * the wire, and each is a different journey. Choosing one hands over to the
 * identity provider's page. **That is deliberate and reversible, not an
 * oversight** - the handover is narrowed from "any stage we do not recognise"
 * to "three named classes we have chosen not to build blind".
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THIS PARAGRAPH USED TO SAY THE HANDOVER "STILL WORKS". NOBODY HAS
 *    EVER WALKED IT.
 * ═════════════════════════════════════════════════════════════════════════════
 * No `webauthn`, `duo` or `sms` device exists on this tenant, so the branch
 * has never run against a real one. And the sentence was written **before**
 * two things that change the journey underneath it:
 *
 *   1. sign-in moved to its own origin, so the handover now leaves the auth
 *      host for the product host and comes back;
 *   2. `/api/auth/login` gained a hand-over marker, so this navigation is the
 *      one arrival that still starts OIDC directly rather than being sent
 *      back here.
 *
 * ★★ THE QUESTION HAS BEEN WALKED, AND THE ANSWER IS THE FAVOURABLE ONE.
 *   Driven through this panel to the second-factor stage and handed over from
 *   exactly that state, `authorize` **resumes the in-progress flow** - it does
 *   not start a new one:
 *
 *       after handover   /if/flow/default-authentication-flow/
 *                        asksPasswordAgain: false
 *       the screen       "Two-step verification … enter the code from your
 *                        authenticator app", "Welcome back, akadmin"
 *
 *   So the handover lands in a continuing journey with the identity already
 *   established, not a restart. Nobody types a password twice.
 *
 * ⚠ THE SCOPE, BECAUSE OVER-BROADNESS IS WHAT WAS WRONG HERE BEFORE. That was
 *   measured with **`totp`** - still no `webauthn`, `duo` or `sms` device
 *   exists on this tenant. What is established is the MECHANIC the three
 *   journeys depend on: `authorize`, re-entered mid-flow, resumes. Strong
 *   evidence for them; not a walk of them.
 *
 * ★ And it cost one correct password and zero wrong ones. A wrong code is a
 *   counted authentication failure against the only enrolled account on this
 *   deployment, and answering this needed the flow resumed, not completed.
 *
 * ★★ AND IT IS NOW THE ONLY PATH IN THIS APP THAT DELIBERATELY SHOWS THE
 *   IDENTITY PROVIDER'S OWN UI. Five entrances were closed so that nobody
 *   meets it by accident; this one meets it on purpose. That is defensible -
 *   the alternative is guessing at three credential journeys nobody here can
 *   test - but it should be a standing decision rather than a leftover, and
 *   it is the first thing to re-examine if a device of one of these classes
 *   is ever enrolled.
 *
 * ── SIX BOXES FOR A CODE, ONE FIELD FOR A RECOVERY CODE ──
 * 00b specifies six auto-advancing boxes, and Authentik's own enrolment UI uses
 * them. The `otpauth://` URL captured from this deployment says `digits=6`, so
 * six is measured here rather than assumed from convention.
 *
 * ★ **A recovery code is not six digits.** Nothing has been observed about its
 *   length or alphabet, and six boxes would silently truncate one. It gets a
 *   single field, no auto-submit, and no claim about its shape - the same rule
 *   that keeps a lockout number off the failed-password message.
 */

/**
 * Measured from this deployment's own `otpauth://` URL: `digits=6`.
 *
 * ★★ AND NO USER-FACING STRING MAY NAME IT. The hint used to read "the moment
 * the **sixth** digit lands" - a number owned by this constant, written out in
 * prose in two catalogues, where changing the constant would leave both
 * sentences confidently wrong and nothing would disagree. The count reaches the
 * screen through `code.digit`'s `{of}` parameter and through the boxes
 * themselves, which are visible; the hint says "the last digit" and cannot
 * drift. Asserted in the test beside this file.
 */
const CODE_LENGTH = 6;

export function SecondFactor({
  challenge,
  email,
  busy,
  problem,
  onSubmit,
  onHandOver,
}: {
  readonly challenge: AuthenticatorValidateChallenge;
  /**
   * ★★ WHAT THEY TYPED A MOMENT AGO, NOT `pending_user`.
   * The server sends a username - observed as `akadmin` - which reads as an
   * internal system account to somebody halfway through signing in. The address
   * they entered is always recognisable to them, is already in the panel's
   * state, and cannot put an internal account name on the screen.
   */
  readonly email: string;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onSubmit: (body: Record<string, unknown>) => void;
  readonly onHandOver: () => void;
}) {
  const t = useTranslations('auth.secondFactor');

  const devices = useMemo(
    () => devicesByRecency(challenge.device_challenges),
    [challenge.device_challenges],
  );
  const usable = devices.filter((device) => factorEntry(device.device_class) === 'code');

  const [chosen, setChosen] = useState<DeviceChallenge | null>(usable[0] ?? null);
  const [showAll, setShowAll] = useState(false);
  const [code, setCode] = useState('');
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  /*
   * Every device is one we cannot drive. Handing over immediately is better than
   * showing a list whose every entry leaves - the person has one way in and a
   * menu of one is a decision nobody needs to make.
   */
  if (usable.length === 0) {
    onHandOver();
    return <p className={styles.note}>{t('continuing')}</p>;
  }

  /*
   * The provider's own way out of this flow. Never composed by us: it is a
   * path on the identity provider's origin, and guessing one would be the
   * absolute-path defect this repository has already had three times.
   */
  const back = safeLinkUrl(challenge.flow_info?.cancel_url);

  const active = chosen ?? usable[0]!;
  const isRecovery = active.device_class.trim().toLowerCase() === 'static';
  const ready = isRecovery ? code.trim() !== '' : code.length === CODE_LENGTH;

  const send = (value: string) => {
    if (busy) return;
    onSubmit(validateBody(active, value));
  };

  const pick = (device: DeviceChallenge) => {
    if (factorEntry(device.device_class) !== 'code') {
      /*
       * A security key, a push, or an SMS. We have never seen one on the wire and
       * each needs a different submit field, so the identity provider's page
       * finishes it. Chosen deliberately: guessing here locks somebody out.
       */
      onHandOver();
      return;
    }
    setChosen(device);
    setCode('');
    setShowAll(false);
  };

  /** Six boxes that behave like one field. */
  const setDigit = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits === '') {
      setCode((current) => current.slice(0, index) + current.slice(index + 1));
      return;
    }
    /*
     * Pasting a whole code into any box fills all of them - 00b asks for it, and
     * a person copying from an authenticator app pastes into whichever box the
     * cursor is in rather than the first.
     */
    const next = (code.slice(0, index) + digits + code.slice(index + digits.length)).slice(
      0,
      CODE_LENGTH,
    );
    setCode(next);

    const landed = Math.min(index + digits.length, CODE_LENGTH - 1);
    boxes.current[landed]?.focus();

    /*
     * ★ SUBMITS ITSELF THE MOMENT THE SIXTH DIGIT LANDS - 00b's own words. Safe
     *   here in a way it would not be on the approvals queue: a wrong code costs
     *   a retry, and making somebody press a button after typing the last digit
     *   of a code that expires is friction with nothing behind it.
     */
    if (next.length === CODE_LENGTH) send(next);
  };

  const onKeyDown = (index: number, key: string) => {
    /* Backspace on an empty box steps back, which is what a single field does. */
    if (key === 'Backspace' && code[index] === undefined && index > 0) {
      boxes.current[index - 1]?.focus();
    }
  };

  return (
    <form
      className={styles.factor}
      data-testid="second-factor"
      data-device={active.device_class}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) send(isRecovery ? code.trim() : code);
      }}
    >
      {/*
        ═══════════════════════════════════════════════════════════════════
        ★★ "עדיין אין את שם המשתמש למעלה עם אופציה לחזור"
        ═══════════════════════════════════════════════════════════════════
        The account was BELOW the heading as "Signing in as …" and there was no
        way back at all. The mock puts it above, with an arrow:

            <div font-size:12.5px; color:#8C887F; display:flex; gap:8px>
              <i data-lucide="arrow-left" width=14 height=14 stroke-width=2>
              maya@avivco.il
            <h2 margin:14px 0 0>

        ★ `--text-subtle` IS `#8c887f`, so the token carries the mock's value.

        ── AND "BACK" IS A REAL ACTION, NOT A LINK TO THE PREVIOUS PAGE ──
        The stage lives in a server-side flow, so navigating back to
        `/sign-in` RESUMES this same stage - the browser's own back button does
        nothing useful here. Authentik supplies the way out on the challenge
        itself: `flow_info.cancel_url`, which our contract has parsed since the
        day it was written and **nothing has ever read**.

        ⚠ It is `.default('')`, and its value has never been observed. So the
          control renders only when the provider actually offers one - three
          states, never two. A back arrow that silently does nothing on a
          screen somebody is stuck on is worse than no arrow.

        ★ The address is shown beside it when we have it and omitted when we do
          not (a resumed flow has no typed email), which is why the accessible
          name carries the meaning rather than the text.
      */}
      {back ? (
        <a className={styles.back} href={back} data-testid="second-factor-back">
          <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
          {email !== '' ? email : t('backStartAgain')}
          <span className={styles.backLabel}>{t('back')}</span>
        </a>
      ) : null}

      <div className={styles.intro}>
        <Text role="title" as="h1">
          {t('title')}
        </Text>
        {/*
          ════════════════════════════════════════════════════════════════════
          ⚠⚠ RENDERED "Signing in as " WITH NOTHING AFTER IT
          ════════════════════════════════════════════════════════════════════
          Their own address, from stage one - never the server's `pending_user`,
          which is `akadmin` here and reads as an internal account to somebody
          halfway through signing in.

          **But the stage outlives the address.** `startFlow()` on mount resumes
          whatever stage the flow cookie holds, so a reload - or a link opened
          fresh - lands straight on this screen with the panel's `email` state
          empty, because nobody typed it in this page load. The stage lives on
          the server; the typed value lived only in React.

          ★ A label with an empty value is the reassuring-looking failure: it
            reads as a broken screen rather than as a missing fact, and it was
            the first thing the reviewer saw. Three states, never two - we have
            it, or we say nothing. Omitting loses a reassurance; a dangling
            "Signing in as" loses trust in the screen.

          ⚠ It is NOT filled from `pending_user` as a fallback. That was ruled
            on, and a wrong name here is worse than no name.
        */}
        {email !== '' ? (
          <Text role="body" tone="muted">
            {t('forAccount', { email })}
          </Text>
        ) : null}
      </div>

      {problem ? (
        <p className={styles.problem} role="alert" data-testid="second-factor-problem">
          {problem}
        </p>
      ) : null}

      {isRecovery ? (
        <label className={styles.field}>
          <span className={styles.label}>{t('recovery.label')}</span>
          {/*
            One field, not six boxes: nothing has been observed about a recovery
            code's length or alphabet, and six boxes would silently truncate one.
          */}
          <input
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            className={styles.input}
            data-testid="recovery-code"
            value={code}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
          <span className={styles.hint}>{t('recovery.hint')}</span>
        </label>
      ) : (
        <div className={styles.field}>
          <span className={styles.label} id="code-label">
            {t('code.label')}
          </span>
          <div className={styles.boxes} role="group" aria-labelledby="code-label">
            {Array.from({ length: CODE_LENGTH }, (_, index) => (
              <input
                key={index}
                ref={(element) => {
                  boxes.current[index] = element;
                }}
                type="text"
                inputMode="numeric"
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                maxLength={CODE_LENGTH}
                autoFocus={index === 0}
                className={styles.box}
                data-testid={`code-${index}`}
                aria-label={t('code.digit', { position: index + 1, of: CODE_LENGTH })}
                value={code[index] ?? ''}
                disabled={busy}
                onChange={(event) => setDigit(index, event.target.value)}
                onKeyDown={(event) => onKeyDown(index, event.key)}
              />
            ))}
          </div>
          <span className={styles.hint}>{t('code.hint')}</span>
        </div>
      )}

      <Button type="submit" variant="primary" size="lg" fullWidth disabled={!ready || busy}>
        {busy ? t('working') : t('action')}
      </Button>

      {/*
        ★★ ONE DEVICE MEANS NO CHOOSER. The common path is a person with an
        authenticator app, and a list of one is a decision nobody needs. The way
        out is present from the start - quiet, and phrased as the situation
        somebody is actually in rather than as a menu label.
      */}
      {devices.length > 1 ? (
        showAll ? (
          <ul className={styles.others} data-testid="other-methods">
            {devices
              .filter((device) => device !== active)
              .map((device) => (
                <li key={`${device.device_class}-${device.device_uid}`}>
                  <button
                    type="button"
                    className={styles.other}
                    data-testid={`use-${device.device_class}`}
                    onClick={() => pick(device)}
                  >
                    {t(`method.${methodKey(device.device_class)}` as 'method.totp')}
                  </button>
                </li>
              ))}
          </ul>
        ) : (
          <button
            type="button"
            className={styles.noAccess}
            data-testid="no-access"
            onClick={() => setShowAll(true)}
          >
            {/*
              ★ THE LABEL FOLLOWS THE DEVICE, AND THE SECOND CASE IS REACHABLE
              TODAY. "No access to your phone?" is the right sentence to somebody
              holding an authenticator app. Once they have answered it and
              switched to a recovery code, asking again is asking a question they
              have already answered - and the admin account has exactly those two
              devices, so it is one click away rather than hypothetical.
            */}
            {active.device_class.trim().toLowerCase() === 'totp' ? t('noAccess') : t('otherMethod')}
          </button>
        )
      ) : null}
    </form>
  );
}

/**
 * The message key for a device class.
 *
 * `static` is **"a recovery code"** and never "static" - that is Authentik's
 * word for its own storage and means nothing to somebody who was shown ten codes
 * once and told to keep them safe.
 */
function methodKey(deviceClass: string): string {
  const normalised = deviceClass.trim().toLowerCase();
  return ['totp', 'static', 'webauthn', 'duo', 'sms'].includes(normalised) ? normalised : 'other';
}
