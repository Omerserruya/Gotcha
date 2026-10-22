'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';

import {
  countryName,
  countryOptions,
  displayHost,
  fieldOrigin,
  industryReading,
  isoCountry,
  websiteOrigin,
  type Workspace,
} from '@/api/contracts/workspace';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { saveWorkspaceFacts, type WriteResult } from './actions';
import { FromWebsite } from './FromWebsite';
import type { WebsiteScan } from './load-workspace';
import styles from './Workspace.module.css';

/**
 * The business, as one block of 11's table - and the only place it is shown
 * (Omer, 2026-10-11: "business name, website, what you sell and address
 * appear twice and can't be edited there"). It was these rows AND the 11b
 * drawer, which repeated them as a form.
 *
 * ★ EDITABLE IS WHAT `PATCH /workspace` SAVES, AND NOTHING ELSE. Its
 *   allow-list (services/auth/src/routes/workspace.ts) takes `name` (1-200),
 *   `description` (1-2000), `address` (0-300, or null) and, since a6bfa7c9,
 *   `website` (an http(s) address, stored as its origin; null clears it),
 *   `industry` (1-120, not cleared) and `country` (ISO 3166 alpha-2; null
 *   clears it). Every one edits in its row, 11e's way - Enter saves, Esc
 *   cancels. Saving a website never starts a scan; "Scan again" does that,
 *   in Studio · Knowledge.
 */

export type BusinessKey = 'name' | 'website' | 'description' | 'address' | 'industry' | 'country';

type TextKey = 'name' | 'description' | 'address' | 'industry';

/** The route's own rule for each free-text field, after it trims. */
export const BUSINESS_RULES: Readonly<
  Record<TextKey, { readonly max: number; readonly required: boolean }>
> = {
  name: { max: 200, required: true },
  description: { max: 2000, required: true },
  address: { max: 300, required: false },
  industry: { max: 120, required: true },
};

/** The provenance field behind each row's "From your website" chip. */
const PROVENANCE: Readonly<Record<BusinessKey, string>> = {
  name: 'organizationName',
  website: 'websiteDomain',
  description: 'businessDescription',
  address: 'address',
  industry: 'industry',
  country: 'country',
};

export type BusinessCheck =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly problem: 'required' | 'website' }
  | {
      readonly ok: false;
      readonly problem: 'tooLong';
      readonly max: number;
      readonly count: number;
    };

/**
 * What the route would answer, asked before the request. Trimmed as it trims;
 * an empty address, website or country is `null` (cleared), an empty name,
 * description or industry refused; a website goes as the origin it is stored
 * as.
 */
