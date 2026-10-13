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
   * The permission catalogue - screen 12c. 63 permissions, 29 of them scoped.
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
   * therefore returns nothing on a tenant whose members are all admins - an
   * empty array there is indistinguishable from an empty tenant. Settings ·
   * People reads THIS one.
   */
  users: () => endpoint('/api/permissions/users'),

  /**
   * Roles - screens 12b and 12c. Every verb ADMIN only.
   *
   * A role is a name plus a set of feature keys. `TenantRoleFeature` is a
   * composite key with no other columns, so **the money limits the design
   * writes into each role's description have nowhere to live.**
   */
  roles: () => endpoint('/api/permissions/roles'),
  role: (roleId: string) => endpoint('/api/permissions/roles/{roleId}', { roleId }),
  roleFeatures: (roleId: string) =>
    endpoint('/api/permissions/roles/{roleId}/features', { roleId }),
  /** A built-in role back to its defaults (auth 30d610da); 409 NOT_BUILTIN for any other. */
  roleReset: (roleId: string) => endpoint('/api/permissions/roles/{roleId}/reset', { roleId }),

  /** One person: profile, role assignments with scope, and overrides. */
  user: (userId: string) => endpoint('/api/permissions/users/{userId}', { userId }),

  /** A person's primary role - screen 12d. */
  userRole: (userId: string) => endpoint('/api/permissions/users/{userId}/role', { userId }),

  /**
   * One person's exceptions - screen 12e.
   *
   * `granted: true` adds a permission their role lacks; **`granted: false`
   * takes away one their role gives.** Same endpoint, same table, opposite
   * meanings - and the design describes only the first.
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
   * The language mix of recent conversations - screen 11d.
   *
   * `{ windowDays, total, rows: [{ locale, conversations, share }] }`,
   * grouped on `Conversation.detectedLocale` over the same billable
   * population the allowance bar counts, and normalised to the language
   * rather than the tag - *"he-IL and he are one language to a person
   * choosing which languages to answer in"*.
   *
   * `locale: null` is a conversation whose language was never detected. It
   * is a row like any other and must not be rendered as a language.
   */
  languageShare: () => endpoint('/api/analytics/language-share'),
  overview: () => endpoint('/api/analytics/overview'),
  /**
   * The per-day series (backend c054c811): `?days=` 1-90, UTC days, oldest
   * first - gotcha/team answered, alone/passedOver started. At its own path:
   * it was first mounted on `/daily`, where the old app's Redis volumes route
   * answers first; Backend moves it here. Until then this 404s and the
   * charts say they couldn't read the days.
   */
  dailySeries: () => endpoint('/api/analytics/daily-series'),
  /** 06c's report (backend af4f0072): members and the cards, `?days=`. */
  teamReport: () => endpoint('/api/analytics/team'),
  channelPerformance: () => endpoint('/api/analytics/channel-performance'),
  /** Two scalars: `{ waiting, avgWaitTimeMs }`. Not the list. */
  queue: () => endpoint('/api/analytics/queue'),
  /** The ranked list itself. `{ data, nextCursor, totalWaiting }` - use `raw`. */
  queueItems: () => endpoint('/api/analytics/queue/items'),
  /** Completed AI actions merged with pending approvals. `raw`. */
  activity: () => endpoint('/api/analytics/activity'),
  /** Seconds saved, with the arithmetic behind it. */
  timeSaved: () => endpoint('/api/analytics/time-saved'),
  /** What GOTCHA is doing right now, as opposed to what it has done. */
  inFlight: () => endpoint('/api/analytics/in-flight'),
  /** "Worth knowing" - `kind` + `values`, translated by us. */
  insights: () => endpoint('/api/analytics/insights'),
  /** The quiet day's ranked list, merged from four sources server-side. */
  quietDay: () => endpoint('/api/analytics/quiet-day'),
  dismissInsight: (id: string) => endpoint('/api/analytics/insights/{id}/dismiss', { id }),
  /** Per-agent open counts and reply times. Carries no presence. */
  agents: () => endpoint('/api/analytics/agents'),
  /**
   * Screen 06's "what people ask about" - `analytics:dashboard:read`.
   *
   * ★ A "TOPIC" IS A `groupBy`, NOT A THING THE PRODUCT HOLDS.
   * `getTopQuestions` groups `conversationIntelligence` by `detectedIntent`
   * over a date range, with a fallback that scans 1,000 inbound bodies. There
   * is no `Topic` model, which is why 06e became a panel: a rename has nowhere
   * to persist and the next request regroups from the raw column.
   */
  topQuestions: () => endpoint('/api/analytics/top-questions'),
  /** Catalogue searches by ISO week; misses by default. `{ weekKey, data }` - so `raw`. */
  productDemand: () => endpoint('/api/analytics/product-demand'),
  /** One UTC day's messages by UTC hour (Redis, kept 7 days). `{ data }`; `?date=YYYY-MM-DD`. */
  hourly: () => endpoint('/api/analytics/hourly'),
  /** AI vs human messages, resolution, and the approval governance figures. `{ data }`. */
  aiPerformance: () => endpoint('/api/analytics/ai-performance'),
  /** Questions GOTCHA could not answer. `{ period, data }` - `data` a sibling, so `raw`. */
  unansweredQuestions: () => endpoint('/api/analytics/unanswered-questions'),
  /**
   * Screen 10 - how often each tool has actually run.
   *
   * ★ IT UNIONS TWO TABLES AND THAT IS THE POINT. `getToolUsageStats` reads
   * `ToolExecution` AND the `adapter.*` audit rows, because *"the dev estate
   * holds 0 ToolExecution rows and 3,475 adapter records… the connector
   * executions were never missing; they were in the other table."* A panel
   * built on a `ToolExecution` groupBy would be silently blind to every
   * adapter-run tool - a Shopify refund among them.
   *
   * Gated on `analytics:dashboard:read`, which the permissions list itself
   * does not need, so this can 403 on a screen that otherwise works.
   */
  toolUsage: () => endpoint('/api/analytics/tool-usage'),
  /**
   * People who wrote twice or more and then went quiet (60 days by default),
   * oldest silence first, capped at 100. Keyed by the identity they wrote
   * from, not by contact. `analytics:workspace:read`.
   */
  dormantCustomers: () => endpoint('/api/analytics/dormant-customers?limit=100'),
  /** The same, from an instant (ISO) to now - 03c's "today". */
  toolUsageFrom: (from: string) => endpoint('/api/analytics/tool-usage?from={from}', { from }),
} as const;

/**
 * Things GOTCHA learned about the business that need a person to settle.
 *
 * Answers `{ ok, pending, reviews }` - a third envelope shape, so requests
 * against it are made with `raw`.
 */
/**
 * Day one. Reachable while the workspace is still onboarding - these are the
 * endpoints for a workspace that is not live yet, so they must not require it.
 */
export const setupEndpoints = {
  state: () => endpoint('/api/setup/state'),
  knowledgeIngest: () => endpoint('/api/knowledge/ingest/latest'),
  /**
   * What the website scan found (ADMIN). 11b reads two parts: the store
   * platform and the contact channels - "Also found". The rest is
   * onboarding's.
   */
  discovery: () => endpoint('/api/onboarding/discovery'),
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
   * Take the site's value for offered fields - stamps them `scan`-owned.
   *
   * A plain PATCH cannot do this: PATCH means "a human set this". Without
   * this endpoint `scan` ownership was unreachable and every scan offered
   * everything forever.
   */
  scanAccept: () => endpoint('/api/workspace/scan/accept'),
  /**
   * The workspace's system language - `Tenant.defaultLocale`, the language
   * GOTCHA uses with the team when a person has set none. `PUT {locale}`,
   * `en` or `he`; needs `settings:workspace:update` (auth agents.ts).
   */
  systemLocale: () => endpoint('/api/agents/settings/locale'),
  /** This person's own interface language - `PUT {locale}` (auth agents.ts). */
  myLocale: () => endpoint('/api/agents/me/locale'),
  /** The response target (SLA): `GET/PUT` - Owner only, the GET too (auth agents.ts). */
  sla: () => endpoint('/api/agents/settings/sla'),
  /** One department's own response target, overriding the workspace's when enabled. */
  slaDepartment: (id: string) => endpoint('/api/agents/settings/sla/department/{id}', { id }),
  /** Follow-up and auto-close (S3): `GET/PUT` - Owner only, the GET too (auth agents.ts). */
  idleAutomation: () => endpoint('/api/agents/settings/idle-automation'),
} as const;

/**
 * Conversation headroom for the period. Served by billing, not analytics.
 *
 * `/api/usage/allowance` - path taken from the MOUNT (`usage-allowance.ts:30`),
 * not from the filename. It is one of only three routes in the platform that
 * split a compound name with a slash rather than a hyphen, and the same
 * mistake on `/api/tenant/security` cost six capture runs.
 */
export const usageEndpoints = {
  allowance: () => endpoint('/api/usage/allowance'),
} as const;

/**
 * Plan, price, invoices and payment method - screen 17.
 *
 * `subscription` answers **bare `{ subscription }`**, not `{ data }`. Its
 * siblings are enveloped; this one is not.
 */
