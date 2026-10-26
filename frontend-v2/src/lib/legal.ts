/**
 * Terms and privacy, off the app (it no longer serves /legal).
 *
 * 00d's consent line links the marketing site (landing's legal-registry).
 * The first-password checkbox links the trust site, by locale - Backend's
 * `legalUrls(locale)`, the same documents the consent record names (each a
 * 200 with no redirect, supervisor 2026-10-26).
 */
export const LEGAL_SITE = 'https://gotcha.co.il/legal';

export const TERMS_URL = `${LEGAL_SITE}/terms-of-service`;
export const PRIVACY_URL = `${LEGAL_SITE}/privacy-policy`;

const TRUST_SITE = 'https://trust.gotcha.co.il';

/** Hebrew under /he; English at the root. */
export function legalUrls(locale: string): { readonly terms: string; readonly privacy: string } {
  const base = locale === 'he' ? `${TRUST_SITE}/he` : TRUST_SITE;
  return { terms: `${base}/terms-of-service`, privacy: `${base}/privacy-policy` };
}
