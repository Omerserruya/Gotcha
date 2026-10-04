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

/**
 * The risk tags the schema names, and the only ones this app has words for.
 *
 * `riskTags` is a free `Json` column, so anything can be in it. A tag outside
 * this set is rendered **as itself** rather than dropped: an unrecognised risk
 * label is still a risk label, and silently hiding one because we have no
 * translation for it is the wrong way round on a screen about money.
 *
 * ── THIS IS THE OPPOSITE CALL FROM `UNFIRING_EVENTS`, ON PURPOSE ──
 * Screen 15 refuses to offer an event nothing raises. This one insists on
 * showing a tag nothing translates. Both follow the same rule — **never let
 * the screen be less honest than the data** — and they point in opposite
 * directions because the risk does. There, the harm was showing something the
 * product cannot do. Here, the harm would be hiding something the product is
 * warning about.
 *
 * So: do not "tidy" this by filtering to the known set.
 */
/*
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE VOCABULARY IS WHAT THE WRITERS WRITE — AND IT IS OPEN
 * ════════════════════════════════════════════════════════════════════════════
 * The first three came from the schema's own comment (`["HIGH","IRREVERSIBLE",
 * "FINANCIAL"]`), and no writer in the monorepo produces any of them. The
 * write sites produce `commerce`, the action's own name, `human_initiated`
 * (commerce-actions.service), `SYSTEM_COPILOT` and `PLAN` (system-tools),
 * and `REQUIRES_APPROVAL` (agent-tools). A test item carried `MOVES_MONEY`,
 * written nowhere, and it reached the screen as the raw enum.
 *
 * Because action names make the set OPEN, a map can never be complete. So a
 * tag with a label gets it, and any other is turned into words by
 * `humanizeTag` — `MOVES_MONEY` reads "Moves money", `cancel_order` reads
 * "Cancel order". Shown, never hidden (see above); never raw.
 */
export const KNOWN_RISK_TAGS = [
  'HIGH',
  'IRREVERSIBLE',
  'FINANCIAL',
  'commerce',
  'human_initiated',
  'SYSTEM_COPILOT',
  'PLAN',
  'REQUIRES_APPROVAL',
] as const;
export type KnownRiskTag = (typeof KNOWN_RISK_TAGS)[number];

/**
 * The tags worth a pill on the APPROVALS screen.
 *
 * ★ THE ONE EXCEPTION TO "NEVER HIDE A TAG", AND WHY IT IS ONE. That rule
 *   protects information: a warning must not vanish for want of a label.
 *   `REQUIRES_APPROVAL` (agent-tools writes it; 9 rows on dev carry it) is
 *   true of every item on this screen by definition, so as a pill it says
 *   nothing — it is the reason the row is here, not a risk of acting on it.
 *   Every other tag still shows, labelled or turned into words.
 */
export function visibleRiskTags(tags: readonly string[]): readonly string[] {
  return tags.filter((tag) => tag !== 'REQUIRES_APPROVAL');
}

