'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition } from 'react';

import {
  countryName,
  displayHost,
  fieldOrigin,
  industryReading,
  type Workspace,
} from '@/api/contracts/workspace';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { saveWorkspaceFacts, type WriteResult } from './actions';
import type { WebsiteScan } from './load-workspace';
import styles from './Workspace.module.css';

/**
 * The business, as one block of 11's table - and the only place it is shown
 * (Omer, 2026-10-11: "business name, website, what you sell and address
 * appear twice and can't be edited there"). It was these rows AND the 11b
 * drawer, which repeated them as a form.
 *
 * ★ EDITABLE IS WHAT `PATCH /workspace` SAVES, AND NOTHING ELSE. Its
 *   allow-list is closed (services/auth/src/routes/workspace.ts): `name`
 *   (1-200), `description` (1-2000) and `address` (0-300, or null) are on it,
 *   so those three edit in their rows, 11e's way - Enter saves, Esc cancels.
 *   `websiteDomain`, `industry` and `country` are not: a control would 422 on
 *   "unknown field", so they are drawn as values with no Edit at all.
 */

export type BusinessKey = 'name' | 'description' | 'address';

/** The route's own rule for each field, after it trims. */
export const BUSINESS_RULES: Readonly<
  Record<
    BusinessKey,
    { readonly max: number; readonly required: boolean; readonly provenance: string }
  >
> = {
  name: { max: 200, required: true, provenance: 'organizationName' },
  description: { max: 2000, required: true, provenance: 'businessDescription' },
  address: { max: 300, required: false, provenance: 'address' },
};

export type BusinessCheck =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly problem: 'required' }
  | {
      readonly ok: false;
      readonly problem: 'tooLong';
      readonly max: number;
      readonly count: number;
    };

/**
 * What the route would answer, asked before the request. Trimmed as it trims;
 * an empty address is `null` (cleared), an empty name or description refused.
 */
export function checkBusinessFact(key: BusinessKey, raw: string): BusinessCheck {
  const rule = BUSINESS_RULES[key];
  const value = raw.trim();
  if (value.length === 0)
    return rule.required ? { ok: false, problem: 'required' } : { ok: true, value: null };
  if (value.length > rule.max) {
    return { ok: false, problem: 'tooLong', max: rule.max, count: value.length };
  }
  return { ok: true, value };
}

