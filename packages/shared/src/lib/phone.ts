import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";

/**
 * Normalize a phone number to E.164 ("+972501234567"). Handles the
 * common ways operators store numbers in CRMs:
 *   - already E.164 → returned unchanged
 *   - Israeli local form ("0501234567") → "+972501234567"
 *   - "00972..." (international prefix) → "+972..."
 *   - bare digits with no leading 0 → prepended with the default country
 *
 * Returns the original `raw` value when libphonenumber can't parse it
 * (so callers don't silently drop unknown formats - the broadcast worker
 * will surface the failure when the carrier rejects it).
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry: string = "IL"): string {
  if (!raw || typeof raw !== "string") return raw ?? "";
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const country = (defaultCountry || "IL").toUpperCase() as CountryCode;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, country);
    if (parsed && parsed.isValid()) return parsed.number;
  } catch {
    // fall through to raw return
  }
  return trimmed;
}

/**
 * True when `raw` parses to a valid E.164 number under the given default
 * country. Useful for surface-level UI hints ("this looks bare - we'll
 * prepend +972 at send time").
 */
export function isValidPhone(raw: string | null | undefined, defaultCountry: string = "IL"): boolean {
  if (!raw || typeof raw !== "string") return false;
  const country = (defaultCountry || "IL").toUpperCase() as CountryCode;
  try {
    const parsed = parsePhoneNumberFromString(raw.trim(), country);
    return !!parsed?.isValid();
  } catch {
    return false;
  }
}

/**
 * Returns the catalogue of supported country codes paired with their
 * dial-code, for the settings dropdown. Sorted by country code (alpha).
 */
export function listSupportedCountries(): Array<{ code: string; callingCode: string }> {
  return getCountries()
    .map((code) => ({ code, callingCode: getCountryCallingCode(code) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
