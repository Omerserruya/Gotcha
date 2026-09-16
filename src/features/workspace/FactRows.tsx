'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Fragment, useState, useTransition } from 'react';

import { DAY_KEYS, type DayKey, type Workspace } from '@/api/contracts/workspace';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';

import { saveWorkspaceFacts, type WriteResult } from './actions';
import { hoursPatch, summariseWeek, weekOf, type DayHours } from './hours';
import styles from './Workspace.module.css';

/**
 * The six facts an AI employee quotes to a customer.
 *
 * One row at a time is editable. Not a page-wide form: each fact is
 * independently true, saving one should not require the other five to be
 * valid, and a single Save at the foot would make a typo in the address block
 * a correction to the opening hours.
 *
 * Every save sends `If-Match`, so two people editing this page cannot silently
 * overwrite each other. A stale write is answered in the row, with a reload
 * offered and never forced — the other person's version is not automatically
 * the right one, and discarding what was just typed to show it would be.
 */

type FactKey = 'name' | 'description' | 'address' | 'hours' | 'currencyLanguage' | 'timezone';

export function FactRows({ workspace }: { workspace: Workspace }) {
  const t = useTranslations('workspace');
  const locale = useLocale();
  const [editing, setEditing] = useState<FactKey | null>(null);
  /*
   * A row's own message. `quiet` marks the one kind that is good news.
   *
   * It renders in TWO places, because a save that fails leaves the row open
   * and a save that succeeds closes it — and both carry the same test id with
   * a `data-note-kind` beside it. Without the kind, a test can assert that a
   * message appeared but not WHICH, and "saved" and "someone else saved first"
   * are the two outcomes it most needs to tell apart.
   */
  const [note, setNote] = useState<{ key: FactKey; text: string; quiet?: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();

  function commit(key: FactKey, patch: Record<string, unknown>) {
    setNote(null);
    startTransition(async () => {
      const result = await saveWorkspaceFacts(patch, workspace.updatedAt ?? null);
      if (result.ok) {
        setEditing(null);
        setNote({ key, text: t('saved'), quiet: true });
        return;
      }
      setNote({ key, text: messageFor(result, t) });
    });
  }

  const row = (key: FactKey, value: string | null, form: React.ReactNode) => {
    const isOpen = editing === key;
    const message = note?.key === key ? note : null;

    return (
      <div
        key={key}
        className={isOpen ? styles.rowEditing : styles.row}
        data-testid={`fact-${key}`}
      >
        {isOpen ? (
          <>
            <div className={styles.label}>{t(`fact.${key}`)}</div>
            {form}
            <div className={styles.editActions}>
              <Button
                variant="primary"
                size="sm"
                data-testid={`fact-save-${key}`}
                onClick={() => submit(key)}
                disabled={isPending}
              >
                {isPending ? t('saving') : t('save')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setNote(null);
                }}
              >
                {t('cancel')}
              </Button>
              {message ? (
                <span
                  className={[styles.rowNote, message.quiet ? styles.rowNoteQuiet : '']
                    .join(' ')
                    .trim()}
                  data-testid={`fact-note-${key}`}
                  data-note-kind={message.quiet ? 'success' : 'problem'}
                >
                  {message.text}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className={styles.label}>{t(`fact.${key}`)}</div>
            <div
              className={[styles.value, value ? '' : styles.unset].join(' ').trim()}
              data-testid={`fact-value-${key}`}
            >
              {value ?? t('unset')}
            </div>
            {message?.quiet ? (
              <span
                className={styles.rowNoteQuiet}
                data-testid={`fact-note-${key}`}
                data-note-kind="success"
              >
                {message.text}
              </span>
            ) : null}
            <button
              type="button"
              className={styles.edit}
              data-testid={`fact-edit-${key}`}
              onClick={() => {
                setEditing(key);
                setNote(null);
                seed(key);
              }}
            >
              {t('edit')}
            </button>
          </>
        )}
      </div>
    );
  };

  // ── Drafts, one per shape ───────────────────────────────────────────
  const [text, setText] = useState('');
  const [currency, setCurrency] = useState('');
  const [language, setLanguage] = useState('');
  const [week, setWeek] = useState<Record<DayKey, DayHours>>(() => weekOf(workspace));

  function seed(key: FactKey) {
    if (key === 'name') setText(workspace.name ?? '');
    if (key === 'description') setText(workspace.description ?? '');
    if (key === 'address') setText(workspace.address ?? '');
    if (key === 'timezone') setText(workspace.timezone ?? '');
    if (key === 'currencyLanguage') {
      setCurrency(workspace.currency ?? '');
      setLanguage(workspace.languages[0] ?? '');
    }
    if (key === 'hours') setWeek(weekOf(workspace));
  }

  function submit(key: FactKey) {
    if (key === 'name') return commit(key, { name: text.trim() });
    if (key === 'description') return commit(key, { description: text.trim() });
    // Empty clears it: the server accepts null for an address, and a workspace
    // that removed its address is a different fact from one that never had one.
    if (key === 'address') return commit(key, { address: text.trim() || null });
    if (key === 'timezone') return commit(key, { timezone: text.trim() });
    if (key === 'currencyLanguage') {
      return commit(key, {
        currency: currency.trim() ? currency.trim().toUpperCase() : null,
        // A single entry, deliberately: PATCH keeps only the first, so a
        // control that accepted two would forget one on the next reload.
        languages: language.trim() ? [language.trim().toLowerCase()] : [],
      });
    }
    return commit(key, { hours: hoursPatch(week, workspace.hours ?? null) });
  }

  /*
   * Three states, not two. `hours` null means nobody has ever saved a week;
   * an object with `enabled: false` means someone saved one and switched it
   * off, which is a decision rather than an omission - and it means GOTCHA
   * answers at any hour. Rendering both as "Not set" would hide that.
   */
  const summary = summariseWeek(weekOf(workspace));
  const hoursNeverSaved = workspace.hours == null;
  const hoursSwitchedOff = workspace.hours != null && workspace.hours.enabled === false;
  const hoursValue = hoursNeverSaved
    ? null
    : hoursSwitchedOff
      ? t('hours.disabled')
      : summary.isEmpty
        ? null
        : [
            ...summary.runs.map(
              (run) =>
                `${
                  run.days.length > 1
                    ? `${t(`dayShort.${run.days[0] as DayKey}`)}–${t(`dayShort.${run.days[run.days.length - 1] as DayKey}`)}`
                    : t(`dayShort.${run.days[0] as DayKey}`)
                } ${t('hours.to', { open: run.open, close: run.close })}`,
            ),
            ...(summary.closed.length > 0
              ? [
                  t('hours.closed', {
                    days: summary.closed.map((d) => t(`dayShort.${d}`)).join(', '),
                  }),
                ]
              : []),
          ].join(' · ');

  /*
   * The row is named after two facts, so it shows two.
   *
   * It used to render the bare code `he` and omit the currency entirely, which
   * left a reader unable to tell an unset currency from a row that had
   * forgotten it. Each half now says what it is, or says it is unset, the way
   * Address does — and the language renders as a NAME. Every other value on
   * this screen is human text; a wire format is not a fact anyone quotes.
   *
   * `Intl.DisplayNames` localises it, so a Hebrew reader sees עברית rather
   * than the English word for their own language.
   */
  const languageName = (code: string): string => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
    } catch {
      // An unrecognised code is shown as itself rather than hidden: a value
      // the product cannot name is still a value the owner set.
      return code;
    }
  };

  const currencyPart = workspace.currency ?? t('currencyUnset');
  const storedLanguage = workspace.languages[0];
  const languagePart = storedLanguage
    ? `${languageName(storedLanguage)}, ${t('repliesInCustomerLanguage')}`
    : t('languageUnset');
  // Null only when BOTH are unset, so the row falls back to the shared
  // "Not set" rather than saying it twice.
  const languageValue =
    workspace.currency || storedLanguage ? `${currencyPart} · ${languagePart}` : null;

  return (
    <div className={styles.facts}>
      {row(
        'name',
        workspace.name ?? null,
        <div className={styles.value}>
          <Input
            label={t('fact.name')}
            labelHidden
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
          />
        </div>,
      )}

      {row(
        'description',
        workspace.description ?? null,
        <div className={styles.value}>
          <Input
            label={t('fact.description')}
            labelHidden
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={2000}
          />
        </div>,
      )}

      {row(
        'address',
        workspace.address ?? null,
        <div className={styles.value}>
          <Input
            label={t('fact.address')}
            labelHidden
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={300}
          />
        </div>,
      )}

      {row(
        'hours',
        hoursValue,
        <div className={styles.value}>
          {/*
            One grid, one pair of headings, one origin per column.

            Built as seven separate rows it repeated its own headings down the
            page and the columns drifted rightward, so which pair of times
            belonged to which day — the only thing this form has to say —
            stopped being readable.

            The inputs carry `aria-label` rather than visible labels: the
            column headings name them for a sighted reader, and a label
            repeated in every cell is what caused the drift.
          */}
          <div className={styles.hoursGrid}>
            <span className={styles.hoursSpacer} />
            <span className={styles.hoursHeading}>{t('hours.open')}</span>
            <span className={styles.hoursHeading}>{t('hours.close')}</span>

            {DAY_KEYS.map((day) => (
              <Fragment key={day}>
                <label className={styles.hoursDay}>
                  <input
                    type="checkbox"
                    checked={week[day].enabled}
                    onChange={(e) =>
                      setWeek({ ...week, [day]: { ...week[day], enabled: e.target.checked } })
                    }
                  />
                  {t(`day.${day}`)}
                </label>
                <input
                  className={styles.hoursInput}
                  type="time"
                  aria-label={`${t(`day.${day}`)} — ${t('hours.open')}`}
                  value={week[day].open ?? ''}
                  disabled={!week[day].enabled}
                  onChange={(e) =>
                    setWeek({ ...week, [day]: { ...week[day], open: e.target.value } })
                  }
                />
                <input
                  className={styles.hoursInput}
                  type="time"
                  aria-label={`${t(`day.${day}`)} — ${t('hours.close')}`}
                  value={week[day].close ?? ''}
                  disabled={!week[day].enabled}
                  onChange={(e) =>
                    setWeek({ ...week, [day]: { ...week[day], close: e.target.value } })
                  }
                />
              </Fragment>
            ))}
          </div>
        </div>,
      )}

      {row(
        'currencyLanguage',
        languageValue || null,
        <div className={styles.value}>
          <div className={styles.editFields}>
            <Input
              label={t('currency')}
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value)}
            />
            <Input
              label={t('language')}
              value={language}
              maxLength={8}
              hint={t('languageNote')}
              onChange={(e) => setLanguage(e.target.value)}
            />
          </div>
        </div>,
      )}

      {row(
        'timezone',
        workspace.timezone ?? null,
        <div className={styles.value}>
          <Input
            label={t('fact.timezone')}
            labelHidden
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>,
      )}
    </div>
  );
}

/** One message per failure, because they need different actions from the reader. */
function messageFor(
  result: Extract<WriteResult<unknown>, { ok: false }>,
  t: ReturnType<typeof useTranslations<'workspace'>>,
): string {
  if (result.reason === 'stale') return t('stale');
  if (result.reason === 'no_profile') return t('noProfile');
  if (result.reason === 'invalid') {
    // The server's own wording, which names the field and the limit. Ours
    // would be a second, vaguer copy of a message it already wrote.
    return Object.values(result.fields)[0] ?? t('failed');
  }
  return t('failed');
}
