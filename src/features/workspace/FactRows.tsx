'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { fieldOrigin, type DayKey, type Workspace, displayHost } from '@/api/contracts/workspace';
import { Button } from '@/design-system/primitives/button/Button';
import { Input } from '@/design-system/primitives/input/Input';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link } from '@/i18n/navigation';

import { saveWorkspaceFacts, type WriteResult } from './actions';
import { summariseWeek, weekOf } from './hours';
import styles from './Workspace.module.css';

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

const TIMEZONES: readonly string[] = (() => {
  try {
    return Intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

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

  const origin = (key: FactKey) => {
    const field = PROVENANCE_FIELD[key];
    return field ? fieldOrigin(workspace, field) : 'unknown';
  };

  function saveCurrencyTimezone() {
    setNote(null);
    startTransition(async () => {
      const result = await saveWorkspaceFacts(
        {
          currency: currency.trim() ? currency.trim().toUpperCase() : null,
          timezone: timezone.trim(),
        },
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
        <div
          className={styles.rowEditing}
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
          <div className={styles.rowEditor}>
            <div className={styles.label}>{t('fact.currencyTimezone')}</div>
            <div className={styles.value}>
              <div className={styles.editFields}>
                <Input
                  label={t('currency')}
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value)}
                />
                {/*
                  ★ Searchable by city: the IANA zone name CONTAINS the city.
                  Still free text underneath — a zone this browser does not
                  list must not lock a tenant out of saving their own value.
                */}
                <Input
                  label={t('fact.currencyTimezone')}
                  value={timezone}
                  list="timezone-options"
                  onChange={(e) => setTimezone(e.target.value)}
                />
                <datalist id="timezone-options" data-testid="timezone-options">
                  {TIMEZONES.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className={styles.editActions}>
              <Button
                variant="primary"
                size="sm"
                data-testid="fact-save-currencyTimezone"
                onClick={saveCurrencyTimezone}
                disabled={isPending}
              >
                {isPending ? t('saving') : t('save')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setNote(null);
                }}
              >
                {t('cancel')}
              </Button>
              {note ? (
                <span
                  className={[styles.rowNote, note.quiet ? styles.rowNoteQuiet : '']
                    .join(' ')
                    .trim()}
                  data-testid="fact-note-currencyTimezone"
                  data-note-kind={note.quiet ? 'success' : 'problem'}
                >
                  {note.text}
                </span>
              ) : null}
            </div>
          </div>
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
              ? [workspace.currency ?? t('currencyUnset'), workspace.timezone]
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
              setTimezone(workspace.timezone ?? '');
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
