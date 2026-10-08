/**
 * 11e's time zone, as 02 writes it: the city and its offset in front
 * ("London (GMT+1)"), the IANA name behind ("Europe/London").
 *
 * The offset is the one in force today, from `Intl` - so it moves with
 * daylight saving, as a person reads it, and nothing here keeps a table.
 *
 * ★ IN HEBREW, THE ZONE'S HEBREW NAME - never the IANA city in English (the
 *   14" sweep read "London GMT" on a Hebrew page). `Intl`'s long generic name
 *   is "שעון בריטניה", "שעון ישראל"; English keeps 02's city.
 */

/**
 * The zone the platform uses when a workspace has stored none - the server's
 * own default (Backend, 2026-10-08), shown as the default, never saved for it.
 */
export const SERVER_DEFAULT_ZONE = 'Asia/Jerusalem';

export interface Zone {
  readonly iana: string;
  readonly label: string;
}

const partOf = (iana: string, locale: string, at: Date, style: 'shortOffset' | 'longGeneric') =>
  new Intl.DateTimeFormat(locale, { timeZone: iana, timeZoneName: style })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';

const cityOf = (iana: string) => (iana.split('/').pop() ?? iana).replaceAll('_', ' ');

export function zoneLabel(iana: string, locale: string, at: Date = new Date()): string {
  try {
    const offset = partOf(iana, locale, at, 'shortOffset');
    const name =
      locale === 'en' ? cityOf(iana) : partOf(iana, locale, at, 'longGeneric') || cityOf(iana);
    return offset && offset !== name ? `${name} (${offset})` : name;
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
  const labelled = zones.map((iana) => ({ iana, label: zoneLabel(iana, locale, at) }));
  /*
   * Many zones share one Hebrew name ("שעון מרכז אירופה" is Paris, Berlin,
   * Rome…), and a picker of identical options cannot be chosen from: a
   * shared name carries its city too, so each option is one zone.
   */
  const count = new Map<string, number>();
  for (const z of labelled) count.set(z.label, (count.get(z.label) ?? 0) + 1);
  return labelled.map((z) =>
    (count.get(z.label) ?? 0) > 1 ? { ...z, label: `${z.label} · ${cityOf(z.iana)}` } : z,
  );
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
