'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
  ADMIN_CHOICES,
  automationCeiling,
  choicesFor,
  currentChoice,
  type AdminChoice,
  type Capability,
} from '@/api/contracts/capabilities';

import { setToolPermission, type PermissionWriteResult } from './permission-actions';
import styles from './Capabilities.module.css';

/**
 * Do it · Ask me · Never, for one tool, at the org level.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ "DO IT" IS NOT DRAWN WHERE IT MAY NOT BE CHOSEN, AND IT SAYS WHY
 * ════════════════════════════════════════════════════════════════════════════
 * Not greyed silently. A greyed control with no reason reads as a defect or
 * as a plan upgrade; the sentence says which of the two real reasons applies:
 *
 *   this action changes orders or money       the platform named the risk
 *   we could not tell what this one changes   it did not, and that is not
 *                                             permission to automate it
 *
 * ── AND THE CURRENT STATE IS SHOWN EVEN WHEN IT IS NO LONGER OFFERABLE ──
 * A financial tool can be stored as auto-approve: set before this ceiling
 * existed, or by curl, since the write does not enforce the guard. The
 * screen shows what IS and withholds the option to put it back. **Hiding the
 * current state would be worse — an admin cannot fix a setting the screen
 * will not show them.**
 */
export function PermissionChoice({ capability }: { readonly capability: Capability }) {
  const t = useTranslations('capabilities');
  const [result, setResult] = useState<PermissionWriteResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const choices = choicesFor(capability);
  const current = currentChoice(capability);
  const ceiling = automationCeiling(capability);

  function choose(choice: AdminChoice) {
    if (choice === current) return;
    setResult(null);
    startTransition(async () => {
      setResult(await setToolPermission(capability, choice));
    });
  }

  /*
    ★★ ALWAYS ALL THREE, AND THE STORED ONE ALWAYS SHOWN (02's control).
    A choice the ceiling withholds is DISABLED, not absent, and says why on
    itself — the sentence lives on the segment, not beside every row. And a
    stored state the ceiling would now forbid (a refund set to run on its
    own, before the ceiling or by curl) is still drawn as the current one:
    an admin cannot turn off what the screen will not show them.
  */
  const reasonFor = (choice: AdminChoice): string | undefined => {
    if (choices.includes(choice) || ceiling === null) return undefined;
    const why = t(`choice.noAutomation.${ceiling}` as 'choice.noAutomation.unclassified');
    return current === choice ? `${why} ${t('choice.storedAutomatic')}` : why;
  };

  return (
    <div className={styles.choice} data-testid={`choice-${capability.toolName}`}>
      <div className={styles.choiceRow} role="group" aria-label={t('choice.label')}>
        {ADMIN_CHOICES.map((choice) => {
          const reason = reasonFor(choice);
          return (
            <button
              key={choice}
              type="button"
              className={styles.choiceButton}
              data-testid={`choice-${capability.toolName}-${choice}`}
              data-current={choice === current ? 'yes' : 'no'}
              aria-pressed={choice === current}
              disabled={isPending || reason !== undefined}
              title={reason}
              onClick={() => choose(choice)}
            >
              {t(`choice.${choice}` as 'choice.do_it')}
            </button>
          );
        })}
      </div>

      {result && !result.ok ? (
        <p className={styles.choiceWarn} data-testid={`choice-problem-${capability.toolName}`}>
          {t(`choice.problem.${result.reason}` as 'choice.problem.failed')}
        </p>
      ) : null}
    </div>
  );
}
