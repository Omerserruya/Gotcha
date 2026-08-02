/**
 * The Bank of Israel representative USD/ILS rate.
 *
 * This is the number every Israeli customer's card is converted at, so it comes
 * from the central bank that publishes it rather than from a person typing into
 * a form. Requiring two administrators to approve the BOI's own daily figure
 * would mean charging stops every weekend nobody is watching - approval is
 * reserved for the cases where a human is actually asserting something.
 *
 * VERIFIED CONTRACT. Probed directly against the live official API, because the
 * documentation page sits behind a Radware challenge and cannot be read:
 *
 *   GET https://boi.org.il/PublicApi/GetExchangeRate?key=USD&asJson=true
 *   {"key":"USD","currentExchangeRate":3.04,"currentChange":-0.71,
 *    "unit":1,"lastUpdate":"2026-07-27T12:21:03.6610401Z"}
 *
 * `unit` is the field that will hurt someone. JPY is published as unit 100 -
 * the quoted figure is per HUNDRED yen. USD is unit 1 today, so ignoring the
 * field appears to work and is a 100x error the moment anything changes. It is
 * divided out, and tested.
 *
 * No HTML scraping, no third-party FX site, no browser-supplied value. Egress
 * goes through the SSRF-guarded fetch like every other outbound call.
 */
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { safeFetch } from "@chatcenter/shared";

export const BOI_SOURCE = "BANK_OF_ISRAEL_REPRESENTATIVE";

const DEFAULT_BASE_URL = "https://boi.org.il/PublicApi";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;

/**
 * A rate outside this band is not a market move, it is a broken response - a
 * unit change, a different currency, or a parsing mistake. Charging on it would
 * be catastrophic in one direction and free in the other.
 */
const PLAUSIBLE_MIN = new Prisma.Decimal("1");
const PLAUSIBLE_MAX = new Prisma.Decimal("20");

export interface ExchangeRateResult {
  baseCurrency: "USD";
  quoteCurrency: "ILS";
  /** Decimal string, per ONE unit of the base currency. Never a float. */
  rate: string;
  /** When the Bank of Israel published it. */
  officialDate: Date;
  /** When we read it. */
  retrievedAt: Date;
  source: typeof BOI_SOURCE;
  /** SHA-256 of the exact bytes served, so a disputed charge is traceable. */
  rawResponseHash: string;
  /**
   * False when the publication is older than one day - a weekend, a holiday, or
   * a day with no new representative rate. Still usable; the caller decides
   * against its staleness policy.
   */
  isCurrentBusinessDay: boolean;
}

