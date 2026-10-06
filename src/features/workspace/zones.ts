/**
 * 11e's time zone, as 02 writes it: the city and its offset in front
 * ("London (GMT+1)"), the IANA name behind ("Europe/London").
 *
 * The offset is the one in force today, from `Intl` - so it moves with
 * daylight saving, as a person reads it, and nothing here keeps a table.
 */

export interface Zone {
  readonly iana: string;
  readonly label: string;
}

export function zoneLabel(iana: string, locale: string, at: Date = new Date()): string {
  const city = (iana.split('/').pop() ?? iana).replaceAll('_', ' ');
  try {
    const offset =
      new Intl.DateTimeFormat(locale, { timeZone: iana, timeZoneName: 'shortOffset' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? '';
    return offset ? `${city} (${offset})` : city;
  } catch {
    return iana;
  }
}

export function zoneOptions(locale: string, at: Date = new Date()): readonly Zone[] {
  let zones: readonly string[] = [];
  try {
    zones = Intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  return zones.map((iana) => ({ iana, label: zoneLabel(iana, locale, at) }));
}

/**
 * What was typed, back to IANA: a label from the list, or an IANA name typed
 * as is - the server stores a string, and a zone this browser does not list
 * must still be savable. Anything else is null, and is not sent.
 */
export function zoneFromInput(text: string, options: readonly Zone[]): string | null {
  const v = text.trim();
  if (!v) return null;
  const byLabel = options.find((z) => z.label === v);
  if (byLabel) return byLabel.iana;
  if (/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(v) || v === 'UTC') return v;
  return null;
}

/** 02's currency option: the symbol, then the code - "₪ ILS". */
export function currencyLabel(code: string, locale: string): string {
  try {
    const symbol =
      new Intl.NumberFormat(locale, { style: 'currency', currency: code })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? '';
    return symbol && symbol !== code ? `${symbol} ${code}` : code;
  } catch {
    return code;
  }
}

/** Offered first; the stored one is added when it is not here. */
export const COMMON_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP'] as const;
