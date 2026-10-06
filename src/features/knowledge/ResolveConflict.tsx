'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { answerTooLong, type Variant } from '@/api/contracts/knowledge-candidates';
import { Button } from '@/design-system/primitives/button/Button';

import styles from './Knowledge.module.css';
import { resolveConflict, type ResolveResult } from './resolve-actions';

/**
 * "This one is right" - screen 08's resolve, one button per observed answer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ PRESSING THIS WRITES THE KNOWLEDGE EVERY AI EMPLOYEE ANSWERS FROM
 * ════════════════════════════════════════════════════════════════════════════
 * **No test and no capture presses it.** `Resolve.test.tsx` mocks the action
 * to throw; what is tested is which buttons exist, what the confirm step
 * echoes, and which sentence each outcome produces.
 *
 * ── THE CONFIRM STEP IS NOT CEREMONY, IT IS THE POINT ──
 * These variants are near-identical by construction: the conflict exists
 * because the same question got two answers that differ by a price or a
 * number, and 06e's merge panel exists because model-written labels arrive in
 * *"near-identical variants"*. Two adjacent buttons under two answers that
 * differ by three characters is a misclick that silently sets the wrong
 * refund window - and nobody re-reads an answer that has been approved.
 *
 * So the second press echoes **the answer itself**, not the word "confirm".
 * The reader has to look at the text they chose, which is the only check that
 * catches picking the wrong one of two things that look alike.
 */
export function ResolveConflict({
  candidateId,
  variants,
}: {
  readonly candidateId: string;
  readonly variants: readonly Variant[];
}) {
  const t = useTranslations('knowledge.conflicts.resolve');
  const [armed, setArmed] = useState<string | null>(null);
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function press(variant: Variant) {
    if (armed !== variant.key) {
      // First press arms only. Nothing has been written.
      setArmed(variant.key);
      setResult(null);
      return;
    }
    setArmed(null);
    startTransition(async () => {
      setResult(await resolveConflict(candidateId, variant.answer));
    });
  }

  /*
   * ★ A RESOLVED ROW DOES NOT KEEP OFFERING TO BE RESOLVED.
   * `revalidatePath` will replace this card on the next render, but until it
   * does the buttons would still be live - and a second press on the *other*
   * variant would write a second, contradicting document. `already_covered`
   * counts as settled for the same reason: the candidate has been marked.
   */
  const settled = result?.ok === true || result?.reason === 'already_covered';

  return (
    <div className={styles.resolve} data-testid={`resolve-${candidateId}`}>
      {!settled ? (
        <div className={styles.resolveRow}>
          {variants.map((variant) => {
            /*
             * Refused before the button is even offered, rather than on the
             * press: the route would store this answer cut off at 4000
             * characters, and a disabled button with the reason next to it is
             * a better account of that than a failure message afterwards.
             */
            const tooLong = answerTooLong(variant.answer);
            const isArmed = armed === variant.key;
            return (
              <Button
                key={variant.key}
                /*
                 * Secondary until it is armed. The armed one becomes the
                 * primary action on the card, which is the only moment this
                 * panel has a primary action at all - before that, choosing
                 * between two answers is the reader's job and the screen
                 * takes no side.
                 */
                variant={isArmed ? 'primary' : 'secondary'}
                size="sm"
                data-testid={`resolve-${candidateId}-${variant.key}`}
                data-armed={isArmed ? 'yes' : 'no'}
                disabled={isPending || tooLong}
                onClick={() => press(variant)}
              >
                {isArmed
                  ? /*
                     * The answer, quoted back. Long answers are clipped for
                     * the button label only - never for what is sent, which
                     * is `variant.answer` whole.
                     */
                    t('confirm', { answer: clip(variant.answer) })
                  : t('choose')}
              </Button>
            );
          })}
        </div>
      ) : null}

      {armed !== null ? (
        <p className={styles.resolveNote} data-testid={`resolve-armed-${candidateId}`}>
          {t('armed')}
        </p>
      ) : null}

      {variants.some((v) => answerTooLong(v.answer)) ? (
        <p className={styles.resolveWarn} data-testid={`resolve-too-long-${candidateId}`}>
          {t('problem.too_long')}
        </p>
      ) : null}

      {result?.ok === true ? (
        <p className={styles.resolveDone} data-testid={`resolve-done-${candidateId}`}>
          {/*
            ★★ THREE SENTENCES, BECAUSE `ok: true` IS THREE DIFFERENT FACTS.
            The route answers `ok` whether or not the embedding worked, so
            "GOTCHA answers with this from now on" is only sayable when the
            document came back `ready`. The other two say what was stored and
            what is not yet true, which is the direction that makes somebody
            check.
          */}
          {result.alreadyApproved ? `${t('alreadyApproved')} ` : ''}
          {t(`use.${result.use}` as 'use.in_use')}
        </p>
      ) : null}

      {result && !result.ok && result.reason !== 'too_long' ? (
        <p className={styles.resolveWarn} data-testid={`resolve-problem-${candidateId}`}>
          {t(`problem.${result.reason}` as 'problem.failed')}
        </p>
      ) : null}
    </div>
  );
}

/** Button labels only. What gets written is never clipped. */
function clip(answer: string): string {
  const flat = answer.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}
