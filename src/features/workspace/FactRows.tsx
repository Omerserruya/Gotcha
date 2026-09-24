'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Fragment, useState, useTransition } from 'react';

import { DAY_KEYS, fieldOrigin, type DayKey, type Workspace } from '@/api/contracts/workspace';
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

type FactKey =
  'name' | 'website' | 'description' | 'address' | 'hours' | 'language' | 'currencyTimezone';

/**
 * Which provenance field each row stands for, where one row is one field.
 *
 * `hours` is deliberately absent: business hours live in `TenantSetting` and
 * are not in `PROVENANCED_FIELDS`, so nothing records whether the scan or a
 * person wrote them. **The design puts a "From website" badge on Opening
 * hours and we cannot back it** — the badge would be asserting a source
 * nobody stored.
 *
 * `currencyTimezone` is absent for a different reason: it is two fields, one
 * provenanced (`currency`) and one not (timezone lives in the hours setting).
 * A single badge over the pair would be claiming a source for both.
 */
const PROVENANCE_FIELD: Partial<Record<FactKey, string>> = {
  name: 'organizationName',
  description: 'businessDescription',
  address: 'address',
  language: 'primaryLanguage',
};

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

  /** The badge for a row, where the row stands for exactly one tracked field. */
  const origin = (key: FactKey) => {
    const field = PROVENANCE_FIELD[key];
    return field ? fieldOrigin(workspace, field) : 'unknown';
  };

  const row = (
    key: FactKey,
    value: string | null,
    form: React.ReactNode | null,
    /** Extra line under the value — a caveat the row needs, not a second value. */
    caveat?: string,
  ) => {
    // `form === null` means the field cannot be written through this screen.
    const readOnly = form === null;
    const isOpen = editing === key && !readOnly;
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
              {/*
                The badge INLINE, where the design puts it. The separate
                provenance panel below stays — it accounts for all seven
                tracked fields, including ones that have no row here — but the
                badge is what makes "Scanning again only updates fields marked
                From website" legible at the point it applies.

                Rendered only for `scan`. `human` and `unknown` say nothing
                here: the row already shows the value, and "you typed this" on
                every untouched row would be noise. The panel carries the full
                three-way account.
              */}
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
            {message?.quiet ? (
              <span
                className={styles.rowNoteQuiet}
                data-testid={`fact-note-${key}`}
                data-note-kind="success"
              >
                {message.text}
              </span>
            ) : null}
            {readOnly ? null : (
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
            )}
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
  const [aiOutside, setAiOutside] = useState<'active' | 'silent'>('active');
  const [outsideMsg, setOutsideMsg] = useState('');
  const [copied, setCopied] = useState(false);

  function seed(key: FactKey) {
    if (key === 'name') setText(workspace.name ?? '');
    if (key === 'description') setText(workspace.description ?? '');
    if (key === 'address') setText(workspace.address ?? '');
    if (key === 'language') setLanguage(workspace.languages[0] ?? '');
    if (key === 'currencyTimezone') {
      setCurrency(workspace.currency ?? '');
      setText(workspace.timezone ?? '');
    }
    if (key === 'hours') {
      setWeek(weekOf(workspace));
      setAiOutside(workspace.hours?.aiOutsideHours ?? 'active');
      setOutsideMsg(workspace.hours?.outsideHoursHandoffMessage ?? '');
      setCopied(false);
    }
  }

  function submit(key: FactKey) {
    if (key === 'name') return commit(key, { name: text.trim() });
    if (key === 'description') return commit(key, { description: text.trim() });
    // Empty clears it: the server accepts null for an address, and a workspace
    // that removed its address is a different fact from one that never had one.
    if (key === 'address') return commit(key, { address: text.trim() || null });
    if (key === 'language') {
      // A single entry, deliberately. PATCH now REFUSES a longer list with a
      // 422 rather than keeping the first and answering 200 — so two would be
      // rejected rather than forgotten, and there is still nowhere to put it.
      return commit(key, { languages: language.trim() ? [language.trim().toLowerCase()] : [] });
    }
    if (key === 'currencyTimezone') {
      return commit(key, {
        currency: currency.trim() ? currency.trim().toUpperCase() : null,
        timezone: text.trim(),
      });
    }
    return commit(key, {
      hours: hoursPatch(week, workspace.hours ?? null, {
        aiOutsideHours: aiOutside,
        outsideHoursHandoffMessage: outsideMsg.trim(),
      }),
    });
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

  const storedLanguage = workspace.languages[0];

  return (
    <div className={styles.facts}>
      {/*
        The design's header, above the rows it is about.
        ══════════════════════════════════════════════════════════════════
        It is the sentence that makes the inline badges mean something: a
        reader who meets "From website" without it has no reason to think the
        marking does anything.

        The domain is named when we have one — "filled in from avivco.il" is
        a verifiable claim and "filled in from your website" is not.

        NO "Scan again" BUTTON YET. `POST /workspace/scan` exists and returns
        `applied`, `offer` and `reach`, so a rescan is not one action but a
        conversation: some fields change by themselves, others come back as
        proposals the owner must accept, and the site may turn out to be
        unreadable. A button that fired the scan and dropped `offer` on the
        floor would silently discard the half the endpoint exists to produce.
      */}
      <p className={styles.factsIntro} data-testid="facts-intro">
        {workspace.websiteDomain
          ? t('intro.withSite', { domain: workspace.websiteDomain })
          : t('intro.noSite')}
      </p>

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

      {/*
        ★ THE WEBSITE ROW, WITHOUT THE PAGE COUNT THE DESIGN SHOWS.
        ══════════════════════════════════════════════════════════════════
        The design's value is "avivco.il · 42 pages read, 3 days ago".

        Neither number reaches this screen. `POST /workspace/scan` returns
        `reach` — `pagesRead` AND `distinctTextPages` — but `GET /workspace`
        does not, and nothing persists it, so on load there is no count and
        no date to show. Rendering the domain alone is the whole of what is
        known here.

        That is the safe direction to be missing it in. `pagesRead` on this
        tenant is 17 against `distinctTextPages` of 1 — a password-protected
        store answering every path with the same login page — so "42 pages
        read" is exactly the sentence the crawler's own comment forbids.

        Read-only: `PATCH /workspace` has a closed allow-list and
        `websiteDomain` is not on it. A control here would 422.
      */}
      {row(
        'website',
        workspace.websiteDomain ?? null,
        null,
        workspace.websiteDomain ? t('website.readOnly') : t('website.notSet'),
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

          {/*
            Sunday to Thursday is the Israeli working week, and typing the
            same two times five times is where a week gets entered wrong.
            Purely local — it fills the inputs and changes nothing until Save.
          */}
          <button
            type="button"
            className={styles.hoursCopy}
            data-testid="hours-copy-sunday"
            onClick={() => {
              const sun = week.sunday;
              setWeek({
                ...week,
                monday: { ...sun },
                tuesday: { ...sun },
                wednesday: { ...sun },
                thursday: { ...sun },
              });
              setCopied(true);
            }}
          >
            {t('hours.copySunday')}
          </button>
          {copied ? (
            <p className={styles.hoursNote} data-testid="hours-copied">
              {t('hours.copied')}
            </p>
          ) : null}

          {/*
            ★ TWO THINGS THE DESIGN DRAWS THAT CANNOT BE STORED.
            ════════════════════════════════════════════════════════════════
            `+ Split` per day, and a holiday calendar with per-date overrides.
            `dayScheduleSchema` is `{ enabled, open?, close? }` — one range,
            one week, and no dates at all.

            Named rather than omitted, the same as the grant expiry on 12e: a
            missing control is indistinguishable from a control somebody
            failed to find, and a merchant who closes for lunch needs to know
            GOTCHA cannot be told that rather than hunting for the setting.
          */}
          <p className={styles.hoursAbsent} data-testid="hours-one-range">
            {t('hours.oneRange')}
          </p>
          <p className={styles.hoursAbsent} data-testid="hours-no-holidays">
            {t('hours.noHolidays')}
          </p>

          {/*
            ★ OUTSIDE THESE HOURS — AND THE DESIGN POINTS AT THE WRONG SCREEN.
            ════════════════════════════════════════════════════════════════
            The design says "What customers are told outside these hours is
            set in Studio". There is no second field to go and set: every
            reference in the platform is to ONE key — `businessHours` in
            `TenantSetting`. `agents.ts:538` is that key's validator, its PUT
            and GET are that key's, `workspace.ts:93` serves it, and
            `ai-bot.service.ts:868` reads
            `biz.cfg?.outsideHoursHandoffMessage` off `parseBusinessHours` of
            it. A merchant following the pointer to Studio would change
            nothing, because there is nothing there to change.

            (I first reported this as two rival fields with one reader. It is
            one field. The Shopify shape was fresh and I matched on it.)

            ── ★ AND WHY BOTH FIELDS MUST ALWAYS TRAVEL ──
            The validator defaults them:

              aiOutsideHours:             .optional().default("active")
              outsideHoursHandoffMessage: .optional().default("")

            and the PUT writes the parsed body wholesale. A Zod `.default()`
            does not mean "leave it alone" — an OMITTED field is materialised
            at its default and then WRITTEN. So a client that leaves these out
            does not preserve them, it overwrites them: the message is cleared
            and `aiOutsideHours` resets to `active`.

            Which means **a merchant who deliberately silenced the AI overnight
            has it answering customers at 2am** because some other caller saved
            a schedule without mentioning it.

            The protection lives entirely here, in the caller. That is a
            backend defect and it is with Backend; what this screen owes is to
            keep sending both, which `hoursPatch` does whether or not the form
            is editing them.
          */}
          <p className={styles.hoursSectionHeading}>{t('hours.outsideHeading')}</p>
          <div className={styles.editFields}>
            <label className={styles.hoursChoice}>
              <span className={styles.hoursChoiceLabel}>{t('hours.aiOutsideLabel')}</span>
              <select
                className={styles.hoursSelect}
                data-testid="hours-ai-outside"
                value={aiOutside}
                onChange={(e) => setAiOutside(e.target.value === 'silent' ? 'silent' : 'active')}
              >
                <option value="active">{t('hours.aiOutside.active')}</option>
                <option value="silent">{t('hours.aiOutside.silent')}</option>
              </select>
            </label>
            <Input
              label={t('hours.messageLabel')}
              value={outsideMsg}
              maxLength={500}
              placeholder={t('hours.messagePlaceholder')}
              hint={t('hours.messageHint')}
              onChange={(e) => setOutsideMsg(e.target.value)}
            />
          </div>
        </div>,
      )}

      {/*
        Language on its own row, because 11d is a dedicated panel and a row
        that shares a label with Currency has nothing to open it from.

        Two sentences, because they are two settings the design is right to
        separate: what customers are answered in, and what GOTCHA itself runs
        in. Only the second is stored here — the first is decided per
        conversation from the customer's own message, on a prompt rule marked
        non-negotiable, and this column is never read for it.
      */}
      {row(
        'language',
        storedLanguage
          ? `${t('language.replies')} · ${t('language.system', { locale: languageName(storedLanguage) })}`
          : null,
        <div className={styles.value}>
          <Input
            label={t('language')}
            value={language}
            maxLength={8}
            hint={t('languageNote')}
            onChange={(e) => setLanguage(e.target.value)}
          />
        </div>,
      )}

      {/*
        Currency and time zone together, as the design has them — two facts a
        person sets once and reads as one line. They are stored apart
        (`BusinessProfile.currency` and the hours setting), which is why the
        row carries no provenance badge: one badge over two fields would be
        claiming a source for both.
      */}
      {row(
        'currencyTimezone',
        workspace.currency || workspace.timezone
          ? [workspace.currency ?? t('currencyUnset'), workspace.timezone]
              .filter(Boolean)
              .join(' · ')
          : null,
        <div className={styles.value}>
          <div className={styles.editFields}>
            <Input
              label={t('currency')}
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value)}
            />
            <Input
              label={t('fact.currencyTimezone')}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
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
