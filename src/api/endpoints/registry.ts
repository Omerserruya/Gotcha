/**
 * The only place in the frontend that knows what a GOTCHA URL looks like.
 *
 * UI components, hooks and services refer to endpoints through this registry,
 * never as string literals. That keeps route changes to one file, makes the
 * surface we depend on auditable at a glance, and lets the transport layer
 * report a stable `route` (parameters still templated) for grouping errors and
 * telemetry without leaking identifiers.
 */

/** A resolved endpoint: a concrete path plus the template it came from. */
export interface Endpoint {
  /** Path with parameters substituted, e.g. `/api/permissions/users/42`. */
  readonly path: string;
  /** Template, e.g. `/api/permissions/users/{userId}`. Safe for telemetry. */
  readonly route: string;
}

function endpoint(route: string, params: Record<string, string | number> = {}): Endpoint {
  const path = route.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${key}" for route ${route}`);
    }
    return encodeURIComponent(String(value));
  });
  return { path, route };
}

/**
 * Auth & identity.
 *
 * Note: the platform documents a server-side session flow at
 * `/api/auth/login` and `/api/auth/callback`, but those routes are not
 * currently reachable through the gateway. This app therefore drives the
 * Authorization Code + PKCE flow against Authentik itself; see `src/auth`.
 */
export const authEndpoints = {
  me: () => endpoint('/api/auth/me'),
  memberships: () => endpoint('/api/auth/me/memberships'),
  switchTenant: () => endpoint('/api/auth/me/switch-tenant'),
} as const;

/** The tenant-local permission model. */
export const permissionEndpoints = {
  /** Effective permissions and scope for the current principal + tenant. */
  mine: () => endpoint('/api/permissions/me'),
  /** The full hierarchical permission catalogue, for admin surfaces. */
  catalog: () => endpoint('/api/permissions/catalog'),
  features: () => endpoint('/api/permissions/features'),
  /**
   * The UNIFIED member list: every tenant user except SYSTEM_ADMIN, with their
   * assigned role and team memberships. ADMIN only.
   *
   * Not to be confused with `/api/agents`, which filters `role: "AGENT"` and
   * therefore returns nothing on a tenant whose members are all admins — an
   * empty array there is indistinguishable from an empty tenant. Settings ·
   * People reads THIS one.
   */
  users: () => endpoint('/api/permissions/users'),
} as const;

/**
 * Analytics.
 *
 * `from`/`to` are accepted by `overview` and `channelPerformance`; `queue` is
 * fixed to today and takes no parameters.
 */
export const analyticsEndpoints = {
  overview: () => endpoint('/api/analytics/overview'),
  channelPerformance: () => endpoint('/api/analytics/channel-performance'),
  /** Two scalars: `{ waiting, avgWaitTimeMs }`. Not the list. */
  queue: () => endpoint('/api/analytics/queue'),
  /** The ranked list itself. `{ data, nextCursor, totalWaiting }` — use `raw`. */
  queueItems: () => endpoint('/api/analytics/queue/items'),
  /** Completed AI actions merged with pending approvals. `raw`. */
  activity: () => endpoint('/api/analytics/activity'),
  /** Seconds saved, with the arithmetic behind it. */
  timeSaved: () => endpoint('/api/analytics/time-saved'),
  /** What GOTCHA is doing right now, as opposed to what it has done. */
  inFlight: () => endpoint('/api/analytics/in-flight'),
  /** "Worth knowing" — `kind` + `values`, translated by us. */
  insights: () => endpoint('/api/analytics/insights'),
  /** The quiet day's ranked list, merged from four sources server-side. */
  quietDay: () => endpoint('/api/analytics/quiet-day'),
  dismissInsight: (id: string) => endpoint('/api/analytics/insights/{id}/dismiss', { id }),
  /** Per-agent open counts and reply times. Carries no presence. */
  agents: () => endpoint('/api/analytics/agents'),
} as const;

/**
 * Things GOTCHA learned about the business that need a person to settle.
 *
 * Answers `{ ok, pending, reviews }` — a third envelope shape, so requests
 * against it are made with `raw`.
 */
/**
 * Day one. Reachable while the workspace is still onboarding — these are the
 * endpoints for a workspace that is not live yet, so they must not require it.
 */
export const setupEndpoints = {
  state: () => endpoint('/api/setup/state'),
  knowledgeIngest: () => endpoint('/api/knowledge/ingest/latest'),
} as const;

/**
 * Settings · Workspace. Screen 11.
 *
 * All four live in the auth service, which owns both sources the workspace is
 * composed from. Reachable while the tenant is still onboarding, because these
 * are the facts a workspace fills in on its way to being live.
 */
export const workspaceEndpoints = {
  read: () => endpoint('/api/workspace'),
  voice: () => endpoint('/api/workspace/voice'),
  voiceSample: () => endpoint('/api/workspace/voice/sample'),
  prohibitedClaims: () => endpoint('/api/workspace/prohibited-claims'),
} as const;