export const billingEndpoints = {
  subscription: () => endpoint('/api/billing/subscription'),
  /** Plan names by key - the subscription carries only the key. Bare `{ plans }`. */
  plans: () => endpoint('/api/billing/plans'),
  changePlan: () => endpoint('/api/billing/subscription/change-plan'),
  /**
   * 17b: what change-plan WOULD do and charge, exactly - no write, no provider
   * call (billing 42c52c6e). `{ ok, preview }`, a bare envelope.
   */
  changePlanPreview: () => endpoint('/api/billing/subscription/change-plan/preview'),
  /**
   * Invoices - and this route was here the whole time.
   *
   * The registry used to point at `/api/billing/summary`, annotated
   * *"contracted, not yet served"*, while the screen said *"We can't show
   * your invoices yet."* **`/api/billing/invoices` is mounted and serving** -
   * at bare `/api`, like every billing router, which is why a search for an
   * `/api/billing` mount finds nothing.
   *
   * What that hid was not cosmetic: **four invoices on this tenant, every one
   * FAILED, $5,996 in total.**
   *
   * Answers **`{ invoices }`** - a fifth envelope shape.
   */
  invoices: () => endpoint('/api/billing/invoices'),
  /**
   * Topping up and what happens at the limit - screen 17d.
   *
   * Answers `{ policy, currency, paygRate }`, and the currency travels even
   * when `policy` is null so an amount can be named before anything is set.
   */
  autoPurchase: () => endpoint('/api/billing/auto-purchase'),
  /** Who the bill is made out to - screen 17e. `{ data }`, and it may be null. */
  profile: () => endpoint('/api/billing/profile'),
  /** What it charges against. Answers `{ paymentMethods }` - a sixth shape. */
  paymentMethods: () => endpoint('/api/billing/payment-methods'),
  /**
   * 17e's Add / Replace card: `{ returnTo: "v2" }` → `{ data: { redirectUrl, sessionId } }` - the
   * provider's hosted page. Creates a client at the provider: behind
   * BILLING_WRITES. 409 `{ error }`: payment_setup_unavailable,
   * payment_page_*, no_billable_entity.
   */
  paymentMethodSession: () => endpoint('/api/billing/payment-methods/session'),
  /**
   * After the hosted page: `{ sessionId }` → `{ data: { status: "STORED",
   * paymentMethod } | { status: "PENDING", reason } }`. Asks the provider;
   * a stored card replaces every other (one active card per tenant).
   */
  paymentMethodConfirm: () => endpoint('/api/billing/payment-methods/confirm'),
  /**
   * Credits, and what happens to them - screen 17c.
   *
   * Carries TWO estimates of what the balance buys: `estimatedRemaining` from
   * the public commercial ratio, and `observedRemaining` from this tenant's
   * own measured burn. The route ships both *"each labelled with its basis"*
   * because *"a screen that silently swapped them would make a pricing claim
   * out of one customer's behaviour"*.
   */
  creditSummary: () => endpoint('/api/billing/credit-summary'),

  /* ── Screen 17b - plan, price and changing it ──────────────────────────── */

  /** The catalogue, the display-currency options and the FX behind an ILS price. */
  pricing: () => endpoint('/api/billing/pricing'),
  /** The current subscription from its stored SNAPSHOT, not the live plan. */
  pricingCurrent: () => endpoint('/api/billing/pricing/current'),
  /**
   * Buyable credit packages for THIS plan.
   *
   * `{ packages: [], eligible: false }` means the plan cannot buy them at all
   * - a different fact from an empty catalogue, and not the customer's fault.
   */
  pricingPackages: () => endpoint('/api/billing/pricing/packages'),
  /** Prices a selection from KEYS. Never accepts a price from the client. */
  pricingQuote: () => endpoint('/api/billing/pricing/quote'),
  /**
   * Apply a change. Owner-gated on `settings:billing:manage`.
   *
   * `/api/billing/subscription/change-plan` above is the SAME service behind a
   * second path - identical body, permission and result, differing only in the
   * error string. Not a dead route this time; a duplicate. This screen uses
   * one of them and the registry records that they are the same thing, so
   * nobody later concludes they are two features.
   */
  pricingChange: () => endpoint('/api/billing/pricing/change'),
  /**
   * Screen 17d - buy a credit pack. REAL MONEY.
   *
   * Owner-gated on `settings:billing:manage`. Accepts only a package KEY, a
   * quantity and an intent key: price and credit amount are read from the
   * catalogue inside `buyCredits()`, never from the request, so a tampered
   * body cannot change what is bought or what it costs.
   *
   * ★ `intentKey` IDENTIFIES ONE PURCHASE THE CUSTOMER DECIDED ON, so a
   * double-click is one charge. It must therefore be minted when the CHOICE
   * is made and not when the button is pressed - a key generated per click
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
   * is NOT this screen's. It filters on `active` alone - no `customerVisible`,
   * no `status`, no plan-eligibility gate - so it can list packages a
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
 * Notifications. Cursor-paginated, and the page is `{ data, nextCursor }` -
 * `data` sits beside the cursor rather than wrapping it, so `raw` is required.
 */
export const notificationEndpoints = {
  list: () => endpoint('/api/notifications'),
  unreadCount: () => endpoint('/api/notifications/unread-count'),
  markRead: (id: string) => endpoint('/api/notifications/{id}/mark-read', { id }),
  markAllRead: () => endpoint('/api/notifications/mark-all-read'),
  /**
   * The signed-in person's own notification preferences - screen 15.
   *
   * Four booleans and a quiet-hours window. NOT the design's 8×3 matrix: the
   * matrix that exists (`NotificationPreference`) is scoped to a tenant and a
   * department and carries recipients, which is a different question.
   */
  preferences: () => endpoint('/api/notification-preferences/me'),
  /**
   * The TENANT's notification rules - event type × channels × recipients,
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
 * Home's conversations (assistant-threads-v1, Backend aef95f69): threads that
 * persist, one answer streamed at a time, resumable and cancellable. A thread
 * is its owner's only - another user's id is a 404 on every route.
 */
export const assistantEndpoints = {
  /** POST `{ scope? }` → 201; GET `?limit&cursor` → `{ data, nextCursor }`. */
  threads: () => endpoint('/api/assistant/threads'),
  /** GET the thread, its messages and `activeRun`; PATCH `{ title?, scope?, archived? }`; DELETE. */
  thread: (id: string) => endpoint('/api/assistant/threads/{id}', { id }),
  /** POST `{ text, locale? }` → the answer as an event stream. */
  messages: (id: string) => endpoint('/api/assistant/threads/{id}/messages', { id }),
  /** GET with `Last-Event-ID` → the rest of a run's events; 410 after 15 minutes. */
  runEvents: (id: string, runId: string) =>
    endpoint('/api/assistant/threads/{id}/runs/{runId}/events', { id, runId }),
  /** POST → 202 cancelling; the stream then ends with `message.done` cancelled. */
  cancel: (id: string, messageId: string) =>
    endpoint('/api/assistant/threads/{id}/messages/{messageId}/cancel', { id, messageId }),
  /** Stage 2: the full list behind a source, `?cursor=`, 25 a page (§9.4). */
  sourceRecords: (id: string, messageId: string, sourceId: string) =>
    endpoint('/api/assistant/threads/{id}/messages/{messageId}/sources/{sourceId}/records', {
      id,
      messageId,
      sourceId,
    }),
} as const;

/**
 * AI employees - the non-human half of Settings · People.
 *
 * `list` answers the entire `AIAgent` row, system prompts included; the
 * contract narrows it deliberately rather than passing it through. See
 * `aiEmployeeSchema`.
 */
/**
 * Business skills (Backend b9278d7e; plan §3.1). Read with
 * `ai:employees:read`, written with `ai:employees:update`. Not
 * `/api/ai-skills`, which is the SYSTEM catalogue.
 *
 *   list    ?includeArchived=&from=   each skill with its `stats`
 *   one     GET ?from= · PUT (only what is sent, version++) · DELETE (archive)
 *   create  POST → 201, `status: draft, version: 1`
 *   runs    ?limit=&cursor=           the viewer's visible conversations only
 *   tools   ?agentId=                 the step editor's tool choices
 *   422     `{ error, field, code: INVALID_SKILL }` - shown at the field
 */
export const skillEndpoints = {
  list: () => endpoint('/api/business-skills'),
  one: (id: string) => endpoint('/api/business-skills/{id}', { id }),
  stats: () => endpoint('/api/business-skills/stats'),
  runs: (id: string) => endpoint('/api/business-skills/{id}/runs', { id }),
  tools: () => endpoint('/api/business-skills/tools'),
  /** GET, and PUT the FULL list `[{skillId, mode?, order?}]` - a missing one is removed. */
  forEmployee: (id: string) => endpoint('/api/ai-agents/{id}/skills', { id }),
  fit: (id: string) => endpoint('/api/ai-agents/{id}/skills/fit', { id }),
  /** PATCH `{ noSkillPolicy }` - not PUT. */
  employee: (id: string) => endpoint('/api/ai-agents/{id}', { id }),
} as const;

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
 * `invite` creates the person, their identity, their role and their team
 * memberships in one call, and emails them. `role` is a TenantRole id (or
 * "AGENT"/"ADMIN"); absent means agent (auth 679b8812). "ADMIN" means Owner
 * since auth 30d610da, and so does the merged Admin role's id; this app sends
 * a role id from the list, never the keyword.
 */
export const memberEndpoints = {
  invite: () => endpoint('/api/agents'),
  loginStatus: () => endpoint('/api/permissions/users/login-status'),
  assignRole: (userId: string, roleId: string) =>
    endpoint('/api/permissions/users/{userId}/roles/{roleId}', { userId, roleId }),
} as const;

/**
 * Channels - screen 13.
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
  /**
   * One row per channel account, with its connection state. Any tenant member;
   * the identifier and last error only for `channels:manage:read`.
   */
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
  /**
   * The callable variant (backend ecd64c4d): asked server side with our
   * session, answers `200 { url }` - the provider's page - or `409
   * { error: 'not_configured' }`, or 403 for a non-admin. The way back lands
   * on `/v2/settings/channels?connected=<p>&count=N` or `?platform=<p>&error=<code>`.
   */
  oauthInitUrl: (platform: string) =>
    endpoint('/api/channels/oauth/init-url?platform={platform}&flow=redesign_studio', {
      platform,
    }),
  /** Creates the widget as PENDING - a draft, not a connected channel. */
  createWebChat: () => endpoint('/api/channels/webchat/create'),
  /** GET / PUT - the widget's config (13g-13j); a PUT merges into what is stored. */
  webchatSettings: (id: string) => endpoint('/api/channels/webchat/{id}/settings', { id }),
  /**
   * GET / PUT - the Website widget (website-widget-v1): one settings object
   * for the workspace, a PUT written to every place it is installed.
   */
  websiteWidget: () => endpoint('/api/website-widget'),
  /** Where it is installed: the code snippet, each Shopify shop, WooCommerce. */
  websiteWidgetInstall: () => endpoint('/api/website-widget/install'),
  /**
   * GET / PUT - who answers the widget, written to THE PLAYBOOK (website-widget-v1
   * §4, Backend 544e8b76). Role ADMIN, like the playbook editor.
   */
  websiteWidgetAssignment: () => endpoint('/api/website-widget/assignment'),
  /**
   * The WooCommerce plugin (woocommerce-plugin-v1, Backend 1e90d585): bind a
   * site from the connect page, remove one from Install, the zip.
   */
  wooPluginBind: () => endpoint('/api/woocommerce-plugin/bind'),
  wooPluginSite: (id: string) => endpoint('/api/woocommerce-plugin/sites/{id}', { id }),
  /** SMTP/IMAP credentials. Stores real secrets; never exercised by a test. */
  connectEmail: () => endpoint('/api/channels/connect/email'),
  disconnect: (id: string) => endpoint('/api/channels/{id}/disconnect', { id }),
  /**
   * The Pages a Messenger grant offered, to choose from (backend 0ce84f21):
   * names and ids, never a token. 410 `SESSION_EXPIRED` for an expired,
   * replaced, another workspace's or another person's session.
   */
  messengerCandidates: (session: string) =>
    endpoint('/api/channels/messenger/candidates?session={session}', { session }),
  /** ★ WRITES: connects the chosen Pages and subscribes them at Meta. */
  messengerSelect: () => endpoint('/api/channels/messenger/select'),

  /* ── Screen 13 - WhatsApp numbers ──────────────────────────────────────
   *
   * Mounted at `/api/channels/whatsapp`, which is a DIFFERENT router from the
   * `/api/channels` list above - the same prefix relationship that made
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
   * Pre-flight - screens 13c/13d. Takes a Meta authorization CODE.
   *
   * Read-only against the customer's assets, and NOT side-effect-free: it
   * spends the single-use code and replaces the tenant's signup session.
   */
  whatsappInspect: () => endpoint('/api/channels/whatsapp/inspect'),
  /**
   * 13c's launch parameters for Meta's Embedded Signup - the server is the
   * single source (app id, config id, response type, extras); a guessed
   * config id is what once produced the wrong signup experience.
   */
  config: (mode?: 'coexistence' | 'new_number') =>
    mode
      ? endpoint('/api/channels/config?mode={mode}', { mode })
      : endpoint('/api/channels/config'),
  /** ★ WRITES at Meta - subscribeApp + register. Never fired automatically. */
  whatsappConnect: () => endpoint('/api/channels/whatsapp/connect'),
  /** Deliberate re-read from Meta. The list is built from stored state. */
  whatsappRefresh: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/refresh', { id }),
  /**
   * Run ONE repair we can actually perform.
   *
   * Only for `availableRepairs`. Never for `customerActions`, which are
   * resolved in Meta - "offering one and having it fail is worse than saying
   * plainly that this one is theirs to fix."
   */
  whatsappRepair: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/repair', { id }),
  /**
   * Supply what the customer was asked for - the register step for error
   * 141000, with their two-step PIN. The ONE blocked state clearable here.
   */
  whatsappResume: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/resume', { id }),
  /** The audit trail for one number. Zero rows on this database. */
  whatsappEvents: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}/events', { id }),
  /**
   * Inbound exclusions. `value` is what was typed, `normalized` is what it
   * matches on - both, because showing only the normalised form makes a
   * person think their rule was rewritten.
   */
  whatsappExclusions: () => endpoint('/api/channels/whatsapp/exclusions'),
  /** DELETE one rule - tenant-scoped on the route; 404 when it is not this workspace's. */
  whatsappExclusion: (id: string) => endpoint('/api/channels/whatsapp/exclusions/{id}', { id }),
  /**
   * ★ DELETE disconnects a number: the channel row goes, and with it the
   * number, its events and its private contacts; conversations and history
   * imports are kept, detached. The account's webhook subscription goes only
   * when it was the last number on it. Never pressed by a test or a capture.
   */
  whatsappNumber: (id: string) => endpoint('/api/channels/whatsapp/numbers/{id}', { id }),
} as const;

