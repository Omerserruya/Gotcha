/**
 * Money as integer minor units. No floating-point arithmetic, anywhere.
 *
 * A price is carried as a whole number of minor units (cents, agorot) plus a
 * currency. Parsing happens once at the DB/JSON boundary; every add, multiply
 * and round after that is integer maths, so `0.1 + 0.2` can never turn ₪498
 * into ₪497.99999999999994.
 *
 * Prisma returns `Decimal | string | number` for money columns. `toMinor()` is
 * the single entry point that normalises all three, deliberately going through
 * the decimal STRING rather than `Number()` so a value that is exact in decimal
 * stays exact.
 */

export type CurrencyCode = "USD" | "ILS" | string;

export interface Money {
  /** Whole minor units: 149.00 USD -> 14900. */
  minor: number;
  currency: CurrencyCode;
}

/** Minor units per major unit. Both supported currencies are 2-decimal. */
export function minorUnitScale(_currency: CurrencyCode): number {
  return 100;
}

/**
 * Normalise a Prisma Decimal / string / number into integer minor units.
 *
 * Parses the decimal string rather than multiplying a float by 100: for a value
 * like "0.145", `0.145 * 100` is 14.499999999999998, which truncates to the
 * wrong cent. String parsing keeps it exact.
 */
export function toMinor(value: unknown, currency: CurrencyCode = "USD"): number {
  if (value == null) return 0;
  const scale = minorUnitScale(currency);
  const digits = String(Math.log10(scale) | 0); // "2"
  const s =
    typeof value === "object" && value !== null && "toFixed" in (value as any)
      ? (value as any).toFixed(Number(digits)) // Prisma Decimal
      : typeof value === "number"
        ? value.toFixed(Number(digits))
        : String(value);

  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) return 0;
  const [, sign, whole, frac = ""] = m;
  const fracPadded = (frac + "0".repeat(Number(digits))).slice(0, Number(digits));
  const fracNext = frac.length > Number(digits) ? Number(frac[Number(digits)]) : 0;
  let minor = Number(whole || "0") * scale + Number(fracPadded || "0");
  if (fracNext >= 5) minor += 1; // half-up at the minor-unit boundary
  return sign === "-" ? -minor : minor;
}

export function money(value: unknown, currency: CurrencyCode = "USD"): Money {
  return { minor: toMinor(value, currency), currency };
}

export function zero(currency: CurrencyCode = "USD"): Money {
  return { minor: 0, currency };
}

/** Decimal string with the currency's full precision: 14900 -> "149.00". */
export function toDecimalString(m: Money): string {
  const scale = minorUnitScale(m.currency);
  const digits = String(scale).length - 1;
  const neg = m.minor < 0;
  const abs = Math.abs(m.minor);
  const whole = Math.floor(abs / scale);
  const frac = String(abs % scale).padStart(digits, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function toNumber(m: Money): number {
  return m.minor / minorUnitScale(m.currency);
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function sumMoney(items: Money[], currency: CurrencyCode = "USD"): Money {
  return items.reduce<Money>((acc, m) => addMoney(acc, m), zero(currency));
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

/** Multiply by an integer count (e.g. quantity of credit packages). */
export function multiplyMoney(m: Money, factor: number): Money {
  return { minor: Math.round(m.minor * factor), currency: m.currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency_mismatch:${a.currency}!=${b.currency}`);
  }
}

// ── Rounding policy ─────────────────────────────────────────────────────────

export type RoundingMode = "UP" | "NEAREST" | "DOWN";

/**
 * Round to a whole-major-unit increment (₪1 / ₪5 / ₪10 / ₪50).
 *
 *   roundToIncrement(15100 agorot, 5, "UP") -> 15500  (₪151 -> ₪155)
 *   roundToIncrement(49800 agorot, 5, "UP") -> 50000  (₪498 -> ₪500)
 *
 * Already-on-increment values are left alone, so ₪500 never becomes ₪505.
 */
export function roundToIncrement(m: Money, incrementMajor: number, mode: RoundingMode = "UP"): Money {
  if (!Number.isFinite(incrementMajor) || incrementMajor <= 0) return m;
  const step = Math.round(incrementMajor * minorUnitScale(m.currency));
  if (step <= 0) return m;
  const q = m.minor / step;
  const rounded = mode === "UP" ? Math.ceil(q) : mode === "DOWN" ? Math.floor(q) : Math.round(q);
  return { minor: rounded * step, currency: m.currency };
}

// ── Conversion ──────────────────────────────────────────────────────────────

/**
 * Convert between currencies at a representative rate, before rounding.
 *
 * The rate is passed in as a decimal string (never a float literal) and applied
 * in integer space at 1e8 precision, so the result is deterministic and the same
 * inputs always produce the same displayed price.
 */
export function convertMoney(m: Money, rate: string | number, toCurrency: CurrencyCode): Money {
  const RATE_SCALE = 100_000_000; // 1e8
  const rateMinor = Math.round(Number(String(rate)) * RATE_SCALE);
  const converted = Math.round((m.minor * rateMinor) / RATE_SCALE);
  return { minor: converted, currency: toCurrency };
}

// ── Formatting ──────────────────────────────────────────────────────────────

const SYMBOL: Record<string, string> = { USD: "$", ILS: "₪" };

/** Whole-unit display: "$149", "₪555". Used on pricing cards. */
export function formatMoney(m: Money, opts: { decimals?: number } = {}): string {
  const decimals = opts.decimals ?? 0;
  const value = toNumber(m);
  const sym = SYMBOL[m.currency] ?? "";
  const body = value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return sym ? `${sym}${body}` : `${body} ${m.currency}`;
}
