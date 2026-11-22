import 'server-only';

import { signInRecordSchema, type SignInRecord } from '@/api/contracts/google-sign-in';
import { securityEndpoints } from '@/api/endpoints/registry';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';

import { clientForwarding } from './client-forwarding';
import { HttpClient } from './http-client';

/** Short: it runs between the provider's redirect and the person's first page. */
export const SIGN_IN_RECORD_TIMEOUT_MS = 1500;

/**
 * `POST /api/account/security/sign-in`, called by our OIDC callback right
 * after the code exchange with the NEW access token (Google sign-in,
 * Backend ff3a1b9f). It writes the sign-in audit line with its method,
 * retires the person's invitation links, and answers the connect marker and
 * whether the Terms are owed.
 *
 * ★ BEST EFFORT, NEVER THE SIGN-IN'S FAILURE: any error, timeout or odd body
 *   is `null`, and the callback carries on with no marker.
 * ★ Bearer alone (Backend): no tenant header - a wrong one is a 403 and the
 *   answer is lost. And not `serverApi()`: that reads the session cookie this
 *   request does not have yet, and a legacy platform cookie would send
 *   somebody else's identity.
 */
export async function recordSignIn(
  accessToken: string,
  connectSubject: string | null,
  incoming: { get(name: string): string | null },
): Promise<SignInRecord | null> {
  const env = serverEnv();
  const client = new HttpClient({
    baseUrl: env.API_BASE_URL,
    defaultTimeoutMs: SIGN_IN_RECORD_TIMEOUT_MS,
    fetchOptions: { cache: 'no-store' },
  });
  try {
    return await client.post({
      endpoint: securityEndpoints.signInRecord(),
      payload: signInRecordSchema,
      body: connectSubject ? { connectSubject } : {},
      headers: { ...clientForwarding(incoming, env), authorization: `Bearer ${accessToken}` },
      raw: true,
    });
  } catch (cause) {
    logger.warn('auth.callback.sign_in_record_failed', { cause });
    return null;
  }
}