/**
 * Conversation headroom for the period. Served by billing, not analytics.
 *
 * `/api/usage/allowance` — path taken from the MOUNT (`usage-allowance.ts:30`),
 * not from the filename. It is one of only three routes in the platform that
 * split a compound name with a slash rather than a hyphen, and the same
 * mistake on `/api/tenant/security` cost six capture runs.
 */
export const usageEndpoints = {
  allowance: () => endpoint('/api/usage/allowance'),
  /** Contracted, not yet served. The "where the month went" breakdown. */
  breakdown: () => endpoint('/api/usage/breakdown'),
} as const;

/**
 * Plan, price, invoices and payment method — screen 17.
 *
 * `subscription` answers **bare `{ subscription }`**, not `{ data }`. Its
 * siblings are enveloped; this one is not.
 */
export const billingEndpoints = {
  subscription: () => endpoint('/api/billing/subscription'),
  /** Plan names by key — the subscription carries only the key. Bare `{ plans }`. */
  plans: () => endpoint('/api/billing/plans'),
  changePlan: () => endpoint('/api/billing/subscription/change-plan'),
  /** Contracted, not yet served: invoices and the card on file. */
  summary: () => endpoint('/api/billing/summary'),
} as const;

export const intelligenceReviewEndpoints = {
  list: () => endpoint('/api/intelligence-reviews'),
  approve: (id: string) => endpoint('/api/intelligence-reviews/{id}/approve', { id }),
  reject: (id: string) => endpoint('/api/intelligence-reviews/{id}/reject', { id }),
} as const;

/**
 * Notifications. Cursor-paginated, and the page is `{ data, nextCursor }` —
 * `data` sits beside the cursor rather than wrapping it, so `raw` is required.
 */
export const notificationEndpoints = {
  list: () => endpoint('/api/notifications'),
  unreadCount: () => endpoint('/api/notifications/unread-count'),
  markRead: (id: string) => endpoint('/api/notifications/{id}/mark-read', { id }),
  markAllRead: () => endpoint('/api/notifications/mark-all-read'),
  /**
   * The signed-in person's own notification preferences — screen 15.
   *
   * Four booleans and a quiet-hours window. NOT the design's 8×3 matrix: the
   * matrix that exists (`NotificationPreference`) is scoped to a tenant and a
   * department and carries recipients, which is a different question.
   */
  preferences: () => endpoint('/api/notification-preferences/me'),
} as const;

/**
 * The agent runtime behind Home's command surface.
 *
 * `run` answers `text/event-stream`, so it is read with
 * `streamServerSentEvents` rather than through `HttpClient`. It is listed here
 * anyway: the registry is the only place a URL may live.
 *
 * `clear` wipes the caller's agent memory across EVERY session, not just the
 * current one, so any control for it has to say so before it runs.
 */
/** Per-agent presence, and the heartbeat that keeps it fresh. */
export const presenceEndpoints = {
  roster: () => endpoint('/api/agents/presence'),
  heartbeat: () => endpoint('/api/agents/presence/heartbeat'),
  mine: () => endpoint('/api/agents/presence/me'),
} as const;

/**
 * The socket handshake credential.
 *
 * Minted per connection and spent immediately. See `realtimeTicketSchema` for
 * why the bearer token cannot be used directly.
 */
export const realtimeEndpoints = {
  ticket: () => endpoint('/api/realtime/ticket'),
} as const;

export const agentEndpoints = {
  run: () => endpoint('/api/agent/run'),
  clear: () => endpoint('/api/agent/clear'),
} as const;

/**
 * AI employees — the non-human half of Settings · People.
 *
 * `list` answers the entire `AIAgent` row, system prompts included; the
 * contract narrows it deliberately rather than passing it through. See
 * `aiEmployeeSchema`.
 */
export const aiEmployeeEndpoints = {
  list: () => endpoint('/api/ai-agents'),
  effectivePermissions: (id: string) =>
    endpoint('/api/ai-agents/{id}/effective-permissions', { id }),
} as const;

/** Teams. `Department` is the backend's name for them. */
export const departmentEndpoints = {
  list: () => endpoint('/api/departments'),
  /** Also the create. 402 `PLAN_LIMIT_REACHED` when the plan is out of teams. */
  create: () => endpoint('/api/departments'),
  members: (id: string) => endpoint('/api/departments/{id}/members', { id }),
} as const;

/**
 * Tenant members, as a collection you can add to.
 *
 * Named apart from `agentEndpoints`, which is the AI runtime at `/api/agent`
 * (singular) behind Home's command surface. Two different things a character
 * apart, so neither is spelled as a literal anywhere but here.
 *
 * `invite` creates the person, their identity and their team memberships in
 * one call, and emails them. It cannot set a role: the route passes a literal
 * `"AGENT"`. Role is assigned afterwards, through `permissionEndpoints`.
 */
export const memberEndpoints = {
  invite: () => endpoint('/api/agents'),
  loginStatus: () => endpoint('/api/permissions/users/login-status'),
  assignRole: (userId: string, roleId: string) =>
    endpoint('/api/permissions/users/{userId}/roles/{roleId}', { userId, roleId }),
} as const;

