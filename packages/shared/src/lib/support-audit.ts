/**
 * Support mode across services: attribution only (Omer, 2026-11-01: every
 * change made in support mode is logged under the admin).
 *
 * A route the admin calls runs with the support context (authenticate()).
 * When that service then calls another service with the internal key, the
 * second service would otherwise write its audit rows as "system". So:
 *   - outgoing: any fetch that carries the internal key, made while a support
 *     context is active, also carries `x-support-audit: <supportSessionId>`;
 *   - incoming: that header is read ONLY together with a valid internal key,
 *     and only after the support session is found (for the named tenant when
 *     one is named). It sets the audit context and nothing else - the caller
 *     keeps exactly the internal principal it already had.
 */
import { prisma } from "./prisma";
import { currentRequestContext, type RequestContext } from "./request-context";

export const SUPPORT_AUDIT_HEADER = "x-support-audit";

function internalSecrets(): string[] {
  return [process.env.INTERNAL_SERVICE_KEY, process.env.INTERNAL_SERVICE_TOKEN].filter((v): v is string => !!v);
}

/** True when these outgoing headers carry the internal key (Bearer or X-Internal-Key). */
export function carriesInternalKey(headers: Headers): boolean {
  const secrets = internalSecrets();
  if (!secrets.length) return false;
  const bearer = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const key = headers.get("x-internal-key") ?? "";
  return secrets.some((s) => s === bearer || s === key);
}

let installed = false;

/** Wrap global fetch once so internal calls made in support mode carry the session. */
export function installSupportAuditPropagation(): void {
  if (installed || typeof globalThis.fetch !== "function") return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: any, init?: any) => {
    const ctx = currentRequestContext();
    if (!ctx?.supportSessionId) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!carriesInternalKey(headers) || headers.has(SUPPORT_AUDIT_HEADER)) return original(input, init);
    headers.set(SUPPORT_AUDIT_HEADER, ctx.supportSessionId);
    return original(input, { ...(init ?? {}), headers });
  }) as typeof fetch;
}

/** Test-only. */
export function __resetSupportAuditPropagation(): void {
  installed = false;
}

/**
 * The audit context an INTERNAL request asks for, or null. Callers must have
 * verified the internal key already; this never grants anything.
 */
export async function supportAuditContextOf(
  headerValue: unknown,
  tenantId?: string | null,
): Promise<RequestContext | null> {
  if (typeof headerValue !== "string" || !headerValue || headerValue.length > 64) return null;
  const s = await (prisma as any).supportSession
    .findUnique({ where: { id: headerValue }, select: { id: true, tenantId: true, adminUserId: true } })
    .catch(() => null);
  if (!s) return null;
  if (tenantId && s.tenantId !== tenantId) return null;
  return { supportSessionId: s.id, supportAdminUserId: s.adminUserId };
}
