'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { downloadFromPlatform } from '@/api/client/download';

import styles from './Security.module.css';

/**
 * 16's Export: the whole audit log as CSV (`GET /api/audit-logs/export`).
 *
 * The route: signed in, its workspace (resolveTenant; every row by tenant
 * id), and the same gate as reading the log - ADMIN, or a role with
 * `settings:workspace:update`. Through the BFF, saved under the platform's
 * own name; a refusal is said here, never saved as a file.
 *
 * ⚠ The route streams: a failure part-way ends the file with its own line,
 *   "EXPORT FAILED - this file is incomplete", rather than a short file that
 *   looks whole.
 */
export function ExportAuditLog() {
  const t = useTranslations('security.audit');
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
          const got = await downloadFromPlatform('/api/audit-logs/export');
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
