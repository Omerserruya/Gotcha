/**
 * A duration in the largest unit it fills WHOLE (supervisor, 2026-10-07: a
 * wait read "1,440 minutes"): 1,440 minutes is 1 day, 120 is 2 hours, 90
 * stays 90 minutes - never "1.5 hours". Under a minute rounds up to one.
 * The words are the catalogue's (`common.duration.*`); this only chooses.
 */
export type DurationUnit = 'days' | 'hours' | 'minutes';

const MINUTE_MS = 60_000;
const IN_MINUTES: Readonly<Record<DurationUnit, number>> = { days: 1440, hours: 60, minutes: 1 };

export function wholeUnit(ms: number): { readonly unit: DurationUnit; readonly count: number } {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  for (const unit of ['days', 'hours'] as const) {
    if (minutes % IN_MINUTES[unit] === 0) return { unit, count: minutes / IN_MINUTES[unit] };
  }
  return { unit: 'minutes', count: minutes };
}
