import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  auditFacetsSchema,
  auditPageSchema,
  loginHistoryResponseSchema,
  sessionsResponseSchema,
  tenantSecuritySchema,
  type AuditEntry,
  type AuditFacet,
  type LoginEvent,
  type SecuritySession,
  type TenantSecurity,
} from '@/api/contracts/security';
import { securityEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

import { captureFixturesEnabled, FIXTURE_LOGINS, FIXTURE_SESSIONS } from './capture-fixtures';

/**
 * What screen 16 shows.
 *
 * Four reads, all degrading independently — on a security screen more than
 * anywhere, one section failing must not blank the others, because the reader
 * came to check something specific and the rest is still true.
 *
 * Every "we could not find out" is kept distinct from "there is nothing".
 * Sessions and login history get that for free: the backend answers
 * `{ available: false }` rather than an empty list. The audit log is given the
 * same shape by hand, because it is the section where the difference matters
 * most — *"nothing happened"* is reassuring and *"we cannot read the log"* is
 * not, and they must never look alike.
 *
 * **Nothing here logs an IP, a city or a user agent.** A failure is logged by
 * its cause, which carries a status and a route. The screen renders those
 * details because they are the reader's own and they are what makes an
 * unfamiliar session recognisable; telemetry has no use for them.
 */
export interface SecurityData {
  readonly sessions: readonly SecuritySession[];
  readonly sessionsAvailable: boolean;
  readonly logins: readonly LoginEvent[];
  readonly loginsAvailable: boolean;
  readonly tenant: TenantSecurity | null;
  readonly audit: readonly AuditEntry[];
  /** False when the audit route could not be read. Never means "empty". */
  readonly auditAvailable: boolean;
  /** The real action vocabulary with counts, for navigating the log. */
  readonly facets: readonly AuditFacet[];
  /** True = more actions exist than were returned, verified by the backend. */
  readonly facetsTruncated: boolean;
}

export async function loadSecurity(): Promise<SecurityData> {
  const api = serverApi();

  const [sessions, logins, tenant, audit, facets] = await Promise.all([
    api
      .get({ endpoint: securityEndpoints.sessions(), payload: sessionsResponseSchema, raw: true })
      .catch((cause: unknown) => {
        logger.warn('security.sessions_failed', { cause });
        return null;
      }),
    api
      .get({
        endpoint: securityEndpoints.loginHistory(),
        payload: loginHistoryResponseSchema,
        raw: true,
      })
      .catch((cause: unknown) => {
        logger.warn('security.login_history_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: securityEndpoints.tenantSecurity(), payload: tenantSecuritySchema })
      .catch((cause: unknown) => {
        logger.warn('security.tenant_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: securityEndpoints.auditLogs(), payload: auditPageSchema, raw: true })
      .catch((cause: unknown) => {
        logger.warn('security.audit_failed', { cause });
        return null;
      }),
    api
      .get({ endpoint: securityEndpoints.auditActions(), payload: auditFacetsSchema, raw: true })
      .catch((cause: unknown) => {
        // The facet is navigation, not content. Losing it costs the reader a
        // shortcut; it must not take the log down with it.
        logger.warn('security.audit_facets_failed', { cause });
        return null;
      }),
  ]);

  /*
   * Capture only, and only outside production — see `capture-fixtures.ts`.
   * This screen renders a real IP and a real city, and acceptance screenshots
   * are committed. Everything else on the page still reads live.
   */
  const fixtures = captureFixturesEnabled();

  return {
    sessions: fixtures ? FIXTURE_SESSIONS : (sessions?.sessions ?? []),
    sessionsAvailable: fixtures ? true : (sessions?.available ?? false),
    logins: fixtures ? FIXTURE_LOGINS : (logins?.events ?? []),
    loginsAvailable: fixtures ? true : (logins?.available ?? false),
    tenant,
    audit: audit?.data ?? [],
    auditAvailable: audit != null,
    facets: facets?.data ?? [],
    facetsTruncated: facets?.truncated ?? false,
  };
}
