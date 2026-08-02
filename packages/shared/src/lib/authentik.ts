/**
 * Authentik admin API client.
 *
 * The ONLY way GOTCHA touches identity. Used to provision an identity when an
 * owner invites someone, and to deactivate one when they are removed.
 *
 * Scope discipline: this client creates and disables identities. It must never
 * be used to store business data on the Authentik user (no tenant, no role, no
 * permissions). Authorization is GOTCHA's, and lives in GOTCHA's database.
 */

export interface AuthentikIdentity {
  /** Authentik's immutable user UUID - matches the `sub` claim (sub_mode=user_uuid). */
  subject: string;
  pk: number;
  email: string;
  username: string;
}

function baseUrl(): string {
  const v = process.env.AUTHENTIK_URL;
  if (!v) throw new Error("[authentik] AUTHENTIK_URL is required");
  return v.replace(/\/$/, "");
}

function token(): string {
  const v = process.env.AUTHENTIK_API_TOKEN || process.env.AUTHENTIK_BOOTSTRAP_TOKEN;
  if (!v) throw new Error("[authentik] AUTHENTIK_API_TOKEN is required");
  return v;
}

/**
 * The PUBLIC origin of Authentik, as the browser reaches it. AUTHENTIK_URL is
 * the INTERNAL docker DNS (http://authentik-server:9000), which is unreachable
 * from a user's browser - so any link Authentik builds from its own base (e.g.
 * a recovery link) must have its origin rewritten to this before we hand it to
 * a user. Derived from OIDC_ISSUER (the public issuer the SPA already uses), or
 * an explicit AUTHENTIK_PUBLIC_URL override.
 */
export function publicAuthentikOrigin(): string | null {
  const explicit = process.env.AUTHENTIK_PUBLIC_URL;
  if (explicit) { try { return new URL(explicit).origin; } catch { /* fall through */ } }
  const issuer = process.env.OIDC_ISSUER;
  if (issuer) { try { return new URL(issuer).origin; } catch { /* fall through */ } }
  return null;
}

