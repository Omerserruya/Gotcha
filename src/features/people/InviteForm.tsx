'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { Department } from '@/api/contracts/people';
import { Button } from '@/design-system/primitives/button/Button';
import { Link } from '@/i18n/navigation';
import { Input } from '@/design-system/primitives/input/Input';

import { inviteMember, type PeopleWriteResult } from './actions';
import styles from './People.module.css';

/**
 * *"Invite happens inline on the page, with role and team set before sending."*
 *
 * Team, yes. **Role, no** — and the field is absent rather than disabled.
 * `POST /api/agents` passes a literal `"AGENT"` to `inviteUser`, so a selector
 * would be a control the write path ignores. Role IS assignable afterwards,
 * through a different route; doing it here would mean a second call that can
 * fail AFTER a real person has been created and already emailed, leaving them
 * in the tenant with a role nobody chose and no control on the roster to fix
 * it. A selector that is right most of the time and unrepairable the rest is
 * worse than none, because the admin believes the role was set.
 *
 * The NAME field is not in the design, and is here because the backend
 * requires it. The alternative is deriving it from the email's local part,
 * which is what onboarding does — but that name is written into the identity
 * provider and into the invitation the person receives, so it would greet a
 * real human being as "omerts58". That is not a default worth picking
 * silently.
 */
export function InviteForm({
  teams,
  open,
}: {
  readonly teams: readonly Department[];
  /**
   * 12: the header's "Invite someone" opens this row (`?invite=1`) and its
   * Cancel closes it — the URL holds the state, so header and row share it.
   */
  readonly open: boolean;
}) {
  const t = useTranslations('people');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [teamIds, setTeamIds] = useState<readonly string[]>([]);
  const [result, setResult] = useState<PeopleWriteResult<{ setupLink?: string | null }> | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  function submit() {
    setResult(null);
    startTransition(async () => {
      const outcome = await inviteMember({ email, name, departmentIds: teamIds });
      setResult(outcome);
      if (outcome.ok) {
        // The fields clear but the panel STAYS OPEN, because the success
        // message carries the setup link — closing it would throw away the
        // one copy of a link the admin may need to send by hand.
        setEmail('');
        setName('');
        setTeamIds([]);
      }
    });
  }

  if (!open) return null;

  const fieldErrors = result && !result.ok && result.reason === 'invalid' ? result.fields : {};

  return (
    <section className={styles.invite} data-testid="invite-form">
      <h2 className={styles.inviteHeading}>{t('invite.heading')}</h2>

      <div className={styles.inviteFields}>
        <Input
          label={t('invite.email')}
          type="email"
          value={email}
          autoComplete="off"
          placeholder={t('invite.emailPlaceholder')}
          onChange={(e) => setEmail(e.target.value)}
          {...(fieldErrors.email ? { error: fieldErrors.email } : {})}
        />
        <Input
          label={t('invite.name')}
          value={name}
          autoComplete="off"
          hint={t('invite.nameHint')}
          onChange={(e) => setName(e.target.value)}
          {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
        />
      </div>

      {/*
        Teams are checkboxes, not a single select.
        `departmentIds` is an array and someone may belong to several, so a
        control that accepted one would quietly forget the rest. A tenant with
        no teams yet gets no control at all rather than an empty menu.
      */}
      {teams.length > 0 ? (
        <fieldset className={styles.inviteTeams}>
          <legend className={styles.inviteLegend}>{t('invite.teams')}</legend>
          {teams.map((team) => (
            <label key={team.id} className={styles.inviteTeam}>
              <input
                type="checkbox"
                checked={teamIds.includes(team.id)}
                data-testid={`invite-team-${team.id}`}
                onChange={(e) =>
                  setTeamIds((ids) =>
                    e.target.checked ? [...ids, team.id] : ids.filter((id) => id !== team.id),
                  )
                }
              />
              {team.name}
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className={styles.inviteActions}>
        <Button
          variant="primary"
          size="sm"
          data-testid="invite-send"
          onClick={submit}
          // A trimmed check, so a space is not a name.
          disabled={isPending || !email.trim() || !name.trim()}
        >
          {isPending ? t('invite.sending') : t('invite.send')}
        </Button>
        {/* Closing is leaving `?invite=1` — the state lives in the URL. */}
        <Link href="/settings/people" className={styles.inviteCancel} data-testid="invite-cancel">
          {t('cancel')}
        </Link>
      </div>

      {result ? <InviteOutcome result={result} /> : null}
    </section>
  );
}

/**
 * What happened, in the panel that caused it.
 *
 * The success case is the interesting one. `inviteUser` emails the invitee
 * fire-and-forget and swallows SMTP failures, so an admin can be told "invited"
 * when nothing was delivered. The route hands the setup link back, and showing
 * it turns a silent failure into a recoverable one.
 *
 * A NULL link is not a failure: the backend withholds it when the invitee's
 * identity has signed in before, deliberately, because mailing an existing user
 * a "set your password" link reads like a phish and can lock them out. So that
 * case says they already have an account. Do not "fix" this by minting a link
 * anyway.
 */
function InviteOutcome({
  result,
}: {
  readonly result: PeopleWriteResult<{ setupLink?: string | null }>;
}) {
  const t = useTranslations('people');

  if (result.ok) {
    const link = result.data.setupLink;
    return (
      <div className={styles.inviteNote} data-testid="invite-note" data-note-kind="success">
        <p>{t('invite.sent')}</p>
        {link ? (
          <>
            <p className={styles.inviteLinkLabel}>{t('invite.linkLabel')}</p>
            {/*
              Selectable text rather than a link. It is for copying to someone,
              not for this admin to follow — clicking it would begin setting up
              somebody else's password in their own browser.
            */}
            <code className={styles.inviteLink} data-testid="invite-link">
              {link}
            </code>
          </>
        ) : (
          <p className={styles.inviteLinkLabel}>{t('invite.existingAccount')}</p>
        )}
      </div>
    );
  }

  const message =
    result.reason === 'duplicate'
      ? t('invite.duplicate')
      : result.reason === 'limit'
        ? t('invite.seatLimit')
        : result.reason === 'forbidden'
          ? t('invite.forbidden')
          : result.reason === 'invalid'
            ? (Object.values(result.fields)[0] ?? t('invite.failed'))
            : t('invite.failed');

  return (
    <p className={styles.inviteNote} data-testid="invite-note" data-note-kind="problem">
      {message}
    </p>
  );
}
