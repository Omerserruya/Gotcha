import 'server-only';

import { approvalsSchema, aiEmployeeIdOf, type Approval } from '@/api/contracts/approvals';
import { aiEmployeesSchema, isBuilderDraft, type AiEmployee } from '@/api/contracts/people';
import { serverApi } from '@/api/client/server-api';
import { aiEmployeeEndpoints, approvalEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * What screen 03 reads.
 *
 * ── WHY THE DECIDED LIST IS A SECOND CALL ──
 * `GET /api/approvals` filters on **one** status — `where = { tenantId,
 * status }`, defaulting to PENDING — and carries no date filter of any kind.
 * So "what you decided today" is a separate call per status, narrowed here,
 * and reachable only as far back as the most recent 100 rows of that status.
 *
 * That ceiling is real and the screen says so rather than implying the list is
 * complete. On a tenant deciding more than 100 approvals between now and the
 * start of the day, today's earliest decisions fall outside the window — and a
 * count captioned "today" that silently means "of the last 100" is the kind of
 * number somebody plans around.
 *
 * ── WHY AI EMPLOYEES ARE LOADED AT ALL ──
 * `requestedBy` is `"bot"`, `"flow:<id>"` or `"ai-agent:<id>"`, and the list
 * route resolves user ids to names but explicitly skips anything containing
 * `":"`. So every AI-employee request arrives with `requestedByName: null` and
 * a raw cuid in `requestedBy`. Resolving it is ours to do; `ai-agent:clx…` in
 * front of a person is the defect that shipped `ai_voice` onto billing.
 *
 * Each read degrades on its own. `null` is a failed read and is never conflated
 * with an empty queue — on this screen those are opposite facts: an empty queue
 * means nothing needs you, a failed read means you do not know.
 */
export interface ApprovalsData {
  /** Awaiting a decision. `null` is a failed read, never "none". */
  readonly pending: readonly Approval[] | null;
  /** Approved and rejected, newest first. Bounded — see the note above. */
  readonly decided: readonly Approval[] | null;
  /** For naming the AI employee behind a request. */
  readonly aiEmployees: readonly AiEmployee[] | null;
  /** True when `decided` may be missing rows from today because of `take: 100`. */
  readonly decidedMayBeIncomplete: boolean;
  /**
   * Epoch ms at which this data was read.
   *
   * Carried with the data rather than taken in render, because "which rows had
   * lapsed" is a fact about the moment the queue was READ, not about the
   * moment some JSX happened to run. It also gives the client a starting clock
   * that matches the server's exactly, so the first render cannot mismatch.
   */
  readonly readAt: number;
}

/** The route's own page size. Hitting it means the window may be short. */
const ROUTE_PAGE_SIZE = 100;

export async function loadApprovals(): Promise<ApprovalsData> {
  const api = serverApi();

  const degrade =
    <T>(event: string, value: T) =>
    (cause: unknown): T => {
      logger.warn(event, { cause });
      return value;
    };

  const [pending, approved, rejected, aiEmployees] = await Promise.all([
    api
      .get({ endpoint: approvalEndpoints.list('PENDING'), payload: approvalsSchema })
      .catch(degrade('approvals.pending_failed', null)),
    api
      .get({ endpoint: approvalEndpoints.list('APPROVED'), payload: approvalsSchema })
      .catch(degrade('approvals.approved_failed', null)),
    api
      .get({ endpoint: approvalEndpoints.list('REJECTED'), payload: approvalsSchema })
      .catch(degrade('approvals.rejected_failed', null)),
    api
      .get({ endpoint: aiEmployeeEndpoints.list(), payload: aiEmployeesSchema })
      .catch(degrade('approvals.ai_employees_failed', null)),
  ]);

  const decided =
    approved === null && rejected === null
      ? null
      : [...(approved ?? []), ...(rejected ?? [])].sort(
          (a, b) => Date.parse(b.decidedAt ?? b.createdAt) - Date.parse(a.decidedAt ?? a.createdAt),
        );

  return {
    readAt: Date.now(),
    pending,
    decided,
    aiEmployees: aiEmployees?.filter((ai) => !isBuilderDraft(ai)) ?? null,
    // Either status arriving full means the route truncated, so the combined
    // list cannot be described as everything decided.
    decidedMayBeIncomplete:
      (approved?.length ?? 0) >= ROUTE_PAGE_SIZE || (rejected?.length ?? 0) >= ROUTE_PAGE_SIZE,
  };
}

/**
 * Who asked, in words.
 *
 * `flow:<id>` resolves to nothing nameable — a flow is not in the employee
 * roster — so it returns null and the caller says "an automation" rather than
 * printing an id. `bot` is the same: real, unnamed, and not a person.
 */
export function requesterName(
  approval: Approval,
  aiEmployees: readonly AiEmployee[] | null,
): string | null {
  if (approval.requestedByName) return approval.requestedByName;
  const id = aiEmployeeIdOf(approval);
  if (!id) return null;
  return aiEmployees?.find((ai) => ai.id === id)?.name ?? null;
}

/**
 * 02's header figures for 03c: "Approved this week 42 · Avg decision 16s".
 *
 * Computed from the decisions already loaded — no new read. Over the last
 * seven days: how many were approved, and the mean time from asking to
 * deciding across approvals and rejections.
 *
 * ⚠ `null` when the list may be cut. `GET /api/approvals` caps at 100 per
 *   status with no date filter, so a week busier than that would be counted
 *   short — a figure somebody plans around, quietly wrong. Absent beats low.
 */
export function decisionStats(
  decided: readonly Approval[] | null,
  mayBeIncomplete: boolean,
  now: Date = new Date(),
): { readonly approvedThisWeek: number; readonly avgDecisionSeconds: number | null } | null {
  if (decided === null || mayBeIncomplete) return null;
  const since = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const thisWeek = decided.filter(
    (approval) => approval.decidedAt !== null && Date.parse(approval.decidedAt) >= since,
  );
  const durations = thisWeek
    .filter((approval) => approval.status === 'APPROVED' || approval.status === 'REJECTED')
    .map((approval) => (Date.parse(approval.decidedAt!) - Date.parse(approval.createdAt)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0);
  return {
    approvedThisWeek: thisWeek.filter((approval) => approval.status === 'APPROVED').length,
    avgDecisionSeconds:
      durations.length === 0
        ? null
        : Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length),
  };
}
