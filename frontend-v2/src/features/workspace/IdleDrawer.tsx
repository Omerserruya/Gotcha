'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';

import {
  BOT_IDLE_DELAY_MAX_MINUTES,
  BOT_IDLE_GROUPS,
  botIdleGroupProblem,
  type BotIdleGroup,
  type BotIdleGroupKey,
  type BotIdleGroupWrite,
} from '@/api/contracts/bot-idle-automation';
import { IDLE_DELAY_MAX_MINUTES, type IdleAutomation } from '@/api/contracts/idle-automation';
import disclosure from '@/design-system/styles/disclosure.module.css';
import drawer from '@/design-system/styles/drawer.module.css';
import { Link } from '@/i18n/navigation';
import { wholeUnit, type DurationUnit } from '@/lib/duration';

import { saveBotIdleAutomation, saveIdleAutomation, type IdleWriteResult } from './idle-actions';
import { delayWords } from './IdleRow';
import type { BotIdleSetup } from './load-idle';
import styles from './Workspace.module.css';

const UNITS: readonly DurationUnit[] = ['minutes', 'hours', 'days'];
const IN_MINUTES: Readonly<Record<DurationUnit, number>> = { minutes: 1, hours: 60, days: 1440 };

/** A delay as the drawer edits it: a count and a unit. */
interface Delay {
  readonly count: string;
  readonly unit: DurationUnit;
}

const delayOf = (minutes: number | null, fallback: number): Delay => {
  const { unit, count } = wholeUnit((minutes ?? fallback) * 60_000);
  return { count: String(count), unit };
};

/** Minutes, or `null` when the entry is not a whole number within the PUT's seven days. */
export function minutesOf(delay: Delay, max: number = IDLE_DELAY_MAX_MINUTES): number | null {
  if (!/^\d+$/.test(delay.count.trim())) return null;
  const minutes = Number(delay.count.trim()) * IN_MINUTES[delay.unit];
  return minutes >= 1 && minutes <= max ? minutes : null;
}

/** The person-held part as the drawer edits it. */
interface PersonDraft {
  readonly remind: boolean;
  readonly remindAfter: Delay;
  readonly remindText: string;
  readonly close: boolean;
  readonly closeAfter: Delay;
  readonly closeText: string;
}

const personDraftOf = (s: IdleAutomation): PersonDraft => ({
  remind: s.reminderEnabled,
  remindAfter: delayOf(s.reminderDelayMinutes, 60),
  remindText: s.reminderMessage ?? '',
  close: s.autoCloseEnabled,
  closeAfter: delayOf(s.autoCloseDelayMinutes, 1440),
  closeText: s.autoCloseMessage ?? '',
});

/** One of the AI employee's groups as the drawer edits it. */
interface GroupDraft {
  readonly enabled: boolean;
  readonly remindAfter: Delay;
  readonly closeAfter: Delay;
  readonly remindText: string;
  readonly closeText: string;
}

const groupDraftOf = (g: BotIdleGroup): GroupDraft => ({
  enabled: g.enabled,
  remindAfter: delayOf(g.reminderAfterMinutes, g.reminderAfterMinutes),
  closeAfter: delayOf(g.closeAfterReminderMinutes, g.closeAfterReminderMinutes),
  remindText: g.reminderText,
  closeText: g.closeText,
});

