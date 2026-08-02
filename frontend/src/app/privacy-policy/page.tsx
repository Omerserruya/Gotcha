import { permanentRedirect } from "next/navigation";

/**
 * /privacy-policy is kept as a permanent redirect rather than deleted.
 *
 * Same reason as /terms: this route served a stale hand-maintained copy with
 * "[Company Name]" placeholders and a February effective date, while the
 * maintained policy lives in docs/legal. This URL in particular is registered
 * with Meta as the privacy policy and data deletion instructions URL, so it must
 * keep resolving. The deletion instructions the old page carried now live in
 * section 11 of the policy itself.
 */
export default function PrivacyPolicyRedirect(): never {
  permanentRedirect("/legal/privacy-policy");
}
