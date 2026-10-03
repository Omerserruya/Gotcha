'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState, useTransition } from 'react';

import { fieldOrigin, type DayKey, type Workspace, displayHost } from '@/api/contracts/workspace';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { saveWorkspaceFacts, type WriteResult } from './actions';
import { summariseWeek, weekOf } from './hours';
import styles from './Workspace.module.css';
import { COMMON_CURRENCIES, currencyLabel, zoneFromInput, zoneLabel, zoneOptions } from './zones';

/**
 * The facts an AI employee quotes to a customer, as 11's table.
 *
 * 02 edits them in three drawers and one place: name, website, what you sell
 * and address in 11b (`?panel=business`), opening hours in 11c
 * (`?panel=hours`), language in 11d (`?panel=language`). Only a single value
 * edits in its row — 11e, "Enter saves, Esc cancels" — and that is currency
 * & time zone.
 */

type FactKey =
  'name' | 'website' | 'description' | 'address' | 'hours' | 'language' | 'currencyTimezone';

type Panel = 'business' | 'hours' | 'language';

/**
 * The provenance field behind each row. Hours and currency & time zone have
 * none: hours is a setting the scan never writes, and one badge over two
 * fields would claim a source for both.
 */
const PROVENANCE_FIELD: Partial<Record<FactKey, string>> = {
  name: 'organizationName',
  description: 'businessDescription',
  address: 'address',
  language: 'primaryLanguage',
};

