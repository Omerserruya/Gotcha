/**
 * Why a setup link could not be redeemed - the `?reason=` services/auth
 * puts on the redirect (setup-link.ts:39 `expiredPage`): `resolveSetupLink`'s
 * invalid | expired | revoked (`SetupLinkRejection`, :130), `identity_missing`
 * (:145) and `idp_unavailable` (:164).
 */
export const SETUP_LINK_REASONS = [
  'expired',
  'revoked',
  'invalid',
  'identity_missing',
  'idp_unavailable',
] as const;
export type SetupLinkReason = (typeof SETUP_LINK_REASONS)[number];

/**
 * A reason this screen does not know - or none - reads as `expired`, as it
 * did in the legacy page: the commonest case, and its advice (ask for a new
 * link) is the safe one.
 */
export function setupLinkReason(raw: unknown): SetupLinkReason {
  return SETUP_LINK_REASONS.find((reason) => reason === raw) ?? 'expired';
}
