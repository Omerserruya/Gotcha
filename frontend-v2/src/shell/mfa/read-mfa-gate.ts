import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { mfaGateSchema, type MfaGate } from '@/api/contracts/mfa';
import { securityEndpoints } from '@/api/endpoints/registry';
import { serverEnv } from '@/config/env.server';
import { logger } from '@/observability/logger';

/**
 * The MFA gate's read, the legacy `MfaEnrollmentGate`'s `getMfaGate`.
 *
 * `null` is "not read". The layouts then draw the product, as the legacy
 * gate did on a first-read failure: the platform is the authority, and its
 * own `403 mfa_enrollment_required` (Backend, after B3) refuses every read
 * while enrolment is owed. A read that never answers must not lock out a
 * person who has enrolled.
 */
export async function readMfaGate(): Promise<MfaGate | null> {
  try {
    return await serverApi().get({ endpoint: securityEndpoints.mfaGate(), payload: mfaGateSchema });
  } catch (cause) {
    logger.warn('mfa.gate_unread', { status: isApiError(cause) ? cause.status : undefined });
    return null;
  }
}

/**
 * Where the identity provider's own pages are served (the OIDC issuer's
 * origin). The enrolment flows are framed from there, and the proxy's
 * `frame-src` names the same origin.
 */
export function authOrigin(): string {
  return new URL(serverEnv().OIDC_ISSUER).origin;
}
