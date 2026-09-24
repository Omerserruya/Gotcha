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
   * The permission catalogue — screen 12c. 63 permissions, 29 of them scoped.
   *
   * `scopes` is `own · team · department · workspace`, and the VALUE lives on
   * the role, not on a permission: `PermissionDef.scoped` is a boolean saying
   * whether the dimension applies at all.
   */
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

  /**
   * Roles — screens 12b and 12c. Every verb ADMIN only.
   *
   * A role is a name plus a set of feature keys. `TenantRoleFeature` is a
   * composite key with no other columns, so **the money limits the design
   * writes into each role's description have nowhere to live.**
   */
  roles: () => endpoint('/api/permissions/roles'),
  role: (roleId: string) => endpoint('/api/permissions/roles/{roleId}', { roleId }),
  roleFeatures: (roleId: string) =>
    endpoint('/api/permissions/roles/{roleId}/features', { roleId }),

  /** One person: profile, role assignments with scope, and overrides. */
  user: (userId: string) => endpoint('/api/permissions/users/{userId}', { userId }),

  /** A person's primary role — screen 12d. */
  userRole: (userId: string) => endpoint('/api/permissions/users/{userId}/role', { userId }),

  /**
   * One person's exceptions — screen 12e.
   *
   * `granted: true` adds a permission their role lacks; **`granted: false`
   * takes away one their role gives.** Same endpoint, same table, opposite
   * meanings — and the design describes only the first.
   */
  userGrants: (userId: string) => endpoint('/api/permissions/users/{userId}/grants', { userId }),
  userGrant: (userId: string, feature: string) =>
    endpoint('/api/permissions/users/{userId}/grants/{feature}', { userId, feature }),
} as const;

/**
 * Analytics.
 *
 * `from`/`to` are accepted by `overview` and `channelPerformance`; `queue` is
 * fixed to today and takes no parameters.
 */
