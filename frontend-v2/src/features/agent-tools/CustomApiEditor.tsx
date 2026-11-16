'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';

import {
  CUSTOM_API_AUTH_KINDS,
  CUSTOM_API_CATEGORIES,
  CUSTOM_API_METHODS,
  customApiRisk,
  toSlug,
  type CustomApiTool,
} from '@/api/contracts/agent-tools';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { useRouter } from '@/i18n/navigation';

import { saveCustomApiTool, type ToolsRefusal } from './agent-tools-actions';
import { checkDraft, draftOf, type CustomApiDraft, type DraftProblem } from './custom-api-form';
import { RiskBadge } from './RiskBadge';
import styles from './AgentTools.module.css';

/** A labelled textarea; the design system has none. Code fields read left to right. */
function Area({
  label,
  hint,
  error,
  value,
  onChange,
  rows = 3,
  code = false,
  testid,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly rows?: number;
  readonly code?: boolean;
  readonly testid: string;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className={code ? `${styles.textarea} ${styles.code}` : styles.textarea}
        rows={rows}
        value={value}
        dir={code ? 'ltr' : 'auto'}
        spellCheck={!code}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testid}
      />
      {hint && !error ? (
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className={styles.error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function Pick<T extends string>({
  label,
  value,
  options,
  words,
  onChange,
  testid,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly T[];
  readonly words: (option: T) => string;
  readonly onChange: (value: T) => void;
  readonly testid: string;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        data-testid={testid}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {words(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Add or edit one custom API tool - the legacy builder's fields, in four
 * parts: what it is for, the request, how it signs in, and its input and
 * output. The slug is fixed once created (the route ignores it on PATCH).
 * Secrets are never shown; empty keeps the stored one.
 */
export function CustomApiEditor({
  tool = null,
  onDone,
}: {
  readonly tool?: CustomApiTool | null;
  readonly onDone: () => void;
}) {
  const t = useTranslations('capabilities.ownTools.custom');
  const tr = useTranslations('capabilities.ownTools');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [draft, setDraft] = useState<CustomApiDraft>(() => draftOf(tool));
  const [problems, setProblems] = useState<readonly DraftProblem[]>([]);
  const [refusal, setRefusal] = useState<ToolsRefusal | null>(null);
  const isNew = tool === null;
  const keeps = !isNew && tool.hasSecrets;
  const set = <K extends keyof CustomApiDraft>(key: K, value: CustomApiDraft[K]) =>
    setDraft((before) => ({ ...before, [key]: value }));
  const err = (problem: DraftProblem) => (problems.includes(problem) ? t(`problem.${problem}`) : undefined);

  function save() {
    const checked = checkDraft(draft, { isNew, hasSecrets: tool?.hasSecrets ?? false });
    if (!checked.ok) {
      setProblems(checked.problems);
      return;
    }
    setProblems([]);
    setRefusal(null);
    startTransition(async () => {
      const result = await saveCustomApiTool(tool?.id ?? null, checked.input);
      if (!result.ok) {
        setRefusal(result.reason);
        return;
      }
      onDone();
      router.refresh();
    });
  }

  return (
    <form
      className={styles.form}
      data-testid={isNew ? 'custom-new' : `custom-edit-${tool.id}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <fieldset className={styles.part}>
        <legend className={styles.partHeading}>{t('part.about')}</legend>
        <Input
          label={t('field.name')}
          value={draft.name}
          maxLength={80}
          onChange={(event) => set('name', event.target.value)}
          error={err('name')}
          data-testid="custom-name"
        />
        <Input
          label={t('field.slug')}
          hint={isNew ? t('field.slugHint') : t('field.slugFixed')}
          value={isNew ? draft.slug || toSlug(draft.name) : draft.slug}
          dir="ltr"
          disabled={!isNew}
          spellCheck={false}
          onChange={(event) => set('slug', toSlug(event.target.value))}
          error={err('slug')}
          data-testid="custom-slug"
        />
        <Area
          label={t('field.description')}
          value={draft.description}
          onChange={(value) => set('description', value)}
          error={err('description')}
          rows={2}
          testid="custom-description"
        />
        <Area
          label={t('field.whenToUse')}
          hint={t('field.whenToUseHint')}
          value={draft.whenToUse}
          onChange={(value) => set('whenToUse', value)}
          error={err('whenToUse')}
          rows={2}
          testid="custom-when"
        />
        <Area
          label={t('field.whenNotToUse')}
          hint={t('field.whenNotToUseHint')}
          value={draft.whenNotToUse}
          onChange={(value) => set('whenNotToUse', value)}
          rows={2}
          testid="custom-when-not"
        />
        <div className={styles.row}>
          <Pick
            label={t('field.category')}
            value={draft.category}
            options={CUSTOM_API_CATEGORIES}
            words={(option) => t(`category.${option}`)}
            onChange={(value) => set('category', value)}
            testid="custom-category"
          />
          <Pick
            label={t('field.riskLevel')}
            value={draft.riskLevel}
            options={['LOW', 'MEDIUM', 'HIGH'] as const}
            words={(option) => t(`riskLevel.${option}`)}
            onChange={(value) => set('riskLevel', value)}
            testid="custom-risk-level"
          />
          <span className={styles.riskPreview} data-testid="custom-risk-preview">
            <RiskBadge
              risk={customApiRisk({ category: draft.category, method: draft.method, riskLevel: draft.riskLevel })}
              testid="custom-risk"
            />
          </span>
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(event) => set('isActive', event.target.checked)}
            data-testid="custom-active"
          />
          <span>{t('field.active')}</span>
        </label>
      </fieldset>

      <fieldset className={styles.part}>
        <legend className={styles.partHeading}>{t('part.request')}</legend>
        <div className={styles.row}>
          <Pick
            label={t('field.method')}
            value={draft.method}
            options={CUSTOM_API_METHODS}
            words={(option) => option}
            onChange={(value) => set('method', value)}
            testid="custom-method"
          />
          <Input
            label={t('field.url')}
            hint={t('field.urlHint')}
            value={draft.urlTemplate}
            dir="ltr"
            spellCheck={false}
            placeholder="https://api.example.com/orders/{{order_id}}"
            onChange={(event) => set('urlTemplate', event.target.value)}
            error={err('urlTemplate')}
            data-testid="custom-url"
          />
        </div>
        <Input
          label={t('field.hosts')}
          hint={t('field.hostsHint')}
          value={draft.allowedHosts}
          dir="ltr"
          spellCheck={false}
          placeholder="api.example.com"
          onChange={(event) => set('allowedHosts', event.target.value)}
          error={err('allowedHosts') ?? err('hostNotAllowed')}
          data-testid="custom-hosts"
        />
        <div className={styles.field}>
          <span className={styles.label}>{t('field.headers')}</span>
          {draft.headers.map((header, index) => (
            <span key={index} className={styles.row}>
              <Input
                label={t('field.headerName')}
                labelHidden
                value={header.key}
                dir="ltr"
                placeholder="X-Custom-Header"
                onChange={(event) =>
                  set(
                    'headers',
                    draft.headers.map((h, i) => (i === index ? { ...h, key: event.target.value } : h)),
                  )
                }
                data-testid={`custom-header-key-${index}`}
              />
              <Input
                label={t('field.headerValue')}
                labelHidden
                value={header.value}
                dir="ltr"
                onChange={(event) =>
                  set(
                    'headers',
                    draft.headers.map((h, i) => (i === index ? { ...h, value: event.target.value } : h)),
                  )
                }
                data-testid={`custom-header-value-${index}`}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => set('headers', draft.headers.filter((_, i) => i !== index))}
              >
                {t('field.headerRemove')}
              </Button>
            </span>
          ))}
          <span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set('headers', [...draft.headers, { key: '', value: '' }])}
              data-testid="custom-header-add"
            >
              {t('field.headerAdd')}
            </Button>
          </span>
        </div>
        {draft.method !== 'GET' && draft.method !== 'DELETE' ? (
          <Area
            label={t('field.body')}
            hint={t('field.bodyHint')}
            value={draft.bodyTemplate}
            onChange={(value) => set('bodyTemplate', value)}
            code
            rows={4}
            testid="custom-body"
          />
        ) : null}
        <Input
          label={t('field.timeout')}
          value={draft.timeoutMs}
          dir="ltr"
          inputMode="numeric"
          onChange={(event) => set('timeoutMs', event.target.value.replace(/\D/g, ''))}
          error={err('timeout')}
          data-testid="custom-timeout"
        />
      </fieldset>

      <fieldset className={styles.part}>
        <legend className={styles.partHeading}>{t('part.auth')}</legend>
        <Pick
          label={t('field.authKind')}
          value={draft.authKind}
          options={CUSTOM_API_AUTH_KINDS}
          words={(option) => t(`authKind.${option}`)}
          onChange={(value) => set('authKind', value)}
          testid="custom-auth"
        />
        {draft.authKind === 'bearer' ? (
          <Input
            label={t('field.bearer')}
            hint={keeps ? tr('form.secretKept') : undefined}
            type="password"
            autoComplete="off"
            dir="ltr"
            value={draft.bearer}
            onChange={(event) => set('bearer', event.target.value)}
            error={err('secret')}
            data-testid="custom-bearer"
          />
        ) : draft.authKind === 'api_key' ? (
          <>
            <div className={styles.row}>
              <Pick
                label={t('field.keyIn')}
                value={draft.authIn}
                options={['header', 'query'] as const}
                words={(option) => t(`keyIn.${option}`)}
                onChange={(value) => set('authIn', value)}
                testid="custom-key-in"
              />
              <Input
                label={t('field.keyName')}
                value={draft.authName}
                dir="ltr"
                placeholder="X-API-Key"
                onChange={(event) => set('authName', event.target.value)}
                error={err('authName')}
                data-testid="custom-key-name"
              />
            </div>
            <Input
              label={t('field.apiKey')}
              hint={keeps ? tr('form.secretKept') : undefined}
              type="password"
              autoComplete="off"
              dir="ltr"
              value={draft.apiKey}
              onChange={(event) => set('apiKey', event.target.value)}
              error={err('secret')}
              data-testid="custom-api-key"
            />
          </>
        ) : draft.authKind === 'basic' ? (
          <div className={styles.row}>
            <Input
              label={t('field.basicUser')}
              autoComplete="off"
              dir="ltr"
              value={draft.basicUser}
              onChange={(event) => set('basicUser', event.target.value)}
              error={err('secret')}
              data-testid="custom-basic-user"
            />
            <Input
              label={t('field.basicPass')}
              hint={keeps ? tr('form.secretKept') : undefined}
              type="password"
              autoComplete="off"
              dir="ltr"
              value={draft.basicPass}
              onChange={(event) => set('basicPass', event.target.value)}
              data-testid="custom-basic-pass"
            />
          </div>
        ) : null}
      </fieldset>

      <fieldset className={styles.part}>
        <legend className={styles.partHeading}>{t('part.shape')}</legend>
        <Area
          label={t('field.input')}
          hint={t('field.inputHint')}
          value={draft.parameters}
          onChange={(value) => set('parameters', value)}
          error={err('parameters')}
          code
          rows={7}
          testid="custom-input"
        />
        <Input
          label={t('field.output')}
          hint={t('field.outputHint')}
          value={draft.responseFields}
          dir="ltr"
          spellCheck={false}
          placeholder="data.id, data.status"
          onChange={(event) => set('responseFields', event.target.value)}
          data-testid="custom-output"
        />
      </fieldset>

      {problems.length > 0 ? (
        <p className={styles.warn} role="alert" data-testid="custom-problems">
          {t('problemsSummary')}
        </p>
      ) : null}
      {refusal !== null ? (
        <p className={styles.warn} role="alert" data-testid="custom-refusal">
          {tr(`refusal.${refusal}`)}
        </p>
      ) : null}

      <span className={styles.actions}>
        <Button size="sm" onClick={onDone} disabled={isPending}>
          {tr('form.cancel')}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={isPending} data-testid="custom-save">
          {isNew ? t('add') : tr('form.save')}
        </Button>
      </span>
    </form>
  );
}
