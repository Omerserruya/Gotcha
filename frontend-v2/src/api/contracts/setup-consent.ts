import { z } from 'zod';

/**
 * `POST /api/auth/setup/:token/accept` (services/auth setup-link.ts, Backend
 * 2026-10-26): the Terms of Service and the Privacy Policy, accepted before a
 * first password. The server records both and only then mints the provider's
 * flow token - without the acceptance there is no token, and so no password.
 *
 *   200 { data: { status: 'recovery', flow, flowToken } }   recorded; the flow opens on the prompt
 *   200 { data: { status: 'already_has_password', next } }  nothing to set
 *   200 { data: { status: 'expired', reason } }             invalid | expired | revoked | identity_missing
 *   400 { error: 'consent_required' }                       terms or privacy not true
 *   503 { error: 'idp_unavailable' }
 *
 * ★ `next` is not read: the sign-in this screen offers is its own href, so the
 *   answer cannot send the browser anywhere.
 */
export const setupAcceptSchema = z.object({
  data: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('recovery'),
      flow: z.string().min(1),
      flowToken: z.string().min(1),
    }),
    z.object({ status: z.literal('already_has_password') }),
    z.object({ status: z.literal('expired') }),
  ]),
});

export type SetupAcceptBody = {
  readonly terms: true;
  readonly privacy: true;
  readonly locale: 'he' | 'en';
  /** The checkbox's label exactly as it was shown, for the record's evidence. */
  readonly capturedText: string;
};

export type SetupAcceptOutcome =
  | { readonly kind: 'recovery'; readonly flow: string; readonly flowToken: string }
  | { readonly kind: 'hasPassword' }
  | { readonly kind: 'expired' }
  /** Answered, and not one of the above: a refusal this screen cannot fix. */
  | { readonly kind: 'refused' }
  /** Not answered (network, 5xx): the person can press Continue again. */
  | { readonly kind: 'unreachable' };

export function readSetupAccept(status: number, body: unknown): SetupAcceptOutcome {
  // A rate limit passes; pressing Continue again later is the right advice.
  if (status >= 500 || status === 429) return { kind: 'unreachable' };
  if (status !== 200) return { kind: 'refused' };
  const parsed = setupAcceptSchema.safeParse(body);
  if (!parsed.success) return { kind: 'refused' };
  const data = parsed.data.data;
  if (data.status === 'recovery') {
    return { kind: 'recovery', flow: data.flow, flowToken: data.flowToken };
  }
  return { kind: data.status === 'expired' ? 'expired' : 'hasPassword' };
}