/**
 * Voice - a different spine from `channelEndpoints`.
 *
 * Served by the conversation service at `/api/voice-channels`, backed by
 * `CommunicationChannel` → `VoiceChannel` rather than `ChannelAccount`.
 *
 * The router is gated on `Tenant.voiceCopilotEnabled` and answers **404
 * `not_found`** when voice is not offered to a tenant. That 404 is an answer,
 * not a failure: it means "this does not exist for you", and the Channels
 * screen reads it as "do not offer a Phone calls row".
 */
/**
 * Onboarding after the workspace exists - 00d-00h (design 6). The auth
 * service's `/api/onboarding/*`: no tenant-status gate, so they answer while
 * the workspace is still being set up. Surveyed 2026-10-06.
 *
 *   status     GET   the tenant, its profile (websiteDomain), core system
 *   discovery  GET   the scan's row: status, scanPhase, crawl, brand (ADMIN)
 *   discover   POST  `{ domain, locale }` - crawls, synthesises and ingests
 *              in ONE long request; 409 `scan_in_progress` within 3 minutes
 *   teach      POST  `{ label, method: 'text', value, locale }` - an answer
 *              into Knowledge (embedded; re-teaching the same label replaces
 *              it), closes a matching gap, schedules the next-day nudge.
 *              `{ data: { ok: false, reason } }` when it was not learned
 *
 * NOT used: `employee-chat` - it tunes the new employee's persona from the
 * business summary (not Knowledge) and saves the persona and transcript.
 */
export const onboardingEndpoints = {
  status: () => endpoint('/api/onboarding/status'),
  /**
   * The business profile (`organizationName`, `businessDescription`, …) -
   * required by `complete`; the old setup writes it from the confirmed read.
   * 400 once the tenant is ACTIVE.
   */
  businessProfile: () => endpoint('/api/onboarding/business-profile'),
  // Finishing is `goLiveEndpoints.complete` - one name for one route.
  /** 00h (Backend 77da3edd, f4057eaa): ADMIN; a workspace being set up, or ACTIVE. */
  previewQuestions: () => endpoint('/api/ai-assist/onboarding-preview-questions'),
  /** `{ question (1-300), locale? }`; 422 / 429 retryAfterSeconds / 402 `{ code }`. */
  previewAnswer: () => endpoint('/api/ai-assist/onboarding-preview-answer'),
  discovery: () => endpoint('/api/onboarding/discovery'),
  discover: () => endpoint('/api/onboarding/discover'),
  teach: () => endpoint('/api/onboarding/teach'),
} as const;

/**
 * 01c's Go live (Omer, decision 01): the workspace leaves setup mode and
 * GOTCHA answers real customers. `POST /api/onboarding/complete`, ADMIN.
 * `{ skipEmployee: true }` - Go live opens only once an employee is hired,
 * and without it the route hires ANOTHER. Refuses 400 for a missing profile,
 * admin, or `core_system_required`.
 */
/**
 * The payment flow the old app owns (`lib/payment-gate.ts`): the tenant's
 * outstanding checkout, `{ data: { checkout: { reference } | null } }`.
 */
export const checkoutEndpoints = {
  mine: () => endpoint('/api/checkout/mine'),
} as const;

export const goLiveEndpoints = {
  complete: () => endpoint('/api/onboarding/complete'),
} as const;

export const voiceChannelEndpoints = {
  list: () => endpoint('/api/voice-channels'),
  /**
   * 13's Phone calls, bring your own Twilio: `{ friendlyName, accountSid,
   * authToken }` → 201 `{ data: channel }` with the account's numbers. ⚠ A
   * 502 `twilio_discovery_failed` still leaves the channel created (ERROR).
   */
  create: () => endpoint('/api/voice-channels'),
  /** Points one number's webhooks at GOTCHA. Writes at Twilio. */
  activate: (id: string, numberId: string) =>
    endpoint('/api/voice-channels/{id}/numbers/{numberId}/activate', { id, numberId }),
} as const;

/**
 * Business systems - screen 14.
 *
 * `detail` is listed but NOT used: it selects and returns
 * `TenantIntegration.credentials`, the stored integration secret, while the
 * list route excludes it with a comment saying no list view needs it. The
 * contract strips it either way; the screen reads the list.
 */
/** Providers whose redesign flow starts at `/api/integrations/oauth/{slug}/init`. */
const LEGACY_OAUTH_ROUTE = new Set(['zoho_crm', 'google_calendar', 'calendly']);

