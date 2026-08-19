/**
 * Coupons: issuing them, assigning them to organizations, and resolving the
 * one that applies when money is about to move.
 *
 * The arithmetic lives in `@chatcenter/shared` (pure, tested); this file owns
 * the database side and the two rules that make recurrence work:
 *
 *   • ONE coupon applies at a time. Stacking discounts is a pricing decision
 *     nobody has made, and silently stacking them is how a customer ends up
 *     paying nothing. When several assignments are live, the one that saves
 *     the customer most wins - deterministic, and never a surprise downgrade.
 *   • The assignment window is the whole recurrence mechanism. "20% off for a
 *     year" is one row with endsAt = +12 months; every monthly charge inside
 *     that window is discounted, with no per-period bookkeeping to drift.
 */
import {
  prisma,
  applyCouponToPrice,
  assignmentIsLive,
  couponLabel,
  type CouponTerms,
  type DiscountBreakdown,
} from "@chatcenter/shared";

export interface LiveAssignment {
  assignmentId: string;
  couponId: string;
  terms: CouponTerms;
  startsAt: Date;
  endsAt: Date | null;
  label: string;
}

/**
 * Every assignment currently in force for a tenant, richest-discount first.
 *
 * `at` is passed rather than read from the clock so a renewal dated in the
 * past resolves the coupon that was live THEN, not the one live now.
 */
export async function liveAssignmentsFor(tenantId: string, at: Date = new Date()): Promise<LiveAssignment[]> {
  const rows = await prisma.tenantCoupon.findMany({
    where: { tenantId, status: "ACTIVE" },
    include: { coupon: true },
  });
  return rows
    .filter((r) => assignmentIsLive(r, at) && r.coupon.active)
    .map((r) => ({
      assignmentId: r.id,
      couponId: r.couponId,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      label: couponLabel(termsOf(r.coupon)),
      terms: termsOf(r.coupon),
    }));
}

function termsOf(c: {
  code: string;
  discountType: string;
  percentOff: number | null;
  amountOff: unknown;
  currency: string | null;
}): CouponTerms {
  return {
    code: c.code,
    discountType: c.discountType === "FIXED" ? "FIXED" : "PERCENT",
    percentOff: c.percentOff,
    amountOff: c.amountOff,
    currency: c.currency,
  };
}

export interface ResolvedDiscount extends DiscountBreakdown {
  assignmentId: string | null;
  endsAt: Date | null;
}

/**
 * The discount that applies to one price, for one tenant, at one moment.
 *
 * Called by BOTH the charge path and the display path - that shared call is
 * what guarantees the number on the billing page is the number that will be
 * taken from the card.
 */
export async function resolveDiscount(input: {
  tenantId: string;
  listPrice: unknown;
  currency: string;
  at?: Date;
}): Promise<ResolvedDiscount> {
  const at = input.at ?? new Date();
  const live = await liveAssignmentsFor(input.tenantId, at);

  let best: { breakdown: DiscountBreakdown; assignment: LiveAssignment } | null = null;
  for (const assignment of live) {
    const breakdown = applyCouponToPrice(input.listPrice, input.currency, assignment.terms);
    if (breakdown.skipped) {
      // Loud, not swallowed: an operator wrote a coupon that cannot apply here
      // (usually a FIXED amount in the wrong currency), and the customer is
      // being charged full price while everyone believes they have a discount.
      console.warn(
        `[billing][coupon] ${assignment.terms.code} does not apply to tenant ${input.tenantId}: ${breakdown.skipped}`,
      );
      continue;
    }
    if (!best || breakdown.discount.minor > best.breakdown.discount.minor) {
      best = { breakdown, assignment };
    }
  }

  if (!best) {
    const empty = applyCouponToPrice(input.listPrice, input.currency, null);
    return { ...empty, assignmentId: null, endsAt: null };
  }
  return { ...best.breakdown, assignmentId: best.assignment.assignmentId, endsAt: best.assignment.endsAt };
}

// ── Operator surface ────────────────────────────────────────────────────────

export async function listCoupons() {
  const coupons = await prisma.coupon.findMany({
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { assignments: true } } },
  });
  return coupons.map((c) => ({
    id: c.id,
    code: c.code,
    nameEn: c.nameEn,
    nameHe: c.nameHe,
    discountType: c.discountType,
    percentOff: c.percentOff,
    amountOff: c.amountOff ? String(c.amountOff) : null,
    currency: c.currency,
    defaultDurationMonths: c.defaultDurationMonths,
    active: c.active,
    maxRedemptions: c.maxRedemptions,
    redemptionCount: c.redemptionCount,
    assignmentCount: c._count.assignments,
    internalNote: c.internalNote,
    label: couponLabel(termsOf(c)),
    createdAt: c.createdAt,
  }));
}

export interface CreateCouponInput {
  code: string;
  nameEn: string;
  nameHe?: string | null;
  discountType: "PERCENT" | "FIXED";
  percentOff?: number | null;
  amountOff?: string | null;
  currency?: string | null;
  defaultDurationMonths?: number | null;
  maxRedemptions?: number | null;
  internalNote?: string | null;
  actor?: string;
}

