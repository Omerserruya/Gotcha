/**
 * The exchange rate money is charged at.
 *
 * GOTCHA sells in USD and charges in ILS. The number in between now comes from
 * the Bank of Israel's published representative rate, fetched by the backend.
 *
 * Approval follows who is asserting something. Nobody needs to sign off the
 * central bank's own daily figure - requiring that would mean charging stops
 * every weekend nobody is watching, which is worse than the risk it guards
 * against. Two administrators are required exactly where a HUMAN is making a
 * claim: a manual override, a markup, or an emergency fallback when the
 * official source has been unreachable past the permitted window.
 *
 * This is deliberately NOT `getUsdIlsRate` from the shared billing lib. That one
 * silently substitutes a hardcoded 3.7 when its fetch fails. For showing an
 * approximate price that is fine; for deciding what to take from a card it is
 * not, because a network blip would quietly change the amount charged and
 * nobody could say afterwards which rate applied. Display keeps that path.
 *
 * The rule that governs everything here: if there is no rate we can defend,
 * charging stops. An unpriced charge is worse than a blocked one.
 */
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";
import type { BillingExchangeRate } from "@prisma/client";
import {
  boiExchangeRateProvider,
  BOI_SOURCE,
  ExchangeRateUnavailable as ProviderUnavailable,
  fxMetrics,
} from "../providers/boi-fx.provider";

export const DEFAULT_BASE = "USD";
export const DEFAULT_QUOTE = "ILS";

/** Two decimals, half-up. Stated explicitly because rounding money is a policy. */
export const ROUNDING_MODE = "HALF_UP" as const;
const ROUND = Prisma.Decimal.ROUND_HALF_UP;
const SCALE = 2;

/**
 * How long a published rate stays usable.
 *
 * The Bank of Israel does not publish on weekends or Israeli holidays, so a
 * Friday rate has to carry through to Sunday at minimum. The default spans a
 * long weekend plus a holiday without letting a genuinely abandoned rate live
 * forever.
 */
export function maxStalenessHours(): number {
  const raw = Number(process.env.BOI_FX_MAX_STALENESS_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

/** Whether the automatic source is switched on at all. */
export function boiFxEnabled(): boolean {
  return String(process.env.BOI_FX_ENABLED || "").toLowerCase() === "true";
}

export class ExchangeRateUnavailable extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] exchange rate unavailable: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ExchangeRateUnavailable";
  }
}

export class ExchangeRateRefused extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[billing] exchange rate refused: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ExchangeRateRefused";
  }
}

/**
 * What is cached, and deliberately what is not.
 *
 * The customer's browser polls the checkout status while they pay, so without
 * some restraint every poll becomes a call to the central bank - rude, and a
 * good way to get rate-limited at the worst possible moment.
 *
 * So the FETCH is throttled, and the stored rate is NOT cached. Caching the row
 * was the obvious first move and it broke the emergency stop: retiring a rate
 * is how someone halts charging when a number turns out to be wrong, and a
 * cached row kept charging for another five minutes. Worse across instances,
 * where clearing one process's cache does nothing to the others.
 *
 * Reading one indexed row per quote costs nothing next to the network call this
 * is actually protecting.
 */
const FETCH_THROTTLE_MS = 5 * 60 * 1000;
let lastFetchAttemptAt = 0;

export function clearRateCache(): void {
  lastFetchAttemptAt = 0;
}

function pair(opts: { base?: string; quote?: string }) {
  return {
    baseCurrency: (opts.base ?? DEFAULT_BASE).toUpperCase(),
    quoteCurrency: (opts.quote ?? DEFAULT_QUOTE).toUpperCase(),
  };
}

/** A stored rate is usable until its hard expiry, whatever its age. */
function usable(rate: BillingExchangeRate, now: Date): boolean {
  if (rate.status !== "ACTIVE") return false;
  if (rate.activeFrom > now) return false;
  if (rate.activeUntil && rate.activeUntil <= now) return false;
  if (rate.maxUseUntil && rate.maxUseUntil <= now) return false;
  return new Prisma.Decimal(rate.rate).gt(0);
}

/**
 * The rate in force right now, or a typed failure.
 *
 * Order of preference, and the reasoning behind it:
 *
 *   1. A live manual override. A person deliberately said "use this", so it
 *      outranks the automatic feed until it expires.
 *   2. A stored official rate still inside its staleness window - including one
 *      published on Friday and read on Sunday.
 *   3. A fresh fetch from the Bank of Israel.
 *
 * If none of those produces something defensible, this throws and charging
 * stops. It does NOT fall back to an old rate, a hardcoded rate, or the display
 * estimate.
 */
