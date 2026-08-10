/**
 * Tax, as configuration rather than code.
 *
 * Catalogue prices are NET. Tax is added on top, so the number a customer is
 * charged is not the number on the pricing page, and the document has to state
 * both plus the rate that connects them.
 *
 * The rate comes from a country the customer DECLARED. It is deliberately not
 * inferred: `Tenant.defaultCountryCode` is a phone-normalisation default and
 * the onboarding country is a website-crawl guess. Neither is a statement
 * anyone made about where they are liable, and a tax authority asking why VAT
 * was not charged will not accept one.
 *
 * A country with no active rate is 0%. That is what lets "Israel 18, everyone
 * else nothing" be one row instead of two hundred, and it makes adding a
 * jurisdiction a row rather than a deploy.
 */
import { prisma } from "@chatcenter/shared";
import { Prisma } from "@prisma/client";

/** Two decimals, half-up - the same policy the FX conversion states. */
const ROUND = Prisma.Decimal.ROUND_HALF_UP;
const SCALE = 2;

export class TaxCountryUndeclared extends Error {
  readonly code = "tax_country_undeclared";
  constructor() {
    super(
      "[billing] refusing to price tax: no billing country has been declared. " +
        "Charging 0% by default would silently under-collect from a customer who owes tax.",
    );
    this.name = "TaxCountryUndeclared";
  }
}

export interface TaxRateResolution {
  countryCode: string;
  /** Whole percent, e.g. 18 - not a multiplier. Documents state a rate. */
  percent: number;
  label: string | null;
  /** True when nothing is owed here. Kept explicit so callers read intent. */
  exempt: boolean;
}

/**
 * The active rate for a country, or 0% when none is configured.
 *
 * Absence is a real answer, not a missing one: it is how every country other
 * than Israel is currently expressed.
 */
export async function resolveTaxRate(countryCode: string): Promise<TaxRateResolution> {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!code) throw new TaxCountryUndeclared();

  const row = await prisma.taxRate.findFirst({ where: { countryCode: code, active: true } });
  if (!row) return { countryCode: code, percent: 0, label: null, exempt: true };

  const percent = Number(row.percent);
  return { countryCode: code, percent, label: row.label ?? null, exempt: percent === 0 };
}

export interface TaxedAmount {
  /** The catalogue figure, before tax. */
  net: string;
  /** What the tax itself comes to. Shown as its own line on the document. */
  tax: string;
  /** What the customer is actually charged. */
  gross: string;
  percent: number;
  label: string | null;
  countryCode: string;
  exempt: boolean;
}

/**
 * Add tax to a net amount.
 *
 * Every figure is carried as a decimal string. The tax is computed once, from
 * the net, and the gross is net + tax - rather than deriving the tax back out
 * of a rounded gross, which is how a document ends up with three numbers that
 * do not add up.
 */
export function applyTax(net: string, rate: TaxRateResolution): TaxedAmount {
  const netD = new Prisma.Decimal(net);
  const taxD = netD.mul(rate.percent).div(100).toDecimalPlaces(SCALE, ROUND);
  const grossD = netD.plus(taxD).toDecimalPlaces(SCALE, ROUND);

  return {
    net: netD.toFixed(SCALE),
    tax: taxD.toFixed(SCALE),
    gross: grossD.toFixed(SCALE),
    percent: rate.percent,
    label: rate.label,
    countryCode: rate.countryCode,
    exempt: rate.exempt,
  };
}

/**
 * Price a net amount for a billing profile.
 *
 * Throws when the profile has not declared a country. Refusing is the point:
 * defaulting to 0% would charge an Israeli customer no VAT and leave them
 * owing it, which is worse than making them answer one question.
 */
export async function taxForProfile(
  net: string,
  profile: { billingCountry?: string | null },
): Promise<TaxedAmount> {
  if (!profile.billingCountry) throw new TaxCountryUndeclared();
  const rate = await resolveTaxRate(profile.billingCountry);
  return applyTax(net, rate);
}
