/**
 * Active-tenant plumbing for the multi-tenant identity model.
 *
 * One Authentik identity can hold memberships in many tenants. The backend
 * resolves which membership a request acts as from the `X-Tenant-Id` header
 * (validated server-side against the caller's memberships - the header is a
 * HINT, never an authorization). This module owns:
 *
 *   - the persisted "which tenant am I working in" selection, and
 *   - a single fetch-level interceptor that stamps the header onto EVERY
 *     same-origin /api call, so the ~30 scattered fetch sites in this app
 *     need no per-call changes and can never forget the header.
 *
 * The interceptor also self-heals a stale selection: if the server answers
 * 403 `tenant_denied` (membership revoked, tenant deleted), the stored id is
 * dropped and the app reloads into the identity's default tenant.
 */

const ACTIVE_TENANT_KEY = "activeTenantId";

export function getActiveTenantId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_TENANT_KEY);
  } catch {
    return null;
  }
}

export function setActiveTenantId(tenantId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (tenantId) window.localStorage.setItem(ACTIVE_TENANT_KEY, tenantId);
    else window.localStorage.removeItem(ACTIVE_TENANT_KEY);
  } catch {
    /* storage unavailable - header just won't be sent */
  }
}

/** Is this request URL one of OUR api endpoints (same-origin or API_URL)? */
function isApiRequest(url: string): boolean {
  if (url.startsWith("/api/")) return true;
  try {
    const base = process.env.NEXT_PUBLIC_API_URL || window.location.origin;
    const u = new URL(url, window.location.origin);
    const b = new URL(base, window.location.origin);
    return u.origin === b.origin && u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

let installed = false;

/**
 * Patch window.fetch once so every /api request carries the active tenant.
 * Idempotent; a no-op during SSR. Installed from AuthContext at module load,
 * before any authenticated call can fire.
 */
export function installTenantFetchInterceptor(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    const tenantId = getActiveTenantId();
    if (tenantId && isApiRequest(url)) {
      const headers = new Headers(
        init?.headers || (input instanceof Request ? input.headers : undefined),
      );
      if (!headers.has("X-Tenant-Id")) headers.set("X-Tenant-Id", tenantId);
      init = { ...init, headers };
    }

    const res = await original(input as any, init);

    // Self-heal a selection the server refuses (membership revoked / tenant
    // gone): drop it and reload into the identity's default tenant.
    if (res.status === 403 && tenantId && isApiRequest(url)) {
      try {
        const body = await res.clone().json();
        if (body?.code === "tenant_denied") {
          setActiveTenantId(null);
          window.location.reload();
        }
      } catch {
        /* non-JSON 403 - not ours to handle */
      }
    }
    return res;
  };
}
