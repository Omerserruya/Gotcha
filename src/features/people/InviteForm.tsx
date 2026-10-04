'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { Department } from '@/api/contracts/people';
import { Button } from '@/design-system/primitives/button/Button';
import { Link } from '@/i18n/navigation';

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
  /* Several teams at once (Omer, 12: "you can allow several") — the route takes a list. */
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

  /*
    12, measured: ONE inline row — email, name, role, team, Send invite,
    Cancel — inside a violet edge. Each control keeps a label for a screen
    reader; the eye gets 02's row.

    ── WHAT THE ROUTE TAKES, AND SO WHAT THE ROW HOLDS ──
      name   REQUIRED by `POST /api/agents` (`z.string().min(1)`): 02 has no
             name field, so it is one more input in the row — a constraint,
             not a design choice. What it is for is on the field (`title`).
      role   the route invites every person as AGENT and takes no role: the
             control shows "Agent" and is not live.
      team   the route takes several, and so does the row (Omer, 12): 02's
             dropdown, holding a checkbox per team.
  */
  return (
    <section className={styles.invite} data-testid="invite-form">
      <div className={styles.inviteRow}>
        <label className="srOnly" htmlFor="invite-email">
          {t('invite.email')}
        </label>
        <input
          id="invite-email"
          className={styles.inviteEmail}
          type="email"
          value={email}
          autoComplete="off"
          placeholder={t('invite.emailPlaceholder')}
          aria-invalid={fieldErrors.email ? true : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label className="srOnly" htmlFor="invite-name">
          {t('invite.name')}
        </label>
        <input
          id="invite-name"
          className={styles.inviteInput}
          value={name}
          autoComplete="off"
          placeholder={t('invite.name')}
          title={t('invite.nameHint')}
          aria-invalid={fieldErrors.name ? true : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="srOnly" htmlFor="invite-role">
          {t('invite.role')}
        </label>
        <select
          id="invite-role"
          className={styles.inviteSelect}
          disabled
          title={t('invite.roleFixed')}
          data-testid="invite-role"
        >
          <option>{t('invite.roleAgent')}</option>
        </select>
        <details className={styles.inviteTeams} data-testid="invite-team">
          <summary className={styles.inviteSelect} aria-label={t('invite.teams')}>
            {teamIds.length === 0
              ? t('invite.noTeam')
              : teamIds.length === 1
                ? (teams.find((team) => team.id === teamIds[0])?.name ??
                  t('invite.teamsCount', { count: 1 }))
                : t('invite.teamsCount', { count: teamIds.length })}
          </summary>
          <fieldset className={styles.inviteTeamList}>
            <legend className="srOnly">{t('invite.teams')}</legend>
            {teams.length === 0 ? (
              <span className={styles.inviteNote}>{t('invite.noTeams')}</span>
            ) : (
              teams.map((team) => (
                <label key={team.id} className={styles.inviteTeamOption}>
                  <input
                    type="checkbox"
                    checked={teamIds.includes(team.id)}
                    data-testid={`invite-team-${team.id}`}
                    onChange={() =>
                      setTeamIds((now) =>
                        now.includes(team.id)
                          ? now.filter((id) => id !== team.id)
                          : [...now, team.id],
                      )
                    }
                  />
                  {team.name}
                </label>
              ))
            )}
          </fieldset>
        </details>
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

      {fieldErrors.email || fieldErrors.name ? (
        <p className={styles.inviteNote} data-testid="invite-field-error">
          {fieldErrors.email ?? fieldErrors.name}
        </p>
      ) : null}

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
