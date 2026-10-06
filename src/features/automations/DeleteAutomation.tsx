'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';

import { deleteAutomation } from './automation-actions';
import styles from './StepSheet.module.css';

/**
 * Delete, confirmed - and the confirmation says what the route does: it
 * stops, it is deleted, and its run history goes with it (the runs are
 * deleted by cascade); a conversation waiting on it carries on.
 */
export function DeleteAutomation({
  id,
  name,
  onClose,
  onDeleted,
}: {
  readonly id: string;
  readonly name: string;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const t = useTranslations('automations.delete');
  const [failed, setFailed] = useState(false);
  const [isDeleting, start] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        title={t('title', { name })}
        description={t('what')}
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
            onClick={() =>
              start(async () => {
                setFailed(false);
                if (await deleteAutomation(id)) onDeleted();
                else setFailed(true);
              })
            }
            data-testid="delete-automation-yes"
          >
            {isDeleting ? t('deleting') : t('yes')}
          </button>
        </span>
      </DialogContent>
    </Dialog>
  );
}
