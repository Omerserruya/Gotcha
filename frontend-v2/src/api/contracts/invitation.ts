import { z } from 'zod';

/**
 * An invitation to a workspace, read and accepted without a session - the
 * `/join?token=` link (services/auth onboarding.ts:2977 builds it).
 *
 * Both routes are on the auth service's public router (`/api/public/onboarding`,
 * index.ts:83), which identifies the tenant by the token and reads no bearer.
 *
 *   GET  /invite/:token   onboarding.ts:2989  `{ data: { tenant, email, role,
 *                         requiresPassword } }`; 404 `invite_invalid_or_expired`
 *                         for an unknown, used OR expired token - one answer
 *                         for all three, so the screen cannot tell them apart
 *   POST /invite/accept   onboarding.ts:3023  `{ token, name, email? }` →
 *                         `{ data: { ok, tenantId, setupLink } }`. `setupLink`
 *                         is null when the person already has a password
 *                         (another workspace's member): they sign in instead.
 */
export const invitationSchema = z.object({
  tenant: z.object({ name: z.string() }),
  /** Fixed by the inviter, or null: an open link, where the person types it. */
  email: z.string().nullable().catch(null).default(null),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const acceptedInvitationSchema = z.object({
  /** Where the person sets their password - Authentik, via our redeem route. */
  setupLink: z.string().nullable().catch(null).default(null),
});

/** Refusals the accept route names (onboarding.ts:3030-3061). */
export const INVITE_INVALID = 'invite_invalid_or_expired';
export const EMAIL_REQUIRED = 'email_required';
export const EMAIL_ALREADY_IN_TENANT = 'email_already_in_tenant';
