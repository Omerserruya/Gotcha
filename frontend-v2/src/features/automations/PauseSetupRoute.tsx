'use client';

import { useTranslations } from 'next-intl';

import { Dialog, DialogContent } from '@/design-system/primitives/overlay/Dialog';

import styles from './StepSheet.module.css';

/**
 * Pausing the automation onboarding wrote, confirmed - it is what answers
 * every new conversation, so off means nobody does until it is on again
 * (Omer, 2026-11-02). Any other automation pauses at once, as before.
 */
export function PauseSetupRoute({
  name,
  onClose,
  onPause,
}: {
  readonly name: string;
  readonly onClose: () => void;
  readonly onPause: () => void;
}) {
  const t = useTranslations('automations.pauseSetup');
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent title={t('title', { name })} description={t('what')} data-testid="pause-setup">
        <span className={styles.setupActions}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={onPause}
            data-testid="pause-setup-yes"
          >
            {t('yes')}
          </button>
        </span>
      </DialogContent>
    </Dialog>
  );
}
