'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import {
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

  return (
    <div className={styles.choice} data-testid={`choice-${capability.toolName}`}>
      <div className={styles.choiceRow} role="group" aria-label={t('choice.label')}>
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            className={styles.choiceButton}
            data-testid={`choice-${capability.toolName}-${choice}`}
            data-current={choice === current ? 'yes' : 'no'}
            aria-pressed={choice === current}
            disabled={isPending}
            onClick={() => choose(choice)}
          >
            {t(`choice.${choice}` as 'choice.do_it')}
          </button>
        ))}
      </div>

      {/*
        ★ THE WITHHELD OPTION, NAMED. A reader coming from the design looks
        for three buttons and finds two; an absence that explains itself only
        has to explain itself once.
      */}
      {ceiling !== null ? (
        <p className={styles.choiceNote} data-testid={`no-automation-${capability.toolName}`}>
          {t(`choice.noAutomation.${ceiling}` as 'choice.noAutomation.unclassified')}
        </p>
      ) : null}

      {/*
        ★★ AND THE STATE THE CEILING WOULD NOW FORBID, IF IT IS THE STORED ONE.
        Shown as what it is, with the fact that it cannot be re-chosen — so
        an admin who wants it off can act, and one who wants it back knows to
        ask rather than hunting for a control that is not there.
      */}
      {ceiling !== null && current === 'do_it' ? (
        <p className={styles.choiceWarn} data-testid={`stored-automatic-${capability.toolName}`}>
          {t('choice.storedAutomatic')}
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