export function FactRows({ workspace }: { readonly workspace: Workspace }) {
  const t = useTranslations('workspace');
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [currency, setCurrency] = useState('');
  const [timezone, setTimezone] = useState('');
  const [note, setNote] = useState<{ text: string; quiet?: boolean } | null>(null);
  const [isPending, startTransition] = useTransition();
  const zones = useMemo(() => zoneOptions(locale), [locale]);

  const origin = (key: FactKey) => {
    const field = PROVENANCE_FIELD[key];
    return field ? fieldOrigin(workspace, field) : 'unknown';
  };

  function saveCurrencyTimezone() {
    setNote(null);
    const zone = zoneFromInput(timezone, zones);
    if (zone === null) {
      setNote({ text: t('zoneUnknown') });
      return;
    }
    startTransition(async () => {
      const result = await saveWorkspaceFacts(
        { currency: currency || null, timezone: zone },
        workspace.updatedAt ?? null,
      );
      if (result.ok) {
        setEditing(false);
        setNote({ text: t('saved'), quiet: true });
        return;
      }
      setNote({ text: messageFor(result, t) });
    });
  }

  /** A row whose Edit opens a drawer. */
  const row = (key: FactKey, value: string | null, panel: Panel, caveat?: string) => (
    <div key={key} className={styles.row} data-testid={`fact-${key}`}>
      <div className={styles.label}>{t(`fact.${key}`)}</div>
      <div
        className={[styles.value, value ? '' : styles.unset].join(' ').trim()}
        data-testid={`fact-value-${key}`}
      >
        {/*
          ★★ ISOLATED: a Hebrew value with embedded Latin reordered on the
          English screen. The data was right and the rendering was not.
        */}
        {value === null ? t('unset') : <UserText>{value}</UserText>}
        {/* The badge only where it is true: `scan`, never `human` or unknown. */}
        {origin(key) === 'scan' ? (
          <span className={styles.fromWebsite} data-testid={`fact-origin-${key}`}>
            {t('provenance.origin.scan')}
          </span>
        ) : null}
      </div>
      {caveat ? (
        <p className={styles.rowCaveat} data-testid={`fact-caveat-${key}`}>
          {caveat}
        </p>
      ) : null}
      <Link
        href={{ pathname: '/settings/workspace', query: { panel } }}
        className={styles.edit}
        data-testid={`fact-edit-${key}`}
        scroll={false}
      >
        {t('edit')}
      </Link>
    </div>
  );

  const summary = summariseWeek(weekOf(workspace));
  const hoursNeverSaved = workspace.hours == null;
  /*
    "Set, but switched off" only when there IS a week to switch off. Dev
    stores `{ enabled: false }` and no schedule at all — that is "Not set",
    and the drawer would otherwise show seven closed days under the claim.
  */
  const hoursSwitchedOff =
    workspace.hours != null && workspace.hours.enabled === false && !summary.isEmpty;
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

  const languageName = (code: string): string => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  };

  const storedLanguage = workspace.languages[0];

  return (
    <div className={styles.facts}>
      {row('name', workspace.name ?? null, 'business')}

      {/*
        ★ THE WEBSITE ROW, WITHOUT THE PAGE COUNT THE DESIGN SHOWS. Neither
        number reaches this screen — `GET /workspace` does not carry the
        scan's `reach` — and "42 pages read" is the sentence the crawler's
        own comment forbids for a store answering every path with one login
        page. The domain is the whole of what is known here. Its Edit opens
        11b, where the website is drawn and not live: `websiteDomain` is not
        on `PATCH /workspace`'s allow-list.
      */}
      {row(
        'website',
        workspace.websiteDomain ? displayHost(workspace.websiteDomain) : null,
        'business',
        workspace.websiteDomain ? undefined : t('website.notSet'),
      )}

      {row('description', workspace.description ?? null, 'business')}
      {row('address', workspace.address ?? null, 'business')}
      {row('hours', hoursValue, 'hours')}

      {/*
        The business's MAIN language — `primaryLanguage`, what knowledge from
        the website is written in. Not the language replies go out in (each
        customer's own, by rule) and not the system language (the tenant's
        locale). 11d separates all three.
      */}
      {row('language', storedLanguage ? languageName(storedLanguage) : null, 'language')}

      {/*
        11e: the one row that edits in place — two values a person sets once
        and reads as one line. Enter saves, Esc cancels.
      */}
      {editing ? (
        /*
          11e, measured: the edit happens ON the row — [₪ ILS ▾] [London
          (GMT+1)] Save Cancel — with a hint under it. The label is the row's,
          once. Enter saves, Esc cancels.
        */
        <div
          className={styles.rowInline}
          data-testid="fact-currencyTimezone"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setEditing(false);
              setNote(null);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              saveCurrencyTimezone();
            }
          }}
        >
          <div className={styles.label}>{t('fact.currencyTimezone')}</div>
          <div className={styles.inlineControls}>
            <select
              className={styles.inlineSelect}
              aria-label={t('currency')}
              value={currency}
              data-testid="currency-select"
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currency === '' ? <option value="">—</option> : null}
              {[
                ...new Set([
                  ...(workspace.currency ? [workspace.currency] : []),
                  ...COMMON_CURRENCIES,
                ]),
              ].map((code) => (
                <option key={code} value={code}>
                  {currencyLabel(code, locale)}
                </option>
              ))}
            </select>
            {/*
              ★ Searchable by city: "Type a city" finds the zone, shown as
              02 writes it — "London (GMT+1)" — and saved as IANA.
            */}
            <input
              className={styles.inlineCombo}
              aria-label={t('timezone')}
              placeholder={t('typeCity')}
              list="timezone-options"
              value={timezone}
              data-testid="timezone-input"
              onChange={(e) => setTimezone(e.target.value)}
            />
            <datalist id="timezone-options" data-testid="timezone-options">
              {zones.map((zone) => (
                <option key={zone.iana} value={zone.label} />
              ))}
            </datalist>
            <button
              type="button"
              className={styles.inlineSave}
              data-testid="fact-save-currencyTimezone"
              onClick={saveCurrencyTimezone}
              disabled={isPending}
            >
              {isPending ? t('saving') : t('save')}
            </button>
            <button
              type="button"
              className={styles.inlineCancel}
              onClick={() => {
                setEditing(false);
                setNote(null);
              }}
            >
              {t('cancel')}
            </button>
          </div>
          <p className={styles.inlineHint}>
            {note ? (
              <span
                className={note.quiet ? styles.rowNoteQuiet : styles.rowNote}
                data-testid="fact-note-currencyTimezone"
                data-note-kind={note.quiet ? 'success' : 'problem'}
              >
                {note.text}
              </span>
            ) : (
              t('currencyHint')
            )}
          </p>
        </div>
      ) : (
        <div className={styles.row} data-testid="fact-currencyTimezone">
          <div className={styles.label}>{t('fact.currencyTimezone')}</div>
          <div
            className={[styles.value, workspace.currency || workspace.timezone ? '' : styles.unset]
              .join(' ')
              .trim()}
            data-testid="fact-value-currencyTimezone"
          >
            {workspace.currency || workspace.timezone
              ? [
                  workspace.currency
                    ? currencyLabel(workspace.currency, locale)
                    : t('currencyUnset'),
                  workspace.timezone ? zoneLabel(workspace.timezone, locale) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('unset')}
          </div>
          {note?.quiet ? (
            <span
              className={styles.rowNoteQuiet}
              data-testid="fact-note-currencyTimezone"
              data-note-kind="success"
            >
              {note.text}
            </span>
          ) : null}
          <button
            type="button"
            className={styles.edit}
            data-testid="fact-edit-currencyTimezone"
            onClick={() => {
              setEditing(true);
              setNote(null);
              setCurrency(workspace.currency ?? '');
              setTimezone(workspace.timezone ? zoneLabel(workspace.timezone, locale) : '');
            }}
          >
            {t('edit')}
          </button>
        </div>
      )}
    </div>
  );
}

function messageFor(
  result: Extract<WriteResult<unknown>, { ok: false }>,
  t: ReturnType<typeof useTranslations<'workspace'>>,
): string {
  if (result.reason === 'stale') return t('stale');
  if (result.reason === 'no_profile') return t('noProfile');
  if (result.reason === 'invalid') {
    return Object.values(result.fields)[0] ?? t('failed');
  }
  return t('failed');
}