/**
 * Channels — screen 13.
 *
 * `disconnect` is listed but is NOT a soft local toggle: the route revokes at
 * the platform first (deletes Meta `subscribed_apps`, stops Gmail push, drops
 * the Microsoft Graph subscription, revokes the Slack token) before marking
 * the record DISCONNECTED. Reconnecting means a full OAuth round trip with
 * real platform credentials. It is not reversible from here, and no test may
 * exercise it.
 *
 * `oauthInit` is a REDIRECT target, not a fetch: the browser navigates to it
 * and the platform hands control back at `/oauth/callback`.
 */
export const channelEndpoints = {
  list: () => endpoint('/api/channels'),
  /** Health counts only. Any tenant member; carries no credentials. */
  state: () => endpoint('/api/channels/state'),
  /**
   * NOT callable from this app as written: it accepts the access token only as
   * a QUERY PARAMETER, and ours lives in an HttpOnly sealed cookie the browser
   * never sees. Supplying it would put a bearer credential in the address bar,
   * in history, in the `Referer` sent onward to the platform, and in every
   * proxy log on the way. Listed because the registry is the only place a URL
   * may live; a ticket-based variant is contracted with the backend.
   */
  oauthInit: (platform: string) =>
    endpoint('/api/channels/oauth/init?platform={platform}', { platform }),
  /** Creates the widget as PENDING — a draft, not a connected channel. */
  createWebChat: () => endpoint('/api/channels/webchat/create'),
  /** SMTP/IMAP credentials. Stores real secrets; never exercised by a test. */
  connectEmail: () => endpoint('/api/channels/connect/email'),
  responseMode: (id: string) => endpoint('/api/channels/{id}/response-mode', { id }),
  disconnect: (id: string) => endpoint('/api/channels/{id}/disconnect', { id }),
} as const;

/**
 * Voice — a different spine from `channelEndpoints`.
 *
 * Served by the conversation service at `/api/voice-channels`, backed by
 * `CommunicationChannel` → `VoiceChannel` rather than `ChannelAccount`.
 *
 * The router is gated on `Tenant.voiceCopilotEnabled` and answers **404
 * `not_found`** when voice is not offered to a tenant. That 404 is an answer,
 * not a failure: it means "this does not exist for you", and the Channels
 * screen reads it as "do not offer a Phone calls row".
 */
export const voiceChannelEndpoints = {
  list: () => endpoint('/api/voice-channels'),
} as const;

/**
 * Business systems — screen 14.
 *
 * `detail` is listed but NOT used: it selects and returns
 * `TenantIntegration.credentials`, the stored integration secret, while the
 * list route excludes it with a comment saying no list view needs it. The
 * contract strips it either way; the screen reads the list.
 */
export const integrationEndpoints = {
  list: () => endpoint('/api/integrations'),
  detail: (slug: string) => endpoint('/api/integrations/{slug}', { slug }),
  tools: (slug: string) => endpoint('/api/integrations/{slug}/tools', { slug }),
} as const;

/**
 * The tenant's tool policy — AUTHORITATIVE over an integration's activation.
 *
 * A separate resource because it is keyed by tool NAME across every
 * integration, not by integration. Also returns raw OAuth scopes, which this
 * screen may never render; the contract does not name them.
 */
export const toolPermissionEndpoints = {
  list: () => endpoint('/api/tool-permissions'),
  update: (toolName: string) => endpoint('/api/tool-permissions/{toolName}', { toolName }),
} as const;

/**
 * Security — screen 16.
 *
 * Sessions and login history are served from AUTHENTIK, not from our
 * `UserSession` table, so they carry a real IP and a GeoIP city where our own
 * column carries only a hash. Both answer `{ available, … }` and degrade to
 * `available: false` rather than to an empty list.
 */
export const securityEndpoints = {
  sessions: () => endpoint('/api/account/sessions'),
  revokeSession: (id: string) => endpoint('/api/account/sessions/{id}', { id }),
  /** Revokes every OTHER session, keeping the caller's. */
  revokeOtherSessions: () => endpoint('/api/account/sessions'),
  loginHistory: () => endpoint('/api/account/login-history'),
  /**
   * `/api/tenant/security` — a SLASH, and it is an exception.
   *
   * Compound paths in this platform are hyphenated **38 to 3**. Only
   * `/api/tenant/security`, `/api/usage/allowance` and `/api/voice/incoming`
   * split a compound name with a slash, and this one contradicts its own
   * sibling: `/api/tenant-settings` hyphenates the same `tenant` prefix that
   * `/api/tenant/security` splits.
   *
   * So the convention does not tell you, and neither does the route file
   * (`routes/tenant-security.ts`, hyphenated). **Only `app.use` does.** This
   * was wrong for six capture runs and cost nothing but time because the
   * section now says when it cannot read its data — which is the other half of
   * the fix.
   */
  tenantSecurity: () => endpoint('/api/tenant/security'),
  auditLogs: () => endpoint('/api/audit-logs'),
  /** The real action vocabulary with counts — not a taxonomy we invented. */
  auditActions: () => endpoint('/api/audit-logs/actions'),
} as const;

export type { Endpoint as ApiEndpoint };
export { endpoint as defineEndpoint };
