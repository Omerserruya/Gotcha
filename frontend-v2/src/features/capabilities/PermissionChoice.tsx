'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  ADMIN_CHOICES,
  automationCeiling,
  choicesFor,
  confirmBeforeChoosing,
  currentChoice,
  type AdminChoice,
  type Capability,
  type ConfirmedGroup,
} from '@/api/contracts/capabilities';

import { setToolPermission, type PermissionWriteResult } from './permission-actions';
import styles from './Capabilities.module.css';

/**
 * Do it · Ask me · Never, for one tool, at the org level.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ "DO IT" WHERE IT MAY NOT BE CHOSEN IS LOCKED, AND SAYS WHY ON THE ROW
 * ════════════════════════════════════════════════════════════════════════════
 * Not greyed silently. A greyed control with no reason reads as a defect or
 * as a plan upgrade; the sentence says which of the two real reasons applies:
 *
 *   it deletes, moves money or changes        the platform's kill switch
 *   settings                                  keeps approval on these
 *   we could not tell what this one changes   the read carried no group
 *
 * ── SAID TWICE: A LINE UNDER THE CONTROL, AND THE SEGMENT'S TOOLTIP ──
 * Omer (2026-10-12, Woo, "Create coupon"): a muted "Do it" that did nothing
 * on click, no reason anywhere. The reason was a `title` on a `disabled`
 * button - a tooltip several browsers never show on a disabled control - and
 * one line at the foot of the page. So the locked segment is `aria-disabled`,
 * not `disabled`: hoverable and focusable, its tooltip shown, a press writing
 * nothing; and the same sentence is a visible line under the control, which
 * the segment names as its description.
 *
 * ── ONE CONFIRM, NAMING WHAT IT TOUCHES ──
 * Loosening a tool that touches customer details, moves money, deletes or
 * changes settings to run on its own asks once, on the row, in that group's
 * sentence (`confirmBeforeChoosing`). Nothing else confirms.
 *
 * ── AND THE CURRENT STATE IS SHOWN EVEN WHEN IT IS NO LONGER OFFERABLE ──
 * A financial tool can be stored as auto-approve: set before this ceiling
 * existed. The screen shows what IS and withholds the option to put it back. **Hiding the
 * current state would be worse - an admin cannot fix a setting the screen
 * will not show them.**
 */
export function PermissionChoice({
  capability,
  blocked,
}: {
  readonly capability: Capability;
  /**
   * Why none of the three can be chosen right now - a connection down, a
   * permission not granted. The control is still drawn, its stored state
   * marked, every segment disabled with this as its title: a state, never a
   * paragraph beside the row.
   */
  readonly blocked?: string;
}) {
  const t = useTranslations('capabilities');
  const [result, setResult] = useState<PermissionWriteResult | null>(null);
  const [confirming, setConfirming] = useState<ConfirmedGroup | null>(null);
  const [isPending, startTransition] = useTransition();

  const choices = choicesFor(capability);
  const current = currentChoice(capability);
  const ceiling = automationCeiling(capability);

  function write(choice: AdminChoice) {
    setResult(null);
    startTransition(async () => {
      setResult(await setToolPermission(capability, choice));
    });
  }

  function choose(choice: AdminChoice) {
    if (blocked !== undefined || choice === current || !choices.includes(choice)) return;
    const asks = confirmBeforeChoosing(capability, choice);
    if (asks !== null) {
      setResult(null);
      setConfirming(asks);
      return;
    }
    setConfirming(null);
    write(choice);
  }

  /*
    ★★ ALWAYS ALL THREE, AND THE STORED ONE ALWAYS SHOWN (02's control).
    A choice the ceiling withholds is DISABLED, not absent, and says why on
    itself - the sentence lives on the segment, not beside every row. And a
    stored state the ceiling would now forbid (a refund set to run on its
    own, before the ceiling or by curl) is still drawn as the current one:
    an admin cannot turn off what the screen will not show them.
  */
  const reasonFor = (choice: AdminChoice): string | undefined => {
    if (blocked !== undefined) return blocked;
    if (choices.includes(choice) || ceiling === null) return undefined;
    const why = t(`choice.noAutomation.${ceiling}` as 'choice.noAutomation.unclassified');
    return current === choice ? `${why} ${t('choice.storedAutomatic')}` : why;
  };
  /* The ceiling's sentence, on the row - only when the platform has not blocked all three. */
  const locked = blocked === undefined ? reasonFor('do_it') : undefined;
  const lockedId = `choice-why-${capability.toolName}`;

  return (
    <div
      className={styles.choice}
      data-testid={`choice-${capability.toolName}`}
      data-blocked={blocked !== undefined ? 'yes' : undefined}
    >
      <div className={styles.choiceRow} role="group" aria-label={t('choice.label')}>
        {ADMIN_CHOICES.map((choice) => {
          const reason = reasonFor(choice);
          const isLocked = blocked === undefined && reason !== undefined;
          return (
            <button
              key={choice}
              type="button"
              className={styles.choiceButton}
              data-testid={`choice-${capability.toolName}-${choice}`}
              data-current={choice === current ? 'yes' : 'no'}
              aria-pressed={choice === current}
              disabled={isPending || blocked !== undefined}
              aria-disabled={isLocked ? 'true' : undefined}
              aria-describedby={isLocked ? lockedId : undefined}
              title={reason}
              onClick={() => choose(choice)}
            >
              {t(`choice.${choice}` as 'choice.do_it')}
            </button>
          );
        })}
      </div>

      {locked !== undefined ? (
        <p id={lockedId} className={styles.choiceNote} data-testid={lockedId}>
          {locked}
        </p>
      ) : null}

      {confirming !== null ? (
        <p className={styles.choiceConfirm} data-testid={`choice-confirm-${capability.toolName}`}>
          <span>{t(`choice.confirm.${confirming}`)}</span>
          <button
            type="button"
            className={styles.choiceConfirmYes}
            disabled={isPending}
            data-testid={`choice-confirm-${capability.toolName}-yes`}
            onClick={() => {
              setConfirming(null);
              write('do_it');
            }}
          >
            {t('choice.confirmYes')}
          </button>
          <button
            type="button"
            className={styles.choiceConfirmNo}
            data-testid={`choice-confirm-${capability.toolName}-no`}
            onClick={() => setConfirming(null)}
          >
            {t('choice.confirmNo')}
          </button>
        </p>
      ) : null}

      {result && !result.ok ? (
        <p className={styles.choiceWarn} data-testid={`choice-problem-${capability.toolName}`}>
          {t(`choice.problem.${result.reason}` as 'choice.problem.failed')}
        </p>
      ) : null}
    </div>
  );
}
