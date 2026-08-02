import { permanentRedirect } from "next/navigation";

/**
 * /terms is kept as a permanent redirect rather than deleted.
 *
 * This route used to serve a hand-maintained copy of the terms that had drifted
 * badly from docs/legal: a different effective date, materially different
 * liability terms, and unfilled "[Company Name]" / "[Registered Address]"
 * placeholders sitting on a live public page. Two copies of a contract is one
 * copy too many, so the document now has exactly one home, generated from the
 * markdown that is actually maintained.
 *
 * The URL survives because it is referenced externally, including from platform
 * app reviews and the marketing site, and those references must not break. 308
 * so that search engines move to the canonical URL.
 */
export default function TermsRedirect(): never {
  permanentRedirect("/legal/terms-of-service");
}
