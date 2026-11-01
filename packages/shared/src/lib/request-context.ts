/**
 * Per-request facts that writeAudit needs without every caller passing them:
 * set once by authenticate() for the rest of the request.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Set when the request runs in support mode (support_sessions.id). */
  supportSessionId?: string;
  /** The SYSTEM_ADMIN's own membership id, in the System tenant. */
  supportAdminUserId?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return store.getStore();
}