/**
 * Create a coupon.
 *
 * Validation is deliberately strict at creation rather than at charge time: a
 * coupon that cannot apply is invisible until someone's invoice is wrong, so
 * the refusal belongs where the operator can still fix it.
 */
export async function createCoupon(input: CreateCouponInput) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code)) throw new Error("invalid_code");
  if (!input.nameEn?.trim()) throw new Error("name_required");

  if (input.discountType === "PERCENT") {
    const pct = Number(input.percentOff ?? 0);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new Error("percent_out_of_range");
  } else {
    const amount = Number(input.amountOff ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount_required");
    if (!input.currency) throw new Error("currency_required_for_fixed");
  }
  if (input.defaultDurationMonths != null && (!Number.isInteger(input.defaultDurationMonths) || input.defaultDurationMonths < 1)) {
    throw new Error("invalid_duration");
  }

  return prisma.coupon.create({
    data: {
      code,
      nameEn: input.nameEn.trim(),
      nameHe: input.nameHe?.trim() || null,
      discountType: input.discountType,
      percentOff: input.discountType === "PERCENT" ? Number(input.percentOff) : null,
      amountOff: input.discountType === "FIXED" ? (input.amountOff as any) : null,
      currency: input.discountType === "FIXED" ? String(input.currency).toUpperCase() : null,
      defaultDurationMonths: input.defaultDurationMonths ?? null,
      maxRedemptions: input.maxRedemptions ?? null,
      internalNote: input.internalNote ?? null,
      createdBy: input.actor ?? null,
    },
  });
}

export async function setCouponActive(couponId: string, active: boolean) {
  return prisma.coupon.update({ where: { id: couponId }, data: { active } });
}

/**
 * Give a coupon to one organization.
 *
 * `endsAt` is resolved once, here, so the window is a fact on the row rather
 * than something recomputed from the coupon's defaults later (which would move
 * silently if an operator edited the coupon afterwards).
 */
export async function assignCoupon(input: {
  tenantId: string;
  couponId?: string;
  code?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  durationMonths?: number | null;
  note?: string | null;
  actor?: string;
}) {
  const coupon = input.couponId
    ? await prisma.coupon.findUnique({ where: { id: input.couponId } })
    : await prisma.coupon.findUnique({ where: { code: String(input.code || "").toUpperCase() } });
  if (!coupon) throw new Error("unknown_coupon");
  if (!coupon.active) throw new Error("coupon_inactive");
  if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) {
    throw new Error("coupon_exhausted");
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
  if (!tenant) throw new Error("unknown_tenant");

  // One live assignment per tenant per coupon. Re-assigning the same coupon is
  // an operator correcting the window, not a second discount.
  const existing = await prisma.tenantCoupon.findFirst({
    where: { tenantId: input.tenantId, couponId: coupon.id, status: "ACTIVE" },
  });
  if (existing) throw new Error("already_assigned");

  const startsAt = input.startsAt ?? new Date();
  const months = input.durationMonths ?? coupon.defaultDurationMonths ?? null;
  const endsAt =
    input.endsAt !== undefined
      ? input.endsAt
      : months != null
        ? addMonths(startsAt, months)
        : null;

  const assignment = await prisma.tenantCoupon.create({
    data: {
      tenantId: input.tenantId,
      couponId: coupon.id,
      startsAt,
      endsAt,
      note: input.note ?? null,
      assignedBy: input.actor ?? null,
    },
    include: { coupon: true },
  });
  await prisma.coupon.update({
    where: { id: coupon.id },
    data: { redemptionCount: { increment: 1 } },
  });
  return assignment;
}

export async function revokeAssignment(assignmentId: string, actor?: string) {
  return prisma.tenantCoupon.update({
    where: { id: assignmentId },
    data: { status: "REVOKED", revokedAt: new Date(), assignedBy: actor ?? undefined },
  });
}

export async function assignmentsForTenant(tenantId: string) {
  const rows = await prisma.tenantCoupon.findMany({
    where: { tenantId },
    include: { coupon: true },
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    code: r.coupon.code,
    nameEn: r.coupon.nameEn,
    nameHe: r.coupon.nameHe,
    label: couponLabel(termsOf(r.coupon)),
    discountType: r.coupon.discountType,
    percentOff: r.coupon.percentOff,
    amountOff: r.coupon.amountOff ? String(r.coupon.amountOff) : null,
    currency: r.coupon.currency,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    status: r.status,
    live: assignmentIsLive(r, now) && r.coupon.active,
    note: r.note,
    assignedBy: r.assignedBy,
    createdAt: r.createdAt,
  }));
}

/**
 * Retire assignments whose window has closed.
 *
 * `assignmentIsLive` already refuses an elapsed window, so this changes no
 * money - it exists so the operator sees EXPIRED with a date instead of an
 * ACTIVE row that mysteriously stopped discounting.
 */
export async function expireDueAssignments(now = new Date()): Promise<number> {
  const { count } = await prisma.tenantCoupon.updateMany({
    where: { status: "ACTIVE", endsAt: { not: null, lte: now } },
    data: { status: "EXPIRED" },
  });
  return count;
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const targetMonth = d.getMonth() + months;
  const day = d.getDate();
  d.setMonth(targetMonth, 1);
  // Clamp: "+1 month" from the 31st lands on the last day of a shorter month
  // rather than skipping into the one after it.
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}
