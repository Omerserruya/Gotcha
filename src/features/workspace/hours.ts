import { DAY_KEYS, type DayKey, type Workspace } from '@/api/contracts/workspace';

/**
 * Reading a week back to somebody.
 *
 * The design writes it as "Sun–Thu 09:00–18:00 · Fri 09:00–13:00 · closed
 * Saturday" — runs of identical days collapsed, the exceptions spelled out.
 * Seven lines would be accurate and unreadable; this is the same information
 * at a glance, which is what a fact row is for.
 *
 * Pure, and separate from the component, because the grouping is the part that
 * can be quietly wrong: a week where Monday differs by ten minutes must not
 * collapse into the run beside it.
 */

export interface DayHours {
  readonly enabled: boolean;
  readonly open?: string;
  readonly close?: string;
}

export interface HoursRun {
  /** One entry for a single day, two or more for a collapsed run. */
  readonly days: readonly DayKey[];
  readonly open: string;
  readonly close: string;
}

export interface WeekSummary {
  readonly runs: readonly HoursRun[];
  readonly closed: readonly DayKey[];
  /** True when the week holds no open day at all. */
  readonly isEmpty: boolean;
}

/** The schedule as a complete week, with anything missing read as closed. */
export function weekOf(workspace: Workspace | null): Record<DayKey, DayHours> {
  const raw = (workspace?.hours?.schedule ?? {}) as Record<string, DayHours | undefined>;
  return Object.fromEntries(
    DAY_KEYS.map((day) => {
      const entry = raw[day];
      return [
        day,
        entry?.enabled && entry.open && entry.close
          ? { enabled: true, open: entry.open, close: entry.close }
          : { enabled: false },
      ];
    }),
  ) as Record<DayKey, DayHours>;
}

/**
 * Collapses the week into runs.
 *
 * Runs are consecutive in the week's own order, which starts on Sunday here
 * because the business does. Two separate stretches with the same hours stay
 * separate: "Sun–Mon and Thu–Fri" is true and "Sun–Fri" is not.
 */
export function summariseWeek(week: Record<DayKey, DayHours>): WeekSummary {
  const runs: HoursRun[] = [];
  const closed: DayKey[] = [];
  let current: { days: DayKey[]; open: string; close: string } | null = null;

  for (const day of DAY_KEYS) {
    const entry = week[day];
    if (!entry.enabled || !entry.open || !entry.close) {
      closed.push(day);
      current = null;
      continue;
    }
    if (current && current.open === entry.open && current.close === entry.close) {
      current.days.push(day);
      continue;
    }
    current = { days: [day], open: entry.open, close: entry.close };
    runs.push(current);
  }

  return { runs, closed, isEmpty: runs.length === 0 };
}

/**
 * The payload `PATCH /api/workspace` expects for `hours`.
 *
 * Always a complete week: the server REPLACES this setting rather than merging
 * it, so submitting a partial one would produce a schedule nobody wrote.
 * Closed days are sent as `{ enabled: false }` with no times, matching what
 * the server stores.
 */
export function hoursPatch(
  week: Record<DayKey, DayHours>,
  existing: Workspace['hours'] | null | undefined,
  /**
   * The outside-hours pair, when the form is editing them.
   *
   * They live in this same setting and the server REPLACES it, so they have
   * always had to travel with the week. They used to be carried silently from
   * `existing`; now the screen can set them, and omitting the argument keeps
   * the old carry-through exactly.
   */
  outside?: { aiOutsideHours?: 'active' | 'silent'; outsideHoursHandoffMessage?: string },
): Record<string, unknown> {
  return {
    enabled: DAY_KEYS.some((day) => week[day].enabled),
    schedule: Object.fromEntries(
      DAY_KEYS.map((day) => {
        const entry = week[day];
        return [
          day,
          entry.enabled && entry.open && entry.close
            ? { enabled: true, open: entry.open, close: entry.close }
            : { enabled: false },
        ];
      }),
    ),
    // Set when the form supplies them, carried otherwise. Either way they
    // travel: this setting is REPLACED, so leaving them out of the payload
    // would silently reset the message to empty and the AI to `active`.
    aiOutsideHours: outside?.aiOutsideHours ?? existing?.aiOutsideHours ?? 'active',
    outsideHoursHandoffMessage:
      outside?.outsideHoursHandoffMessage ?? existing?.outsideHoursHandoffMessage ?? '',
  };
}