export async function activeRate(
  opts: { base?: string; quote?: string; now?: Date; skipCache?: boolean } = {},
): Promise<BillingExchangeRate> {
  const now = opts.now ?? new Date();
  const where = pair(opts);

  const stored = await prisma.billingExchangeRate.findFirst({
    where: { ...where, status: "ACTIVE" },
    orderBy: [{ officialDate: "desc" }, { activeFrom: "desc" }],
  });

  // A manual override is a decision someone took. It stands until it expires,
  // and is never quietly replaced by the feed.
  if (stored && stored.origin !== "AUTOMATIC_OFFICIAL" && usable(stored, now)) {
    assertManuallyApproved(stored);
    return stored;
  }

  if (stored && usable(stored, now) && withinRefreshWindow(stored, now)) {
    return stored;
  }

  // Nothing usable stored. Ask the source.
  if (where.baseCurrency === "USD" && where.quoteCurrency === "ILS" && boiFxEnabled()) {
    // Throttled, not cached: a burst of polls produces one call to the central
    // bank, while a retired rate still stops charging on the very next request.
    const throttled = !opts.skipCache && Date.now() - lastFetchAttemptAt < FETCH_THROTTLE_MS;
    if (throttled && stored && usable(stored, now)) return stored;

    try {
      lastFetchAttemptAt = Date.now();
      return await fetchAndStoreOfficialRate(now);
    } catch (err) {
      // The fetch failed. A stored rate still inside its staleness window is a
      // legitimate answer - that is what the window is for. One outside it is
      // not, and we stop rather than charge at a number we cannot stand behind.
      if (stored && usable(stored, now)) return stored;
      const code = err instanceof ProviderUnavailable ? err.code : "source_unreachable";
      throw new ExchangeRateUnavailable("no_usable_rate", code);
    }
  }

  if (stored && usable(stored, now)) return stored;

  throw new ExchangeRateUnavailable(
    "no_active_rate",
    `${where.baseCurrency}->${where.quoteCurrency}${boiFxEnabled() ? "" : " (BOI_FX_ENABLED is not true)"}`,
  );
}

/**
 * Whether a stored official rate is fresh enough to serve without re-checking.
 *
 * Distinct from usability. A rate can be usable (inside the staleness window)
 * while being worth refreshing, and this is what stops a Monday charge going
 * out at Friday's rate when today's is available.
 */
function withinRefreshWindow(rate: BillingExchangeRate, now: Date): boolean {
  if (!rate.officialDate) return false;
  const ageHours = (now.getTime() - rate.officialDate.getTime()) / 3_600_000;
  // Under a day old: certainly current. Older: re-check, but the caller falls
  // back to this same row if the source is down.
  return ageHours < 20;
}

function assertManuallyApproved(rate: BillingExchangeRate): void {
  // Belt and braces over the database CHECK. A manual rate is only valid if two
  // different people stand behind it.
  if (!rate.createdBy || !rate.approvedBy || rate.createdBy === rate.approvedBy) {
    throw new ExchangeRateUnavailable("manual_rate_not_two_person_approved", rate.id);
  }
}

/**
 * Fetch today's official rate and make it the active one.
 *
 * Retiring the previous rate and activating the new one happen together, so the
 * partial unique index never sees two active rows and no window exists where a
 * charge finds none.
 */
export async function fetchAndStoreOfficialRate(now: Date = new Date()): Promise<BillingExchangeRate> {
  const result = await boiExchangeRateProvider.getLatestRate("USD", "ILS");

  const maxUseUntil = new Date(result.officialDate.getTime() + maxStalenessHours() * 3_600_000);
  if (maxUseUntil <= now) {
    // The source answered, but with something already past its permitted life.
    throw new ExchangeRateUnavailable("official_rate_too_stale", result.officialDate.toISOString());
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.billingExchangeRate.findFirst({
      where: {
        baseCurrency: "USD",
        quoteCurrency: "ILS",
        source: BOI_SOURCE,
        officialDate: result.officialDate,
      },
    });
    // Same publication, already stored. Re-activating it is enough; writing a
    // second row would make the audit trail look like two separate decisions.
    if (existing && existing.status === "ACTIVE") return existing;

    const last = await tx.billingExchangeRate.findFirst({
      where: { baseCurrency: "USD", quoteCurrency: "ILS" },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await tx.billingExchangeRate.updateMany({
      where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
      data: { status: "RETIRED", activeUntil: now },
    });

    if (existing) {
      return tx.billingExchangeRate.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", activeUntil: null, maxUseUntil, retrievedAt: result.retrievedAt },
      });
    }

    return tx.billingExchangeRate.create({
      data: {
        baseCurrency: "USD",
        quoteCurrency: "ILS",
        rate: result.rate,
        source: result.source,
        version: (last?.version ?? 0) + 1,
        origin: "AUTOMATIC_OFFICIAL",
        verificationState: "VERIFIED_OFFICIAL",
        officialDate: result.officialDate,
        retrievedAt: result.retrievedAt,
        rawResponseHash: result.rawResponseHash,
        maxUseUntil,
        activeFrom: now,
        status: "ACTIVE",
        // No approver, and none required: nobody asserted this number, the
        // Bank of Israel published it.
        createdBy: null,
        approvedBy: null,
      },
    });
  });
}