export const integrationEndpoints = {
  list: () => endpoint('/api/integrations'),
  detail: (slug: string) => endpoint('/api/integrations/{slug}', { slug }),
  tools: (slug: string) => endpoint('/api/integrations/{slug}/tools', { slug }),
  /**
   * 10's Connect (Omer, 2026-10-04): `{ credentials }`, encrypted at rest, and
   * the connection is CONNECTED with the catalogue's default tools. Stores real
   * secrets; no test reaches it.
   */
  connect: (slug: string) => endpoint('/api/integrations/{slug}/connect', { slug }),
  /**
   * Disconnect (connectors-admin.ts): the row goes DISCONNECTED and its
   * credentials are emptied; `TenantTool` rows are left, so the action
   * settings survive. Answers `{ ok: true }` (not enveloped). Chosen over
   * `POST /api/integrations/:slug/disconnect`, which DELETES those tool rows -
   * and `/connect`'s update branch never recreates them, so a form system
   * reconnected after it would have no actions at all.
   */
  disconnect: (slug: string) => endpoint('/api/connectors/{slug}/disconnect', { slug }),
  /**
   * OAuth at the provider, returning to THIS app (backend 381a5d1b): the
   * `redesign_studio` flow lands on `/v2/studio/capabilities?system=<slug>`
   * with `connected=1` or `error=<code>`. Answers `{ url }` (not enveloped).
   * Salesforce takes the login host; Shopify re-authorises the store already
   * connected and refuses 409 without one.
   */
  oauthInit: (slug: string, loginHost?: string) =>
    loginHost
      ? endpoint('/api/connectors/{slug}/oauth/init?flow=redesign_studio&loginHost={loginHost}', {
          slug,
          loginHost,
        })
      : LEGACY_OAUTH_ROUTE.has(slug)
        ? // Zoho, Google Calendar and Calendly start from the older routes (backend e7523379).
          endpoint('/api/integrations/oauth/{slug}/init?flow=redesign_studio', { slug })
        : endpoint('/api/connectors/{slug}/oauth/init?flow=redesign_studio', { slug }),
  /**
   * B: WooCommerce through the store's own approval - the store address only,
   * answered `{ url }` (`format=json`); 400 `invalid_store_url`. Lands on
   * `?system=woocommerce&connected=1|error=<code>`.
   */
  /**
   * Shopify, started from here (backend 98676242). No store is typed:
   * Shopify picks it. `availability` is read-only (`{ mode, helpUrl }`);
   * `start` mints an intent and answers it IN A COOKIE (`gotcha_shopify_intent`),
   * which the server hands on to the browser; `pending`/`claim` read the
   * pending install from the browser's `gotcha_shopify_pending` cookie.
   */
  shopifyAvailability: () => endpoint('/api/connectors/shopify/install/availability'),
  shopifyStart: () => endpoint('/api/connectors/shopify/install/start?flow=redesign_studio'),
  shopifyPending: () => endpoint('/api/connectors/shopify/install/pending'),
  shopifyClaim: () => endpoint('/api/connectors/shopify/install/claim'),
  /**
   * Back from Shopify's plan page (backend bb4acc12 lands it on 10 with
   * `?billing=verify&shop=`). Re-reads the subscription from Shopify; `shop`
   * goes as a query and is compared, never trusted. 409 `shopify_shop_mismatch`
   * / `shopify_not_connected`, 502 `shopify_verification_failed` (nothing
   * changed). Answers the access snapshot.
   */
  shopifyBillingComplete: () => endpoint('/api/billing/shopify/complete'),
  wooOAuthInit: (storeUrl: string) =>
    endpoint(
      '/api/integrations/woocommerce/oauth/init?storeUrl={storeUrl}&flow=redesign_studio&format=json',
      { storeUrl },
    ),
  /** The same key flow from the plugin's connect page: it comes back to /connect/woocommerce. */
  wooOAuthInitPlugin: (storeUrl: string) =>
    endpoint(
      '/api/integrations/woocommerce/oauth/init?storeUrl={storeUrl}&flow=wp_plugin&format=json',
      { storeUrl },
    ),
  /**
   * Screens 14b/14c - the use case, the parts, who CAN serve each and who
   * DOES. Never connects anything; connecting stays in the marketplace.
   *
   * A part nothing could ever serve reports `available: false` with a
   * reason, which is a different fact from an empty candidate list.
   */
  businessCore: () => endpoint('/api/integrations/business-core'),
  /**
   * Screen 14c - elect the system that plays a part.
   *
   * DISPLACES rather than refusing when the part is already taken, and
   * answers with what it replaced so the screen can name it. Refuses a
   * system that is not CONNECTED, and refuses the CRM outright with
   * `CRM_ELECTED_ELSEWHERE` - that one is `PUT /:slug/crm-source`.
   */
  electRole: () => endpoint('/api/integrations/business-core/role'),
  /**
   * 14b: what the business runs on - `PUT { useCase }`, one of ecommerce /
   * leads / both; 422 otherwise. Same permission as electing a part.
   */
  useCase: () => endpoint('/api/integrations/business-core/use-case'),
} as const;

/**
 * The tenant's tool policy - AUTHORITATIVE over an integration's activation.
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
 * Security - screen 16.
 *
 * Sessions and login history are served from AUTHENTIK, not from our
 * `UserSession` table, so they carry a real IP and a GeoIP city where our own
 * column carries only a hash. Both answer `{ available, … }` and degrade to
 * `available: false` rather than to an empty list.
 */
export const securityEndpoints = {
  /**
   * The signed-in person and their workspace - screen 11d.
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
   * `/api/tenant/security` - a SLASH, and it is an exception.
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
   * section now says when it cannot read its data - which is the other half of
   * the fix.
   */
  tenantSecurity: () => endpoint('/api/tenant/security'),
  auditLogs: () => endpoint('/api/audit-logs'),
  /** The real action vocabulary with counts - not a taxonomy we invented. */
  auditActions: () => endpoint('/api/audit-logs/actions'),
} as const;

/**
 * Approvals - screen 03. `conversation_service` in both gateway templates
 * (`gateway/…:752`, `nginx/…:636`).
 *
 * The route file holds seven handlers; **two of them are not ours.**
 * `/:id/dispatch-approved` and `/:id/dispatch-rejected` sit above the
 * `authenticate` middleware behind `requireInternalKey` - service-to-service
 * dispatch hooks, deliberately unreachable from a browser session. They are
 * absent here on purpose, the way the five dev-only gateway routes are.
 *
 * `list` takes **one** status and defaults to PENDING (`where = { tenantId,
 * status }`), with no date filter of any kind, `take: 100`, newest first. So
 * "what you decided today" is one call per status, narrowed on our side, and
 * only as far back as the most recent 100 rows of each - a real ceiling on a
 * busy tenant, and not one the screen may pretend away.
 *
 * `detail` answers a bare `{ approval, conversation, contact, recentMessages }`
 * - not `{ data }`. Third envelope shape in this platform.
 */