export function checkBusinessFact(key: BusinessKey, raw: string): BusinessCheck {
  const value = raw.trim();
  if (key === 'country') return { ok: true, value: value === '' ? null : value.toUpperCase() };
  if (key === 'website') {
    if (value === '') return { ok: true, value: null };
    const origin = websiteOrigin(value);
    return origin ? { ok: true, value: origin } : { ok: false, problem: 'website' };
  }
  const rule = BUSINESS_RULES[key];
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
  const countries = useMemo(() => countryOptions(locale), [locale]);
  /* After a save or a cancel, focus goes back to the row it left. */
  const editButtons = useRef<Partial<Record<BusinessKey, HTMLButtonElement | null>>>({});
  const returnTo = useRef<BusinessKey | null>(null);
  useEffect(() => {
    if (editing !== null || returnTo.current === null) return;
    editButtons.current[returnTo.current]?.focus();
    returnTo.current = null;
  }, [editing]);

  const industry = industryReading(workspace.industry);
  const industryShown =
    industry === null
      ? null
      : 'code' in industry
        ? t(`business.industryName.${industry.code}`)
        : industry.text;
  const host = workspace.websiteDomain ? displayHost(workspace.websiteDomain) : null;
  const storedCountry = isoCountry(workspace.country) ?? '';

  /** What the field opens with. An industry kept as a code opens as its name. */
  const opening = (key: BusinessKey): string =>
    key === 'name'
      ? (workspace.name ?? '')
      : key === 'description'
        ? (workspace.description ?? '')
        : key === 'address'
          ? (workspace.address ?? '')
          : key === 'website'
            ? (workspace.websiteDomain ?? '')
            : key === 'industry'
              ? (industryShown ?? '')
              : storedCountry;

  /** What the row reads as, not being edited. */
  const shown = (key: BusinessKey): ReactNode =>
    key === 'website'
      ? host
      : key === 'industry'
        ? industryShown
        : key === 'country'
          ? countryName(workspace.country, locale)
          : opening(key) || null;

  function start(key: BusinessKey) {
    if (editing === key) return;
    setEditing(key);
    setDraft(opening(key));
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
        check.problem === 'tooLong'
          ? t('businessEdit.tooLong', { max: check.max, count: check.count })
          : check.problem === 'website'
            ? t('businessEdit.website')
            : t(`businessEdit.required.${key as 'name' | 'description' | 'industry'}`),
      );
      return;
    }
    /*
      An unchanged value is still sent. The route stamps "a person set this"
      only on a value that differs, so it marks nothing - and the If-Match
      still says whether someone else saved meanwhile.

      ★ An industry kept as a code opens as its name; left as it opened, the
        code goes back - never its name in this screen's language in its place.
    */
    const value =
      key === 'industry' && industry !== null && 'code' in industry && check.value === industryShown
        ? workspace.industry!
        : check.value;
    setProblem(null);
    startTransition(async () => {
      // ★ Exactly this field, against the version this screen was drawn from.
      const result = await saveWorkspaceFacts({ [key]: value }, workspace.updatedAt ?? null);
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

  const chip = (key: BusinessKey) =>
    fieldOrigin(workspace, PROVENANCE[key]) === 'scan' ? (
      <FromWebsite domain={host} testId={`fact-origin-${key}`} />
    ) : null;

  const label = (key: BusinessKey) =>
    key === 'industry' || key === 'country' ? t(`business.${key}`) : t(`fact.${key}`);

  /**
   * A row that edits in place: the whole row starts it; its Edit is the one
   * tab stop. `below` is what the row says under its value (the website's
   * scan line); `beside` is a second action that stays its own.
   */
  const editable = (key: BusinessKey, below?: ReactNode, beside?: ReactNode) => {
    const labelId = `${uid}-${key}-label`;
    const value = shown(key);

    if (editing === key) {
      const inputId = `${uid}-${key}-input`;
      const hintId = `${uid}-${key}-hint`;
      const field = {
        id: inputId,
        value: draft,
        autoFocus: true,
        'aria-invalid': problem ? true : undefined,
        'aria-describedby': hintId,
        'data-testid': `fact-input-${key}`,
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
              event.target instanceof HTMLTextAreaElement ||
              event.target instanceof HTMLSelectElement;
            if (event.key === 'Enter' && !event.shiftKey && inField) {
              event.preventDefault();
              save();
            }
          }}
        >
          <label className={styles.label} id={labelId} htmlFor={inputId}>
            {label(key)}
          </label>
          <div className={styles.inlineControls}>
            {key === 'description' ? (
              <textarea
                {...field}
                className={styles.inlineText}
                rows={3}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : key === 'country' ? (
              <select
                {...field}
                className={styles.inlineSelect}
                onChange={(e) => setDraft(e.target.value)}
              >
                <option value="">-</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                {...field}
                type={key === 'website' ? 'url' : 'text'}
                inputMode={key === 'website' ? 'url' : undefined}
                dir={key === 'website' ? 'ltr' : undefined}
                className={styles.inlineInput}
                onChange={(e) => setDraft(e.target.value)}
              />
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
          {label(key)}
        </div>
        {/*
          Always the stack, below or not: it is what fills the row, so Edit
          lands at the row's END (Omer, 2026-10-12: on Address it sat right
          after the value, at the start). A bare div took only its content.
        */}
        <div className={styles.valueStack}>
          <div
            className={[styles.value, value ? '' : styles.unset].join(' ').trim()}
            data-testid={`fact-value-${key}`}
          >
            {/* ★★ ISOLATED: a Hebrew value with embedded Latin reorders on the English screen. */}
            {value ? <UserText>{value}</UserText> : t('unset')}
            {chip(key)}
          </div>
          {below}
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
        {beside}
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

  const ago = (days: number) =>
    new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');

  /*
    Under the website: what the scan read and found. "Scan again" leads to
    Studio · Knowledge, where the rescan lives - its own action, so a click on
    it never starts editing the row.
  */
  const websiteBelow = (
    <>
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
    </>
  );
  const scanAgain = host ? (
    <Link
      href={{ pathname: '/studio/knowledge', hash: 'scan' }}
      className={styles.edit}
      data-testid="business-scan-again"
      onClick={(event) => event.stopPropagation()}
    >
      {t('website.scanAgain')}
    </Link>
  ) : null;

  return (
    <>
      {editable('name')}
      {editable('website', websiteBelow, scanAgain)}
      {editable('description')}
      {editable('address')}
      {editable('industry')}
      {editable('country')}
    </>
  );
}