/** A code-shaped tag as words: `MOVES_MONEY` → "Moves money". */
export function humanizeTag(tag: string): string {
  const words = tag
    .replace(/[_.\-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tag;
}

export function isKnownRiskTag(tag: string): tag is KnownRiskTag {
  return (KNOWN_RISK_TAGS as readonly string[]).includes(tag);
}

export const approvalSchema = z
  .object({
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
    /**
     * Where the decision was made — `whatsapp` for a manager's reply, `web` in
     * the app, `null` on older rows. Was on the wire and stripped.
     */
    decisionChannel: z.string().nullish().default(null),
    /**
     * The action's own parameters — read by the TRANSFORM below to give an old
     * row a sentence, and then dropped. See there.
     */
    params: z.unknown().optional(),
    /** What ran, when an approver edited it (backend 05979604). Only its amount leaves. */
    modifiedParams: z.unknown().optional(),
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
  })
  /*
   * ════════════════════════════════════════════════════════════════════════
   * ⚠⚠ `params` IS READ HERE AND GOES NO FURTHER
   * ════════════════════════════════════════════════════════════════════════
   * The list route spreads the raw row, and `params` can carry anything the
   * tool was given — a card number, in the test that guards this. The parse
   * runs on the server, so the sentence is derived HERE (`approvalSummary`)
   * and `params` is dropped in the same step: no screen, prop or client
   * bundle ever holds it.
   */
  .transform(({ params, modifiedParams, ...approval }) => ({
    ...approval,
    summary: approvalSummary({ summary: approval.summary, tool: approval.tool, params }),
    facts: approvalFacts(params),
    /** The amount that ran, when an approver edited it; `null` when nothing was. */
    editedAmount: modifiedParams != null ? approvalFacts(modifiedParams).amount : null,
    /** The percentage that ran, when an approver edited a discount. */
    editedPercentage: modifiedParams != null ? approvalFacts(modifiedParams).percentage : null,
  }));

export const approvalsSchema = z.array(approvalSchema);
export type Approval = z.infer<typeof approvalSchema>;

/**
 * What `POST /:id/approve` answers — and it is better than it looks.
 *
 * `{ approval, dispatch }`, a bare envelope (the fourth shape in this
 * platform), where **`dispatch` is the outcome of the attempt that was just
 * made**. So the second of screen 03b's three facts — *did the thing actually
 * happen* — arrives in the response to the decision itself, synchronously, with
 * no poll and no event subscription.
 *
 * That is the whole reason 03b is a screen rather than a toast. A decision that
 * dispatched cleanly and one that dispatched and failed are told apart here, at
 * the only moment the person who decided is still looking.
 */
export const approveResultSchema = z.object({
  approval: approvalSchema,
  dispatch: z.object({
    ok: z.boolean(),
    /** Present when `ok` is false. The reason, in the provider's words. */
    error: z.string().nullable().default(null),
  }),
});
export type ApproveResult = z.infer<typeof approveResultSchema>;

/**
 * `POST /:id/reject` → bare `{ approval }`.
 *
 * **`decisionReason` is required**: the route answers 400 without one. So the
 * design's *"rejecting asks why in one tap"* is not a nicety the screen chose,
 * it is the contract — and the reason it gives is stored on `decisionReason`
 * and shown back on the decided list.
 */
export const rejectResultSchema = z.object({ approval: approvalSchema });

/**
 * `POST /:id/retry-execution` → `{ data: { approvalId, executed, error } }`.
 *
 * Enveloped in `data`, unlike both of its siblings on the same route file.
 * **Three sibling routes, three envelope shapes**: approve answers bare
 * `{ approval, dispatch }`, reject answers bare `{ approval }`, and this one
 * answers `{ data }`.
 *
 * The route refuses `LEGACY_UNVERIFIED` with a 409 of its own — *"legacy
 * approval predates execution tracking"* — which is the server reaching the
 * same conclusion as `isRetryable`, independently.
 */
export const retryResultSchema = z.object({
  approvalId: z.string().min(1),
  /** Whether the re-dispatch succeeded. Named `executed`, not `ok`, here. */
  executed: z.boolean(),
  error: z.string().nullable().default(null),
});

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

/**
 * The row's sentence — the stored `summary`, unless it is not one.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 27 OF 54 ROWS SAID "ai-bot inbox tool call"
 * ════════════════════════════════════════════════════════════════════════════
 * `summary` is a plain String, and writers used to put a debug breadcrumb, a
 * function signature (`issue_refund()`) or the tool's name in it. The platform
 * now writes a sentence with `describeApprovalAction(tool, params)` — for NEW
 * rows. Old ones keep the breadcrumb, but every one still carries `tool` and
 * `params`, so the sentence is derived here from that record: real data, not
 * invented. (Backend could do this once in the list route; that is on hold.)
 *
 * ⚠ A PORT, kept in step by the platform's own cases
 *   (`packages/shared/src/lib/__tests__/approval-summary.test.ts`), copied
 *   into `approvals.test.ts`. English, as the stored summaries are, and with
 *   NO currency: `params.amount` carries none, and a symbol would be invented.
 */
export function approvalSummary(approval: {
  readonly summary: string;
  readonly tool: string;
  readonly params?: unknown;
}): string {
  return isNotASentence(approval.summary, approval.tool)
    ? describeApprovalAction(approval.tool, approval.params)
    : approval.summary;
}

/** The conventions measured in the data, and nothing broader. */
export function isNotASentence(summary: string, tool: string): boolean {
  const text = summary.trim();
  return (
    text === '' ||
    /\btool call\b/i.test(text) ||
    /^[a-z0-9_.]+\(.*\)$/i.test(text) ||
    text === tool.trim()
  );
}

/** A port of the platform's `describeApprovalAction` — see `approvalSummary`. */
export function describeApprovalAction(tool: string, params: unknown = {}): string {
  const bare = String(tool || '')
    .split('.')
    .pop()!
    .replace(/^integration_/, '');
  const words = bare.replace(/_+/g, ' ').trim();
  if (!words) return 'Approve this action';
  const verb = words.charAt(0).toUpperCase() + words.slice(1);

  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const scalar = (v: unknown): string => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '';
  };
  const order = scalar(p.order_name) || scalar(p.orderName);
  const subject = scalar(p.subject) || scalar(p.title) || scalar(p.name);
  const amount = scalar(p.amount);

  let out = verb;
  if (amount && /refund/i.test(words)) out += ` of ${amount}`;
  if (order) {
    out += /\border$/i.test(verb) ? ` ${order}` : ` for order ${order}`;
  } else if (subject) {
    out += `: ${subject}`;
  }
  return out;
}

/**
 * Why a dispatch failed, as a class the operator can act on.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE PROVIDER'S TEXT NEVER REACHES THE SCREEN RAW
 * ════════════════════════════════════════════════════════════════════════════
 * Measured on dev: a revoked Shopify token came back as "Token refresh failed
 * for shopify: shopify_token_refresh_failed_401: <!DOCTYPE html> <html …" —
 * Shopify's whole error page, printed under the decision. The classes follow
 * the platform's own `toCustomerSafeReason` (`routes/approvals.ts`), with one
 * split it does not need: a refused CONNECTION (401, token, OAuth) is apart
 * from a refused PERMISSION, because its repair is reconnecting the store and
 * retrying is pointless until then.
 */
export const DISPATCH_FAILURES = [
  'connection',
  'already_done',
  'after_shipping',
  'not_permitted',
  'provider_unavailable',
  'exceeds_limit',
  'unknown',
] as const;
export type DispatchFailure = (typeof DISPATCH_FAILURES)[number];

export function classifyDispatchError(error: string | null | undefined): DispatchFailure {
  const e = String(error ?? '').toLowerCase();
  if (!e) return 'unknown';
  if (/already (cancelled|canceled|refunded)|already_(cancelled|canceled|refunded)/.test(e)) {
    return 'already_done';
  }
  if (/fulfil|shipped|dispatched/.test(e)) return 'after_shipping';
  // Before the platform's broader permission class: 401 and a failed token
  // refresh are the store's connection, not this action's permission.
  if (/\b401\b|token|oauth|unauthori[sz]ed|reconnect/.test(e)) return 'connection';
  if (/scope|permission|forbidden|\b403\b|policy|blocked|revalidat/.test(e)) return 'not_permitted';
  if (/timeout|econnrefused|enotfound|unavailable|\b5\d\d\b/.test(e)) return 'provider_unavailable';
  if (/limit|exceed|maximum|too (large|many)/.test(e)) return 'exceeds_limit';
  return 'unknown';
}

/**
 * The provider's text for a tooltip: tags and everything inside an HTML
 * document dropped, whitespace collapsed, cut to `max`. For whoever is
 * debugging — never a line on the screen.
 */
export function plainErrorText(error: string | null | undefined, max = 160): string | null {
  const text = String(error ?? '')
    .replace(/<!doctype[\s\S]*$/i, '')
    .replace(/<html[\s\S]*$/i, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:\s]+$/, '');
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "shopify.process_refund" → "Shopify": who refused, from the tool's own prefix. */
export function providerOf(tool: string): string | null {
  const prefix = tool.includes('.') ? tool.split('.')[0]! : null;
  if (!prefix || prefix === 'integration') return null;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

/**
 * The two facts 03c's sentence needs from `params` — the order and the amount —
 * lifted here so the parameters themselves still never leave the contract.
 * `currency` only when the call named one: an amount is never given a symbol
 * nobody stated.
 */
export function approvalFacts(params: unknown): {
  readonly order: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
  /** The call's own note ("damaged item · full refund"), when it wrote one. */
  readonly note: string | null;
  /** A discount's percentage, on the coupon tools (backend f16a5afa). */
  readonly percentage: number | null;
} {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const amount =
    typeof p.amount === 'number' && Number.isFinite(p.amount)
      ? p.amount
      : typeof p.amount === 'string' && Number.isFinite(Number(p.amount)) && p.amount.trim()
        ? Number(p.amount)
        : null;
  const currency = text(p.currency);
  return {
    order: text(p.order_name) ?? text(p.orderName),
    amount,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    note: text(p.note),
    percentage:
      typeof p.percentage === 'number' && Number.isFinite(p.percentage) ? p.percentage : null,
  };
}