export const approvalEndpoints = {
  list: (status?: string) =>
    status ? endpoint('/api/approvals?status={status}', { status }) : endpoint('/api/approvals'),
  detail: (id: string) => endpoint('/api/approvals/{id}', { id }),
  approve: (id: string) => endpoint('/api/approvals/{id}/approve', { id }),
  reject: (id: string) => endpoint('/api/approvals/{id}/reject', { id }),
  /**
   * Re-runs a dispatch that ran and FAILED. It runs the action **forward** -
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
 * Customers - screen 04. `conversation_service` in both gateway templates.
 *
 * **`list` is deliberately the segment route, not `GET /api/contacts`.** That
 * one is a CRM proxy search: it requires a connected CRM *and* a non-empty
 * query, returns `{ data: [], total: 0 }` otherwise, and its `meta.total` is
 * `rows.length`. This tenant's only integration is Shopify (ECOMMERCE, ERROR),
 * so it can never answer with a customer here.
 *
 * `segment` queries the local `Contact` table, answers a real
 * `prisma.contact.count`, and has a `countOnly` mode. Its rule vocabulary has
 * thirteen cases and **no name case** - searching by name is not currently
 * possible against the local table, and is requested.
 */
export const customerEndpoints = {
  /** POST. Body `{ rules?, channel?, countOnly? }`. */
  list: () => endpoint('/api/contacts/segment'),
  /**
   * POST `{ externalId, channel, displayName?, email?, phone? }` → `{ data }`.
   * ⚠ An UPSERT on (channel, externalId): an existing contact's fields are
   * overwritten. 04's Add looks the person up first.
   */
  create: () => endpoint('/api/contacts'),
  /**
   * 04's rows in bulk (backend 63985641 / 01bb7b6e). Each takes at most 100
   * ids. The commerce three answer `source: null` + `reason` when there is no
   * store to read - never zeros - and `data` sits BESIDE `source`, so they
   * are read `raw`.
   *   commerceSummary  ?contactIds= → { source, truncated, data: {[id]: summary} }
   *   commerceSegments              → { source, truncated, total, counts }
   *   byOrder          ?number=     → { source, contactId | null, orderNumber }
   *   insights         ?ids=        → { data: {[id]: insight | null} }
   *   tags  POST { contactIds, add?, remove? } → { data: {[id]: tags} }, all or nothing
   */
  commerceSummary: () => endpoint('/api/commerce-context/customers/commerce-summary'),
  commerceSegments: () => endpoint('/api/commerce-context/customers/segments'),
  byOrder: () => endpoint('/api/commerce-context/customers/by-order'),
  /** Backend e30900fd - one person's orders, Woo or Shopify. See `customerOrdersSchema`. */
  contactOrders: (contactId: string) =>
    endpoint('/api/commerce-context/customers/{contactId}/orders', { contactId }),
  insights: () => endpoint('/api/contacts/insights'),
  tags: () => endpoint('/api/contacts/tags'),
  detail: (id: string) => endpoint('/api/contacts/{id}', { id }),
  /**
   * Screen 04b's timeline. CONTACT-keyed, and the only one of the three
   * reads that takes the id the list hands us.
   *
   * Follows `mergedIntoId`, gathers sibling contacts and aliases preserved
   * from prior merges - so this genuinely is every channel on one spine.
   * What it is NOT is complete: 50 conversations, newest 5 messages each,
   * and `type: "message"` is the whole event union. See
   * `contracts/customer-detail.ts`.
   */
  timeline: (id: string) => endpoint('/api/identity/{id}/timeline', { id }),
  /**
   * The person's conversations with their status (and much else, unread
   * here) - UNENVELOPED: `{ contact, conversations, … }`. 04b colours its
   * timeline by it: open and theirs last is "needs attention", closed is
   * resolved.
   */
  identityInsights: (id: string) => endpoint('/api/identity/{id}/insights', { id }),
  /**
   * Backend ed8f3e1f - every channel's conversations for one person, newest
   * first, each with its stored one-line summary. `?limit=&current=<id>` marks
   * the open one `isCurrent`. `{ data, total, hasMore }`; `total` counts only
   * what this viewer may see. 404: no such contact.
   */
  conversations: (contactId: string) =>
    endpoint('/api/identity/{contactId}/conversations', { contactId }),
  /**
   * The written character summary. A **POST**, and it requires a
   * `conversationId` - customer-level intelligence behind a
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
   * nowhere else, so a human agent opening the same chat saw nothing" -
   * which is the failure this whole redesign exists to stop repeating.
   *
   * Returns facts as `{ text, category, confidence }` only:
   * `evidenceConversationIds` is written and returned by no route.
   */
  memory: (externalId: string) =>
    endpoint('/api/historical-imports/customer-context?externalId={externalId}', { externalId }),
  /**
   * The CRM panel for one conversation - 04b reads `recent_crm_notes` from it.
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
   * Screen 04d - this customer's orders from the connected store.
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
   * taken from a customer page would leave a wrong audit trail - and the
   * audit trail is the thing those actions exist to leave behind.
   */
  orders: (conversationId: string) =>
    endpoint('/api/commerce-context/{conversationId}', { conversationId }),
  /**
   * Screen 04d's order actions - cancel, refund, return, exchange. REAL MONEY.
   *
   * The best-guarded write in the platform: permission, ownership
   * re-validation, business policy, optional approval, idempotent adapter
   * call, provider-result validation, post-action verify, audit. *"There is
   * NO second frontend-to-Shopify execution path."*
   *
   * Conversation-keyed, and that is acceptable HERE because the audit's
   * subject is `targetType: "customer" | "order"` with the conversation in
   * free-form metadata as context. Contrast `createNote`, where the
   * conversation IS the attribution in the merchant's own CRM.
   *
   * ⚠ NOTHING AUTOMATED MAY CALL THIS.
   */
  orderAction: (conversationId: string) =>
    endpoint('/api/commerce-context/{conversationId}/actions', { conversationId }),
  /**
   * Screen 04e - what was done in this customer's context.
   *
   * ★ A DIFFERENT GATE FROM ITS THREE SIBLINGS, ON PURPOSE.
   * `crm:contacts:read` **or** `ADMIN` - whoever can open screen 04. The
   * other three `/audit-logs` routes keep `settings:workspace:update` or
   * ADMIN, and the export deliberately stays there: one constant gated all
   * four, and widening it in place would have handed every agent a CSV of
   * the whole workspace log.
   *
   * `?shopifyCustomerId=` is what makes customer-keyed rows attributable -
   * `targetId` on those is the PROVIDER's customer id and this endpoint
   * cannot derive one from a contact. The value comes from the verified
   * commerce context, never from anything client-supplied.
   *
   * Answers `{ contact, data, nextCursor, coverage, scope }`. `coverage` is
   * a CONSTANT describing what is attributable in principle - see
   * `coverageGaps`, which is why it takes what we actually sent.
   */
  audit: (contactId: string) => endpoint('/api/audit-logs/customer/{contactId}', { contactId }),
  /**
   * Screen 04f - the team's notes about this person.
   *
   * ★ CONTACT-KEYED, which is the whole reason the stub was replaced: it was
   * keyed on a conversation, and *"a note is about a person, and the person
   * outlives the thread."* So this does NOT go through `readKeyFor`, and the
   * write prohibition recorded there does not reach it.
   *
   * Answers `{ notes, contactId }` - **no `data` envelope**, checked at the
   * route rather than assumed either way.
   *
   * ⚠ NO PERMISSION GATE ON THE ROUTER. `authenticate, resolveTenant,
   * requireActiveTenant()` and nothing more. Authorship is enforced per-note
   * on PATCH and DELETE (`not_the_author`), not by a permission.
   */
  notes: (contactId: string) => endpoint('/api/identity/{contactId}/notes', { contactId }),
  /**
   * One note. PATCH edits it, DELETE soft-deletes it - the row stays, because
   * *"a customer's history should not develop holes."*
   *
   * ⚠ AUTHOR ONLY. Both answer 403 `not_the_author` for anybody else, so the
   * screen must offer these controls only to the author or it is offering a
   * button that fails.
   */
  note: (contactId: string, noteId: string) =>
    endpoint('/api/identity/{contactId}/notes/{noteId}', { contactId, noteId }),
} as const;

/**
 * Cross-channel identity - the merge the design shows as *suggested, never
 * silent*. `resolve` proposes, `merge` acts, and a person confirms in between.
 */
export const identityEndpoints = {
  resolve: () => endpoint('/api/identity/resolve'),
  merge: () => endpoint('/api/identity/merge'),
  /**
   * 04's "Not the same" (conversation e5a56fd3): GET the marked pairs
   * (`crm:contacts:read`), POST `{ contactIds: [a, b] }` to mark one
   * (`crm:contacts:update`; idempotent; 404 CONTACT_NOT_FOUND, 409
   * ALREADY_SAME_PERSON). A later merge of the pair clears the mark.
   */
  notSame: () => endpoint('/api/identity/not-same'),
  /**
   * 04's "Two accounts look like one person" (Backend 83579ac8): GET the
   * pending pairs (`crm:contacts:read`), each with both customers' labels.
   * `?status=APPLIED` lists the automatic links instead; 04 draws no place
   * for those, so nothing here asks for them.
   */
  suggestions: () => endpoint('/api/identity/suggestions'),
  /**
   * POST `{ contactIds: [a, b] }`: link a pair a person approved as one
   * person (`crm:contacts:update`). 400 TWO_CONTACTS_REQUIRED, 404
   * CONTACT_NOT_FOUND, 409 NOT_SAME. Both contacts stay; no field changes.
   */
  acceptSuggestion: () => endpoint('/api/identity/suggestions/accept'),
  /** F1 (Backend 196fea72): who this customer is linked to, and how (`crm:contacts:read`). */
  links: (contactId: string) => endpoint('/api/identity/links/{contactId}', { contactId }),
  /**
   * POST `{ contactIds: [a, b] }` - the link row's own `unlink` body
   * (`crm:contacts:update`). 404 NOT_LINKED, 400 TWO_CONTACTS_REQUIRED.
   */
  unlink: () => endpoint('/api/identity/unlink'),
  timeline: (id: string) => endpoint('/api/identity/{id}/timeline', { id }),
} as const;

/**
 * Outreach - screens 05 and 05b. `conversation_service` in both templates.
 *
 * **There is no pause and no resume.** `cancel` is the only thing that stops a
 * send: it removes the queued jobs, marks every pending recipient `"skipped"`,
 * sets `completedAt`, and leaves the campaign `CANCELLED` with no path back to
 * `SENDING`. It accepts `SENDING` and `SCHEDULED` only, and answers 400
 * otherwise.
 *
 * `validate` is a real pre-send check against the actual audience and channel.
 * It is what the design drew as *"Waiting for your approval"* - a state with
 * no field on `Broadcast`, and one that cannot borrow `ApprovalRequest`, whose
 * own schema comment says it is exclusively the bot path.
 */
export const outreachEndpoints = {
  /** GET the list; POST creates a DRAFT (Omer, 2026-10-04: drafts only). */
  list: () => endpoint('/api/broadcasts'),
  detail: (id: string) => endpoint('/api/broadcasts/{id}', { id }),
  recipients: (id: string) => endpoint('/api/broadcasts/{id}/recipients', { id }),
  /** Answers "will this actually send?" without sending anything. */
  validate: (id: string) => endpoint('/api/broadcasts/{id}/validate', { id }),
  /** TERMINAL. Drains the queue and skips everyone still pending. */
  cancel: (id: string) => endpoint('/api/broadcasts/{id}/cancel', { id }),
  resend: (id: string) => endpoint('/api/broadcasts/{id}/resend', { id }),
  /**
   * SENDS - to real people. Only a DRAFT or SCHEDULED one; 400 with why
   * (no recipients, no channel…). A WhatsApp campaign only with a real WABA
   * (Omer's ruling), which the screen checks before offering it.
   */
  send: (id: string) => endpoint('/api/broadcasts/{id}/send', { id }),
} as const;

/**
 * Message templates - screen 05c. ADMIN on every verb.
 *
 * `list` paginates properly: `{ data, total, page, limit }` with a real
 * `prisma.messageTemplate.count`, and filters on channel, status and category.
 *
 * **No `include` for the `broadcasts` relation**, so usage count and reply
 * rate are unserved rather than impossible - the join exists on the model.
 */
export const templateEndpoints = {
  /** GET the list; POST creates a local template (a DRAFT; not sent to Meta). */
  list: () => endpoint('/api/templates'),
  detail: (id: string) => endpoint('/api/templates/{id}', { id }),
  duplicate: (id: string) => endpoint('/api/templates/{id}/duplicate', { id }),
  /** Sends it to Meta for review. The state changes; no ETA comes back. */
  submit: (id: string) => endpoint('/api/templates/{id}/submit-to-meta', { id }),
  /**
   * The two templates every WhatsApp number needs (Backend 7e91418b). GET
   * `?channelAccountId=`: each role's state on that number and `canSubmit`.
   * POST `{ channelAccountId, role, language, body?, button?, submit? }`
   * saves the DRAFT; only `submit: true` on a connected number sends it to
   * Meta for review (409 NUMBER_NOT_CONNECTED otherwise, still saved). An
   * approved or pending one answers 409 ALREADY_SUBMITTED: Outreach edits it.
   * ADMIN (Owner) only. `/api/templates/sync` is deliberately not here.
   */
  required: () => endpoint('/api/templates/required'),
} as const;

/**
 * Phone calls - screens 05d and 05e.
 *
 * **Every route here is behind `voiceCopilotGate`**, which answers 404 for the
 * whole router when `tenant.voiceCopilotEnabled` is false. A 404 from the gate
 * is indistinguishable from a missing route, so the screen asks
 * `tenantSettings` - which is NOT behind the gate - before interpreting one.
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
  /*
   * 05d / 05e writes (Omer, 2026-10-04). The same calls the old frontend
   * makes (`ChatCenter/frontend/src/lib/api.ts`).
   */
  /** `{ to, conversationId?, notes? }` → `{ mode: IN_PLATFORM | AGENT_FIRST, … }`. */
  startOutbound: () => endpoint('/api/voice-sessions/start-outbound'),
  hangup: (id: string) => endpoint('/api/voice-sessions/{id}/hangup', { id }),
  /** `{ to, label? }` - a third party into the conference. */
  addParticipant: (id: string) => endpoint('/api/voice-sessions/{id}/add-participant', { id }),
  /** `{ hold }` - the customer on hold music while you consult. */
  customerHold: (id: string) => endpoint('/api/voice-sessions/{id}/customer-hold', { id }),
  /** Cold transfer: the agent's leg drops; customer and third party stay. */
  agentLeave: (id: string) => endpoint('/api/voice-sessions/{id}/agent-leave', { id }),
} as const;

