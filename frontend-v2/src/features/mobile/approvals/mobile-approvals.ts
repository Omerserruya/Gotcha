import { decisionStance, type Approval } from '@/api/contracts/approvals';

/**
 * The phone's approvals list, as facts a card can say - each one the
 * desktop's own (`ApprovalsScreen`), put where a 390px card can hold it.
 *
 * ★ Nothing here decides what is PERMITTED. Lapsed or not is what the card
 *   OFFERS; the route's 409 is the backstop, as it is on the website.
 */

/** A deadline within the hour is said as one: 02's "38m left". */
export const SOON_MS = 60 * 60 * 1000;

/** What a card says about time: lapsed, how long is left, or how long it has waited. */
export type RowClock =
  | { readonly kind: 'lapsed' }
  | { readonly kind: 'left'; readonly ms: number }
  | { readonly kind: 'waited'; readonly ms: number };

export function rowClock(approval: Approval, now: Date): RowClock {
  if (decisionStance(approval, now) === 'lapsed') return { kind: 'lapsed' };
  const left = Date.parse(approval.expiresAt) - now.getTime();
  if (Number.isFinite(left) && left < SOON_MS) return { kind: 'left', ms: left };
  const waited = now.getTime() - Date.parse(approval.createdAt);
  return { kind: 'waited', ms: Number.isFinite(waited) ? waited : 0 };
}

/** "2m", "1h", "3d" as the desktop's `time.*` keys and their number. */
export function spanOf(ms: number): {
  readonly unit: 'minutes' | 'hours' | 'days';
  readonly n: number;
} {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return { unit: 'minutes', n: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { unit: 'hours', n: hours };
  return { unit: 'days', n: Math.round(hours / 24) };
}

/**
 * Who asked, by approval id - the desktop page's rule: a name where the
 * platform holds one; a request the AI made (`ai-bot:…`) named only where one
 * employee could have made it, and otherwise said as "your AI employee".
 */
export function requestersOf(
  pending: readonly Approval[],
  nameOf: (approval: Approval) => string | null,
  liveAiNames: readonly string[],
): { readonly names: Record<string, string>; readonly aiAsked: readonly string[] } {
  const names: Record<string, string> = {};
  const aiAsked: string[] = [];
  for (const approval of pending) {
    const name = nameOf(approval);
    if (name) {
      names[approval.id] = name;
      continue;
    }
    if (!approval.requestedBy.startsWith('ai-bot')) continue;
    if (liveAiNames.length === 1) names[approval.id] = liveAiNames[0]!;
    else aiAsked.push(approval.id);
  }
  return { names, aiAsked };
}

/**
 * Who asked for a plan, and where, as an `approvals.plan.asked.*` key: "You
 * asked GOTCHA in Home", "Matan asked…", "Someone on the team asked…". `null`
 * for anything that is not a plan.
 */
export function planAsked(
  approval: Pick<Approval, 'plan'>,
  viewerId: string | null,
): { readonly key: string; readonly name?: string } | null {
  const plan = approval.plan;
  if (!plan) return null;
  const where = plan.source ?? 'unknown';
  const asker = plan.requester;
  if (asker && viewerId && asker.userId === viewerId) return { key: `plan.asked.you.${where}` };
  if (asker?.name) return { key: `plan.asked.other.${where}`, name: asker.name };
  return { key: `plan.asked.someone.${where}` };
}

/** An amount in its currency when the call named one; never a symbol nobody stated. */
export function amountOf(approval: Pick<Approval, 'facts'>, locale: string): string | null {
  const { amount, currency } = approval.facts;
  if (amount === null) return null;
  return new Intl.NumberFormat(
    locale,
    currency ? { style: 'currency', currency, maximumFractionDigits: 0 } : {},
  ).format(amount);
}

/** A card's one tag, in the design's five tones: danger, money, the AI's own, the rest. */
export type TagTone = 'bad' | 'warn' | 'ai' | 'mute';

export function tagTone(tag: string): TagTone {
  if (tag === 'IRREVERSIBLE' || tag === 'HIGH') return 'bad';
  if (tag === 'FINANCIAL') return 'warn';
  if (tag === 'PLAN' || tag === 'SYSTEM_COPILOT') return 'ai';
  return 'mute';
}

/** A deadline inside the hour, or past it: the time said in the accent. */
export function isUrgent(clock: RowClock): boolean {
  return clock.kind !== 'waited';
}

/** The decisions taken on `now`'s calendar day, in the order given (newest first). */
export function decidedOn(decided: readonly Approval[], now: Date): readonly Approval[] {
  const day = now.toDateString();
  return decided.filter(
    (approval) =>
      approval.decidedAt !== null && new Date(approval.decidedAt).toDateString() === day,
  );
}

/**
 * What a decided row says at its end: rejected, or approved - and of an
 * approval, whether it RAN, as the desktop keeps the two apart. `approved`
 * alone is a decision whose run is not known to have finished.
 */
export type DecidedOutcome = 'ran' | 'didntRun' | 'approved' | 'rejected';

export function decidedOutcome(
  approval: Pick<Approval, 'status' | 'executionState'>,
): DecidedOutcome {
  if (approval.status === 'REJECTED') return 'rejected';
  if (approval.executionState === 'SUCCEEDED') return 'ran';
  if (approval.executionState === 'FAILED') return 'didntRun';
  return 'approved';
}
