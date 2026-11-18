'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import { PERMISSIONS } from '@/permissions/catalogue';
import { usePermissions } from '@/permissions/permissions-context';

import styles from './RelevanceFilter.module.css';
import { setRelevanceFilter, type RelevanceFilterProblem } from './relevance-filter-actions';

/**
 * One channel account's "personal and not relevant" filter (Omer, 2026-11-18):
 * on, the classifier's personal, advertising and automatic conversations go to
 * that folder and the bot does not answer them; off, every conversation on the
 * account is treated as the business's.
 *
 * Optimistic: the switch moves at once, and a refusal moves it back and says
 * why, under it. Without `channels:manage:update` it is drawn, disabled, with
 * who can change it - as the rest of this screen's settings are.
 *
 * `block`: a card or a drawer (13b's number card, a mailbox's drawer) - the
 * label beside the switch and the help line under both. `inline`: a channel
 * row (Instagram, Messenger) - the label only, the help line its description.
 *
 * The callers draw it only while `INBOX_RELEVANCE` is on and the account's
 * value is a boolean (`null`: the classifier never runs there).
 */
export function RelevanceFilterSwitch({
  channelAccountId,
  enabled,
  layout = 'block',
}: {
  readonly channelAccountId: string;
  readonly enabled: boolean;
  readonly layout?: 'block' | 'inline';
}) {
  const t = useTranslations('channels.relevanceFilter');
  const { canSee } = usePermissions();
  const canChange = canSee(PERMISSIONS.channels.manage.update);
  const [on, setOn] = useState(enabled);
  const [problem, setProblem] = useState<RelevanceFilterProblem | null>(null);
  const [saving, startSaving] = useTransition();
  const id = useId();

  const flip = () => {
    const next = !on;
    setOn(next);
    setProblem(null);
    startSaving(async () => {
      const result = await setRelevanceFilter(channelAccountId, next);
      if (!result.ok) {
        setOn(!next);
        setProblem(result.reason);
      }
    });
  };

  const inline = layout === 'inline';
  return (
    <div
      className={inline ? styles.inline : styles.block}
      data-readonly={canChange ? undefined : 'yes'}
      data-testid={`relevance-filter-${channelAccountId}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        className={styles.switch}
        data-on={on ? 'yes' : 'no'}
        disabled={saving || !canChange}
        onClick={flip}
        data-testid={`relevance-filter-switch-${channelAccountId}`}
      />
      <span id={`${id}-label`} className={styles.label}>
        {t('label')}
      </span>
      <span id={`${id}-help`} className={inline ? 'srOnly' : styles.help}>
        {t('help')}
        {canChange ? null : ` ${t('readOnly')}`}
      </span>
      {problem ? (
        <p
          className={styles.problem}
          role="alert"
          data-testid={`relevance-filter-problem-${channelAccountId}`}
        >
          {t(`problem.${problem}`)}
        </p>
      ) : null}
    </div>
  );
}
