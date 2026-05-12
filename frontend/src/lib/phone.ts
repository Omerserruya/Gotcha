import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";
import { getTenantSettings } from "./api";

let cachedDefaultCountry: string | null = null;
let inflight: Promise<string> | null = null;

export function getDefaultCountrySync(): string {
  return cachedDefaultCountry || "IL";
}

export async function ensureDefaultCountry(token: string | null | undefined): Promise<string> {
  if (cachedDefaultCountry) return cachedDefaultCountry;
  if (!token) return "IL";
  if (inflight) return inflight;
  inflight = getTenantSettings(token)
    .then((res) => {
      cachedDefaultCountry = res.data?.defaultCountryCode || "IL";
      return cachedDefaultCountry;
    })
    .catch(() => "IL")
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function normalizeE164(input: string | null | undefined, defaultCountry?: string): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  const country = ((defaultCountry || cachedDefaultCountry || "IL").toUpperCase()) as CountryCode;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, country);
    if (parsed && parsed.isValid()) return parsed.number;
  } catch {
    // fall through
  }
  return null;
}