/** What a group would send, or `null` while a delay is not one it takes. */
export function groupWriteOf(d: GroupDraft): BotIdleGroupWrite | null {
  const reminderAfterMinutes = minutesOf(d.remindAfter, BOT_IDLE_DELAY_MAX_MINUTES);
  const closeAfterReminderMinutes = minutesOf(d.closeAfter, BOT_IDLE_DELAY_MAX_MINUTES);
  if (reminderAfterMinutes === null || closeAfterReminderMinutes === null) return null;
  return {
    enabled: d.enabled,
    reminderAfterMinutes,
    closeAfterReminderMinutes,
    reminderText: d.remindText,
    closeText: d.closeText,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Drafts = Partial<Record<BotIdleGroupKey, GroupDraft>>;
type Sources = Partial<Record<BotIdleGroupKey, BotIdleGroup['source']>>;

function readGroups(bot: BotIdleSetup | undefined): { drafts: Drafts; sources: Sources } {
  const drafts: Drafts = {};
  const sources: Sources = {};
  if (bot?.kind === 'read') {
    for (const key of BOT_IDLE_GROUPS) {
      const g = bot.groups[key];
      if (g) {
        drafts[key] = groupDraftOf(g);
        sources[key] = g.source;
      }
    }
  }
  return { drafts, sources };
}

/**
 * Follow-up and auto-close (S3, Omer 2026-10-13: "Hi, we didn't hear back…"
 * after a while, and closing after a while - both optional).
 *
 * It says what the platform does, because nothing else on the screen will:
 * only conversations a person holds, whose last message is ours; the close
 * counts from our last message, which a sent reminder becomes; and on
 * WhatsApp past 24 hours the reminder is not sent and the close goes without
 * its message (Backend, B8).
 *
 * ★★ TWO PARTS (Omer, 2026-11-19): the person-held setting above, unchanged,
 *   and the AI employee's own below - two groups (live chat, messaging), on
 *   by default with the server's values. Each group is one row saying what
 *   happens today; it opens to its fields on a click (design-system
 *   disclosure, as the employee page's tool domains).
 * ★ ONE SAVE, ONLY WHAT CHANGED: a part, or a group, the reader did not touch
 *   is never sent - so saving never turns a default into "your own", and
 *   opening the drawer writes nothing.
 * ★ A closed group keeps its edits (the drafts live here, not in the group),
 *   and a field Save refuses inside a closed group opens it and takes focus.
 */
export function IdleDrawer({
  settings,
  bot,
}: {
  readonly settings: IdleAutomation;
  /** The AI employee's groups; absent, the drawer has only the person-held part. */
  readonly bot?: BotIdleSetup;
}) {
  const t = useTranslations('workspace');
  const [person, setPerson] = useState(() => personDraftOf(settings));
  const [personBase, setPersonBase] = useState(person);
  const [drafts, setDrafts] = useState<Drafts>(() => readGroups(bot).drafts);
  const [groupBase, setGroupBase] = useState<Drafts>(drafts);
  const [sources, setSources] = useState<Sources>(() => readGroups(bot).sources);
  const [open, setOpen] = useState<Partial<Record<BotIdleGroupKey, boolean>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [nothing, setNothing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const root = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);
  const id = useId();

  // A refused field in a group Save just opened: focus it once it is drawn.
  useEffect(() => {
    const testid = focusNext.current;
    if (!testid) return;
    focusNext.current = null;
    root.current?.querySelector<HTMLElement>(`[data-testid="${testid}"]`)?.focus();
  }, [open, problem]);

  const edit = (patch: Partial<PersonDraft>) => setPerson((was) => ({ ...was, ...patch }));
  const editGroup = (key: BotIdleGroupKey, patch: Partial<GroupDraft>) =>
    setDrafts((was) => (was[key] ? { ...was, [key]: { ...was[key], ...patch } } : was));

  const remindMinutes = minutesOf(person.remindAfter);
  const closeMinutes = minutesOf(person.closeAfter);
  const remindTextMissing = person.remind && person.remindText.trim() === '';
  const parts = bot !== undefined;

  /** The first field of a group Save would refuse, by test id; `null` when it can go. */
  const firstBad = (key: BotIdleGroupKey, d: GroupDraft): string | null => {
    if (minutesOf(d.remindAfter, BOT_IDLE_DELAY_MAX_MINUTES) === null) {
      return `bot-idle-${key}-reminder-count`;
    }
    if (d.enabled && d.remindText.trim() === '') return `bot-idle-${key}-reminder-text`;
    if (minutesOf(d.closeAfter, BOT_IDLE_DELAY_MAX_MINUTES) === null) {
      return `bot-idle-${key}-close-count`;
    }
    const write = groupWriteOf(d);
    return write && botIdleGroupProblem(write) === null ? null : `bot-idle-${key}-reminder-text`;
  };

  function save() {
    setProblem(null);
    setSaved(false);
    setNothing(false);
    const personDirty = !same(person, personBase);
    const dirty = BOT_IDLE_GROUPS.filter(
      (key) => drafts[key] && !same(drafts[key], groupBase[key]),
    );
    if (!personDirty && dirty.length === 0) {
      setNothing(true);
      return;
    }
    const personBad =
      personDirty && (remindMinutes === null || closeMinutes === null || remindTextMissing);
    const bad = dirty
      .map((key) => [key, firstBad(key, drafts[key]!)] as const)
      .find(([, field]) => field !== null);
    if (personBad || bad) {
      setProblem(t('idleDrawer.fix'));
      if (!personBad && bad) {
        focusNext.current = bad[1];
        setOpen((was) => ({ ...was, [bad[0]]: true }));
      }
      return;
    }
    const personNow = person;
    const groupsNow = Object.fromEntries(dirty.map((key) => [key, drafts[key]!])) as Drafts;
    startTransition(async () => {
      const [p, b] = await Promise.all([
        personDirty
          ? saveIdleAutomation({
              reminderEnabled: personNow.remind,
              reminderDelayMinutes: remindMinutes!,
              reminderMessage: personNow.remindText,
              autoCloseEnabled: personNow.close,
              autoCloseDelayMinutes: closeMinutes!,
              autoCloseMessage: personNow.closeText,
            })
          : null,
        dirty.length > 0
          ? saveBotIdleAutomation(
              Object.fromEntries(dirty.map((key) => [key, groupWriteOf(groupsNow[key]!)!])),
            )
          : null,
      ]);
      const failed: [string, IdleWriteResult & { ok: false }][] = [];
      if (p) {
        if (p.ok) setPersonBase(personNow);
        else failed.push(['partPerson', p]);
      }
      if (b) {
        if (b.ok) {
          setGroupBase((was) => ({ ...was, ...groupsNow }));
          setSources((was) => ({
            ...was,
            ...Object.fromEntries(dirty.map((key) => [key, 'custom' as const])),
          }));
        } else failed.push(['partBot', b]);
      }
      if (failed.length === 0) {
        setSaved(true);
        return;
      }
      setProblem(
        failed
          .map(([part, result]) => {
            const reason = t(`idleDrawer.problem.${result.reason}`);
            return parts
              ? t('idleDrawer.partFailed', { part: t(`idleDrawer.${part}`), reason })
              : reason;
          })
          .join(' '),
      );
    });
  }

  const delayField = (
    label: string,
    testid: string,
    value: Delay,
    set: (next: Delay) => void,
    bad: boolean,
  ) => (
    <div className={drawer.field}>
      <span className={drawer.fieldLabel}>{label}</span>
      <span className={drawer.pair}>
        <input
          className={drawer.box}
          inputMode="numeric"
          value={value.count}
          aria-label={label}
          aria-invalid={bad}
          data-testid={`${testid}-count`}
          onChange={(e) => set({ ...value, count: e.target.value })}
        />
        <select
          className={drawer.box}
          value={value.unit}
          aria-label={t('idleDrawer.unit')}
          data-testid={`${testid}-unit`}
          onChange={(e) => set({ ...value, unit: e.target.value as DurationUnit })}
        >
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {t(`idleDrawer.units.${unit}`)}
            </option>
          ))}
        </select>
      </span>
      {bad ? (
        <span className={styles.rowNote} data-testid={`${testid}-problem`}>
          {t('idleDrawer.invalidDelay')}
        </span>
      ) : null}
    </div>
  );

  const personPart = (
    <>
      <p className={drawer.hint} data-testid="idle-who">
        {t('idleDrawer.who')}
      </p>

      <h3 className={drawer.sectionTitle}>{t('idleDrawer.reminderTitle')}</h3>
      <label className={styles.weekUse}>
        <input
          type="checkbox"
          className="srOnly"
          checked={person.remind}
          data-testid="idle-reminder-enabled"
          onChange={(e) => edit({ remind: e.target.checked })}
        />
        <span className={styles.weekPill} aria-hidden="true" />
        {t('idleDrawer.reminderEnabled')}
      </label>
      {delayField(
        t('idleDrawer.reminderAfter'),
        'idle-reminder',
        person.remindAfter,
        (remindAfter) => edit({ remindAfter }),
        remindMinutes === null,
      )}
      <label className={drawer.field}>
        <span className={drawer.fieldLabel}>{t('idleDrawer.reminderMessage')}</span>
        <textarea
          className={drawer.box}
          rows={3}
          maxLength={1000}
          value={person.remindText}
          aria-invalid={remindTextMissing}
          data-testid="idle-reminder-message"
          onChange={(e) => edit({ remindText: e.target.value })}
        />
        {remindTextMissing ? (
          <span className={styles.rowNote} data-testid="idle-reminder-message-problem">
            {t('idleDrawer.reminderMessageRequired')}
          </span>
        ) : null}
      </label>
      <p className={drawer.hint} data-testid="idle-whatsapp-reminder">
        {t('idleDrawer.whatsappReminder')}
      </p>

      <h3 className={drawer.sectionTitle}>{t('idleDrawer.closeTitle')}</h3>
      <label className={styles.weekUse}>
        <input
          type="checkbox"
          className="srOnly"
          checked={person.close}
          data-testid="idle-close-enabled"
          onChange={(e) => edit({ close: e.target.checked })}
        />
        <span className={styles.weekPill} aria-hidden="true" />
        {t('idleDrawer.closeEnabled')}
      </label>
      {delayField(
        t('idleDrawer.closeAfter'),
        'idle-close',
        person.closeAfter,
        (closeAfter) => edit({ closeAfter }),
        closeMinutes === null,
      )}
      <label className={drawer.field}>
        <span className={drawer.fieldLabel}>{t('idleDrawer.closeMessage')}</span>
        <textarea
          className={drawer.box}
          rows={3}
          maxLength={1000}
          value={person.closeText}
          data-testid="idle-close-message"
          onChange={(e) => edit({ closeText: e.target.value })}
        />
        <span className={drawer.hint}>{t('idleDrawer.closeMessageHint')}</span>
      </label>
      <p className={drawer.hint} data-testid="idle-close-timing">
        {person.remind && person.close && remindMinutes !== null && closeMinutes !== null
          ? t('idleDrawer.closeTimingAfterReminder', {
              reminder: delayWords(remindMinutes, t),
              close: delayWords(closeMinutes, t),
            })
          : t('idleDrawer.closeTiming')}
      </p>
    </>
  );

  /** One group: its row (what happens today), and its fields while open. */
  const group = (key: BotIdleGroupKey): ReactNode => {
    const d = drafts[key];
    if (!d) {
      return (
        <div key={key} className={disclosure.group} data-testid={`bot-idle-${key}`}>
          <p className={styles.botGroupUnread} data-testid={`bot-idle-${key}-unread`}>
            <span className={styles.botGroupTitle}>{t(`botIdle.group.${key}`)}</span>
            {t('botIdle.groupUnread')}
          </p>
        </div>
      );
    }
    const base = groupWriteOf(groupBase[key]!);
    const changed = !same(d, groupBase[key]);
    const source = changed ? 'unsaved' : sources[key];
    const isOpen = open[key] === true;
    const bodyId = `${id}-${key}`;
    const remindBad = minutesOf(d.remindAfter, BOT_IDLE_DELAY_MAX_MINUTES) === null;
    const closeBad = minutesOf(d.closeAfter, BOT_IDLE_DELAY_MAX_MINUTES) === null;
    const textMissing = d.enabled && d.remindText.trim() === '';
    return (
      <div key={key} className={disclosure.group} data-testid={`bot-idle-${key}`}>
        <button
          type="button"
          className={disclosure.head}
          aria-expanded={isOpen}
          aria-controls={isOpen ? bodyId : undefined}
          data-testid={`bot-idle-${key}-toggle`}
          onClick={() => setOpen((was) => ({ ...was, [key]: !isOpen }))}
        >
          <span className={`${disclosure.name} ${styles.botGroupName}`}>
            <span className={styles.botGroupTitle}>{t(`botIdle.group.${key}`)}</span>
            <span className={styles.botGroupSummary} data-testid={`bot-idle-${key}-summary`}>
              {base && base.enabled
                ? t('botIdle.summaryOn', {
                    reminder: delayWords(base.reminderAfterMinutes, t),
                    close: delayWords(base.closeAfterReminderMinutes, t),
                  })
                : t('botIdle.summaryOff')}
            </span>
          </span>
          {source ? (
            <span className={disclosure.count} data-testid={`bot-idle-${key}-source`}>
              {t(`botIdle.source.${source}`)}
            </span>
          ) : null}
          <ChevronDown className={disclosure.chevron} size={14} aria-hidden="true" />
        </button>
        {/* Not drawn while closed - never `hidden`; its edits are kept above. */}
        {isOpen ? (
          <div id={bodyId} className={styles.botGroupBody} data-testid={`bot-idle-${key}-body`}>
            <label className={styles.weekUse}>
              <input
                type="checkbox"
                className="srOnly"
                checked={d.enabled}
                data-testid={`bot-idle-${key}-enabled`}
                onChange={(e) => editGroup(key, { enabled: e.target.checked })}
              />
              <span className={styles.weekPill} aria-hidden="true" />
              {t('botIdle.enabled')}
            </label>
            {delayField(
              t('botIdle.reminderAfter'),
              `bot-idle-${key}-reminder`,
              d.remindAfter,
              (remindAfter) => editGroup(key, { remindAfter }),
              remindBad,
            )}
            <label className={drawer.field}>
              <span className={drawer.fieldLabel}>{t('botIdle.reminderText')}</span>
              <textarea
                className={drawer.box}
                rows={2}
                maxLength={1000}
                value={d.remindText}
                aria-invalid={textMissing}
                data-testid={`bot-idle-${key}-reminder-text`}
                onChange={(e) => editGroup(key, { remindText: e.target.value })}
              />
              {textMissing ? (
                <span
                  className={styles.rowNote}
                  data-testid={`bot-idle-${key}-reminder-text-problem`}
                >
                  {t('idleDrawer.reminderMessageRequired')}
                </span>
              ) : null}
            </label>
            {delayField(
              t('botIdle.closeAfter'),
              `bot-idle-${key}-close`,
              d.closeAfter,
              (closeAfter) => editGroup(key, { closeAfter }),
              closeBad,
            )}
            <label className={drawer.field}>
              <span className={drawer.fieldLabel}>{t('botIdle.closeText')}</span>
              <textarea
                className={drawer.box}
                rows={2}
                maxLength={1000}
                value={d.closeText}
                data-testid={`bot-idle-${key}-close-text`}
                onChange={(e) => editGroup(key, { closeText: e.target.value })}
              />
              <span className={drawer.hint}>{t('botIdle.closeTextHint')}</span>
            </label>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className={drawer.drawerBody} data-testid="idle-drawer" ref={root}>
        {parts ? (
          <>
            <section
              className={styles.drawerPart}
              aria-labelledby={`${id}-person`}
              data-testid="idle-part-person"
            >
              <h3 className={drawer.sectionTitle} id={`${id}-person`}>
                {t('idleDrawer.partPerson')}
              </h3>
              {personPart}
            </section>
            <section
              className={styles.drawerPart}
              aria-labelledby={`${id}-bot`}
              data-testid="idle-part-bot"
            >
              <h3 className={drawer.sectionTitle} id={`${id}-bot`}>
                {t('idleDrawer.partBot')}
              </h3>
              {bot.kind === 'read' ? (
                <>
                  <p className={drawer.hint} data-testid="bot-idle-who">
                    {t('botIdle.who')}
                  </p>
                  <div className={styles.botGroups}>{BOT_IDLE_GROUPS.map(group)}</div>
                  <p className={drawer.hint} data-testid="bot-idle-finished">
                    {t('botIdle.finished')}
                  </p>
                </>
              ) : (
                <p className={drawer.hint} role="status" data-testid="bot-idle-unread">
                  {t('botIdle.unread')}
                </p>
              )}
            </section>
          </>
        ) : (
          personPart
        )}
      </div>
      <footer className={drawer.drawerFoot}>
        <button
          type="button"
          className={styles.saveButton}
          data-testid="drawer-save-idle"
          disabled={isPending}
          onClick={save}
        >
          {isPending ? t('saving') : t('save')}
        </button>
        <Link href="/settings/workspace" className={drawer.drawerCancel}>
          {t('cancel')}
        </Link>
        {problem ? (
          <span className={styles.rowNote} data-testid="idle-problem">
            {problem}
          </span>
        ) : saved ? (
          <span className={styles.rowNoteQuiet} data-testid="idle-saved">
            {t('saved')}
          </span>
        ) : nothing ? (
          <span className={styles.rowNoteQuiet} data-testid="idle-nothing">
            {t('idleDrawer.nothingChanged')}
          </span>
        ) : null}
      </footer>
    </>
  );
}
