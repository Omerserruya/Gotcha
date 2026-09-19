import { z } from 'zod';

/**
 * Approvals — screen 03, and its two other states 03b and 03c.
 *
 * Shapes read from `services/conversation/src/routes/approvals.ts` and the
 * model at `packages/shared/prisma/schema.prisma:2148`.
 *
 * ── THE ONE DISTINCTION THIS WHOLE SCREEN RESTS ON ──
 * The model's own comment, and it is the best sentence in the backend:
 *
 *   *"A manager approving is not the action happening. `status` records the
 *   human decision; `executionState` records what the system then did. Both
 *   are needed: without this, a dispatch that failed left an APPROVED row
 *   indistinguishable from one that succeeded, nothing could retry it, and
 *   the customer was simply never told anything."*
 *
 * So two independent axes, never collapsed into one badge:
 *   `status`         — what the human decided
 *   `executionState` — what happened next
 *
 * An approval that was granted and then failed to execute is the case this
 * screen exists for. The design drew four green ticks, which is the one
 * outcome that needs no screen.
 *
 * ── WHAT IS DELIBERATELY NOT MODELLED ──
 * `params`, `modifiedParams`, `resumeEnvelope` and `executionResult` are
 * **stripped**, and `object` rather than `looseObject` is what does it. The
 * list route spreads the raw Prisma row (`...r`) for up to 100 rows, so all
 * four cross the wire today; `resumeEnvelope` is the full stored
 * ExecutionRequest. None of them is needed to decide anything.
 *
 * `params` is also untyped by construction — it is whatever the planning step
 * wanted to pass to the tool, different per tool and guaranteed by nothing. So
 * the amount on screen comes from **`summary`**, which the backend writes for
 * exactly this purpose (*"Cancel order #12345 and refund $89.50"*). Parsing a
 * number out of an untyped blob to print next to a currency symbol is the kind
 * of guess that puts a wrong figure in front of someone approving money.
 */

/** The human decision. Never conflated with what happened afterwards. */
export const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * What the system managed to do about the decision.
 *
 * `LEGACY_UNVERIFIED` is the one to respect. Its schema comment:
 * *"Historical rows approved BEFORE the execution state machine existed.
 * Their dispatch outcome was never recorded (many provably never ran). They
 * must not read as SUCCEEDED (that falsifies history) and must not be
 * retryable (re-running an old refund/booking is worse). Terminal,
 * audit-only."* Both halves are enforced below.
 */
