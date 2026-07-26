/**
 * USD/ILS display conversion.
 *
 * USD is the canonical public pricing currency. ILS is a DISPLAY conversion at
 * an official representative rate, rounded upward by a configurable increment.
 *
 * Rules the implementation enforces rather than documents:
 *   • The rate is fetched SERVER-SIDE and cached daily. A client can never
 *     supply, hint at, or influence it.
 *   • No external request happens on render - callers read the cached snapshot.
 *   • On fetch failure the configured fallback is used and clearly attributed,
 *     never a stale-but-unlabelled guess.
 *   • Display currency and CHARGED currency are different things. Unless the
 *     config explicitly enables charging in the display currency, ILS is
 *     labelled an estimate and the charge happens in USD.
 */
import { prisma } from "../prisma";
import { safeFetch } from "../safe-fetch";
import {
  type Money,
  type CurrencyCode,
  type RoundingMode,
  money,
  convertMoney,
  roundToIncrement,
  formatMoney,
  toDecimalString,
} from "./money";

export interface CurrencyConfig {
  baseCurrency: CurrencyCode;
  displayCurrencies: CurrencyCode[];
  ilsRoundingIncrement: number;
  roundingMode: RoundingMode;
  fxSource: string;
  fxRefreshHours: number;
  fallbackUsdIls: string;
  chargeInDisplayCurrency: boolean;
}

export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = {
  baseCurrency: "USD",
  displayCurrencies: ["USD", "ILS"],
  ilsRoundingIncrement: 5,
  roundingMode: "UP",
  fxSource: "boi",
  fxRefreshHours: 24,
  fallbackUsdIls: "3.70",
  chargeInDisplayCurrency: false,
};

const CONFIG_TTL_MS = 60_000;
let configCache: { at: number; value: CurrencyConfig } | null = null;
let rateCache: { at: number; value: FxRate } | null = null;

export function invalidateCurrencyCache(): void {
  configCache = null;
  rateCache = null;
}

export async function getCurrencyConfig(): Promise<CurrencyConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  let value = DEFAULT_CURRENCY_CONFIG;
  try {
    const row = await prisma.pricingCurrencyConfig.findFirst({ where: { active: true }, orderBy: { updatedAt: "desc" } });
    if (row) {
      value = {
        baseCurrency: row.baseCurrency,
        displayCurrencies: Array.isArray(row.displayCurrencies)
          ? (row.displayCurrencies as string[])
          : DEFAULT_CURRENCY_CONFIG.displayCurrencies,
        ilsRoundingIncrement: row.ilsRoundingIncrement,
        roundingMode: (row.roundingMode as RoundingMode) ?? "UP",
        fxSource: row.fxSource,
        fxRefreshHours: row.fxRefreshHours,
        fallbackUsdIls: String(row.fallbackUsdIls),
        chargeInDisplayCurrency: row.chargeInDisplayCurrency,
      };
    }
  } catch (err: any) {
    console.error("[billing/currency] config load failed:", err?.message ?? err);
  }
  configCache = { at: Date.now(), value };
  return value;
}

// ── FX rate ─────────────────────────────────────────────────────────────────

