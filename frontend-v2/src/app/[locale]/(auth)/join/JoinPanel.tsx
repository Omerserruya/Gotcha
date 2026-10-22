'use client';

import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import type { Invitation } from '@/api/contracts/invitation';
import { Button } from '@/design-system/primitives/button/Button';
import { Text } from '@/design-system/primitives/text/Text';

import { acceptInvite, type AcceptInviteResult } from '@/features/join/actions';

import styles from '../recover/Recover.module.css';

/** Leaves for the setup link. A prop so a test can watch it without leaving. */
const leaveFor = (url: string) => window.location.assign(url);

/**
 * Accepting an invitation - legacy `frontend/src/app/join/page.tsx`.
 *
 * A name, and the address when the invitation did not fix one. No password:
 * accepting answers with a setup link where the person chooses it on our
 * sign-in service, and the browser goes straight there - the legacy app did
 * the same, so they are never shown a sign-in form they have no password for.
 *
 * ★ No setup link means this person already has a password (they belong to
 *   another workspace). Legacy sent them to the login page without a word;
 *   here the screen says they joined and offers sign-in, because a silent
 *   bounce to a password field reads like the invitation failed.
 */
export function JoinPanel({
  token,
  invitation,
  signInHref,
  go = leaveFor,
}: {
  readonly token: string;
  readonly invitation: Invitation;
  readonly signInHref: string;
  readonly go?: (url: string) => void;
}) {
  const t = useTranslations('auth.join');
  const fixedEmail = invitation.email;
  const [name, setName] = useState('');
  const [email, setEmail] = useState(fixedEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Extract<AcceptInviteResult, { ok: false }> | null>(null);
  const [joined, setJoined] = useState(false);
  /*
   * ⚠ `busy` is state, and two presses in one tick both read it as false.
   *   A second accept would mint a second setup link that revokes the first,
   *   so the guard is a ref - set before anything awaits.
   */
  const inFlight = useRef(false);

  const ready = name.trim().length > 0 && email.trim().length > 0;
  // The inviter's text: isolated, so a Hebrew name in an English line keeps its order.
  const workspaceName = () => <bdi dir="auto">{invitation.tenant.name}</bdi>;

  async function join(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !ready) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const result = await acceptInvite({
      token,
      name,
      // A fixed address is the invitation's own; the route ignores ours.
      ...(fixedEmail ? {} : { email }),
    });
    if (!result.ok) {
      inFlight.current = false;
      setBusy(false);
      setProblem(result);
      return;
    }
    if (result.setupLink) {
      // Stays busy: the page is leaving, and a second press would mint a
      // second link that revokes the first.
      go(result.setupLink);
      return;
    }
    setBusy(false);
    setJoined(true);
  }

  if (joined) {
    return (
      <div className={styles.done} data-testid="join-done">
        <Text role="title" as="h1">
          {t.rich('joinedTitle', { workspace: workspaceName })}
        </Text>
        <Text role="body" tone="muted" as="p">
          {t('joinedBody')}
        </Text>
        <a className={styles.back} href={signInHref} data-testid="join-sign-in">
          {t('signIn')}
        </a>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={join} data-testid="join-form" noValidate>
      <Text role="title" as="h1">
        {t.rich('title', { workspace: workspaceName })}
      </Text>
      <Text role="body" tone="muted" as="p" className={styles.lede}>
        {t('lede')}
      </Text>

      {problem ? (
        <p className={styles.notice} role="alert" data-testid="join-problem">
          {t(`problem.${problem.reason}`)}
        </p>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>{t('name')}</span>
        <span className={styles.fieldControl}>
          <input
            type="text"
            name="name"
            autoComplete="name"
            autoFocus
            required
            maxLength={120}
            className={styles.input}
            data-testid="join-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </span>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>{t('email')}</span>
        <span className={styles.fieldControl}>
          <input
            type="email"
            name="email"
            autoComplete="email"
            dir="ltr"
            required
            readOnly={fixedEmail !== null}
            className={styles.input}
            data-testid="join-email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </span>
      </label>
      {fixedEmail !== null ? (
        <Text role="meta" tone="muted" as="p">
          {t('emailFixed')}
        </Text>
      ) : null}

      <Text role="meta" tone="muted" as="p">
        {t('passwordNext')}
      </Text>

      <Button type="submit" disabled={busy || !ready} data-testid="join-submit">
        {busy ? t('joining') : t('submit')}
      </Button>

      <a className={styles.back} href={signInHref} data-testid="join-have-account">
        {t('haveAccount')}
      </a>
    </form>
  );
}
