'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import { createTeam, type PeopleWriteResult } from './actions';
import styles from './People.module.css';

/**
 * *"Add a team."*
 *
 * Name and description only. The design's team card also states which channels
 * a team receives and where its escalations go, and this form offers neither
 * because nothing behind it can store them: `ChannelAccount` has no department
 * link, and `escalationPolicy` has one writer that no client reaches. Offering
 * the fields and dropping the values would be worse than not offering them.
 *
 * `queueMode` is not asked for either. It defaults to CLAIM server-side, and
 * it is a routing decision rather than part of naming a team - a control for
 * it belongs wherever the team is configured, not in the two fields that
 * create one.
 */
export function AddTeam() {
  const t = useTranslations('people');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState<PeopleWriteResult<unknown> | null>(null);
  const [isPending, startTransition] = useTransition();

  function close() {
    setOpen(false);
    setName('');
    setDescription('');
    setResult(null);
  }

  function submit() {
    setResult(null);
    startTransition(async () => {
      const outcome = await createTeam({ name, description });
      setResult(outcome);
      // Closes only on success: a failure leaves what was typed in place, so
      // a duplicate name can be corrected rather than retyped.
      if (outcome.ok) close();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        className={styles.addTeam}
        data-testid="team-add-open"
        onClick={() => setOpen(true)}
      >
        {t('teams.add')}
      </button>
    );
  }

  const fieldErrors = result && !result.ok && result.reason === 'invalid' ? result.fields : {};
  const message =
    result && !result.ok
      ? result.reason === 'duplicate'
        ? t('teams.duplicate')
        : result.reason === 'limit'
          ? t('teams.limit')
          : result.reason === 'forbidden'
            ? t('invite.forbidden')
            : result.reason === 'invalid'
              ? (Object.values(result.fields)[0] ?? t('teams.failed'))
              : t('teams.failed')
      : null;

  return (
    <div className={styles.teamCard} data-testid="team-add-form">
      <div className={styles.inviteFields}>
        <Input
          label={t('teams.name')}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
        />
        <Input
          label={t('teams.description')}
          value={description}
          maxLength={500}
          hint={t('teams.descriptionHint')}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className={styles.inviteActions}>
        <Button
          variant="primary"
          size="sm"
          data-testid="team-add-save"
          onClick={submit}
          disabled={isPending || !name.trim()}
        >
          {isPending ? t('teams.creating') : t('teams.create')}
        </Button>
        <Button size="sm" onClick={close}>
          {t('cancel')}
        </Button>
      </div>

      {message ? (
        <p className={styles.inviteNote} data-testid="team-add-note" data-note-kind="problem">
          {message}
        </p>
      ) : null}
    </div>
  );
}