/**
 * Tenant feature flags, deliberately OUTSIDE the voice gate.
 *
 * This is how the screen tells *"voice is not switched on here"* from *"the
 * route is missing"* - two conditions that answer 404 identically.
 */
export const tenantSettingsEndpoints = {
  read: () => endpoint('/api/tenant-settings'),
} as const;

/**
 * AI employees - Studio, screen 07.
 *
 * `list` returns each employee enriched with three conversation counts, its
 * knowledge sources, its department and when it was last tested. The counts
 * exclude sandbox rows and setup rehearsals; imported history is excluded by
 * the platform's own default rather than restated.
 *
 * **`PATCH /:id` is how pause and resume happen** - `{ status }`. There is no
 * retire: `AIAgentStatus` is ACTIVE | DRAFT | PAUSED.
 */
export const employeeEndpoints = {
  list: () => endpoint('/api/ai-agents'),
  detail: (id: string) => endpoint('/api/ai-agents/{id}', { id }),
  /** Pause and resume both go through here, as `{ status }`. */
  update: (id: string) => endpoint('/api/ai-agents/{id}', { id }),
  /** `{ hasCanvas, reachable }` - is this employee wired into the routing? */
  reachability: (id: string) => endpoint('/api/ai-agents/{id}/reachability', { id }),
  /**
   * `{ allowed, choices }` - the business systems this employee may use, and
   * every one the workspace has set up (Backend 00c6c229). Written as
   * `PATCH /:id { integrationAccess }`, which replaces the list.
   */
  integrationAccess: (id: string) => endpoint('/api/ai-agents/{id}/integration-access', { id }),
} as const;

/**
 * What GOTCHA knows - Studio, screen 08.
 *
 * `sources` (at `/api/knowledge-bases`) returns each knowledge base with its documents, including
 * `updatedAt`, which the route's comment says *"drives last refreshed"*.
 *
 * `unanswered` is the newer of two routes over the same `UnansweredQuestion`
 * table - the other lives in analytics. Both read the same rows; this one has
 * the naming fixes, `timesAsked` and `distinctAskers`, and filters on reason
 * and resolved-versus-open.
 */
export const knowledgeEndpoints = {
  /**
   * **`/api/knowledge-bases`, not `/api/knowledge`.** Both are mounted in
   * `services/ai/src/index.ts` - `:109` carries the list router and `:111`
   * carries Confluence/Drive OAuth, which declares no `GET /`.
   *
   * Both are in the gateway allowlist, so both proxy cleanly and **both
   * answer 401 unauthenticated**: the service authenticates before it routes.
   * A 401 proves the upstream resolved. It does not prove the route exists,
   * and only an authenticated request tells them apart - this one was wrong
   * for a whole screen before a capture found it.
   */
  sources: () => endpoint('/api/knowledge-bases'),
  unanswered: () => endpoint('/api/knowledge/unanswered-questions'),
  /**
   * 08's Answer (Backend c5c5d6ed + d645751f): `{ answer }` (1-20000, kept as
   * typed) into the knowledge every employee answers from, and the question
   * resolved. Waits while it is learned; 502 NOT_LEARNED leaves it open.
   * ai:knowledge:write or ADMIN; 404 for another workspace's id.
   */
  answerUnanswered: (id: string) =>
    endpoint('/api/knowledge/unanswered-questions/{id}/answer', { id }),
  /**
   * 08b's "Add knowledge" (Omer, 2026-10-04). Writes the knowledge every AI
   * employee answers from; each document is embedded in the background.
   *
   *   createBase  `POST /api/knowledge-bases` `{ name }` - only when the
   *               tenant has none to add to (entitlement + capacity gated).
   *   addDocument `{ title, content, sourceType: 'text' }`, or
   *               `{ sourceType: 'url', sourceUrl }` - the server reads the
   *               page (SSRF-hardened) and refuses 400 when it cannot.
   *   upload      multipart `file` (+ `title`): PDF, DOCX, DOC, MD, TXT, 10 MB.
   */
  createBase: () => endpoint('/api/knowledge-bases'),
  /**
   * Drive or Confluence at the provider, returning HERE (backend df9ee4cd):
   * `/v2/studio/knowledge?add=1&way=drive|confluence&connected=1|error=<code>`.
   * Answers `{ url }` (not enveloped). ADMIN only; `kbId` required.
   */
  /** 08b after connecting: the base's Drive / Confluence connections. `{ data: [...] }`. */
  integrations: (kbId: string) => endpoint('/api/knowledge/kb/{kbId}/integrations', { kbId }),
  /** One level of a Drive, folders first. `folderId` absent: the root. */
  driveFiles: (intId: string, folderId?: string) =>
    folderId
      ? endpoint('/api/knowledge/integrations/{intId}/drive/files?folderId={folderId}', {
          intId,
          folderId,
        })
      : endpoint('/api/knowledge/integrations/{intId}/drive/files', { intId }),
  /** `{ sources: [{ id, kind, name, mimeType }] }` - folders and files not mixed. Learns them. */
  driveSync: (intId: string) =>
    endpoint('/api/knowledge/integrations/{intId}/drive/sync', { intId }),
  /** What is kept in sync, with its state. */
  driveSources: (intId: string) =>
    endpoint('/api/knowledge/integrations/{intId}/drive/sources', { intId }),
  confluenceSpaces: (intId: string) =>
    endpoint('/api/knowledge/integrations/{intId}/confluence/spaces', { intId }),
  /** `{ spaceKeys }` - learns those spaces' pages. */
  confluenceSync: (intId: string) =>
    endpoint('/api/knowledge/integrations/{intId}/confluence/sync', { intId }),
  /**
   * DELETE: disconnects a Drive or Confluence - the connection row goes, so
   * its sync stops; what it already taught stays (`removeData=1`, never sent
   * here, would delete Drive's documents too). Answers `{ data: { deleted } }`.
   */
  removeIntegration: (intId: string) => endpoint('/api/knowledge/integrations/{intId}', { intId }),
  /**
   * The provider's page for a base that exists (`kbId`), or for a NEW base
   * the callback creates only once the provider's grant works (`newBaseName`,
   * ai c6c6309a) - so a connect abandoned at the provider leaves no empty base.
   */
  oauthInit: (
    provider: 'google-drive' | 'confluence',
    target: { readonly kbId: string } | { readonly newBaseName: string },
  ) =>
    'kbId' in target
      ? endpoint('/api/knowledge/oauth/{provider}/init?kbId={kbId}&flow=redesign_studio', {
          provider,
          kbId: target.kbId,
        })
      : endpoint(
          '/api/knowledge/oauth/{provider}/init?newBaseName={newBaseName}&flow=redesign_studio',
          { provider, newBaseName: target.newBaseName },
        ),
  addDocument: (baseId: string) => endpoint('/api/knowledge-bases/{baseId}/documents', { baseId }),
  upload: (baseId: string) =>
    endpoint('/api/knowledge-bases/{baseId}/documents/upload', { baseId }),
  /**
   * K6's drawer: one document (ai 67d267f0, `knowledge.ts` GET
   * `/:id/documents/:docId`). `{ data: { …, content (20k at most), truncated,
   * ai: { sectionCount, sections, sectionsTruncated, facts: null } } }`;
   * 404 when it is not in this tenant AND this base, 403 without
   * `ai:knowledge:read`.
   *
   * K11: the same path edits and deletes it - both `ai:knowledge:write` or
   * ADMIN. PUT `{ title?, content?, manualEdit? }` answers the row plus
   * `reprocessing`; DELETE drops its vectors and the row, `{ deleted: true }`.
   * See `document-actions.ts` for what each really does.
   */
  document: (baseId: string, docId: string) =>
    endpoint('/api/knowledge-bases/{baseId}/documents/{docId}', { baseId, docId }),
  /**
   * Screen 08's conflicts, and the reason they need an import id first.
   *
   * ★ CONFLICT DETECTION RUNS INSIDE THE HISTORICAL-IMPORT PIPELINE ONLY.
   * `knowledge-clustering.stage.ts` queries
   * `where: { importId, tenantId, status: "PENDING" }` - so conflicts belong
   * to an import, not to the tenant, and there is no tenant-wide read of
   * them. Nothing looks at live conversations or at a document uploaded
   * afterwards, which the screen has to say rather than imply.
   *
   * Answers `{ imports: [...] }`, newest first, capped at 20.
   */
  imports: () => endpoint('/api/historical-imports'),
  /**
   * One import's knowledge candidates. Answers `{ candidates, counts }`.
   *
   * Conflicts are ordered first by the route itself - *"they are the only
   * items where doing nothing is the wrong answer"* - and `variants` is sent
   * only on a conflicted row (`c.conflict ? c.variants : null`).
   */
  candidates: (importId: string) =>
    endpoint('/api/historical-imports/{importId}/candidates', { importId }),
  /**
   * Resolve a conflict - screen 08's hero.
   *
   * ⚠ THIS WRITES THE TENANT KNOWLEDGE BASE EVERY AI EMPLOYEE ANSWERS FROM.
   * Gated on `ai:knowledge:write` or ADMIN, so a 403 is a real state rather
   * than a fault.
   *
   * A conflicted candidate is refused with `conflict_requires_answer` unless
   * the body names the chosen answer - the route will not *"silently enshrine
   * whichever variant happened to be most common"*. Which is what makes
   * resolving it a one-tap act: the tap supplies the answer.
   *
   * ★★ THE BODY KEY IS `answer`, NOT `editedAnswer`. `editedAnswer` is the
   * handler's local variable and the column it lands in; the line that reads
   * the request says `req.body?.answer`. See `APPROVE_BODY_KEY` - the wrong
   * key makes this route refuse every conflicted row, which is every row the
   * button exists for.
   *
   * Three other refusals, each a different repair: `no_knowledge_base` (there
   * is nowhere to write), `already_covered` with a 409 (the base already
   * answers this - not a failure, and it marks the candidate), and the 403
   * above. `force` skips the duplicate check and **this product never sends
   * it**.
   *
   * ⚠ `{ ok: true }` does not mean the AI can answer with it - the embedding
   * failure is caught and discarded inside the route. See `documentUseOf`.
   */
  approveCandidate: (candidateId: string) =>
    endpoint('/api/historical-imports/candidates/{candidateId}/approve', { candidateId }),
  /**
   * 13f's "Add the N ready ones" (Omer): every waiting, unconflicted answer at
   * the server's floor, up to 100 - `{ approved, skipped }`.
   */
  bulkApprove: (importId: string) =>
    endpoint('/api/historical-imports/{importId}/bulk-approve', { importId }),
  /**
   * 13f's "Run the analysis again" (Omer). ⚠ It DELETES this import's
   * suggestions (decided ones too) and customer memories, then reads the
   * imported conversations again. Approved answers already in Knowledge stay.
   * 409 with why when the import has not settled.
   */
  rerun: (importId: string) =>
    endpoint('/api/historical-imports/{importId}/rerun-intelligence', { importId }),
  /**
   * 13f's "See the chats": every exchange behind one suggestion, newest first,
   * at most 50 - `{ evidence: [{ question, answer, occurredAt, variantKey,
   * conversationId }] }`. Reads need `ai:knowledge:read` (or ADMIN).
   */
  evidence: (candidateId: string) =>
    endpoint('/api/historical-imports/candidates/{candidateId}/evidence', { candidateId }),
  /**
   * One imported thread (origin HISTORICAL_IMPORT only; 404 otherwise), its
   * first 500 messages. Private contacts were never imported
   * (`isInboundExcluded` at ingest), so none can be opened here.
   */
  importedThread: (conversationId: string) =>
    endpoint('/api/historical-imports/conversations/{conversationId}/messages', {
      conversationId,
    }),
  /**
   * 13f's "Preview five": the import's customers, most messages first (the
   * route takes 100) - `{ customers: [...] }`.
   */
  importCustomers: (importId: string) =>
    endpoint('/api/historical-imports/{importId}/customers', { importId }),
  /** What was learned about one imported customer: `{ memory: { facts, summary } | null }`. */
  importCustomerMemory: (customerId: string) =>
    endpoint('/api/historical-imports/customers/{customerId}/memory', { customerId }),
  /** 13f's Reject / Skip: `{ ok: true }`; 404 when gone or already decided. */
  rejectCandidate: (candidateId: string) =>
    endpoint('/api/historical-imports/candidates/{candidateId}/reject', { candidateId }),
} as const;

