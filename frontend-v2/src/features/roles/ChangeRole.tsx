'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';

import { changeRole } from './actions';
import { isCeilingReason, useCeilingSentence } from './ceiling-words';
import styles from './Roles.module.css';

/** A role to offer, already in the reader's words. */
export interface RoleChoice {
  readonly id: string;
  readonly name: string;
}

/**
 * 12d's Change - a person's role, replaced (PUT), live since auth 00d669a3.
 *
 * Choose → the sentence of what changes → Yes. Nothing is sent before Yes.
 * The server alone decides the two lock-outs (the caller's own admin, the
 * workspace's last admin) and the screen says each in words; it does not
 * guess them first, because the server's check runs on the state after the
 * change, under a lock, and a guess here could only disagree with it.
 * Success says "within a minute": other services cache a role for up to 30s.
 */
export function ChangeRole({
  userId,
  personName,
  current,
  scope,
  held,
  choices,
}: {
  readonly userId: string;
  readonly personName: string;
  /** The role they hold now, if one can be named. */
  readonly current: RoleChoice | null;
  /** The scope of the one assignment they hold - kept; null when several. */
  readonly scope: string | null;
  /** How many role assignments they hold now - every one is replaced. */
  readonly held: number;
  readonly choices: readonly RoleChoice[];
}) {
  const t = useTranslations('roles.person.changeRole');
  const tp = useTranslations('roles.person');
  const ceiling = useCeilingSentence();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const offered = choices.filter((c) => c.id !== current?.id);
  const target = offered.find((c) => c.id === picked) ?? null;

  if (!open) {
    return (
      <span className={styles.changeRoleClosed}>
        {said?.ok ? (
          <span className={styles.changeRoleDone} role="status" data-testid="change-role-done">
            {said.text}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.personAction}
          data-testid="change-role"
          onClick={() => {
            setSaid(null);
            setPicked('');
            setOpen(true);
          }}
        >
          {tp('change')}
        </button>
      </span>
    );
  }

  const yes = () =>
    target &&
    startTransition(async () => {
      const result = await changeRole(userId, target.id, scope);
      if (result.ok) {
        setOpen(false);
        setSaid({ ok: true, text: t('done', { name: personName, role: target.name }) });
        router.refresh();
      } else {
        setSaid({
          ok: false,
          text: isCeilingReason(result) ? ceiling(result) : t(`refused.${result.reason}`),
        });
      }
    });

  return (
    <div className={styles.changeRole} data-testid="change-role-form">
      <label className={styles.changeRoleLabel}>
        <span>{t('choose')}</span>
        <select
          className={styles.changeRoleSelect}
          value={picked}
          disabled={isPending}
          data-testid="change-role-select"
          onChange={(e) => {
            setSaid(null);
            setPicked(e.target.value);
          }}
        >
          <option value="">{t('placeholder')}</option>
          {offered.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {target ? (
        <p className={styles.changeRoleAsk} data-testid="change-role-ask">
          {current
            ? t('ask', { name: personName, role: target.name, current: current.name })
            : t('askNone', { name: personName, role: target.name })}
          {held > 1 ? ` ${t('askMany', { name: personName, count: held })}` : null} {t('askWhen')}
        </p>
      ) : null}
      <p className={styles.changeRoleButtons}>
        <button
          type="button"
          className={styles.changeRoleYes}
          disabled={!target || isPending}
          data-testid="change-role-yes"
          onClick={yes}
        >
          {isPending ? t('changing') : t('yes')}
        </button>
        <button
          type="button"
          className={styles.personAction}
          disabled={isPending}
          onClick={() => {
            setSaid(null);
            setOpen(false);
          }}
        >
          {t('cancel')}
        </button>
      </p>
      {said && !said.ok ? (
        <p className={styles.changeRoleProblem} role="alert" data-testid="change-role-problem">
          {said.text}
        </p>
      ) : null}
    </div>
  );
}