export interface FxRate {
  rate: string;
  source: string;
  rateDate: string;
  fetchedAt: string;
  /** True when the configured fallback is in use because no live rate exists. */
  isFallback: boolean;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The representative USD/ILS rate to display with.
 *
 * Reads the newest cached snapshot. If it is older than the configured refresh
 * window, a refresh is attempted; a failed refresh falls back to the newest
 * snapshot we do have, and only then to the configured fallback constant.
 */
export async function getUsdIlsRate(now = new Date()): Promise<FxRate> {
  const cfg = await getCurrencyConfig();
  const ttlMs = Math.max(1, cfg.fxRefreshHours) * 3600_000;
  if (rateCache && now.getTime() - rateCache.at < ttlMs) return rateCache.value;

  let newest: FxRate | null = null;
  try {
    const row = await prisma.fxRateSnapshot.findFirst({
      where: { baseCurrency: "USD", quoteCurrency: "ILS" },
      orderBy: { fetchedAt: "desc" },
    });
    if (row) {
      newest = {
        rate: String(row.rate),
        source: row.source,
        rateDate: row.rateDate,
        fetchedAt: row.fetchedAt.toISOString(),
        isFallback: row.source === "fallback",
      };
    }
  } catch (err: any) {
    console.error("[billing/currency] snapshot read failed:", err?.message ?? err);
  }

  const fresh = newest && now.getTime() - new Date(newest.fetchedAt).getTime() < ttlMs;
  if (fresh && newest) {
    rateCache = { at: now.getTime(), value: newest };
    return newest;
  }

  const refreshed = await refreshUsdIlsRate(now).catch(() => null);
  const value = refreshed ?? newest ?? {
    rate: cfg.fallbackUsdIls,
    source: "fallback",
    rateDate: dateKey(now),
    fetchedAt: now.toISOString(),
    isFallback: true,
  };
  rateCache = { at: now.getTime(), value };
  return value;
}

/**
 * Fetch and persist today's representative rate. Called by the refresh path and
 * by the billing scheduler - never from a render.
 *
 * The Bank of Israel publishes the official representative rate; `FX_USD_ILS_URL`
 * lets an operator point at a different official source without a code change.
 * Any failure returns null so the caller falls back rather than throwing into a
 * pricing page.
 */
export async function refreshUsdIlsRate(now = new Date()): Promise<FxRate | null> {
  const cfg = await getCurrencyConfig();
  const url = process.env.FX_USD_ILS_URL;
  let rate: string | null = null;

  if (url) {
    try {
      // safeFetch is the SSRF-guarded egress path: an operator-set URL is still
      // operator-set input, so it goes through the same allow-list as any other
      // outbound call and never resolves to an internal address.
      const res = await safeFetch(url, { method: "GET", timeoutMs: 8_000 });
      if (res.ok) {
        const body: any = JSON.parse(res.text);
        // Accept the common shapes without hard-coding one provider's envelope.
        const candidate =
          body?.rate ?? body?.currentExchangeRate ?? body?.rates?.ILS ?? body?.data?.rate ?? null;
        if (candidate != null && Number(candidate) > 0) rate = String(candidate);
      } else {
        console.warn("[billing/currency] FX fetch not ok:", res.status, res.error ?? "");
      }
    } catch (err: any) {
      console.warn("[billing/currency] FX fetch failed, falling back:", err?.message ?? err);
    }
  }

  const isFallback = rate == null;
  const finalRate = rate ?? cfg.fallbackUsdIls;
  const source = isFallback ? "fallback" : cfg.fxSource;
  const rateDate = dateKey(now);

  try {
    await prisma.fxRateSnapshot.upsert({
      where: { baseCurrency_quoteCurrency_rateDate_source: { baseCurrency: "USD", quoteCurrency: "ILS", rateDate, source } },
      create: { baseCurrency: "USD", quoteCurrency: "ILS", rate: finalRate, source, rateDate, fetchedAt: now },
      update: { rate: finalRate, fetchedAt: now },
    });
  } catch (err: any) {
    console.error("[billing/currency] snapshot write failed:", err?.message ?? err);
  }

  rateCache = null;
  return { rate: finalRate, source, rateDate, fetchedAt: now.toISOString(), isFallback };
}

// ── Display conversion ──────────────────────────────────────────────────────

export interface DisplayPrice {
  /** The canonical price, always present. */
  base: { amount: string; currency: CurrencyCode; formatted: string };
  /** The requested display rendering. Equals `base` when displaying USD. */
  display: { amount: string; currency: CurrencyCode; formatted: string };
  /** True when `display` is a converted estimate rather than the charged amount. */
  isEstimatedConversion: boolean;
  /** The currency the customer will actually be charged in. */
  chargedCurrency: CurrencyCode;
  fx: { rate: string; source: string; rateDate: string; isFallback: boolean } | null;
}

/**
 * Render a canonical USD price in the requested display currency.
 *
 *   displayIls = baseUsdPrice x representativeRate, rounded UP to ₪5
 *
 * `isEstimatedConversion` is what the UI must key its "estimated conversion"
 * label off - never a hardcoded assumption about which currency is charged.
 */
export async function toDisplayPrice(
  baseUsd: Money,
  displayCurrency: CurrencyCode,
  now = new Date(),
): Promise<DisplayPrice> {
  const cfg = await getCurrencyConfig();
  const base = {
    amount: toDecimalString(baseUsd),
    currency: baseUsd.currency,
    formatted: formatMoney(baseUsd),
  };

  if (displayCurrency === baseUsd.currency) {
    return {
      base,
      display: base,
      isEstimatedConversion: false,
      chargedCurrency: baseUsd.currency,
      fx: null,
    };
  }

  const fx = await getUsdIlsRate(now);
  const converted = convertMoney(baseUsd, fx.rate, displayCurrency);
  const rounded =
    displayCurrency === "ILS"
      ? roundToIncrement(converted, cfg.ilsRoundingIncrement, cfg.roundingMode)
      : converted;

  return {
    base,
    display: {
      amount: toDecimalString(rounded),
      currency: displayCurrency,
      formatted: formatMoney(rounded),
    },
    isEstimatedConversion: !cfg.chargeInDisplayCurrency,
    chargedCurrency: cfg.chargeInDisplayCurrency ? displayCurrency : baseUsd.currency,
    fx: { rate: fx.rate, source: fx.source, rateDate: fx.rateDate, isFallback: fx.isFallback },
  };
}

/**
 * The exact amount to charge, plus the FX snapshot to persist alongside it.
 *
 * When charging in the base currency, no rate is recorded - there is nothing to
 * snapshot. When ILS billing is enabled, the rate used IS the contract and is
 * stored so the invoice can show the exact charged amount forever.
 */
export async function resolveChargeAmount(
  baseUsd: Money,
  requestedCurrency: CurrencyCode,
  now = new Date(),
): Promise<{ amount: Money; fxSnapshot: FxRate | null }> {
  const cfg = await getCurrencyConfig();
  if (!cfg.chargeInDisplayCurrency || requestedCurrency === baseUsd.currency) {
    return { amount: baseUsd, fxSnapshot: null };
  }
  const fx = await getUsdIlsRate(now);
  const converted = convertMoney(baseUsd, fx.rate, requestedCurrency);
  const rounded =
    requestedCurrency === "ILS"
      ? roundToIncrement(converted, cfg.ilsRoundingIncrement, cfg.roundingMode)
      : converted;
  return { amount: rounded, fxSnapshot: fx };
}

export { money, formatMoney };
export type { Money, CurrencyCode };
