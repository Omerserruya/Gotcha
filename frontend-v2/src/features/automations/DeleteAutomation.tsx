'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';

import { deleteAutomation } from './automation-actions';
import styles from './StepSheet.module.css';

/**
 * Delete, confirmed - and the confirmation says what the route does: it
 * stops, it is deleted, and its run history goes with it (the runs are
 * deleted by cascade); a conversation waiting on it carries on.
 *
 * One or several (09c's selection): several are named by count, "Delete 3
 * automations?". Each is deleted on its own route call; the ones that went
 * are reported back even when another did not, and that one is said.
 */
export function DeleteAutomation({
  targets,
  onClose,
  onDeleted,
}: {
  readonly targets: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
  /** The ids that were deleted. */
  readonly onDeleted: (ids: readonly string[]) => void;
}) {
  const t = useTranslations('automations.delete');
  const [failed, setFailed] = useState(false);
  // AU2: awaited with its own pending state; `onDeleted` (a navigation in the builder) runs outside any transition.
  const [isDeleting, setDeleting] = useState(false);
  // A retry asks only for the ones still here.
  const [left, setLeft] = useState(targets);
  const one = left.length === 1 ? left[0]! : null;
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        title={one ? t('title', { name: one.name }) : t('titleMany', { count: left.length })}
        description={one ? t('what') : t('whatMany')}
        data-testid="delete-automation"
      >
        {failed ? (
          <p className={styles.problem} role="alert" data-testid="delete-automation-failed">
            {t('failed')}
          </p>
        ) : null}
        <span className={styles.setupActions}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            disabled={isDeleting}
            onClick={async () => {
              setDeleting(true);
              setFailed(false);
              const done: string[] = [];
              for (const target of left) {
                if (await deleteAutomation(target.id)) done.push(target.id);
              }
              if (done.length > 0) onDeleted(done);
              if (done.length === left.length) return;
              setLeft(left.filter((target) => !done.includes(target.id)));
              setFailed(true);
              setDeleting(false);
            }}
            data-testid="delete-automation-yes"
          >
            {isDeleting ? t('deleting') : t('yes')}
          </button>
        </span>
      </DialogContent>
    </Dialog>
  );
}