export function BusinessFacts({
  workspace,
  scan = null,
}: {
  readonly workspace: Workspace;
  /** The website line: what the scan read, and what else it found. */
  readonly scan?: WebsiteScan | null;
}) {
  const t = useTranslations('workspace');
  const locale = useLocale();
  const uid = useId();
  const [editing, setEditing] = useState<BusinessKey | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<BusinessKey | null>(null);
  const [isPending, startTransition] = useTransition();
  /* After a save or a cancel, focus goes back to the row it left. */
  const editButtons = useRef<Partial<Record<BusinessKey, HTMLButtonElement | null>>>({});
  const returnTo = useRef<BusinessKey | null>(null);
  useEffect(() => {
    if (editing !== null || returnTo.current === null) return;
    editButtons.current[returnTo.current]?.focus();
    returnTo.current = null;
  }, [editing]);

  const stored = (key: BusinessKey): string | null =>
    (key === 'name'
      ? workspace.name
      : key === 'description'
        ? workspace.description
        : workspace.address) ?? null;

  function start(key: BusinessKey) {
    if (editing === key) return;
    setEditing(key);
    setDraft(stored(key) ?? '');
    setProblem(null);
    setSavedKey(null);
  }

  function cancel() {
    returnTo.current = editing;
    setEditing(null);
    setProblem(null);
  }

  function save() {
    const key = editing;
    if (key === null || isPending) return;
    const check = checkBusinessFact(key, draft);
    if (!check.ok) {
      setProblem(
        check.problem === 'required'
          ? t(`businessEdit.required.${key as 'name' | 'description'}`)
          : t('businessEdit.tooLong', { max: check.max, count: check.count }),
      );
      return;
    }
    /*
      An unchanged value is still sent. The route stamps "a person set this"
      only on a value that differs, so it marks nothing - and the If-Match
      still says whether someone else saved meanwhile.
    */
    setProblem(null);
    startTransition(async () => {
      // ★ Exactly this field, against the version this screen was drawn from.
      const result = await saveWorkspaceFacts({ [key]: check.value }, workspace.updatedAt ?? null);
      if (result.ok) {
        returnTo.current = key;
        setEditing(null);
        setSavedKey(key);
        return;
      }
      setProblem(problemFor(result, key));
    });
  }

  function problemFor(result: Extract<WriteResult<unknown>, { ok: false }>, key: BusinessKey) {
    if (result.reason === 'stale') return t('stale');
    if (result.reason === 'no_profile') return t('noProfile');
    // The route's own message is English and technical; this field's is not.
    if (result.reason === 'invalid' && key in result.fields) return t('businessEdit.rejected');
    return t('failed');
  }

  const chip = (key: string, field: string) =>
    fieldOrigin(workspace, field) === 'scan' ? (
      <span className={styles.fromWebsite} data-testid={`fact-origin-${key}`}>
        {t('provenance.origin.scan')}
      </span>
    ) : null;

  /** A row that edits in place: the whole row starts it; its Edit is the one tab stop. */
  const editable = (key: BusinessKey) => {
    const labelId = `${uid}-${key}-label`;
    const value = stored(key);

    if (editing === key) {
      const inputId = `${uid}-${key}-input`;
      const hintId = `${uid}-${key}-hint`;
      const field = {
        id: inputId,
        className: key === 'description' ? styles.inlineText : styles.inlineInput,
        value: draft,
        autoFocus: true,
        'aria-invalid': problem ? true : undefined,
        'aria-describedby': hintId,
        'data-testid': `fact-input-${key}`,
        onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      } as const;
      return (
        <div
          key={key}
          className={styles.rowInline}
          data-testid={`fact-${key}`}
          data-editing="yes"
          onKeyDown={(event) => {
            if (isPending) return;
            if (event.key === 'Escape') {
              event.stopPropagation();
              cancel();
              return;
            }
            // Enter in the field saves; on Save or Cancel it presses that button.
            const inField =
              event.target instanceof HTMLInputElement ||
              event.target instanceof HTMLTextAreaElement;
            if (event.key === 'Enter' && !event.shiftKey && inField) {
              event.preventDefault();
              save();
            }
          }}
        >
          <label className={styles.label} id={labelId} htmlFor={inputId}>
            {t(`fact.${key}`)}
          </label>
          <div className={styles.inlineControls}>
            {key === 'description' ? (
              <textarea {...field} rows={3} />
            ) : (
              <input type="text" {...field} />
            )}
            <button
              type="button"
              className={styles.inlineSave}
              data-testid={`fact-save-${key}`}
              onClick={save}
              disabled={isPending}
            >
              {isPending ? t('saving') : t('save')}
            </button>
            <button
              type="button"
              className={styles.inlineCancel}
              data-testid={`fact-cancel-${key}`}
              onClick={cancel}
              disabled={isPending}
            >
              {t('cancel')}
            </button>
          </div>
          <p className={styles.inlineHint} id={hintId} aria-live="polite">
            {problem ? (
              <span
                className={styles.rowNote}
                data-testid={`fact-problem-${key}`}
                data-note-kind="problem"
              >
                {problem}
              </span>
            ) : (
              t(`businessEdit.hint.${key}`)
            )}
          </p>
        </div>
      );
    }

    const editId = `${uid}-${key}-edit`;
    return (
      <div
        key={key}
        className={`${styles.row} ${styles.rowEditable}`}
        data-testid={`fact-${key}`}
        onClick={() => start(key)}
      >
        <div className={styles.label} id={labelId}>
          {t(`fact.${key}`)}
        </div>
        <div
          className={[styles.value, value ? '' : styles.unset].join(' ').trim()}
          data-testid={`fact-value-${key}`}
        >
          {/* ★★ ISOLATED: a Hebrew value with embedded Latin reorders on the English screen. */}
          {value ? <UserText>{value}</UserText> : t('unset')}
          {chip(key, BUSINESS_RULES[key].provenance)}
        </div>
        {savedKey === key ? (
          <span
            className={styles.rowNoteQuiet}
            data-testid={`fact-note-${key}`}
            data-note-kind="success"
          >
            {t('saved')}
          </span>
        ) : null}
        <button
          type="button"
          ref={(el) => {
            editButtons.current[key] = el;
          }}
          className={styles.edit}
          data-testid={`fact-edit-${key}`}
          aria-labelledby={`${editId} ${labelId}`}
          onClick={(event) => {
            event.stopPropagation();
            start(key);
          }}
        >
          <span id={editId}>{t('edit')}</span>
        </button>
      </div>
    );
  };

  /** A value no route here can save: no Edit, and why on its title. */
  const readOnly = (key: 'industry' | 'country', value: string | null, field: string) => (
    <div key={key} className={styles.row} data-testid={`fact-${key}`}>
      <div className={styles.label}>{t(`business.${key}`)}</div>
      <div
        className={[styles.value, value ? '' : styles.unset].join(' ').trim()}
        data-testid={`fact-value-${key}`}
        title={t('business.notHere')}
      >
        {value ?? t('unset')}
        {chip(key, field)}
      </div>
    </div>
  );

  const host = workspace.websiteDomain ? displayHost(workspace.websiteDomain) : null;
  const industry = industryReading(workspace.industry);
  const ago = (days: number) =>
    new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');

  return (
    <>
      {editable('name')}

      {/*
        The website: read, never edited here - `websiteDomain` is not on
        PATCH's allow-list. What the scan read and found sits under it, and
        "Scan again" leads to Studio · Knowledge, where the rescan lives.
      */}
      <div className={styles.row} data-testid="fact-website">
        <div className={styles.label}>{t('fact.website')}</div>
        <div className={styles.valueStack}>
          <div
            className={[styles.value, host ? '' : styles.unset].join(' ').trim()}
            data-testid="fact-value-website"
            title={host ? t('website.readOnly') : undefined}
          >
            {host ?? t('unset')}
          </div>
          {host ? null : (
            <p className={styles.rowCaveat} data-testid="fact-caveat-website">
              {t('website.notSet')}
            </p>
          )}
          {host && scan && scan.pagesRead > 0 ? (
            <p className={styles.rowCaveat} data-testid="business-scan-line">
              {[
                t('website.pagesRead', { count: scan.pagesRead }),
                scan.daysAgo === null ? t('website.reading') : ago(scan.daysAgo),
              ].join(' ')}
              {scan.topics.length > 0 ? ` · ${scan.topics.join(', ')}` : ''}
            </p>
          ) : null}
          {host && scan && scan.alsoFound.length > 0 ? (
            <span className={styles.alsoFound} data-testid="business-also-found">
              <span className={styles.alsoFoundLabel}>{t('website.alsoFound')}</span>
              {scan.alsoFound.map((item) => (
                <span key={`${item.kind}-${item.name}`} className={styles.alsoFoundChip}>
                  {item.kind === 'store' ? t('website.store', { name: item.name }) : item.name}
                </span>
              ))}
            </span>
          ) : null}
        </div>
        {host ? (
          <Link
            href={{ pathname: '/studio/knowledge', hash: 'scan' }}
            className={styles.edit}
            data-testid="business-scan-again"
          >
            {t('website.scanAgain')}
          </Link>
        ) : null}
      </div>

      {editable('description')}
      {editable('address')}

      {readOnly(
        'industry',
        industry === null
          ? null
          : 'code' in industry
            ? t(`business.industryName.${industry.code}`)
            : industry.text,
        'industry',
      )}
      {readOnly('country', countryName(workspace.country, locale), 'country')}
    </>
  );
}