/**
 * Automations - Studio, 09c / 09d / 09e (design 6). `/api/automations`
 * (chatbot service; Backend 87456663, contract v1). Reads: any member.
 * Writes `ai:workflows:update`; activate / pause `ai:workflows:publish`.
 *
 *   list       ?status=live|paused|draft      `{ data }`, `path` per row
 *   one        GET · PUT (`expectedUpdatedAt`; 409 stale; 422 if live and
 *              it would not validate - nothing stored) · DELETE
 *   activate   `{ data, warnings }` or 422 `{ error, errors, warnings }`
 *   pause      `{ data }` with pausedAt / pausedBy
 *   validate   `{ errors, warnings }` for an unsaved canvas
 *   catalog    ?channel=&after=&automationId=  (09e)
 *   runs       ?limit=&cursor=&status=   `{ data, nextCursor }`
 *   run        one run with its steps
 *   nodeStats  ?days=   `{ data: { [nodeId] }, days }`
 *
 * `/api/chatbot-flows` answers 409 for an automation: never written here.
 */
export const automationEndpoints = {
  list: () => endpoint('/api/automations'),
  create: () => endpoint('/api/automations'),
  one: (id: string) => endpoint('/api/automations/{id}', { id }),
  validate: (id: string) => endpoint('/api/automations/{id}/validate', { id }),
  activate: (id: string) => endpoint('/api/automations/{id}/activate', { id }),
  pause: (id: string) => endpoint('/api/automations/{id}/pause', { id }),
  catalog: () => endpoint('/api/automations/catalog'),
  runs: (id: string) => endpoint('/api/automations/{id}/runs', { id }),
  run: (runId: string) => endpoint('/api/automations/runs/{runId}', { runId }),
  nodeStats: (id: string) => endpoint('/api/automations/{id}/node-stats', { id }),
  /** GET `?workflowId=` → `{ data | null }`; POST `{ workflowId }` (ADMIN), idempotent. */
  webhookTriggers: () => endpoint('/api/webhook-triggers'),
} as const;

/**
 * What GOTCHA is allowed to do - Studio, screen 10.
 *
 * `list` merges adapter tool specs with the tenant's stored permissions.
 * Seventeen rows here, every one a platform default.
 *
 * **`riskGroup` on those rows is a regex over the tool's NAME**, computed at
 * response time by `riskGroupFor` - not stored, not assessed, and
 * `create_update` is its no-match fallback.
 */
export const capabilityEndpoints = {
  list: () => endpoint('/api/tool-permissions'),
  /** PUT, ADMIN or `ai:tools:manage`. One tool at a time. */
  update: (toolName: string) => endpoint('/api/tool-permissions/{toolName}', { toolName }),
} as const;

/**
 * Screen 02 · the Inbox.
 *
 * ★ PASS `cursor` TO GET KEYSET. Without it the route paginates by OFFSET,
 * and on a recency ordering a new message between pages shows a duplicate
 * and **silently skips one** - somebody waiting who never appears.
 *
 * With a cursor it orders `{ lastMessageAt: desc, nulls: last }` with a
 * `(timestamp, id)` tiebreak and answers `{ data, page: { limit, hasMore,
 * nextCursor } }`. The cursor encodes the literal string "null" for a row
 * with no timestamp, and the predicate has a branch for the null tail - so
 * the undated rows at the end of the queue are paged through correctly
 * rather than repeating or vanishing.
 */
