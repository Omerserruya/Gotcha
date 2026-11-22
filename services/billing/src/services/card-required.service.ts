/**
 * A card after N days (self sign-up, 2026-11-22).
 *
 * An organization that signed itself up runs its evaluation without a card.
 * From the day its mark names (`cardRequiredAfterDays`, the number in force
 * the day it signed up) it must have one stored. Past that day and with no
 * card, the sweep moves it to PENDING_PAYMENT: the existing access policy then
 * closes the app and sends its people to /checkout/payment-required.
 *
 * The way back is the existing card session. A confirmed stored card puts the
 * organization back where it was. Nothing here charges anybody and nothing
 * here talks to the payment provider: the sweep is database reads and one
 * write, the restore is one write after the confirm route has already heard
 * from the provider.
 *
 * Rules:
 *   - only an organization that carries the mark is looked at, so nothing that
 *     existed before sign-up, and nothing an operator created, is ever swept;
 *   - only the evaluation is closed. An organization with a plan of its own
 *     pays through that plan and is left alone;
 *   - the status and the mark change in ONE transaction, and the status only
 *     if it is still the one that was read. The mark is what remembers the
 *     status to put back, so a half-written pair is an organization closed
 *     with no way to open;
 *   - the sweep closes an organization once per mark. An operator who opens a
 *     closed organization by hand is not overruled an hour later;
 *   - a card opens only what the sweep closed. An organization that owes a
 *     first payment (an open checkout) stays closed until it pays.
 *
 * The mark is read from the database, never from the cache: a stale mark here
 * closes or opens an organization.
 */
import {
  prisma,
  withCrossTenantAccess,
  writeAudit,
  AuditAction,
  writeDurableSetting,
  SELF_SIGNUP_ORIGIN_KEY,
  parseSelfSignupOrigin,
  cardIsDue,
  CARD_BLOCKABLE_STATUSES,
  type SelfSignupOrigin,
  type CardBlockableStatus,
} from "@chatcenter/shared";
import { POC_PLAN_KEY } from "./poc.service";

/** Who the mark's row says wrote it. */
const ACTOR = "system:card-required";

/** A checkout that can still be paid. The same list GET /checkout/mine reads. */
const OPEN_CHECKOUT = ["PENDING", "AWAITING_PROVIDER", "TOKENIZED"] as const;

export interface CardFacts {
  /** The organization's status now, or null when the organization is gone. */
  status: string | null;
  /** True when an active stored card exists on its billing account. */
  hasCard: boolean;
  /** The plan of its subscription row, whatever that row's state; null with no row. */
  planKey: string | null;
}

export type CardVerdict =
  | { act: "block"; priorStatus: CardBlockableStatus }
  | { act: "restore" }
  | { act: "leave" };

/**
 * What the facts ask for. Pure: the clock comes in, nothing is read.
 *
 * "restore" here says the organization is closed for a card and has one. The
 * open-checkout question and the status to put back are answered when the
 * restore is carried out.
 */
export function cardVerdict(origin: SelfSignupOrigin, facts: CardFacts, now: Date): CardVerdict {
  if (origin.cardBlock) {
    return facts.status === "PENDING_PAYMENT" && facts.hasCard ? { act: "restore" } : { act: "leave" };
  }
  if (!cardIsDue(origin, now)) return { act: "leave" };
  if (facts.hasCard) return { act: "leave" };
  // Only the evaluation. A plan of its own is paid through that plan.
  if (facts.planKey !== null && facts.planKey !== POC_PLAN_KEY) return { act: "leave" };
  const status = facts.status as CardBlockableStatus;
  if (!(CARD_BLOCKABLE_STATUSES as readonly string[]).includes(status)) return { act: "leave" };
  return { act: "block", priorStatus: status };
}

/** The organization's mark, from the database. Null when absent or unreadable. */
export async function storedOrigin(tenantId: string): Promise<SelfSignupOrigin | null> {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: SELF_SIGNUP_ORIGIN_KEY } },
    select: { value: true },
  });
  return row ? parseSelfSignupOrigin(row.value) : null;
}

async function factsFor(tenantId: string): Promise<CardFacts> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  if (!tenant) return { status: null, hasCard: false, planKey: null };
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId },
    select: { billableEntityId: true },
  });
  if (!link) return { status: tenant.status, hasCard: false, planKey: null };
  const subscription = await prisma.subscription.findUnique({
    where: { billableEntityId: link.billableEntityId },
    select: { planKey: true },
  });
  const card = await prisma.paymentMethod.findFirst({
    where: { status: "ACTIVE", profile: { billableEntityId: link.billableEntityId } },
    select: { id: true },
  });
  return { status: tenant.status, hasCard: !!card, planKey: subscription?.planKey ?? null };
}

/**
 * True when the sweep closed this organization and it is still closed. What
 * GET /checkout/mine reports as `reason: "card_required"`, and what lets its
 * admin reach the card session after the evaluation's licences have lapsed.
 */
export async function closedForCard(tenantId: string): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  if (tenant?.status !== "PENDING_PAYMENT") return false;
  return !!(await storedOrigin(tenantId))?.cardBlock;
}

