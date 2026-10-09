/**
 * The statuses of one AI step - Backend ed0f1c9c's `ActivityStatus`
 * (`statusForEvent` plus the table's own). Here, in `lib`, because both the
 * contract (`api`) and the realtime translator read it, and neither layer may
 * import the other.
 */
export const ACTIVITY_STATUSES = [
  'proposed',
  'approved',
  'running',
  'completed',
  'failed',
  'denied',
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
