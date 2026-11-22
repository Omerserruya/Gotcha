/**
 * The acceptance of the Terms and the Privacy Policy, as it is written down.
 *
 * Always two rows, written together: one per document, each naming the
 * document's address and version, because "accepted the Terms" is only
 * evidence when it says which Terms. Every screen that records an acceptance
 * builds its rows here, so the rows of one screen cannot drift from another's.
 * What differs between screens is `source` and the evidence around it.
 */
import { legalUrls, LEGAL_VERSIONS } from "@chatcenter/shared";

export const TERMS_PURPOSE = "terms_of_service";
export const PRIVACY_PURPOSE = "privacy_policy";

/** The screen an acceptance was given on. */
export type TermsConsentSource =
  /** The first-password screen behind a setup link. */
  | "setup"
  /** The screen shown before first entry to a person who came in with Google. */
  | "google_first_sign_in"
  /** The public sign-up form, before any account exists. */
  | "self_signup";

export interface Acceptance {
  locale: "he" | "en";
  /** The words the person saw next to the boxes, as the screen sent them. */
  capturedText: string | null;
}

/**
 * What the screen sent, read strictly: both boxes must be exactly `true`.
 * Null when either is anything else, so a missing or a loosely typed box
 * ("true", 1) is never an acceptance.
 */
export function acceptanceOf(body: unknown): Acceptance | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.terms !== true || b.privacy !== true) return null;
  return {
    locale: typeof b.locale === "string" && b.locale.toLowerCase().startsWith("he") ? "he" : "en",
    capturedText: typeof b.capturedText === "string" ? b.capturedText.trim().slice(0, 1000) : null,
  };
}

/** The two rows of one acceptance, ready for `consentRecord.create`. */
export function termsConsentRows(a: {
  tenantId: string;
  userId: string;
  source: TermsConsentSource;
  locale: "he" | "en";
  evidence: Record<string, unknown>;
}) {
  const urls = legalUrls(a.locale);
  return [
    { purpose: TERMS_PURPOSE, document: { url: urls.terms, version: LEGAL_VERSIONS.terms } },
    { purpose: PRIVACY_PURPOSE, document: { url: urls.privacy, version: LEGAL_VERSIONS.privacy } },
  ].map((r) => ({
    tenantId: a.tenantId,
    subjectType: "user",
    subjectId: a.userId,
    purpose: r.purpose,
    granted: true,
    source: a.source,
    evidence: { ...a.evidence, document: r.document },
  }));
}