/** The status and the mark together, the status only if it is still `from`. */
async function moveWithMark(tenantId: string, from: string, to: string, mark: SelfSignupOrigin): Promise<boolean> {
  const moved = await prisma.$transaction(async (tx) => {
    const { count } = await tx.tenant.updateMany({
      where: { id: tenantId, status: from as any },
      data: { status: to as any },
    });
    if (count !== 1) return false;
    await tx.tenantSetting.update({
      where: { tenantId_key: { tenantId, key: SELF_SIGNUP_ORIGIN_KEY } },
      data: { value: mark as any, updatedBy: ACTOR },
    });
    return true;
  });
  if (!moved) return false;
  // The same value again through the shared writer, for its cache. The
  // database already holds the truth, so a failure here costs nothing.
  await writeDurableSetting(tenantId, SELF_SIGNUP_ORIGIN_KEY, JSON.stringify(mark), ACTOR).catch((err: unknown) =>
    console.warn(`[card-required] the mark's cache was not refreshed for ${tenantId}:`, (err as Error)?.message ?? err),
  );
  return true;
}

async function block(tenantId: string, origin: SelfSignupOrigin, priorStatus: CardBlockableStatus, now: Date): Promise<boolean> {
  const mark: SelfSignupOrigin = { ...origin, cardBlock: { at: now.toISOString(), priorStatus } };
  if (!(await moveWithMark(tenantId, priorStatus, "PENDING_PAYMENT", mark))) return false;
  void writeAudit({
    tenantId,
    actorType: "system",
    actorId: null,
    action: AuditAction.CARD_REQUIRED_BLOCKED,
    targetType: "tenant",
    targetId: tenantId,
    metadata: {
      before: { status: priorStatus },
      after: { status: "PENDING_PAYMENT" },
      signedUpAt: origin.at,
      cardRequiredAfterDays: origin.cardRequiredAfterDays,
    },
  });
  return true;
}

export type RestoreOutcome =
  | { restored: true; status: string }
  | { restored: false; reason: "not_closed_for_card" | "no_card" | "checkout_open" | "status_changed" };

/**
 * Put back an organization the sweep closed, now that it has a card.
 *
 * Called by the confirm route once a card is stored, and by the sweep for an
 * organization whose confirm stored the card but did not get this far.
 */
export async function restoreAfterCard(tenantId: string, now: Date = new Date()): Promise<RestoreOutcome> {
  const origin = await storedOrigin(tenantId);
  if (!origin?.cardBlock) return { restored: false, reason: "not_closed_for_card" };
  const facts = await factsFor(tenantId);
  if (facts.status !== "PENDING_PAYMENT") return { restored: false, reason: "not_closed_for_card" };
  if (!facts.hasCard) return { restored: false, reason: "no_card" };

  // A first payment still owed is a different reason to be closed, and a card
  // on file does not settle it.
  const owed = await prisma.pendingCheckout.findFirst({
    where: { tenantId, status: { in: [...OPEN_CHECKOUT] } },
    select: { id: true },
  });
  if (owed) return { restored: false, reason: "checkout_open" };

  // Setup could be finished while the organization was closed. It then opens
  // as a finished organization, not as one still setting up.
  const onboarding = await prisma.tenantOnboarding.findUnique({ where: { tenantId }, select: { completedAt: true } });
  const { priorStatus } = origin.cardBlock;
  const status = onboarding?.completedAt ? "ACTIVE" : priorStatus;

  const { cardBlock: _closed, ...rest } = origin;
  const mark: SelfSignupOrigin = { ...rest, cardRestoredAt: now.toISOString() };
  if (!(await moveWithMark(tenantId, "PENDING_PAYMENT", status, mark))) return { restored: false, reason: "status_changed" };

  void writeAudit({
    tenantId,
    actorType: "system",
    actorId: null,
    action: AuditAction.CARD_REQUIRED_RESTORED,
    targetType: "tenant",
    targetId: tenantId,
    metadata: { before: { status: "PENDING_PAYMENT" }, after: { status }, closedAt: origin.cardBlock.at },
  });
  return { restored: true, status };
}

export interface CardSweepResult {
  /** Organizations that carry a readable mark. */
  examined: number;
  blocked: number;
  restored: number;
  /** Organizations whose turn threw. The rest of the sweep still ran. */
  failed: number;
}

/**
 * One pass over every self-signed-up organization. No provider call, so it is
 * as safe on dev (whose billing talks to the real provider) as anywhere.
 */
export async function sweepCardRequired(now: Date = new Date()): Promise<CardSweepResult> {
  const rows = await withCrossTenantAccess(() =>
    prisma.tenantSetting.findMany({
      where: { key: SELF_SIGNUP_ORIGIN_KEY },
      select: { tenantId: true, value: true },
      orderBy: { tenantId: "asc" },
    }),
  );
  const result: CardSweepResult = { examined: 0, blocked: 0, restored: 0, failed: 0 };
  for (const row of rows) {
    // A mark that cannot be read is not a mark: its organization is left alone.
    const origin = parseSelfSignupOrigin(row.value);
    if (!origin) continue;
    result.examined++;
    // Nothing to ask the database: not closed, and the day has not come.
    if (!origin.cardBlock && !cardIsDue(origin, now)) continue;
    try {
      const verdict = cardVerdict(origin, await factsFor(row.tenantId), now);
      if (verdict.act === "block") {
        if (await block(row.tenantId, origin, verdict.priorStatus, now)) result.blocked++;
      } else if (verdict.act === "restore") {
        if ((await restoreAfterCard(row.tenantId, now)).restored) result.restored++;
      }
    } catch (err) {
      // One organization's bad row must not leave the others unswept.
      result.failed++;
      console.error(`[card-required] ${row.tenantId} was not swept:`, (err as Error)?.message ?? err);
    }
  }
  return result;
}
