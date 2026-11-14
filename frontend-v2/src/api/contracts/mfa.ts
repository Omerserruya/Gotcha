import { z } from 'zod';

/**
 * Two-factor enrolment: the legacy gate's two reads (auth `routes/account.ts`).
 *
 * `GET /api/account/mfa-gate` - is this person required to have MFA, and have
 * they enrolled? Enrolled is BOTH an authenticator and recovery codes
 * (`isEnrolledWithRecovery`); `mustEnroll` is the server's own conclusion and
 * the only field the gate acts on. When the identity provider is unreachable
 * the route falls back to its stored stamp, so a transient blip never sends
 * an enrolled person back through setup.
 */
export const MFA_REASONS = ['system_admin', 'tenant_admins', 'all_users'] as const;
export type MfaReason = (typeof MFA_REASONS)[number];

export const mfaGateSchema = z.object({
  required: z.boolean(),
  reason: z.enum(MFA_REASONS).nullable().catch(null),
  enrolled: z.boolean(),
  hasAuthenticator: z.boolean(),
  hasRecovery: z.boolean(),
  mustEnroll: z.boolean(),
  identityAvailable: z.boolean().catch(false),
});
export type MfaGate = z.infer<typeof mfaGateSchema>;

const device = z.looseObject({
  id: z.coerce.string(),
  name: z.string().nullable().catch(null).default(null),
  createdAt: z.string().nullable().catch(null).default(null),
});
export type MfaDevice = z.infer<typeof device>;

/**
 * `GET /api/account/security` - the caller's own factors. `available: false`
 * when there is no identity or the provider is unreachable: then nothing is
 * known, and the page says so rather than "not set up".
 */
export const accountSecuritySchema = z.looseObject({
  available: z.boolean(),
  totp: z.array(device).catch([]).default([]),
  passkeys: z.array(device).catch([]).default([]),
  recoveryCodes: z.array(device).catch([]).default([]),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

/**
 * Authentik's own enrolment flows (bound in scripts/authentik/bootstrap.mjs),
 * framed from the identity provider's origin exactly as the legacy gate does.
 */
export const MFA_FLOWS = {
  totp: 'default-authenticator-totp-setup',
  recoveryCodes: 'default-authenticator-static-setup',
} as const;
export type MfaFlow = keyof typeof MFA_FLOWS;

/**
 * A flow's address on the identity provider. `next` MUST be relative to that
 * host: Authentik refuses an absolute one with "Request has been denied.
 * Invalid next URL". The authenticator step chains straight into recovery
 * codes this way; the last step has no next, and the gate's poll releases.
 */
export function mfaFlowUrl(
  authOrigin: string,
  flow: MfaFlow,
  nonce = 0,
  /** The gate chains the authenticator into recovery codes; a single change does not. */
  chain = true,
): string {
  const base = `${authOrigin}/if/flow/${MFA_FLOWS[flow]}/`;
  const next = chain && flow === 'totp' ? `/if/flow/${MFA_FLOWS.recoveryCodes}/` : null;
  const query = new URLSearchParams();
  if (next) query.set('next', next);
  query.set('_n', String(nonce));
  return `${base}?${query.toString()}`;
}

/** The platform's refusal while enrolment is owed (Backend, after B3). */
export const MFA_REQUIRED_ERROR = 'mfa_enrollment_required';