export const analyticsEndpoints = {
  /**
   * The language mix of recent conversations — screen 11d.
   *
   * `{ windowDays, total, rows: [{ locale, conversations, share }] }`,
   * grouped on `Conversation.detectedLocale` over the same billable
   * population the allowance bar counts, and normalised to the language
   * rather than the tag — *"he-IL and he are one language to a person
   * choosing which languages to answer in"*.
   *
   * `locale: null` is a conversation whose language was never detected. It
   * is a row like any other and must not be rendered as a language.
   */
  languageShare: () => endpoint('/api/analytics/language-share'),
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
  /**
   * Screen 11b. Re-crawls the site and writes only what the scan already
   * owns; everything else returns as a proposal.
   */
  scan: () => endpoint('/api/workspace/scan'),
  /**
   * Take the site's value for offered fields — stamps them `scan`-owned.
   *
   * A plain PATCH cannot do this: PATCH means "a human set this". Without
   * this endpoint `scan` ownership was unreachable and every scan offered
   * everything forever.
   */
  scanAccept: () => endpoint('/api/workspace/scan/accept'),
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
  /**
   * Invoices — and this route was here the whole time.
   *
   * The registry used to point at `/api/billing/summary`, annotated
   * *"contracted, not yet served"*, while the screen said *"We can't show
   * your invoices yet."* **`/api/billing/invoices` is mounted and serving** —
   * at bare `/api`, like every billing router, which is why a search for an
   * `/api/billing` mount finds nothing.
   *
   * What that hid was not cosmetic: **four invoices on this tenant, every one
   * FAILED, $5,996 in total.**
   *
   * Answers **`{ invoices }`** — a fifth envelope shape.
   */
  invoices: () => endpoint('/api/billing/invoices'),
  /**
   * Topping up and what happens at the limit — screen 17d.
   *
   * Answers `{ policy, currency, paygRate }`, and the currency travels even
   * when `policy` is null so an amount can be named before anything is set.
   */
  autoPurchase: () => endpoint('/api/billing/auto-purchase'),
  /** Who the bill is made out to — screen 17e. `{ data }`, and it may be null. */
  profile: () => endpoint('/api/billing/profile'),
  /** What it charges against. Answers `{ paymentMethods }` — a sixth shape. */
  paymentMethods: () => endpoint('/api/billing/payment-methods'),
  /**
   * Credits, and what happens to them — screen 17c.
   *
   * Carries TWO estimates of what the balance buys: `estimatedRemaining` from
   * the public commercial ratio, and `observedRemaining` from this tenant's
   * own measured burn. The route ships both *"each labelled with its basis"*
   * because *"a screen that silently swapped them would make a pricing claim
   * out of one customer's behaviour"*.
   */
  creditSummary: () => endpoint('/api/billing/credit-summary'),

  /* ── Screen 17b — plan, price and changing it ──────────────────────────── */

  /** The catalogue, the display-currency options and the FX behind an ILS price. */
  pricing: () => endpoint('/api/billing/pricing'),
  /** The current subscription from its stored SNAPSHOT, not the live plan. */
  pricingCurrent: () => endpoint('/api/billing/pricing/current'),
  /**
   * Buyable credit packages for THIS plan.
   *
   * `{ packages: [], eligible: false }` means the plan cannot buy them at all
   * — a different fact from an empty catalogue, and not the customer's fault.
   */
  pricingPackages: () => endpoint('/api/billing/pricing/packages'),
  /** Prices a selection from KEYS. Never accepts a price from the client. */
  pricingQuote: () => endpoint('/api/billing/pricing/quote'),
  /**
   * Apply a change. Owner-gated on `settings:billing:manage`.
   *
   * `/api/billing/subscription/change-plan` above is the SAME service behind a
   * second path — identical body, permission and result, differing only in the
   * error string. Not a dead route this time; a duplicate. This screen uses
   * one of them and the registry records that they are the same thing, so
   * nobody later concludes they are two features.
   */
  pricingChange: () => endpoint('/api/billing/pricing/change'),
  /**
   * Screen 17d — buy a credit pack. REAL MONEY.
   *
   * Owner-gated on `settings:billing:manage`. Accepts only a package KEY, a
   * quantity and an intent key: price and credit amount are read from the
   * catalogue inside `buyCredits()`, never from the request, so a tampered
   * body cannot change what is bought or what it costs.
   *
   * ★ `intentKey` IDENTIFIES ONE PURCHASE THE CUSTOMER DECIDED ON, so a
   * double-click is one charge. It must therefore be minted when the CHOICE
   * is made and not when the button is pressed — a key generated per click
   * is not an idempotency key, it is a new purchase each time.
   *
   * ★ AND A FAILURE HERE IS 409, NOT 402, when the provider has not settled:
   * "a payment-required response invites the customer to try again, and they
   * may already have been charged."
   *
   * ⚠ NOTHING AUTOMATED MAY CALL THIS. It charges a live card on a real
   * tenant.
   *
   * NOTE: `/api/billing/credits/packages` is a SECOND packages route and it
   * is NOT this screen's. It filters on `active` alone — no `customerVisible`,
   * no `status`, no plan-eligibility gate — so it can list packages a
   * customer must not see or cannot buy. `pricingPackages` above is the
   * filtered one. Recorded so nobody later reads them as interchangeable.
   */
  creditsBuy: () => endpoint('/api/billing/credits/buy'),
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
  /**
   * The TENANT's notification rules — event type × channels × recipients,
   * scoped to a department. ADMIN only.
   *
   * This is the table the dispatcher actually reads
   * (`notification-engine.service.ts:133`). The per-user `preferences` above
   * is read by nothing but its own route, which is why screen 15 is built
   * against this one.
   *
   * Gateway reachability verified 2026-09-18 in BOTH nginx templates
   * (`gateway/nginx.prod.conf.template:1150`, `nginx/nginx.conf.template:1059`):
   * `/api/notification-preferences` proxies to `notifications_service` in each.
   * So the remaining unknown on this screen is the RULE PAYLOAD shape, not
   * whether the path resolves.
   */
  rules: () => endpoint('/api/notification-preferences'),
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

  /* ── Screen 13 — WhatsApp numbers ──────────────────────────────────────
   *
   * Mounted at `/api/channels/whatsapp`, which is a DIFFERENT router from the
   * `/api/channels` list above — the same prefix relationship that made
   * `/api/knowledge` look alive for a whole screen. Both are checked by
   * `scripts/check-routes.sh`.
   *
   * The list answers `{ data, unprofiled }`. The second array is WhatsApp
   * channels connected before per-number health existed: working, and with no
   * health at all. On this tenant `data` is empty and `unprofiled` has one
   * entry, so it is the only state the screen can currently show.
   */
  whatsappNumbers: () => endpoint('/api/channels/whatsapp/numbers'),
  /**
   * Pre-flight — screens 13c/13d. Takes a Meta authorization CODE.
   *
   * Read-only against the customer's assets, and NOT side-effect-free: it
   * spends the single-use code and replaces the tenant's signup session.
   */
  whatsappInspect: () => endpoint('/api/channels/whatsapp/inspect'),
  /** ★ WRITES at Meta — subscribeApp + register. Never fired automatically. */
  whatsappConnect: () => endpoint('/api/channels/whatsapp/connect'),
  /** Deliberate re-read from Meta. The list is built from stored state. */
  whatsappRefresh: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/refresh', { id }),
  /**
   * Run ONE repair we can actually perform.
   *
   * Only for `availableRepairs`. Never for `customerActions`, which are
   * resolved in Meta — "offering one and having it fail is worse than saying
   * plainly that this one is theirs to fix."
   */
  whatsappRepair: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/repair', { id }),
  /**
   * Supply what the customer was asked for — the register step for error
   * 141000, with their two-step PIN. The ONE blocked state clearable here.
   */
  whatsappResume: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/resume', { id }),
  /** The audit trail for one number. Zero rows on this database. */
  whatsappEvents: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/events', { id }),
  /**
   * Inbound exclusions. `value` is what was typed, `normalized` is what it
   * matches on — both, because showing only the normalised form makes a
   * person think their rule was rewritten.
   */
  whatsappExclusions: () => endpoint('/api/channels/whatsapp/exclusions'),
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
  /**
   * Screens 14b/14c — the use case, the parts, who CAN serve each and who
   * DOES. Never connects anything; connecting stays in the marketplace.
   *
   * A part nothing could ever serve reports `available: false` with a
   * reason, which is a different fact from an empty candidate list.
   */
  businessCore: () => endpoint('/api/integrations/business-core'),
  /**
   * Screen 14c — elect the system that plays a part.
   *
   * DISPLACES rather than refusing when the part is already taken, and
   * answers with what it replaced so the screen can name it. Refuses a
   * system that is not CONNECTED, and refuses the CRM outright with
   * `CRM_ELECTED_ELSEWHERE` — that one is `PUT /:slug/crm-source`.
   */
  electRole: () => endpoint('/api/integrations/business-core/role'),
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
  /**
   * The signed-in person and their workspace — screen 11d.
   *
   * Carries `tenantDefaultLocale` (the language GOTCHA itself runs in) and
   * `user.locale` (this person's own interface language). They are two
   * different settings and the design is right to separate them.
   */
  me: () => endpoint('/api/account'),
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

/**
 * Approvals — screen 03. `conversation_service` in both gateway templates
 * (`gateway/…:752`, `nginx/…:636`).
 *
 * The route file holds seven handlers; **two of them are not ours.**
 * `/:id/dispatch-approved` and `/:id/dispatch-rejected` sit above the
 * `authenticate` middleware behind `requireInternalKey` — service-to-service
 * dispatch hooks, deliberately unreachable from a browser session. They are
 * absent here on purpose, the way the five dev-only gateway routes are.
 *
 * `list` takes **one** status and defaults to PENDING (`where = { tenantId,
 * status }`), with no date filter of any kind, `take: 100`, newest first. So
 * "what you decided today" is one call per status, narrowed on our side, and
 * only as far back as the most recent 100 rows of each — a real ceiling on a
 * busy tenant, and not one the screen may pretend away.
 *
 * `detail` answers a bare `{ approval, conversation, contact, recentMessages }`
 * — not `{ data }`. Third envelope shape in this platform.
 */
export const approvalEndpoints = {
  list: (status?: string) =>
    status ? endpoint('/api/approvals?status={status}', { status }) : endpoint('/api/approvals'),
  detail: (id: string) => endpoint('/api/approvals/{id}', { id }),
  approve: (id: string) => endpoint('/api/approvals/{id}/approve', { id }),
  reject: (id: string) => endpoint('/api/approvals/{id}/reject', { id }),
  /**
   * Re-runs a dispatch that ran and FAILED. It runs the action **forward** —
   * on a refund that is the opposite of an undo, and it is the affordance the
   * design drew an Undo in place of.
   */
  retryExecution: (id: string) => endpoint('/api/approvals/{id}/retry-execution', { id }),
} as const;

/**
 * The thresholds behind "Change what needs asking".
 *
 * Immutable-versioned: a write creates version+1 and historical
 * `PolicyDecision` rows keep pointing at the version that actually judged
 * them, so changing a rule never rewrites history.
 */
export const businessPolicyEndpoints = {
  list: () => endpoint('/api/business-policies'),
  update: (actionKind: string) => endpoint('/api/business-policies/{actionKind}', { actionKind }),
  /** Answers "what would change" before anything is applied. */
  preview: (actionKind: string) =>
    endpoint('/api/business-policies/{actionKind}/preview', { actionKind }),
} as const;

/**
 * Customers — screen 04. `conversation_service` in both gateway templates.
 *
 * **`list` is deliberately the segment route, not `GET /api/contacts`.** That
 * one is a CRM proxy search: it requires a connected CRM *and* a non-empty
 * query, returns `{ data: [], total: 0 }` otherwise, and its `meta.total` is
 * `rows.length`. This tenant's only integration is Shopify (ECOMMERCE, ERROR),
 * so it can never answer with a customer here.
 *
 * `segment` queries the local `Contact` table, answers a real
 * `prisma.contact.count`, and has a `countOnly` mode. Its rule vocabulary has
 * thirteen cases and **no name case** — searching by name is not currently
 * possible against the local table, and is requested.
 */
export const customerEndpoints = {
  /** POST. Body `{ rules?, channel?, countOnly? }`. */
  list: () => endpoint('/api/contacts/segment'),
  detail: (id: string) => endpoint('/api/contacts/{id}', { id }),
  /**
   * Screen 04b's timeline. CONTACT-keyed, and the only one of the three
   * reads that takes the id the list hands us.
   *
   * Follows `mergedIntoId`, gathers sibling contacts and aliases preserved
   * from prior merges — so this genuinely is every channel on one spine.
   * What it is NOT is complete: 50 conversations, newest 5 messages each,
   * and `type: "message"` is the whole event union. See
   * `contracts/customer-detail.ts`.
   */
  timeline: (id: string) => endpoint('/api/identity/{id}/timeline', { id }),
  /**
   * The written character summary. A **POST**, and it requires a
   * `conversationId` — customer-level intelligence behind a
   * conversation-shaped door, so 04b passes this person's most recent
   * conversation and a person with none has no brief.
   *
   * ⚠ Never send `refresh: true` from a page load. The route falls back to
   * inline generation when the flag is set, which is a live model call.
   */
  summary: () => endpoint('/api/customer-summary'),
  /**
   * What GOTCHA learned about this person, keyed on THEIR OWN identifier
   * rather than an import-internal id, with both-shapes phone normalisation.
   *
   * It exists because the import's memory "went into the bot prompt and
   * nowhere else, so a human agent opening the same chat saw nothing" —
   * which is the failure this whole redesign exists to stop repeating.
   *
   * Returns facts as `{ text, category, confidence }` only:
   * `evidenceConversationIds` is written and returned by no route.
   */
  memory: (externalId: string) =>
    endpoint('/api/historical-imports/customer-context?externalId={externalId}', { externalId }),
  /**
   * The CRM panel for one conversation — 04b reads `recent_crm_notes` from it.
   *
   * ⚠ CONVERSATION-KEYED, so the customer page enters through
   * `readKeyFor(events)`. READ ONLY from here: the sibling write sets
   * `source_interaction_id` to whatever conversation we passed, which on a
   * customer page would attach a note to an unrelated chat in the MERCHANT'S
   * OWN CRM, where we cannot correct it.
   */
  crmContext: (conversationId: string) =>
    endpoint('/api/crm/conversation/{conversationId}/context', { conversationId }),
  /**
   * Screen 04d — this customer's orders from the connected store.
   *
   * Conversation-keyed like the CRM panel, so the customer page enters
   * through `readKeyFor(events)`. Permission-gated on
   * `customer:commerce:read`.
   *
   * ★ Answers a DISCRIMINATED UNION of eight states, and the type's own
   * comment asks the frontend to render an explicit UI for each rather than
   * guess from a bare error. `not_connected` and `connection_unhealthy` are
   * separate, which is the 14c distinction made by Backend before we got
   * here.
   *
   * ⚠ READ ONLY from this screen. The sibling `POST /:conversationId/actions`
   * writes an audit record carrying that conversation id, so an order action
   * taken from a customer page would leave a wrong audit trail — and the
   * audit trail is the thing those actions exist to leave behind.
   */
  orders: (conversationId: string) =>
    endpoint('/api/commerce-context/{conversationId}', { conversationId }),
} as const;

/**
 * Cross-channel identity — the merge the design shows as *suggested, never
 * silent*. `resolve` proposes, `merge` acts, and a person confirms in between.
 */
export const identityEndpoints = {
  resolve: () => endpoint('/api/identity/resolve'),
  merge: () => endpoint('/api/identity/merge'),
  timeline: (id: string) => endpoint('/api/identity/{id}/timeline', { id }),
} as const;

/**
 * Outreach — screens 05 and 05b. `conversation_service` in both templates.
 *
 * **There is no pause and no resume.** `cancel` is the only thing that stops a
 * send: it removes the queued jobs, marks every pending recipient `"skipped"`,
 * sets `completedAt`, and leaves the campaign `CANCELLED` with no path back to
 * `SENDING`. It accepts `SENDING` and `SCHEDULED` only, and answers 400
 * otherwise.
 *
 * `validate` is a real pre-send check against the actual audience and channel.
 * It is what the design drew as *"Waiting for your approval"* — a state with
 * no field on `Broadcast`, and one that cannot borrow `ApprovalRequest`, whose
 * own schema comment says it is exclusively the bot path.
 */
export const outreachEndpoints = {
  list: () => endpoint('/api/broadcasts'),
  detail: (id: string) => endpoint('/api/broadcasts/{id}', { id }),
  recipients: (id: string) => endpoint('/api/broadcasts/{id}/recipients', { id }),
  /** Answers "will this actually send?" without sending anything. */
  validate: (id: string) => endpoint('/api/broadcasts/{id}/validate', { id }),
  /** TERMINAL. Drains the queue and skips everyone still pending. */
  cancel: (id: string) => endpoint('/api/broadcasts/{id}/cancel', { id }),
  resend: (id: string) => endpoint('/api/broadcasts/{id}/resend', { id }),
} as const;

/**
 * Message templates — screen 05c. ADMIN on every verb.
 *
 * `list` paginates properly: `{ data, total, page, limit }` with a real
 * `prisma.messageTemplate.count`, and filters on channel, status and category.
 *
 * **No `include` for the `broadcasts` relation**, so usage count and reply
 * rate are unserved rather than impossible — the join exists on the model.
 */
export const templateEndpoints = {
  list: () => endpoint('/api/templates'),
  detail: (id: string) => endpoint('/api/templates/{id}', { id }),
  duplicate: (id: string) => endpoint('/api/templates/{id}/duplicate', { id }),
  /** Sends it to Meta for review. The state changes; no ETA comes back. */
  submit: (id: string) => endpoint('/api/templates/{id}/submit-to-meta', { id }),
} as const;

/**
 * Phone calls — screens 05d and 05e.
 *
 * **Every route here is behind `voiceCopilotGate`**, which answers 404 for the
 * whole router when `tenant.voiceCopilotEnabled` is false. A 404 from the gate
 * is indistinguishable from a missing route, so the screen asks
 * `tenantSettings` — which is NOT behind the gate — before interpreting one.
 */
export const callEndpoints = {
  /** Cursor-paginated. Filters on `direction` and `status`. */
  list: () => endpoint('/api/voice-sessions'),
  /** Counts by direction and status, plus an average with its sample size. */
  summary: () => endpoint('/api/voice-sessions/summary'),
  active: () => endpoint('/api/voice-sessions/active'),
  missed: () => endpoint('/api/voice-sessions/missed'),
  detail: (id: string) => endpoint('/api/voice-sessions/{id}', { id }),
  /** Voice MESSAGES, not a transcript column. Cursor-paginated, ≤500. */
  transcript: (id: string) => endpoint('/api/voice-sessions/{id}/transcript', { id }),
  context: (id: string) => endpoint('/api/voice-sessions/{id}/context', { id }),
} as const;

/**
 * Tenant feature flags, deliberately OUTSIDE the voice gate.
 *
 * This is how the screen tells *"voice is not switched on here"* from *"the
 * route is missing"* — two conditions that answer 404 identically.
 */
export const tenantSettingsEndpoints = {
  read: () => endpoint('/api/tenant-settings'),
} as const;

/**
 * AI employees — Studio, screen 07.
 *
 * `list` returns each employee enriched with three conversation counts, its
 * knowledge sources, its department and when it was last tested. The counts
 * exclude sandbox rows and setup rehearsals; imported history is excluded by
 * the platform's own default rather than restated.
 *
 * **`PATCH /:id` is how pause and resume happen** — `{ status }`. There is no
 * retire: `AIAgentStatus` is ACTIVE | DRAFT | PAUSED.
 */
export const employeeEndpoints = {
  list: () => endpoint('/api/ai-agents'),
  detail: (id: string) => endpoint('/api/ai-agents/{id}', { id }),
  /** Pause and resume both go through here, as `{ status }`. */
  update: (id: string) => endpoint('/api/ai-agents/{id}', { id }),
  /** `{ hasCanvas, reachable }` — is this employee wired into the routing? */
  reachability: (id: string) => endpoint('/api/ai-agents/{id}/reachability', { id }),
} as const;

/**
 * What GOTCHA knows — Studio, screen 08.
 *
 * `sources` (at `/api/knowledge-bases`) returns each knowledge base with its documents, including
 * `updatedAt`, which the route's comment says *"drives last refreshed"*.
 *
 * `unanswered` is the newer of two routes over the same `UnansweredQuestion`
 * table — the other lives in analytics. Both read the same rows; this one has
 * the naming fixes, `timesAsked` and `distinctAskers`, and filters on reason
 * and resolved-versus-open.
 */
export const knowledgeEndpoints = {
  /**
   * **`/api/knowledge-bases`, not `/api/knowledge`.** Both are mounted in
   * `services/ai/src/index.ts` — `:109` carries the list router and `:111`
   * carries Confluence/Drive OAuth, which declares no `GET /`.
   *
   * Both are in the gateway allowlist, so both proxy cleanly and **both
   * answer 401 unauthenticated**: the service authenticates before it routes.
   * A 401 proves the upstream resolved. It does not prove the route exists,
   * and only an authenticated request tells them apart — this one was wrong
   * for a whole screen before a capture found it.
   */
  sources: () => endpoint('/api/knowledge-bases'),
  unanswered: () => endpoint('/api/knowledge/unanswered-questions'),
} as const;

/**
 * Automations — Studio, screen 09. Served by `chatbot_service`.
 *
 * **`list` answers a BARE ARRAY** — the fourth response shape on this
 * platform, so it is read with `raw`.
 *
 * `validate` is a real pre-flight check, the same shape that replaced the
 * fictional approval state on screen 05. Twice now the honest answer to
 * *"review before it happens"* has been a validate route the design did not
 * know about.
 */
export const automationEndpoints = {
  list: () => endpoint('/api/chatbot-flows'),
  detail: (id: string) => endpoint('/api/chatbot-flows/{id}', { id }),
  validate: (id: string) => endpoint('/api/chatbot-flows/{id}/validate', { id }),
  activate: (id: string) => endpoint('/api/chatbot-flows/{id}/activate', { id }),
} as const;

/**
 * What GOTCHA is allowed to do — Studio, screen 10.
 *
 * `list` merges adapter tool specs with the tenant's stored permissions.
 * Seventeen rows here, every one a platform default.
 *
 * **`riskGroup` on those rows is a regex over the tool's NAME**, computed at
 * response time by `riskGroupFor` — not stored, not assessed, and
 * `create_update` is its no-match fallback.
 */
export const capabilityEndpoints = {
  list: () => endpoint('/api/tool-permissions'),
  /** PUT, ADMIN or `ai:tools:manage`. One tool at a time. */
  update: (toolName: string) => endpoint('/api/tool-permissions/{toolName}', { toolName }),
} as const;

export type { Endpoint as ApiEndpoint };
export { endpoint as defineEndpoint };
