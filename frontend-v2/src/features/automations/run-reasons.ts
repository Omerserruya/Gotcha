/**
 * Why a run did not do what it was built to do, in words - not the
 * platform's code.
 *
 * ⚠ `run.error` and a step's `output.action` are codes ("opted_out",
 *   "skipped_missing_removal_line"), and the run log printed `run.error` as
 *   it came. With the marketing opt-out (Backend 6ba6fac2) most skipped runs
 *   carry one, so a reader would have seen "no_prior_contact_or_consent".
 *
 * The codes, from where the worker writes them (incoming-worker, 2026-10-08):
 *   run.error  - cart / order / call automations: `opted_out`,
 *                `no_prior_contact_or_consent`, `no_reachable_customer`,
 *                `conversation_busy` (call only); the runner:
 *                `automation_inactive`, `stopped: purchased`,
 *                `failed: <message>`; older rows: `no_marketing_consent`.
 *   step       - a send step's `output.action`, any `skipped_*` (status
 *                "skipped" since Backend 4e0e3ced; before it, "ok"). A text
 *                step records "sent" or `skipped_opted_out` (1bfcd27d).
 *
 * ★ An unknown code is never printed: the run's reason is "other" (its code
 *   on the reason's title, for whoever is debugging); a step's is none, and
 *   any `skip_*` / `skipped_*` action - known or not - still reads Skipped.
 */
export const RUN_REASONS = [
  'opted_out',
  'no_prior_contact_or_consent',
  'no_marketing_consent',
  'no_reachable_customer',
  'conversation_busy',
  'automation_inactive',
  'purchased',
  'failed',
  'other',
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

export const STEP_REASONS = [
  'skipped_missing_removal_line',
  'skipped_template_not_approved',
  'skipped_template_not_found',
  'skipped_no_template',
  'skipped_non_whatsapp',
  'skipped_adapter_unsupported',
  'skipped_no_send_ctx',
  // A text or template step after a wait, when the customer replied "הסר" meanwhile (Backend 1bfcd27d).
  'skipped_opted_out',
] as const;
export type StepReason = (typeof STEP_REASONS)[number];

/** A run's `error`, as one of ours; `null` when there is none. */
export function runReason(error: string | null): RunReason | null {
  const code = error?.trim() ?? '';
  if (code === '') return null;
  if (code === 'stopped: purchased') return 'purchased';
  if (code.startsWith('failed:')) return 'failed';
  return (RUN_REASONS as readonly string[]).includes(code) ? (code as RunReason) : 'other';
}

/** Did this step skip? Backend 4e0e3ced's rule: any `skip_*` / `skipped_*` action. */
export function stepSkipped(output: Readonly<Record<string, unknown>> | null): boolean {
  const action = output?.action;
  return typeof action === 'string' && /^skip(ped)?_/.test(action);
}

/** A step's reason, from `output.action`; `null` when it has none we can name. */
export function stepReason(output: Readonly<Record<string, unknown>> | null): StepReason | null {
  const action = output?.action;
  return typeof action === 'string' && (STEP_REASONS as readonly string[]).includes(action)
    ? (action as StepReason)
    : null;
}
