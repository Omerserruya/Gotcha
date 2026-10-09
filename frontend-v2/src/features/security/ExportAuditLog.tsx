'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { downloadFromApp } from '@/api/client/download';

import styles from './Security.module.css';

/**
 * 16's Export: the whole audit log as CSV, in the reader's words
 * (`/api/exports/audit-log`, which reads the platform's
 * `GET /api/audit-logs/export` as it streams - see that route).
 *
 * The platform's route: signed in, its workspace (resolveTenant; every row
 * by tenant id), and the same gate as reading the log - ADMIN, or a role
 * with `settings:workspace:update`. A refusal is said here, never saved as
 * a file.
 *
 * ⚠ The route streams: a failure part-way ends the file with its own line,
 *   "EXPORT FAILED - this file is incomplete", rather than a short file that
 *   looks whole.
 */
export function ExportAuditLog() {
  const t = useTranslations('security.audit');
  const locale = useLocale();
  const [state, setState] = useState<'idle' | 'getting' | 'forbidden' | 'failed'>('idle');
  return (
    <span className={styles.exportWrap}>
      <button
        type="button"
        className={styles.export}
        disabled={state === 'getting'}
        data-testid="audit-export"
        onClick={async () => {
          setState('getting');
          // The readable export: the screen's words first, the platform's columns after.
          const got = await downloadFromApp(`/api/exports/audit-log?locale=${locale}`);
          if (!got.ok) {
            setState(got.status === 403 ? 'forbidden' : 'failed');
            return;
          }
          const url = URL.createObjectURL(got.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          setState('idle');
        }}
      >
        {state === 'getting' ? t('exporting') : t('export')}
      </button>
      {state === 'forbidden' || state === 'failed' ? (
        <span className={styles.exportProblem} role="alert" data-testid="audit-export-problem">
          {t(`exportProblem.${state}`)}
        </span>
      ) : null}
    </span>
  );
}
