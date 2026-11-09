import 'server-only';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { accountSecuritySchema, type AccountSecurity } from '@/api/contracts/mfa';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Console · Security: the signed-in admin's own factors (legacy account
 * page's `getAccountSecurity`). `null` is unread; `available: false` is the
 * route saying it could not ask the identity provider. Neither is "not set up".
 */
export async function loadMySecurity(): Promise<AccountSecurity | null> {
  try {
    return await serverApi().get({
      endpoint: securityEndpoints.accountSecurity(),
      payload: accountSecuritySchema,
    });
  } catch (cause) {
    logger.warn('console.security_unread', {
      status: isApiError(cause) ? cause.status : undefined,
    });
    return null;
  }
}