export class ExchangeRateUnavailable extends Error {
  constructor(readonly code: string, detail?: string) {
    super(`[fx] official rate unavailable: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ExchangeRateUnavailable";
  }
}

export interface ExchangeRateProvider {
  getLatestRate(baseCurrency: "USD", quoteCurrency: "ILS"): Promise<ExchangeRateResult>;
}

/** Counters for observability. Read by the Sysadmin status surface. */
export const fxMetrics = {
  attempts: 0,
  successes: 0,
  failures: 0,
  lastSuccessAt: null as Date | null,
  lastFailureAt: null as Date | null,
  lastFailureReason: null as string | null,
  circuitOpenUntil: null as Date | null,
};

export function resetFxMetrics(): void {
  Object.assign(fxMetrics, {
    attempts: 0, successes: 0, failures: 0,
    lastSuccessAt: null, lastFailureAt: null, lastFailureReason: null, circuitOpenUntil: null,
  });
}

/**
 * How long to stop calling after repeated failures.
 *
 * Bounded rather than indefinite: the point is to stop hammering a struggling
 * endpoint, not to keep refusing after it recovers.
 */
const CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
let consecutiveFailures = 0;

function circuitOpen(now: Date): boolean {
  const until = fxMetrics.circuitOpenUntil;
  if (!until) return false;
  if (until.getTime() <= now.getTime()) {
    fxMetrics.circuitOpenUntil = null;
    consecutiveFailures = 0;
    return false;
  }
  return true;
}

function recordFailure(reason: string, now: Date): void {
  fxMetrics.failures += 1;
  fxMetrics.lastFailureAt = now;
  fxMetrics.lastFailureReason = reason;
  consecutiveFailures += 1;
  if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    fxMetrics.circuitOpenUntil = new Date(now.getTime() + CIRCUIT_COOLDOWN_MS);
  }
}

function baseUrl(): string {
  return (process.env.BOI_FX_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Read the published figure without going through a binary float.
 *
 * `JSON.parse` hands back a JS number, and 3.04 has no exact binary
 * representation. `String()` recovers the shortest round-trip form - the digits
 * as published - and Decimal takes it from there. Nothing downstream ever sees
 * a float.
 */
function toDecimalString(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ExchangeRateUnavailable("rate_not_finite");
    return String(value);
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ExchangeRateUnavailable("rate_missing_from_response");
}

/** Parse and validate one currency entry. Exported for testing the unit rule. */
export function parseRateEntry(entry: any, rawBody: string, now: Date): ExchangeRateResult {
  if (!entry || typeof entry !== "object") throw new ExchangeRateUnavailable("response_not_an_object");
  if (String(entry.key ?? "").toUpperCase() !== "USD") {
    throw new ExchangeRateUnavailable("wrong_currency", String(entry.key));
  }

  const quoted = new Prisma.Decimal(toDecimalString(entry.currentExchangeRate));

  // The published figure is per `unit` units. Ignoring this is a 100x error for
  // any currency the BOI quotes in hundreds.
  const unit = new Prisma.Decimal(toDecimalString(entry.unit ?? 1));
  if (unit.lte(0)) throw new ExchangeRateUnavailable("unit_not_positive", unit.toString());

  const perUnit = quoted.div(unit);
  if (!perUnit.isFinite() || perUnit.lte(0)) throw new ExchangeRateUnavailable("rate_not_positive");
  if (perUnit.lt(PLAUSIBLE_MIN) || perUnit.gt(PLAUSIBLE_MAX)) {
    // Not a market move. A response this far out is broken, and charging on it
    // would be a real loss to a real person.
    throw new ExchangeRateUnavailable("rate_implausible", perUnit.toString());
  }

  const lastUpdate = new Date(String(entry.lastUpdate ?? ""));
  if (Number.isNaN(lastUpdate.getTime())) throw new ExchangeRateUnavailable("publication_date_unparseable");
  if (lastUpdate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    // A publication date in the future means we are not reading what we think.
    throw new ExchangeRateUnavailable("publication_date_in_future");
  }

  const ageHours = (now.getTime() - lastUpdate.getTime()) / 3_600_000;

  return {
    baseCurrency: "USD",
    quoteCurrency: "ILS",
    rate: perUnit.toString(),
    officialDate: lastUpdate,
    retrievedAt: now,
    source: BOI_SOURCE,
    rawResponseHash: createHash("sha256").update(rawBody).digest("hex"),
    isCurrentBusinessDay: ageHours <= 24,
  };
}

export const boiExchangeRateProvider: ExchangeRateProvider = {
  async getLatestRate(baseCurrency, quoteCurrency): Promise<ExchangeRateResult> {
    if (baseCurrency !== "USD" || quoteCurrency !== "ILS") {
      // The BOI quotes foreign currencies against the shekel. Any other pair
      // would need a different source, not a different parameter.
      throw new ExchangeRateUnavailable("unsupported_pair", `${baseCurrency}->${quoteCurrency}`);
    }

    const now = new Date();
    if (circuitOpen(now)) {
      throw new ExchangeRateUnavailable("circuit_open", fxMetrics.lastFailureReason ?? "repeated failures");
    }

    const url = `${baseUrl()}/GetExchangeRate?key=USD&asJson=true`;
    let lastError = "unknown";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      fxMetrics.attempts += 1;
      try {
        // Read-only GET to a public official endpoint, through the same
        // SSRF-guarded egress as every other outbound call.
        const res = await safeFetch(url, { method: "GET", timeoutMs: REQUEST_TIMEOUT_MS });
        if (!res.ok) {
          lastError = `http_${res.status}`;
        } else {
          const parsed = parseRateEntry(JSON.parse(res.text), res.text, new Date());
          fxMetrics.successes += 1;
          fxMetrics.lastSuccessAt = new Date();
          consecutiveFailures = 0;
          fxMetrics.circuitOpenUntil = null;
          return parsed;
        }
      } catch (err: any) {
        // A malformed response will not become well-formed on retry, so it
        // fails immediately rather than burning the budget.
        if (err instanceof ExchangeRateUnavailable && err.code !== "circuit_open") {
          recordFailure(err.code, new Date());
          throw err;
        }
        lastError = err?.message ?? "request_failed";
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }

    recordFailure(lastError, new Date());
    throw new ExchangeRateUnavailable("source_unreachable", lastError);
  },
};
