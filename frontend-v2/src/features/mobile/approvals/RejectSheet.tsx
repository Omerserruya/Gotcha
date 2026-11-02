'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Sheet, SheetClose, SheetContent } from '@/design-system/primitives/overlay/Dialog';
import type { RejectReason } from '@/features/approvals/ApprovalsScreen';
import { typedDir } from '@/lib/typed-dir';

import ui from '../mobile-ui.module.css';
import styles from './mobile-approvals.module.css';

/**
 * "Why reject it?" - the design's sheet: one tap on a reason rejects. The
 * desktop's closed choice, and "Other" to type one; the route refuses a
 * rejection without a reason, so nothing is sent before there is one.
 */
export function RejectSheet({
  open,
  onOpenChange,
  reasons,
  reasonText,
  busy,
  problem,
  onReject,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly reasons: readonly RejectReason[];
  readonly reasonText: (key: RejectReason) => string;
  readonly busy: boolean;
  /** Why the last try was refused, said in the sheet that made it. */
  readonly problem: string | null;
  /** Sends the rejection with this reason. */
  readonly onReject: (reason: string) => void;
}) {
  const t = useTranslations('approvals');
  const m = useTranslations('mobile.approvals');
  const [other, setOther] = useState<string | null>(null);

  const change = (next: boolean) => {
    if (!next) setOther(null);
    onOpenChange(next);
  };

  return (
    <Sheet open={open} onOpenChange={change}>
      <SheetContent title={m('rejectTitle')} data-testid="mobile-reject-sheet">
        <p className={styles.sheetSub}>{m('rejectSub')}</p>
        <div className={styles.reasons} role="group" aria-label={m('rejectTitle')}>
          {reasons.map((key) => (
            <button
              key={key}
              type="button"
              className={styles.reason}
              aria-pressed={key === 'other' ? other !== null : undefined}
              disabled={busy}
              data-testid={`mobile-reason-${key}`}
              onClick={() => (key === 'other' ? setOther('') : onReject(reasonText(key)))}
            >
              {reasonText(key)}
            </button>
          ))}
        </div>
        {other === null ? null : (
          <div className={styles.otherRow}>
            <input
              className={styles.reasonInput}
              value={other}
              dir={typedDir(other)}
              aria-label={t('reject3.otherLabel')}
              placeholder={t('reject3.otherLabel')}
              onChange={(event) => setOther(event.target.value)}
              data-testid="mobile-reject-reason"
            />
            <button
              type="button"
              className={ui.primary}
              disabled={busy || other.trim() === ''}
              onClick={() => onReject(other.trim())}
              data-testid="mobile-reject-confirm"
            >
              {t('action.reject')}
            </button>
          </div>
        )}
        {problem ? (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        ) : null}
        <SheetClose className={styles.sheetCancel}>{m('cancel')}</SheetClose>
      </SheetContent>
    </Sheet>
  );
}