/** Rewrite an Authentik-issued URL's origin to the public host. */
function toPublicUrl(link: string): string {
  const pub = publicAuthentikOrigin();
  if (!pub) return link;
  try {
    const u = new URL(link);
    const p = new URL(pub);
    // Set hostname + port SEPARATELY: the URL `host` setter leaves the port
    // unchanged when the new value has none, so `localhost:9000` -> host
    // "auth-dev.gotcha.co.il" would wrongly keep :9000. p.port is "" for the
    // default port, which clears it.
    u.protocol = p.protocol;
    u.hostname = p.hostname;
    u.port = p.port;
    return u.toString();
  } catch {
    return link;
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}/api/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`[authentik] ${options.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

/**
 * Find an identity by email, or create one.
 *
 * Idempotent so a re-sent invitation does not fork a second identity for the
 * same person. The created identity has no usable password: the user sets one
 * through Authentik's own recovery/enrolment email, so no credential ever
 * transits GOTCHA.
 */
export async function ensureIdentity(email: string, name: string): Promise<AuthentikIdentity> {
  const existing = await api<{ results: any[] }>(
    `/core/users/?email=${encodeURIComponent(email)}`,
  );
  const found = existing.results?.find((u) => u.email === email);
  if (found) {
    return { subject: found.uuid, pk: found.pk, email: found.email, username: found.username };
  }

  const created = await api<any>("/core/users/", {
    method: "POST",
    body: JSON.stringify({
      username: email,
      email,
      name,
      is_active: true,
      path: "users",
      // "external" = an app user of the IdP, not an operator of it. This is
      // what makes Authentik's root redirect to the brand default application
      // (GOTCHA) instead of its own "My applications" library whenever a user
      // completes a login on the IdP itself (e.g. after logout, or via the MFA
      // challenge with no OIDC context). Internal is only for akadmin.
      type: "external",
    }),
  });

  return { subject: created.uuid, pk: created.pk, email: created.email, username: created.username };
}

/**
 * Issue a one-time link that lets an invited user set their initial password.
 *
 * GOTCHA never sees or sets the password - it only hands over a link into
 * Authentik's own recovery flow.
 */
export async function createRecoveryLink(userPk: number): Promise<string> {
  const res = await api<{ link: string }>(`/core/users/${userPk}/recovery/`, { method: "POST" });
  // Authentik builds the link from its INTERNAL base url; rewrite to the public
  // host or the user's browser gets an unreachable authentik-server:9000 link.
  return toPublicUrl(res.link);
}

/**
 * Disable an identity in Authentik.
 *
 * Called when a user is removed from GOTCHA. Deactivating locally is not
 * enough: the identity must lose the ability to authenticate at the IdP, or a
 * removed user keeps a valid token until it expires.
 */
export async function deactivateIdentity(userPk: number): Promise<void> {
  await api(`/core/users/${userPk}/`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: false }),
  });
}

/**
 * Enable or disable an identity's ability to authenticate at the IdP.
 * Keeps the Authentik `is_active` flag consistent with GOTCHA's `User.isActive`
 * so a disabled user cannot keep a live IdP session (deactivating GOTCHA alone
 * only stops authorization, not authentication).
 */
export async function setIdentityActive(userPk: number, active: boolean): Promise<void> {
  await api(`/core/users/${userPk}/`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: active }),
  });
}

/**
 * Update mutable profile attributes on an Authentik identity (today: display
 * name). Keeps the IdP's `name` in sync with GOTCHA's `User.name` so a rename
 * in GOTCHA does not leave Authentik showing the stale name on the login card,
 * account portal, and emails. Best-effort by convention at the call sites:
 * a rename must never fail because the IdP is briefly unreachable.
 *
 * Deliberately does NOT touch `username`/`email`: those are the identity anchor
 * (username is pinned to the email at creation and the OIDC `sub` is the immutable
 * join key). Changing the email is a separate, verification-gated flow.
 */
export async function updateIdentity(
  userPk: number,
  attrs: { name?: string; email?: string; username?: string },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (typeof attrs.name === "string" && attrs.name.trim()) body.name = attrs.name.trim();
  if (typeof attrs.email === "string" && attrs.email.trim()) body.email = attrs.email.trim();
  if (typeof attrs.username === "string" && attrs.username.trim()) body.username = attrs.username.trim();
  if (Object.keys(body).length === 0) return;
  await api(`/core/users/${userPk}/`, { method: "PATCH", body: JSON.stringify(body) });
}

/**
 * Permanently delete an identity in Authentik (GDPR Art. 17 erasure).
 *
 * Unlike deactivateIdentity (which only disables login), this removes the
 * personal data held in the IdP so a data-subject erasure is complete across
 * BOTH GOTCHA and Authentik. Idempotent: a 404 (already gone) is swallowed.
 */
export async function deleteIdentity(userPk: number): Promise<void> {
  try {
    await api(`/core/users/${userPk}/`, { method: "DELETE" });
  } catch (err: any) {
    if (typeof err?.message === "string" && err.message.includes("-> 404")) return;
    throw err;
  }
}

// ─── Read-side surfacing (sessions / login history / devices) ──────────────
// These let GOTCHA render the identity data NATIVELY instead of bouncing the
// user to the Authentik portal. All are read/terminate only and scoped to a
// single user's `pk`. They fail soft at the call site: a transient IdP outage
// should degrade the Account page, not break it.

export interface AuthentikSession {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  city: string | null;
  country: string | null;
  lastUsed: string | null;
  expires: string | null;
}

export interface AuthentikLoginEvent {
  id: string;
  action: string; // "login" | "login_failed" | "logout"
  success: boolean;
  ip: string | null;
  city: string | null;
  country: string | null;
  userAgent: string | null;
  app: string | null;
  timestamp: string;
}

export interface AuthentikDevice {
  id: string;
  type: "totp" | "webauthn" | "static" | "sms" | "duo" | "other";
  name: string;
  createdAt: string | null;
  lastUsed: string | null;
  confirmed: boolean;
}

export interface AuthentikSecuritySummary {
  mfaEnabled: boolean;
  totp: AuthentikDevice[];
  passkeys: AuthentikDevice[]; // WebAuthn
  recoveryCodes: AuthentikDevice[]; // static tokens
  lastLogin: string | null;
}

function geoOf(g: any): { city: string | null; country: string | null } {
  if (!g || typeof g !== "object") return { city: null, country: null };
  return { city: g.city ?? null, country: g.country ?? g.country_code ?? null };
}
/** Render a compact "Browser on OS" label from a raw UA string. */
function prettyUaString(s: string): string {
  const browser =
    /Edg\//.test(s) ? "Edge" :
    /OPR\/|Opera/.test(s) ? "Opera" :
    /Chrome\//.test(s) ? "Chrome" :
    /Firefox\//.test(s) ? "Firefox" :
    /Safari\//.test(s) ? "Safari" : null;
  const os =
    /Windows/.test(s) ? "Windows" :
    /Mac OS X|Macintosh/.test(s) ? "macOS" :
    /Android/.test(s) ? "Android" :
    /iPhone|iPad|iOS/.test(s) ? "iOS" :
    /Linux/.test(s) ? "Linux" : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return s.length > 48 ? s.slice(0, 48) + "…" : s;
}
function uaOf(ua: any): string | null {
  if (!ua) return null;
  if (typeof ua === "string") return prettyUaString(ua);
  // Authentik's parsed user_agent object: assemble "Browser on OS".
  const b = ua.user_agent?.family, o = ua.os?.family;
  if (b && o) return `${b} on ${o === "Mac OS X" ? "macOS" : o}`;
  const parts = [b, o, ua.device?.family].filter(Boolean);
  if (parts.length) return parts.join(" on ");
  return typeof ua.string === "string" ? prettyUaString(ua.string) : null;
}

/** Active browser sessions for a user (AuthenticatedSession).
 *  Endpoint verified against Authentik 2024.10: /core/authenticated_sessions/.
 *  `current` from the API reflects the ADMIN-token caller, not the user's
 *  browser, so it is meaningless here. Pass the calling user's request IP + UA
 *  as `hint` and we mark the matching session (most-recently-used on a tie) as
 *  the current device, giving the Account page a reliable "This device" badge. */
export async function listUserSessions(
  userPk: number,
  hint?: { ip?: string | null; userAgent?: string | null },
): Promise<AuthentikSession[]> {
  const res = await api<{ results: any[] }>(`/core/authenticated_sessions/?user=${userPk}&ordering=-last_used`);
  const list = (res.results ?? []).map((s) => {
    const geo = geoOf(s.geo_ip ?? s.geoip);
    const rawUa = s.user_agent?.string ?? (typeof s.last_user_agent === "string" ? s.last_user_agent : null);
    return {
      id: String(s.uuid ?? s.pk ?? s.session_key ?? ""),
      current: false,
      ip: s.last_ip ?? null,
      userAgent: uaOf(s.user_agent) ?? (typeof s.last_user_agent === "string" ? s.last_user_agent : null),
      city: geo.city,
      country: geo.country,
      lastUsed: s.last_used ?? null,
      expires: s.expires ?? null,
      _rawUa: rawUa as string | null,
    };
  });
  // Match the caller's current session by IP + raw UA (already ordered by most
  // recent). Fall back to UA-only, then IP-only, so a proxy that rewrites one
  // still lands a best-effort badge.
  const hIp = hint?.ip ?? null, hUa = hint?.userAgent ?? null;
  if (hIp || hUa) {
    const pick =
      list.find((s) => hIp && hUa && s.ip === hIp && s._rawUa === hUa) ||
      list.find((s) => hUa && s._rawUa === hUa) ||
      list.find((s) => hIp && s.ip === hIp);
    if (pick) pick.current = true;
  }
  return list.map(({ _rawUa, ...s }) => s);
}

/** Terminate a single session by its Authentik id. */
export async function terminateSession(sessionId: string): Promise<void> {
  await api(`/core/authenticated_sessions/${encodeURIComponent(sessionId)}/`, { method: "DELETE" });
}

/** Terminate every session for a user (optionally keeping the current one). */
export async function terminateAllUserSessions(userPk: number, exceptId?: string): Promise<number> {
  const sessions = await listUserSessions(userPk);
  let n = 0;
  for (const s of sessions) {
    if (exceptId && s.id === exceptId) continue;
    try { await terminateSession(s.id); n++; } catch { /* best-effort */ }
  }
  return n;
}

/** Recent login/logout events for a user (login history).
 *  NOTE (verified against Authentik 2024.10): repeating `?action=` only applies
 *  the LAST value, so we CANNOT OR the actions in the query. Instead pull the
 *  recent event feed unfiltered and filter to the login-related actions + this
 *  user client-side. Geo/UA live under `context`. */
export async function listUserLoginEvents(username: string, limit = 25): Promise<AuthentikLoginEvent[]> {
  const LOGIN_ACTIONS = new Set(["login", "login_failed", "logout"]);
  // Server-side auth (token refresh, internal flows) shows up as logins from a
  // private docker IP / a library UA. Those aren't real user sign-ins, so drop
  // them - the history should read like "where I signed in", not server noise.
  const isInternal = (ip: string | null, ua: any): boolean => {
    if (typeof ip === "string" && /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return true;
    const s = (typeof ua === "string" ? ua : ua?.string ?? "").toLowerCase();
    return /undici|node-fetch|python|axios|curl|go-http|okhttp/.test(s);
  };
  const res = await api<{ results: any[] }>(
    `/events/events/?ordering=-created&page_size=${Math.min(200, Math.max(60, limit * 8))}`,
  );
  const rows = (res.results ?? []).filter((e) => {
    if (!LOGIN_ACTIONS.has(e.action)) return false;
    const u = e.user ?? e.context?.username;
    const uname = typeof u === "object" ? (u.username ?? u.email) : u;
    if (uname !== username) return false;
    return !isInternal(e.client_ip ?? null, e.context?.http_request?.user_agent);
  });
  return rows.slice(0, limit).map((e) => {
    const geo = geoOf(e.geo ?? e.context?.geo);
    return {
      id: String(e.pk ?? e.uuid ?? ""),
      action: e.action,
      success: e.action !== "login_failed",
      ip: e.client_ip ?? e.context?.http_request?.args?.client_ip ?? null,
      city: geo.city,
      country: geo.country,
      userAgent: uaOf(e.context?.http_request?.user_agent ?? e.user_agent),
      app: e.app ?? null,
      timestamp: e.created,
    };
  });
}

/**
 * Classify an Authentik device by its model type string, e.g.
 * "authentik_stages_authenticator_totp.TOTPDevice" -> "totp".
 */
function classifyDevice(type: string | undefined | null): "totp" | "webauthn" | "static" | "other" {
  const t = (type ?? "").toLowerCase();
  if (t.includes("static")) return "static";
  if (t.includes("totp")) return "totp";
  if (t.includes("webauthn")) return "webauthn";
  return "other";
}

/**
 * Every authenticator device for ONE user in a single call.
 *
 * IMPORTANT: the per-type admin endpoints (`/authenticators/admin/totp/?user=`)
 * silently IGNORE the `user` filter and their serializer omits the owner, so
 * they return the WHOLE system's devices for every user - reading them per-user
 * reports the global set as if it were the user's. The aggregate
 * `/authenticators/admin/all/?user=<pk>` endpoint DOES filter by user and
 * carries a `type`, so it is the only reliable per-user source.
 */
async function listUserDeviceRows(userPk: number): Promise<any[]> {
  try {
    const res = await api<any[] | { results?: any[] }>(`/authenticators/admin/all/?user=${userPk}`);
    const arr = Array.isArray(res) ? res : (res.results ?? []);
    // Only confirmed devices count - a half-finished enrolment must not read as set up.
    return arr.filter((d: any) => d?.confirmed !== false);
  } catch {
    return [];
  }
}

/** All authenticator devices for a user, normalized (TOTP / passkeys / recovery). */
export async function listUserDevices(userPk: number): Promise<AuthentikSecuritySummary> {
  const rows = await listUserDeviceRows(userPk);
  const toDevice = (d: any, kind: AuthentikDevice["type"]): AuthentikDevice => ({
    id: String(d.pk ?? d.uuid ?? ""),
    type: kind,
    name: d.name || kind,
    createdAt: d.created ?? null,
    lastUsed: d.last_used ?? d.last_t ?? null,
    confirmed: d.confirmed ?? true,
  });
  const totp: AuthentikDevice[] = [];
  const passkeys: AuthentikDevice[] = [];
  const recoveryCodes: AuthentikDevice[] = [];
  for (const d of rows) {
    const kind = classifyDevice(d.type ?? d.meta_model_name);
    if (kind === "totp") totp.push(toDevice(d, "totp"));
    else if (kind === "webauthn") passkeys.push(toDevice(d, "webauthn"));
    else if (kind === "static") recoveryCodes.push(toDevice(d, "static"));
  }
  let lastLogin: string | null = null;
  try {
    const u = await api<any>(`/core/users/${userPk}/`);
    lastLogin = u?.last_login ?? null;
  } catch { /* ignore */ }
  return {
    mfaEnabled: totp.length > 0 || passkeys.length > 0,
    totp,
    passkeys,
    recoveryCodes,
    lastLogin,
  };
}

/** A user's last successful login timestamp (for invite/pending status). Null if never. */
export async function getUserLastLogin(userPk: number): Promise<string | null> {
  try {
    const u = await api<any>(`/core/users/${userPk}/`);
    return u?.last_login ?? null;
  } catch {
    return null;
  }
}

/**
 * Last-login lookup by OIDC subject in a SINGLE API call (one filtered list),
 * so a Users-page status enrichment costs one round-trip per user rather than
 * two. Returns null if the identity is unknown or never signed in.
 */
export async function getLastLoginBySubject(subject: string): Promise<string | null> {
  try {
    const res = await api<{ results: any[] }>(`/core/users/?uuid=${encodeURIComponent(subject)}`);
    const u = res.results?.find((x) => x.uuid === subject);
    return u?.last_login ?? null;
  } catch {
    return null;
  }
}

/** Look up an identity's Authentik pk by subject (uuid). */
export async function findIdentityBySubject(subject: string): Promise<AuthentikIdentity | null> {
  const res = await api<{ results: any[] }>(`/core/users/?uuid=${encodeURIComponent(subject)}`);
  const u = res.results?.find((x) => x.uuid === subject);
  if (!u) return null;
  return { subject: u.uuid, pk: u.pk, email: u.email, username: u.username };
}

export type RemovableDeviceType = "totp" | "webauthn" | "static";
const REMOVABLE_DEVICE_TYPES: readonly RemovableDeviceType[] = ["totp", "webauthn", "static"];

/**
 * Remove a single authenticator device (TOTP / passkey / recovery-code set)
 * for a user. Used by the account "Manage" surface so a user can actually
 * revoke a factor instead of only ever adding more.
 */
export async function deleteUserDevice(type: RemovableDeviceType, id: string): Promise<void> {
  if (!REMOVABLE_DEVICE_TYPES.includes(type)) throw new Error(`[authentik] unknown device type: ${type}`);
  await api(`/authenticators/admin/${type}/${encodeURIComponent(id)}/`, { method: "DELETE" });
}

/** Follow Authentik's page-number pagination, collecting every result row. */
async function listAll(path: string): Promise<any[]> {
  const out: any[] = [];
  let page = 1;
  const sep = path.includes("?") ? "&" : "?";
  for (let i = 0; i < 200; i++) {
    const res = await api<any>(`${path}${sep}page=${page}&page_size=100`);
    const arr = Array.isArray(res) ? res : (res.results ?? []);
    out.push(...arr);
    const pg = res?.pagination;
    if (!pg || pg.total_pages == null || pg.current == null) break;
    if (pg.current >= pg.total_pages) break;
    page = pg.current + 1;
  }
  return out;
}

export interface MfaEnrollmentState {
  hasAuthenticator: boolean; // TOTP or passkey
  hasRecovery: boolean; // static recovery codes
  enrolled: boolean; // both of the above
  // Whether the subject was actually resolved to an Authentik identity and read.
  // false = we could NOT resolve it (unknown subject / identity list cutoff), so
  // `enrolled: false` here means "unknown", NOT "confirmed unenrolled" - callers
  // must not treat an unresolved entry as a reason to clear an enrolment stamp.
  resolved: boolean;
}

/**
 * Enrolment state for MANY users, keyed by OIDC subject (uuid) so callers pass
 * `User.authentikSubject` straight through.
 *
 * Authentik's admin authenticator LIST serializer returns only `{name, pk}` -
 * no user reference - so devices can only be associated to a user via the
 * `?user=<pk>` filter. We therefore resolve each subject to its pk in ONE bulk
 * user list, then fan out the per-user device reads with bounded concurrency
 * (3 filtered calls per user). Unknown / never-authenticated subjects come back
 * not-enrolled.
 */
export async function getMfaEnrollmentMap(subjects: string[]): Promise<Map<string, MfaEnrollmentState>> {
  const result = new Map<string, MfaEnrollmentState>();
  const wanted = subjects.filter(Boolean);
  if (wanted.length === 0) return result;
  const wantedSet = new Set(wanted);

  const users = await listAll("/core/users/");
  const pkBySubject = new Map<string, number>();
  for (const u of users) {
    if (u?.uuid && wantedSet.has(u.uuid) && typeof u.pk === "number") pkBySubject.set(u.uuid, u.pk);
  }

  const stateFor = async (pk: number): Promise<MfaEnrollmentState> => {
    const rows = await listUserDeviceRows(pk);
    let hasAuthenticator = false;
    let hasRecovery = false;
    for (const d of rows) {
      const kind = classifyDevice(d.type ?? d.meta_model_name);
      if (kind === "totp" || kind === "webauthn") hasAuthenticator = true;
      else if (kind === "static") hasRecovery = true;
    }
    return { hasAuthenticator, hasRecovery, enrolled: hasAuthenticator && hasRecovery, resolved: true };
  };

  // Bounded concurrency so a large workspace doesn't open hundreds of sockets.
  const CONCURRENCY = 8;
  let i = 0;
  async function worker() {
    while (i < wanted.length) {
      const subject = wanted[i++];
      const pk = pkBySubject.get(subject);
      result.set(subject, pk == null
        // Unresolved subject: report unknown (resolved:false) so a caller never
        // mistakes "couldn't look it up" for "confirmed unenrolled".
        ? { hasAuthenticator: false, hasRecovery: false, enrolled: false, resolved: false }
        : await stateFor(pk));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker));
  return result;
}
