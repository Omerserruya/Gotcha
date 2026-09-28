'use client';

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

import styles from './SecondFactor.module.css';

/**
 * The second factor, in the same panel — screen 00b's first half.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHAT IS BUILT, AND WHAT DELIBERATELY IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 * The flow permits five device classes. **Two are a code somebody types —
 * `totp` and `static` — and those are built here.** `webauthn` is a browser
 * credential prompt, `duo` is a push waiting for approval, `sms` is an
 * out-of-band message; the schema agrees by giving each its own field
 * (`code` string, `webauthn` object, `duo` integer) rather than one polymorphic
 * value.
 *
 * None of those three is configured on this tenant, none has been observed on
 * the wire, and each is a different journey. Choosing one hands over to the
 * identity provider's page, which still works. **That is deliberate and
 * reversible, not an oversight** — the handover is narrowed from "any stage we
 * do not recognise" to "three named classes we have chosen not to build blind".
 *
 * ── SIX BOXES FOR A CODE, ONE FIELD FOR A RECOVERY CODE ──
 * 00b specifies six auto-advancing boxes, and Authentik's own enrolment UI uses
 * them. The `otpauth://` URL captured from this deployment says `digits=6`, so
 * six is measured here rather than assumed from convention.
 *
 * ★ **A recovery code is not six digits.** Nothing has been observed about its
 *   length or alphabet, and six boxes would silently truncate one. It gets a
 *   single field, no auto-submit, and no claim about its shape — the same rule
 *   that keeps a lockout number off the failed-password message.
 */

/** Measured from this deployment's own `otpauth://` URL: `digits=6`. */
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
   * The server sends a username — observed as `akadmin` — which reads as an
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
   * showing a list whose every entry leaves — the person has one way in and a
   * menu of one is a decision nobody needs to make.
   */
  if (usable.length === 0) {
    onHandOver();
    return <p className={styles.note}>{t('continuing')}</p>;
  }

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
     * Pasting a whole code into any box fills all of them — 00b asks for it, and
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
     * ★ SUBMITS ITSELF THE MOMENT THE SIXTH DIGIT LANDS — 00b's own words. Safe
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
      <div className={styles.intro}>
        <Text role="title" as="h1">
          {t('title')}
        </Text>
        <Text role="body" tone="muted">
          {/* Their own address, from stage one. Never the server's username. */}
          {t('forAccount', { email })}
        </Text>
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
        out is present from the start — quiet, and phrased as the situation
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
            {t('noAccess')}
          </button>
        )
      ) : null}
    </form>
  );
}

/**
 * The message key for a device class.
 *
 * `static` is **"a recovery code"** and never "static" — that is Authentik's
 * word for its own storage and means nothing to somebody who was shown ten codes
 * once and told to keep them safe.
 */
function methodKey(deviceClass: string): string {
  const normalised = deviceClass.trim().toLowerCase();
  return ['totp', 'static', 'webauthn', 'duo', 'sms'].includes(normalised) ? normalised : 'other';
}