export const inboxEndpoints = {
  list: () => endpoint('/api/conversations'),
  /** One conversation, every column - 03c reads its `customerName`. */
  conversation: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}', { conversationId }),
  messages: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/messages', { conversationId }),

  /**
   * The AI's suggested replies for one conversation.
   *
   * ⚠ ENTITLEMENT-GATED on `ai.copilot`, so a **402** here is an ordinary state
   * and not a fault - Foundation denies Copilot. Its neighbour `/summary` is
   * gated on a DIFFERENT key (`communication.crm_summaries`), so having one and
   * not the other is a plan combination the product sells.
   *
   * A read. It costs a model call, which is why the route dedupes on
   * `x-request-instance-id`, but it writes nothing.
   */
  suggestions: (conversationId: string) =>
    endpoint('/api/ai-assist/{conversationId}/suggestions', { conversationId }),
  /**
   * POST `{ locale? }` - the agent's "Try again", and nothing else ever calls
   * it (Backend 9c5e96cc). 15s per conversation, 20 per agent per 10 min:
   * 429 `REFRESH_RATE_LIMITED` with `retryAfterSeconds`.
   */
  /**
   * Backend cd504002 - what the AI is GIVEN about this customer, from the
   * same loaders the prompt renders from: `{ data: { conversationId, facts:
   * [{key, value, confidence, source, observedAt}], historical: { summary,
   * facts } | null } }`. Keyed on the conversation; 404 outside the tenant.
   */
  /** Backend ed0f1c9c - the AI's steps here, newest first. See `contracts/ai-activity.ts`. */
  aiActivity: (conversationId: string) =>
    endpoint('/api/ai-assist/{conversationId}/ai-activity', { conversationId }),
  customerMemory: (conversationId: string) =>
    endpoint('/api/ai-assist/{conversationId}/customer-memory', { conversationId }),
  suggestionsRefresh: (conversationId: string) =>
    endpoint('/api/ai-assist/{conversationId}/suggestions/refresh', { conversationId }),

  /**
   * Drafts or refines ONE outbound message from a plain-language instruction.
   *
   * `{ instruction, surface, conversationId, currentDraft, locale? }` →
   * `{ data: { text } }`. With `surface: 'inbox'` and a conversation, the
   * route reads the last twenty messages itself, so "the customer's language"
   * is something the instruction can ask for. Nothing is sent: the text comes
   * back for a person to read.
   */
  compose: () => endpoint('/api/ai-assist/compose'),

  /**
   * ⚠⚠ SENDS A MESSAGE TO A REAL PERSON. `POST` on the same path as the stream.
   *
   * `{ body, replyToMessageId?, emailReplyMode?, subject? }`, `body` min 1.
   *
   * ★★ A 201 MEANS QUEUED, NOT DELIVERED. The route enqueues onto
   * `outgoingMessageQueue` and answers; delivery happens later, asynchronously,
   * through a path this response cannot see. The row lands as `PENDING` and
   * becomes `SENT`/`DELIVERED`/`FAILED` afterwards, which is why `Message.status`
   * had to reach the contract before this endpoint was worth having.
   *
   * ★★ AND THE ROUTE CHECKS LESS THAN YOU WOULD EXPECT. No assignment check -
   * an agent who has not taken the conversation can send.
   *
   * ★ THE SEND WINDOW IS CHECKED NOW (Backend 47e376a4): outside it the route
   *   answers 409 `{ code: "TEMPLATE_REQUIRED" | "REPLY_WINDOW_CLOSED",
   *   replyWindow }` and stores nothing. Failing open: an unreadable window
   *   lets the send go, and the outgoing worker (and Meta) still decide.
   *
   * Its outcomes: 201; 404 no such conversation; 400 the quoted message is
   * not in this conversation; 400 the channel is not configured for this
   * tenant; 409 the window, above.
   */
  sendMessage: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/messages', { conversationId }),

  /**
   * ⚠⚠ SENDS A FILE TO A REAL PERSON, AND IT SENDS ON UPLOAD.
   *
   * `multipart/form-data`: one `file`, and `body` (or `caption`) as its
   * caption. There is no draft step on the server - the request IS the send -
   * so the composer holds the chosen file and posts it only when Send is
   * pressed.
   *
   * ⚠ The route caps a file at 16MB with busboy's `fileSize`, which
   *   TRUNCATES rather than refuses: an oversized file would go out cut short
   *   with a 201. The composer refuses above the cap before posting.
   *
   * ⚠ It also requires `credentials.accessToken` on the channel account and
   *   answers 400 "Channel not configured" without one - so channels that
   *   authenticate otherwise may refuse files while accepting text.
   */
  sendMedia: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/messages/media', { conversationId }),

  /**
   * The approved templates of this conversation's WhatsApp number (Backend
   * 47e376a4): `{ data: [{ id, name, language, category, body, headerType,
   * headerContent, footer, buttons, placeholders: [{ key, sample }] }] }`,
   * `[]` when the channel is not WhatsApp. A read.
   */
  replyTemplates: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/reply-templates', { conversationId }),

  /**
   * ⚠⚠ SENDS AN APPROVED WHATSAPP TEMPLATE TO A REAL PERSON (Backend 47e376a4).
   *
   * `{ templateId, variables?: { "1": "Dana" } }` → 201 `{ data: message }`
   * (queued, like every send); 409 `TEMPLATE_NOT_USABLE` (not approved for
   * this number); 400 `TEMPLATES_WHATSAPP_ONLY`; 400 channel not configured;
   * 404. No window check: a template is what may go out past it. A blank
   * variable is filled by the route with its sample, then "-", so the
   * composer refuses to send one blank.
   */
  sendTemplate: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/messages/template', { conversationId }),

  /* ── Screen 02's three verbs ─────────────────────────────────────────── */

  /**
   * Take control - *"קבל שליטה"*.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ⚠ THIS CAN SEND A MESSAGE TO THE CUSTOMER
   * ════════════════════════════════════════════════════════════════════════
   * `claim()` ends with `sendAutoGreeting(...)`, whose comment reads *"send
   * on both claim and reclaim"*. If the tenant has an `autoGreeting` durable
   * setting, claiming enqueues a real outbound message on the customer's
   * channel with the agent's name in it. **No test and no capture may press
   * this**, for the same reason as `connect` and `resume`: dev sends real
   * traffic.
   *
   * 409 when somebody else already holds it. Re-claiming your own is allowed
   * and is a no-op for the assignment - but it greets the customer again, so
   * the control is not drawn when the conversation is already yours.
   *
   * Sets `isHandedOver: true` and writes an `agent_claimed` system message.
   */
  claim: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/claim', { conversationId }),

  /**
   * Return to the AI. The inverse of a takeover, and the only thing that
   * clears the `isHandedOver` latch - *"which nothing else in the system ever
   * clears"*.
   *
   * 409 when no AI employee is bound to the conversation: there is nobody to
   * hand back to, and the screen has to say that rather than offer a control
   * that always fails.
   */
  returnToAi: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/return-to-ai', { conversationId }),

  /**
   * Stop the AI without assigning anyone (backend 3e7bae17) - the right-click's
   * "Stop AI". Sets `isHandedOver`, assigns nobody, records an `ai_stopped`
   * handover and writes an `ai_stopped` system message with no name in it.
   * Unlike `claim`, it greets nobody. 404 when there is no such conversation.
   */
  stopAi: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/stop-ai', { conversationId }),

  /**
   * Put a conversation back in the queue - the design's *"requeue"*.
   *
   * ★★ ADDED FOR THE RIGHT-CLICK MENU, AND MEASURED RATHER THAN ASSUMED.
   * `POST /api/conversations/{id}/release`, `conversationService.release`.
   * Its OpenAPI entry is BYTE-IDENTICAL to `claim`'s on the request body -
   * `required: false`, no Zod schema, `additionalProperties: true` - and
   * `claim` is called with `{}` in production today. Same route family, same
   * declared shape, one of them proven.
   *
   * ⚠ The schema says "shape is not verifiable from source", so `{}` is the
   *   measured-adjacent choice rather than a documented one.
   */
  release: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/release', { conversationId }),

  /**
   * Mark a conversation resolved - the design's *"resolve"*.
   *
   * `POST /api/conversations/{id}/close`, `conversationService.close`, and the
   * same request-body story as `release` above.
   */
  close: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/close', { conversationId }),

  /**
   * Transfer to a named colleague. `{ agentId }`.
   *
   * ★ 403 UNLESS IT IS YOURS OR YOU ARE ADMIN. The route checks
   * `conv.assignedAgentId !== userId` for non-admins, so the control belongs
   * on a conversation the viewer holds and nowhere else.
   *
   * Also accepts `{ departmentId }`, which this product does not send - Omer
   * ruled transfers go to a named person. The platform writes a
   * `department_transferred` divider for that path, which the stream renders,
   * because another client can cause it.
   *
   * ⚠ ALSO GREETS THE CUSTOMER, from the new agent, by the same helper.
   */
  reassign: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/reassign', { conversationId }),

  /**
   * ⚠⚠ DELETES THE CONVERSATION AND EVERY MESSAGE IN IT. No undo.
   *
   * ADMIN and SYSTEM_ADMIN only (403 otherwise). A conversation that is not
   * CLOSED is refused with 400 unless `?force=true` - Omer's ruling is that
   * deleting an active one forces, so the menu sends it for those.
   */
  remove: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}', { conversationId }),

  /**
   * Read state FOR THE PERSON CALLING, not for the workspace (Backend
   * 7b69c714, `services/conversation/src/routes/conversations.ts:275,304`).
   *
   *   POST    sets `markedUnread = true`; leaves `lastReadAt` alone
   *   DELETE  sets `markedUnread = false` and `lastReadAt = now` - what
   *           opening a conversation sends
   *
   * Both upsert one `ConversationReadState` row keyed on (user, conversation)
   * and answer `{ data: <that row> }`. 404 for a conversation outside the
   * tenant, or one this viewer may not see (`router.param("id",
   * requireVisibleConversation)` - the list's own visibility rule). No
   * permission and no assignment check beyond that: anyone who can see the
   * conversation can mark it for themselves.
   */
  unread: (conversationId: string) =>
    endpoint('/api/conversations/{conversationId}/unread', { conversationId }),

  /**
   * ⚠⚠ AGREED, NOT YET DEPLOYED (supervisor, 2026-10-11; Backend 0190bd4e is
   *    building it). Until it ships the route answers 404 - and it must be
   *    registered before `GET /:id` (routes/conversations.ts:166), which
   *    would read "unread-counts" as an id. Every failure is "no count",
   *    never a 0.
   *
   * `GET ?views=queue,mine,…` → `{ data: { <view>: n } }`: how many
   * conversations in each view are unread for the person calling. Every
   * `InboxView` id is accepted; an unknown view is a 400, so only real ids
   * are sent. See `unreadCountsSchema`.
   */
  unreadCounts: () => endpoint('/api/conversations/unread-counts'),

  /**
   * The people a conversation can be transferred to.
   *
   * ★ UNGATED BEYOND SIGNING IN. `services/auth/src/routes/agents.ts:29` has
   * no `requirePermission` - only `authenticate`, `resolveTenant` and MFA. So
   * unlike `/api/analytics/agents` (which needs `analytics:workspace:read`
   * and would be empty for most of the people who need to transfer), every
   * member can read it.
   *
   * ⚠ TWO THINGS IT DOES AND DOES NOT CONTAIN.
   * `where: { role: "AGENT" }` - **admins are not in this list**, so a
   * conversation cannot be transferred to one from screen 02, although
   * `reassign` would accept them.
   *
   * And it includes DEACTIVATED people. `reassign` checks only that the user
   * exists in the tenant, so transferring to somebody who cannot sign in
   * succeeds and strands the conversation - assigned to nobody who can act,
   * with no unassign to recover it. The screen filters on `isActive`; the
   * platform will not.
   *
   * Answers a bare array, no envelope.
   */
  agents: () => endpoint('/api/agents'),

  /**
   * Is an auto-greeting configured? ADMIN only (`requireRole("ADMIN")`).
   *
   * Read so screen 02 can tell an agent whether taking control will message
   * the customer - and a 403 here is the ordinary case, not a fault, because
   * most people pressing that button are agents. It becomes "we could not
   * ask", which is its own sentence.
   */
  autoGreeting: () => endpoint('/api/agents/settings/auto-greeting'),

  /**
   * ⚠⚠ `POST /:id/release` EXISTS AND IS DELIBERATELY NOT LISTED ABOVE.
   *
   * It is the "put back in the queue" the design drew, and Omer ruled it out:
   * a human who has taken a conversation may hand it back to the AI or to a
   * named colleague, never drop it.
   *
   * The platform agrees, by accident. `release()` clears `assignedAgentId`
   * and **does not clear `isHandedOver`** - so a released conversation has no
   * human and the AI is still latched off it. Nobody is driving, and nothing
   * on any screen says so. The rule prevents a real defect rather than
   * expressing a preference.
   */
} as const;

export type { Endpoint as ApiEndpoint };
export { endpoint as defineEndpoint };
