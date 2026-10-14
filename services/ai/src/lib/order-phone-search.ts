/**
 * What to put in Woo's order search to find a phone however the store saved
 * it (2026-10-14: guest orders saved "0545680665" were not found by
 * "+972545680665"). Woo's search is a substring match, so:
 *   - the last 9 digits match 0545680665, +972545680665 and 972545680665
 *   - "54-568-0665" matches 054-568-0665 and +972 54-568-0665
 *   - "54 568 0665" matches the same written with spaces
 * The results are re-checked exactly by the caller (the ownership guard on
 * the customer channel), so a looser search never widens what is shown.
 */
export function orderPhoneSearchTerms(phone: unknown): string[] {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (d.length < 9) return [];
  const last9 = d.slice(-9);
  const out = [last9];
  if (/^5\d{8}$/.test(last9)) out.push(`${last9.slice(0, 2)}-${last9.slice(2, 5)}-${last9.slice(5)}`, `${last9.slice(0, 2)} ${last9.slice(2, 5)} ${last9.slice(5)}`);
  return out;
}