export const EXECUTION_STATES = [
  'NOT_STARTED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'LEGACY_UNVERIFIED',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

/** `low | medium | high`, defaulted rather than trusted. */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export const approvalSchema = z.object({
  id: z.string().min(1),
  /** Nullable by design: System Copilot plans are not conversation-scoped. */
  conversationId: z.string().nullable().default(null),
  contactId: z.string().nullable().default(null),
  tool: z.string().min(1),
  /** The backend's own one-line human-facing sentence. The headline. */
  summary: z.string().min(1),
  /** The bot's stated reasoning. Shown as reasoning, never as fact. */
  reason: z.string().default(''),
  /** Denormalised on purpose so it survives the rule being deleted. */
  policyRuleName: z.string().nullable().default(null),
  riskLevel: z.enum(RISK_LEVELS).catch('medium'),
  /** `["HIGH","IRREVERSIBLE","FINANCIAL"]`. A LABEL — see `IRREVERSIBLE`. */
  riskTags: z.array(z.string()).default([]),
  status: z.enum(APPROVAL_STATUSES).catch('PENDING'),
  /** `"bot"` | `"flow:<id>"` | `"ai-agent:<id>"` — never a person. */
  requestedBy: z.string().default('bot'),
  /** Null for anything with a `:` in `requestedBy`, which is every AI employee. */
  requestedByName: z.string().nullable().default(null),
  decidedByName: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
  decisionReason: z.string().nullable().default(null),
  expiresAt: z.string(),
  createdAt: z.string(),

  executionState: z.enum(EXECUTION_STATES).catch('NOT_STARTED'),
  executionError: z.string().nullable().default(null),
  executionAttempts: z.number().default(0),
  /**
   * Set once the customer has been told. The backend uses its presence as the
   * once-only guard for the continuation message, which makes "the customer
   * knows" a **fact on this screen rather than an inference**.
   */
  customerNotifiedAt: z.string().nullable().default(null),
});

export const approvalsSchema = z.array(approvalSchema);
export type Approval = z.infer<typeof approvalSchema>;

/**
 * Past its deadline.
 *
 * **Computed here, never read from `status`.** A sweeper does flip PENDING to
 * EXPIRED — `idle-conversation.worker.ts:79`, started unconditionally, on a
 * five-minute cron — so this is a bounded window rather than a permanent lie.
 * But it is a window that is always open when it matters:
 *
 *   - up to **5 minutes** between the deadline passing and the sweep
 *   - longer on a backlog, since the sweep is `take: 100` per run
 *   - and a live countdown reaches **0m while `status` is still PENDING**,
 *     every single time, by construction
 *
 * A row past its deadline is not a pending approval and must not offer a
 * decision it cannot take: `approvals.ts:1036` answers 409 at decision time.
 */
export function hasLapsed(approval: Approval, now: Date = new Date()): boolean {
  if (approval.status !== 'PENDING') return false;
  const expires = Date.parse(approval.expiresAt);
  return Number.isFinite(expires) && expires <= now.getTime();
}

/** What a row is, once the deadline is accounted for. */
export type DecisionStance = 'awaiting' | 'lapsed' | 'approved' | 'rejected' | 'cancelled';

export function decisionStance(approval: Approval, now: Date = new Date()): DecisionStance {
  if (hasLapsed(approval, now)) return 'lapsed';
  switch (approval.status) {
    case 'PENDING':
      return 'awaiting';
    case 'APPROVED':
      return 'approved';
    case 'REJECTED':
      return 'rejected';
    case 'EXPIRED':
      return 'lapsed';
    case 'CANCELLED':
      return 'cancelled';
  }
}

/** A decision may still be taken on this row. */
export function isDecidable(approval: Approval, now: Date = new Date()): boolean {
  return decisionStance(approval, now) === 'awaiting';
}

/**
 * Retry is only for a dispatch that ran and failed.
 *
 * Never for `LEGACY_UNVERIFIED`: those rows were approved before the state
 * machine existed and many provably never ran, so retrying is a coin flip
 * between re-running an old refund and doing nothing. The schema calls it
 * terminal and audit-only, and this is where that is enforced.
 */
export function isRetryable(approval: Approval): boolean {
  return approval.status === 'APPROVED' && approval.executionState === 'FAILED';
}

/**
 * True where the product cannot tell you whether the action happened.
 *
 * Kept separate from `FAILED` because the remedy differs: a failure can be
 * retried, an unverified historical row can only be looked up by hand.
 */
export function isOutcomeUnknown(approval: Approval): boolean {
  return approval.executionState === 'LEGACY_UNVERIFIED';
}

/**
 * `IRREVERSIBLE` as the model means it: **a risk label, not a window.**
 *
 * There is no undo in this platform — no route, no gateway path, no
 * `undoneAt` or `reversalOf` field, enumerated across the whole repository.
 * `retry-execution` runs the action *forward*, which on a refund is the
 * opposite of undoing it.
 *
 * So nothing on this screen may state or imply a reversal window. The design's
 * *"Reversible · Yes — within 24h"* is removed entirely rather than softened:
 * it is read **before** the irreversible act, and it would make someone
 * approve a refund they would otherwise have questioned.
 */
export function isFlaggedIrreversible(approval: Approval): boolean {
  return approval.riskTags.includes('IRREVERSIBLE');
}

/**
 * The AI employee id behind `requestedBy`, or null.
 *
 * The list route resolves user ids to display names but explicitly skips
 * anything containing `":"`, so `requestedByName` is null for every
 * AI-employee request and the raw `ai-agent:clx…` is what reaches the browser.
 * Resolving it is ours to do — a machine identifier in front of a person is
 * the defect that shipped `ai_voice` onto the billing screen.
 */
export function aiEmployeeIdOf(approval: Approval): string | null {
  const prefix = 'ai-agent:';
  return approval.requestedBy.startsWith(prefix)
    ? approval.requestedBy.slice(prefix.length) || null
    : null;
}