/**
 * Fetch today's rate if the stored one is due for replacement.
 *
 * Called from the scheduler so the day's rate is in place before renewals run,
 * rather than being fetched by whichever customer happens to check out first.
 * Silent when the feed is off or the stored rate is still current - an hourly
 * job that logs on every tick is an hourly job nobody reads.
 */
export async function refreshOfficialRateIfDue(now: Date = new Date()): Promise<{ refreshed: boolean }> {
  if (!boiFxEnabled()) return { refreshed: false };

  const stored = await prisma.billingExchangeRate.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS", status: "ACTIVE" },
    orderBy: [{ officialDate: "desc" }, { activeFrom: "desc" }],
  });

  // A live manual override is someone's deliberate decision. Refreshing over it
  // would undo that silently.
  if (stored && stored.origin !== "AUTOMATIC_OFFICIAL" && usable(stored, now)) {
    return { refreshed: false };
  }
  if (stored && usable(stored, now) && withinRefreshWindow(stored, now)) {
    return { refreshed: false };
  }

  await fetchAndStoreOfficialRate(now);
  return { refreshed: true };
}

/** Whether charging is currently possible at all. Used to gate the UI. */
export async function chargingRateConfigured(
  opts: { base?: string; quote?: string; now?: Date } = {},
): Promise<boolean> {
  try {
    await activeRate(opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert with exact decimal arithmetic.
 *
 * Never binary floating point: 0.1 + 0.2 is not 0.3, and the place that
 * difference shows up is a customer's statement.
 */
export function convert(amount: Prisma.Decimal.Value, rate: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(amount).mul(new Prisma.Decimal(rate)).toDecimalPlaces(SCALE, ROUND);
}

// ─── Manual override ──────────────────────────────────────────────────────

/**
 * Propose a manual rate. Created as DRAFT - proposing changes nothing.
 *
 * Only for the cases where a person is genuinely asserting a number: an
 * override, a markup, or an emergency when the official source has been
 * unreachable past the permitted window. Normal daily rates never come through
 * here.
 */
export async function proposeRate(input: {
  rate: string | number;
  base?: string;
  quote?: string;
  activeFrom?: Date;
  activeUntil?: Date | null;
  /** Why a human number is being used instead of the official one. Required. */
  reason: string;
  origin?: "MANUAL_OVERRIDE" | "EMERGENCY_FALLBACK";
  createdBy: string;
  /** Hard expiry. An override without one would outlive the reason for it. */
  expiresAt?: Date;
}): Promise<BillingExchangeRate> {
  const where = pair(input);

  const value = new Prisma.Decimal(input.rate);
  if (!value.isFinite() || value.lte(0)) throw new ExchangeRateRefused("rate_must_be_positive");
  // A rate outside this band is a typo - a misplaced decimal point, or an
  // inverted pair. Charging on it is catastrophic one way and free the other.
  if (value.gte(1000)) throw new ExchangeRateRefused("rate_implausible", value.toString());
  if (where.baseCurrency === where.quoteCurrency) throw new ExchangeRateRefused("identical_currencies");
  if (!String(input.reason ?? "").trim()) throw new ExchangeRateRefused("reason_required");

  const activeFrom = input.activeFrom ?? new Date();
  if (input.activeUntil && input.activeUntil <= activeFrom) {
    throw new ExchangeRateRefused("active_until_before_active_from");
  }

  // Default expiry so an emergency override cannot quietly become permanent.
  const expiresAt = input.expiresAt ?? new Date(activeFrom.getTime() + 72 * 3_600_000);
  if (expiresAt <= activeFrom) throw new ExchangeRateRefused("expiry_before_start");

  for (let tries = 0; tries < 5; tries += 1) {
    const last = await prisma.billingExchangeRate.findFirst({
      where,
      orderBy: { version: "desc" },
      select: { version: true },
    });
    try {
      return await prisma.billingExchangeRate.create({
        data: {
          ...where,
          rate: value,
          source: "MANUAL_PLATFORM_RATE",
          version: (last?.version ?? 0) + 1,
          origin: input.origin ?? "MANUAL_OVERRIDE",
          verificationState: "MANUALLY_APPROVED",
          activeFrom,
          activeUntil: input.activeUntil ?? null,
          maxUseUntil: expiresAt,
          overrideReason: input.reason.trim(),
          status: "DRAFT",
          createdBy: input.createdBy,
          retrievedAt: new Date(),
        },
      });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
    }
  }
  throw new ExchangeRateRefused("version_allocation_contended");
}

/**
 * Approve a manual override, making it the rate in force.
 *
 * Separation of duties: the person who typed a number is not the person who
 * makes it chargeable. The database enforces this too, so bypassing this
 * function with raw SQL does not get around it.
 */
export async function approveRate(input: {
  id: string;
  approvedBy: string;
  now?: Date;
}): Promise<BillingExchangeRate> {
  const now = input.now ?? new Date();

  const approved = await prisma.$transaction(async (tx) => {
    const draft = await tx.billingExchangeRate.findUnique({ where: { id: input.id } });
    if (!draft) throw new ExchangeRateRefused("rate_not_found");
    if (draft.status === "ACTIVE") return draft;
    if (draft.status === "RETIRED") throw new ExchangeRateRefused("rate_retired");
    if (draft.origin === "AUTOMATIC_OFFICIAL") {
      throw new ExchangeRateRefused("automatic_rate_needs_no_approval");
    }
    if (draft.maxUseUntil && draft.maxUseUntil <= now) {
      // Approving something already expired would put a dead rate into force.
      throw new ExchangeRateRefused("override_expired");
    }
    if (draft.createdBy && draft.createdBy === input.approvedBy) {
      throw new ExchangeRateRefused("approver_must_differ_from_creator");
    }

    await tx.billingExchangeRate.updateMany({
      where: {
        baseCurrency: draft.baseCurrency,
        quoteCurrency: draft.quoteCurrency,
        status: "ACTIVE",
      },
      data: { status: "RETIRED", activeUntil: now },
    });

    return tx.billingExchangeRate.update({
      where: { id: draft.id },
      data: { status: "ACTIVE", approvedBy: input.approvedBy, approvedAt: now },
    });
  });

  clearRateCache();
  return approved;
}

/**
 * Retire a rate without replacing it.
 *
 * For an override this hands control back to the official feed. For the last
 * official rate it stops charging - which is the point of having the lever.
 */
export async function retireRate(input: { id: string; actor: string; now?: Date }): Promise<BillingExchangeRate> {
  const now = input.now ?? new Date();
  const rate = await prisma.billingExchangeRate.findUnique({ where: { id: input.id } });
  if (!rate) throw new ExchangeRateRefused("rate_not_found");
  const retired = await prisma.billingExchangeRate.update({
    where: { id: rate.id },
    data: { status: "RETIRED", activeUntil: rate.activeUntil ?? now },
  });
  clearRateCache();
  return retired;
}

/** History for the Sysadmin surface. Charged quotes reference these by id. */
export async function rateHistory(opts: { base?: string; quote?: string; limit?: number } = {}) {
  return prisma.billingExchangeRate.findMany({
    where: pair(opts),
    orderBy: { version: "desc" },
    take: opts.limit ?? 50,
  });
}

/** Everything the Sysadmin status panel needs, including why it is unhappy. */
export async function fxStatus(now: Date = new Date()) {
  const where = pair({});
  const current = await prisma.billingExchangeRate.findFirst({
    where: { ...where, status: "ACTIVE" },
    orderBy: [{ officialDate: "desc" }, { activeFrom: "desc" }],
  });

  const ageHours = current?.officialDate
    ? (now.getTime() - current.officialDate.getTime()) / 3_600_000
    : null;

  return {
    enabled: boiFxEnabled(),
    source: BOI_SOURCE,
    maxStalenessHours: maxStalenessHours(),
    current: current
      ? {
          id: current.id,
          rate: String(current.rate),
          version: current.version,
          origin: current.origin,
          verificationState: current.verificationState,
          officialDate: current.officialDate,
          retrievedAt: current.retrievedAt,
          maxUseUntil: current.maxUseUntil,
          overrideReason: current.overrideReason,
          approvedBy: current.approvedBy,
          createdBy: current.createdBy,
          ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
          usable: usable(current, now),
        }
      : null,
    charging: await chargingRateConfigured({ now }),
    metrics: {
      attempts: fxMetrics.attempts,
      successes: fxMetrics.successes,
      failures: fxMetrics.failures,
      lastSuccessAt: fxMetrics.lastSuccessAt,
      lastFailureAt: fxMetrics.lastFailureAt,
      lastFailureReason: fxMetrics.lastFailureReason,
      circuitOpenUntil: fxMetrics.circuitOpenUntil,
    },
  };
}
