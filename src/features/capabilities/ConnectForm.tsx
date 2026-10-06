'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { CredentialField } from '@/api/contracts/integrations';
import { useRouter } from '@/i18n/navigation';

import { connectIntegration } from './connect-actions';
import { credentialsFor } from './connect-form';
import styles from './Capabilities.module.css';

/**
 * 10's Connect for a system that connects with credentials - live (Omer,
 * 2026-10-04). The fields are the catalogue's own (`authSchema.fields`), in
 * its words; a secret is a password field and is never shown back. Nothing is
 * sent until the button is pressed.
 */
export function ConnectForm({
  slug,
  name,
  fields,
}: {
  readonly slug: string;
  readonly name: string;
  readonly fields: readonly CredentialField[];
}) {
  const t = useTranslations('capabilities.available');
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.key, f.type === 'select' ? (f.default ?? f.options?.[0] ?? '') : '']),
    ),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const ready = credentialsFor(fields, values) !== null;

  function connect() {
    setProblem(null);
    startTransition(async () => {
      const result = await connectIntegration(slug, values);
      if (result.ok) router.refresh();
      // 422: the backend's own sentence, written for the merchant (1aaaefe4).
      else if (result.reason === 'validation')
        setProblem(result.message ?? t('error.validation', { name }));
      else setProblem(t(`error.${result.reason}`, { name }));
    });
  }

  return (
    <form
      className={styles.connectForm}
      data-testid="connect-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !isPending) connect();
      }}
    >
      {fields.map((field) => (
        <label key={field.key} className={styles.connectField}>
          <span className={styles.connectLabel}>{field.label}</span>
          {field.type === 'select' ? (
            <select
              className={styles.connectBox}
              value={values[field.key]}
              data-testid={`connect-${field.key}`}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
            >
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={styles.connectBox}
              type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              placeholder={field.placeholder}
              required={field.required}
              value={values[field.key]}
              data-testid={`connect-${field.key}`}
              onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className={styles.connectFoot}>
        <button
          type="submit"
          className={styles.connectButton}
          disabled={!ready || isPending}
          data-testid="connect-submit"
        >
          {isPending ? t('connecting') : t('connect')}
        </button>
        {problem ? (
          <span className={styles.connectProblem} role="alert" data-testid="connect-problem">
            {problem}
          </span>
        ) : (
          <span className={styles.connectNote}>{t('secretNote')}</span>
        )}
      </div>
    </form>
  );
}
