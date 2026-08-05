/**
 * Integration framework - shared adapter contract + helpers.
 *
 * Every concrete provider adapter (Stripe, HubSpot, Shopify, Airtable, etc.)
 * implements this interface. The dispatcher resolves the adapter for a
 * tool call, asks it to execute, and threads the result back to the LLM.
 *
 * Auth + token refresh + status updates flow through the helpers below so
 * each adapter stays small (one file, ~150-300 LOC of provider logic).
 */

import { prisma, encryptCredentials, decryptCredentials } from "@chatcenter/shared";

export interface ToolDefinition {
  /** Tool function name surfaced to the LLM (e.g. "stripe.refund_payment"). */
  name: string;
  /** What the tool does, plain English. */
  description: string;
  /** "Use this tool when …" - informs the model's selection. */
  whenToUse: string;
  /** "Do NOT call this tool when …" - guardrails. */
  whenNotToUse?: string;
  /** OpenAI function-calling parameters schema. */
  parameters: Record<string, unknown>;
  /** Free-text description of side effects (e.g. "creates a refund - irreversible"). */
  sideEffects?: string;
  /** Free-text idempotency notes (e.g. "uses (charge_id, amount) as key - safe to retry"). */
  idempotencyNotes?: string;
  /** "READ" | "WRITE" | "DELETE" | "ACTION". Drives permission filtering. */
  category: "READ" | "WRITE" | "DELETE" | "ACTION";
  /** "LOW" | "MEDIUM" | "HIGH". HIGH-risk tools default-require approval. */
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  /**
   * How much this tool matters when the surface must be cut, 0-100 (default 50).
   *
   * OpenAI hard-rejects more than 128 tools, so a merchant with many enabled
   * integrations loses some. That cut used to run alphabetically from the end,
   * which is unrelated to usefulness: on the Urban Supply store it silently
   * removed `shopify.variant_information`, so "do you have this in a 159?" -
   * one of the most common questions a shopper asks - had no tool behind it,
   * and the model answered with a generic catalogue dump instead.
   *
   * Higher survives. Reserve 90+ for the handful of tools a customer
   * conversation genuinely cannot work without.
   */
  priority?: number;
  /**
   * Provider OAuth scopes this tool needs (e.g. ["write_customers"]).
   * When a connection's known-missing scopes (config.missingScopes on the
   * TenantIntegration row) intersect these, the framework short-circuits
   * execution locally and the bot tool surface hides the tool - so the AI
   * never proposes an action the provider will 403 forever.
   */
  requiredScopes?: string[];
  /**
   * Declared for the catalog but NOT executable on this provider's REST API.
   *
   * A tool whose handler always throws must never reach a permission screen:
   * offering Autonomous / HITL / Disabled for something that can only ever
   * fail asks an admin to make a decision that has no effect, and the failure
   * only surfaces later as a raw provider error in front of a customer.
   */
  unsupported?: string;
}

export interface AdapterContext {
  tenantId: string;
  /** TenantIntegration row id - caller resolves this from slug. */
  tenantIntegrationId: string;
  /** Optional conversation/contact for audit + idempotency keys. */
  conversationId?: string;
  contactId?: string;
}

export interface ProviderAdapter {
  /** Catalog slug, e.g. "stripe". */
  readonly slug: string;
  /** List the tools this adapter exposes. Static - same shape for every tenant. */
  tools(): ToolDefinition[];
  /**
   * Execute a tool call. The framework guarantees:
   *   - tenant integration is CONNECTED
   *   - credentials are decrypted + accessToken is fresh (auto-refreshed if OAuth)
   *   - args are validated against the tool's parameters schema (best-effort)
   * The adapter returns a result the LLM can read. Errors throw - the dispatcher
   * catches and surfaces a structured failure to the model.
   */
  execute(opts: {
    ctx: AdapterContext;
    toolName: string;
    args: Record<string, unknown>;
    credentials: Record<string, any>;
    config: Record<string, any>;
  }): Promise<unknown>;
  /**
   * (Optional) Can this action still happen, given the provider's CURRENT
   * state? Consulted BEFORE an approval request is raised.
   *
   * Eligibility is provider knowledge, and checking it at execution time is
   * too late: a customer asked to cancel an order that was already cancelled,
   * and the pipeline dutifully told them "I'm handling your cancellation now",
   * raised an approval, and put a real decision in front of a real person for
   * an action that could not change anything. The same shape - propose,
   * approve, discover it was impossible - is how a fulfilled order burned an
   * approval before this existed.
   *
   * `call` runs another of this provider's READ tools through the normal
   * framework path (credentials, refresh, rate limit, audit), so the check
   * reconciles against live state rather than against what the model believed.
   *
   * Returning `alreadySatisfied` distinguishes "this cannot happen" from "this
   * has already happened" - the customer is owed different sentences, and only
   * the second one is good news.
   */
  precheckEligibility?(opts: {
    toolName: string;
    args: Record<string, unknown>;
    call: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  }): Promise<{ eligible: true } | { eligible: false; reason: string; alreadySatisfied?: boolean }>;
  /**
   * (Optional) Prove the stored credential actually works, without needing a
   * tool call. This is the connection-lifecycle probe: `/test` and the OAuth
   * callbacks use it to decide CONNECTED vs ERROR.
   *
   * Why it exists: the fallback probe ("call the first READ tool with `{}`")
   * is wrong for any provider whose read tools have required arguments -
   * google_calendar.list_events demands from_iso/to_iso, so that provider
   * could never pass a test and was permanently marked ERROR. Adapters with
   * argument-hungry read tools should implement this with a cheap identity
   * call (e.g. `me {}`) instead.
   *
   * Returns `{ok:true}` when the provider accepted the credential, or
   * `{ok:false, error}` with a SAFE, user-facing reason (never a raw token or
   * full provider payload). Adapters that can enumerate their OAuth grants
   * additionally return `grantedScopes`/`missingScopes` so the framework can
   * persist capability state proactively (see refreshCapabilityState).
   */
  validate?(opts: {
    ctx: AdapterContext;
    credentials: Record<string, any>;
    config: Record<string, any>;
  }): Promise<{ ok: boolean; error?: string; grantedScopes?: string[]; missingScopes?: string[] }>;
  /**
   * (Optional) This adapter's refreshTokens can also EXCHANGE a legacy
   * credential blob that has an accessToken but no refreshToken (one-way
   * provider-side migration). Lets a forced refresh reach refreshTokens even
   * without a refresh token.
   */
  readonly migratesLegacyCredentials?: boolean;
  /**
   * (Optional) Refresh OAuth tokens. Called by the framework when accessToken
   * is expired. Returns the new credentials blob - framework persists it.
   */
  refreshTokens?(credentials: Record<string, any>): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    scope?: string;
  }>;
}

// ─── Connection helpers ──────────────────────────────────────

const TOKEN_REFRESH_BUFFER_MS = 60_000;

/**
 * Load the connected TenantIntegration row for a tenant + slug.
 * Returns null if not connected. Decrypts credentials.
 */
export async function loadConnection(opts: { tenantId: string; slug: string }): Promise<{
  tenantIntegrationId: string;
  credentials: Record<string, any>;
  config: Record<string, any>;
  status: string;
  expiresAt: Date | null;
} | null> {
  // Load CONNECTED *or* ERROR integrations. An OAuth integration whose access
  // token merely expired latches to ERROR, but it is recoverable via its refresh
  // token - excluding ERROR here is what created the deadlock (ERROR → never
  // loaded → never refreshed → stays ERROR forever). We load it and let
  // ensureFreshToken / the 401-retry recover it. DISCONNECTED stays excluded.
  // Prefer a CONNECTED row when both somehow exist (CONNECTED < ERROR lexically).
  const ti = await (prisma as any).tenantIntegration.findFirst({
    where: {
      tenantId: opts.tenantId,
      status: { in: ["CONNECTED", "ERROR"] },
      integration: { slug: opts.slug },
    },
    orderBy: { status: "asc" },
    include: { integration: true },
  });
  if (!ti) return null;
  let credentials: Record<string, any> = {};
  try {
    credentials = typeof ti.credentials === "string"
      ? decryptCredentials(ti.credentials)
      : (ti.credentials || {});
  } catch (err: any) {
    console.warn(`[integration-framework] failed to decrypt creds for ${opts.slug}:`, err?.message);
    credentials = {};
  }
  return {
    tenantIntegrationId: ti.id,
    credentials,
    config: ti.config || {},
    status: ti.status,
    expiresAt: credentials?.expiresAt ? new Date(credentials.expiresAt) : null,
  };
}

/**
 * Persist updated credentials for an integration. Encrypts before write.
 * Use this from refreshTokens flows - never write plaintext credentials.
 */
export async function persistCredentials(opts: {
  tenantIntegrationId: string;
  credentials: Record<string, any>;
}): Promise<void> {
  await (prisma as any).tenantIntegration.update({
    where: { id: opts.tenantIntegrationId },
    data: { credentials: encryptCredentials(opts.credentials) },
  });
}

/**
 * Update the connection status. Adapters call this when they detect an
 * unrecoverable auth failure so the marketplace card reflects reality and
 * the bot drops the tools next turn.
 */
export async function setConnectionStatus(opts: {
  tenantIntegrationId: string;
  status: "CONNECTED" | "ERROR" | "DISCONNECTED";
  lastError?: string;
}): Promise<void> {
  await (prisma as any).tenantIntegration.update({
    where: { id: opts.tenantIntegrationId },
    data: {
      status: opts.status,
      lastError: opts.lastError ?? null,
      lastTestedAt: new Date(),
      lastTestResult: opts.status === "CONNECTED",
    },
  });
}

/**
 * Ensure access token is fresh; refresh when within the buffer. Returns
 * the credentials object the adapter should use for this call.
 */
export async function ensureFreshToken(opts: {
  tenantIntegrationId: string;
  credentials: Record<string, any>;
  adapter: ProviderAdapter;
  /** Refresh regardless of expiry buffer (used by the 401-retry path and to
   * recover an integration that latched to ERROR). */
  force?: boolean;
  /** Current integration status; when "ERROR", a successful refresh recovers
   * it to CONNECTED so the tool surfaces again next turn. */
  currentStatus?: string;
}): Promise<Record<string, any>> {
  const expiresAt = opts.credentials?.expiresAt ? new Date(opts.credentials.expiresAt) : null;
  // `expiresAt - now < buffer` is also true for an ALREADY-expired token
  // (negative diff), so an expired token refreshes on use, not just one nearing
  // expiry. `force` covers the case where we have no/garbled expiry or are
  // recovering from a 401.
  const needsRefresh = opts.force || (expiresAt ? expiresAt.getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS : false);
  // Without a refresh token the adapter normally can't rotate - EXCEPT
  // adapters that declare `migratesLegacyCredentials`: for those, a FORCED
  // refresh (401-retry / ERROR recovery) still reaches refreshTokens, which is
  // the seam where a legacy credential shape is exchanged in place (e.g.
  // Shopify's non-expiring → expiring token exchange).
  const canAttempt =
    !!opts.credentials.refreshToken ||
    (opts.force && !!opts.adapter.migratesLegacyCredentials && !!opts.credentials.accessToken);
  if (!needsRefresh || !opts.adapter.refreshTokens || !canAttempt) {
    return opts.credentials;
  }
  try {
    const fresh = await opts.adapter.refreshTokens(opts.credentials);
    const next = {
      ...opts.credentials,
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken || opts.credentials.refreshToken,
      expiresAt: fresh.expiresAt?.toISOString(),
      scope: fresh.scope || opts.credentials.scope,
    };
    await persistCredentials({ tenantIntegrationId: opts.tenantIntegrationId, credentials: next });
    // A refresh that reports its granted scope string proves those scopes are
    // now available - clear any of them from the known-missing capability
    // state so gated tools resurface.
    if (fresh.scope) {
      await clearMissingScopes(opts.tenantIntegrationId, fresh.scope).catch((err: any) =>
        console.warn(`[integration-framework] missing-scope clear failed for ${opts.adapter.slug}:`, err?.message));
    }
    // Self-heal: a successful refresh proves the integration works again.
    if (opts.currentStatus === "ERROR") {
      await setConnectionStatus({ tenantIntegrationId: opts.tenantIntegrationId, status: "CONNECTED" });
      console.log(`[integration-framework] recovered ${opts.adapter.slug} ERROR→CONNECTED via token refresh`);
    }
    return next;
  } catch (err: any) {
    // Only a refresh FAILURE (e.g. revoked/invalid refresh token) is a real,
    // unrecoverable error - a mere access-token expiry is handled above.
    await setConnectionStatus({
      tenantIntegrationId: opts.tenantIntegrationId,
      status: "ERROR",
      lastError: `token_refresh_failed:${err?.message || "unknown"}`,
    });
    throw new Error(`Token refresh failed for ${opts.adapter.slug}: ${err?.message || "unknown"}`);
  }
}

// ─── Missing-scope capability state ─────────────────────────
//
// Some providers (Shopify) stay CONNECTED while the merchant never granted a
// specific OAuth scope - every call then fails with "requires merchant
// approval for <scope> scope" until the shop re-authorizes. Retrying is pure
// noise (HTTP + adapter.err audit spam every turn). We persist the
// known-missing scopes on the TenantIntegration row (config.missingScopes,
// no schema change) so that:
//   - executeAdapterTool short-circuits locally (no HTTP, no audit row);
//   - the bot tool surface drops tools that can never execute (ai-bot.service);
//   - the state self-heals when adapter.validate() passes (the /test route)
//     or a token refresh comes back with the scope granted.

const MISSING_SCOPE_RE = /requires merchant approval for (\w+) scope|missing[^"']*\bscope/i;

/** Read the known-missing scopes off a TenantIntegration config blob. */
export function missingScopesFromConfig(config: Record<string, any> | null | undefined): string[] {
  const v = config?.missingScopes;
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
}

/** True when the tool declares a scope the connection is known to be missing. */
export function toolBlockedByMissingScopes(def: ToolDefinition, missing: string[]): boolean {
  if (!def.requiredScopes?.length || !missing.length) return false;
  return def.requiredScopes.some((s) => missing.includes(s));
}

/**
 * Parse a provider error into the scope(s) it proves missing. The named
 * capture wins; a generic "missing … scope" message falls back to the tool's
 * declared requiredScopes (the ones the failing call needed).
 */
export function extractMissingScopes(message: string, tool?: ToolDefinition): string[] {
  const m = MISSING_SCOPE_RE.exec(message || "");
  if (!m) return [];
  if (m[1]) return [m[1]];
  return tool?.requiredScopes ?? [];
}

/** Read-modify-write config.missingScopes. No-op when nothing changes. */
async function updateMissingScopes(
  tenantIntegrationId: string,
  mutate: (current: string[]) => string[],
): Promise<void> {
  const row = await (prisma as any).tenantIntegration.findUnique({
    where: { id: tenantIntegrationId },
    select: { config: true },
  });
  const cfg: Record<string, any> =
    row?.config && typeof row.config === "object" ? { ...row.config } : {};
  const current = missingScopesFromConfig(cfg);
  const next = Array.from(new Set(mutate(current)));
  if (next.length === current.length && next.every((s) => current.includes(s))) return;
  if (next.length) cfg.missingScopes = next;
  else delete cfg.missingScopes;
  await (prisma as any).tenantIntegration.update({
    where: { id: tenantIntegrationId },
    data: { config: cfg },
  });
}

/** Idempotent merge of newly-proven-missing scopes into config.missingScopes. */
export async function addMissingScopes(tenantIntegrationId: string, scopes: string[]): Promise<void> {
  if (!scopes.length) return;
  await updateMissingScopes(tenantIntegrationId, (cur) => [...cur, ...scopes]);
}

/**
 * Clear missing-scope state. With `grantedScope` (a provider scope string like
 * "read_orders,write_customers") only the scopes it proves granted are
 * removed; without it, everything clears (used after a fully-passing
 * adapter.validate() probe).
 */
export async function clearMissingScopes(tenantIntegrationId: string, grantedScope?: string): Promise<void> {
  const granted = grantedScope
    ? new Set(grantedScope.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))
    : null;
  await updateMissingScopes(tenantIntegrationId, (cur) =>
    granted ? cur.filter((s) => !granted.has(s)) : []);
}

// ─── Proactive capability discovery ─────────────────────────
//
// Missing scopes must be discovered BEFORE a customer request trips over
// them, not after. refreshCapabilityState() runs the adapter's validate()
// probe and persists a capability snapshot on the connection config:
//
//   config.capabilityState = {
//     grantedScopes: string[],   // what the provider says is granted
//     lastCheckedAt: ISO string, // freshness anchor
//     status: "ok" | "missing_scopes" | "error",
//   }
//   config.missingScopes stays the single enforcement source (surface gate +
//   pre-flight short-circuit read it).
//
// Trigger points: the OAuth callback right after connect/reconnect, the
// integration "/test" button, a token refresh whose scope string proves
// grants, and a freshness re-check fired from the bot tool surface when the
// snapshot is older than CAPABILITY_FRESHNESS_MS - so stale scope data is
// never trusted indefinitely.

export const CAPABILITY_FRESHNESS_MS = 6 * 60 * 60 * 1000; // 6h

export function capabilityStateFromConfig(
  config: Record<string, any> | null | undefined,
): { grantedScopes: string[]; lastCheckedAt: string | null; status: string | null } {
  const cs = config?.capabilityState;
  return {
    grantedScopes: Array.isArray(cs?.grantedScopes) ? cs.grantedScopes : [],
    lastCheckedAt: typeof cs?.lastCheckedAt === "string" ? cs.lastCheckedAt : null,
    status: typeof cs?.status === "string" ? cs.status : null,
  };
}

export function capabilityStateIsFresh(config: Record<string, any> | null | undefined): boolean {
  const { lastCheckedAt } = capabilityStateFromConfig(config);
  if (!lastCheckedAt) return false;
  const age = Date.now() - new Date(lastCheckedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < CAPABILITY_FRESHNESS_MS;
}

/**
 * Run the adapter's validate() probe and persist the capability snapshot.
 * Safe to fire-and-forget: failures record status:"error" without touching
 * the enforcement state (fail toward the last KNOWN state, never toward
 * silently trusting an unverified one).
 */
export async function refreshCapabilityState(opts: {
  /**
   * Catalog slug (TenantIntegration.integration.slug), which is also the
   * adapter registry key. There used to be an `adapterSlug` escape hatch for
   * the one adapter registered under a different name (postgres vs
   * postgresql); that adapter was renamed, because the divergence broke
   * loadConnection() everywhere the escape hatch was not threaded through.
   */
  tenantId: string;
  slug: string;
}): Promise<{ ok: boolean; missingScopes: string[] }> {
  const adapter = getAdapter(opts.slug);
  const conn = await loadConnection({ tenantId: opts.tenantId, slug: opts.slug });
  if (!adapter?.validate || !conn) return { ok: false, missingScopes: [] };
  let verdict: Awaited<ReturnType<NonNullable<ProviderAdapter["validate"]>>>;
  try {
    verdict = await adapter.validate({
      ctx: { tenantId: opts.tenantId, tenantIntegrationId: conn.tenantIntegrationId },
      credentials: conn.credentials,
      config: conn.config,
    });
  } catch (err: any) {
    verdict = { ok: false, error: err?.message || "validation threw" };
  }
  const missing = verdict.missingScopes ?? [];
  try {
    const row = await (prisma as any).tenantIntegration.findUnique({
      where: { id: conn.tenantIntegrationId },
      select: { config: true },
    });
    const cfg: Record<string, any> = row?.config && typeof row.config === "object" ? { ...row.config } : {};
    cfg.capabilityState = {
      grantedScopes: verdict.grantedScopes ?? capabilityStateFromConfig(cfg).grantedScopes,
      lastCheckedAt: new Date().toISOString(),
      status: verdict.ok ? "ok" : missing.length ? "missing_scopes" : "error",
    };
    // Enforcement state: a probe that ENUMERATED scopes is authoritative in
    // both directions. A probe that errored without enumeration keeps the
    // last known missingScopes untouched.
    if (verdict.grantedScopes || missing.length) {
      if (missing.length) cfg.missingScopes = missing;
      else delete cfg.missingScopes;
    } else if (verdict.ok) {
      delete cfg.missingScopes;
    }
    await (prisma as any).tenantIntegration.update({
      where: { id: conn.tenantIntegrationId },
      data: { config: cfg },
    });
  } catch (err: any) {
    console.warn(`[integration-framework] capability snapshot persist failed for ${opts.slug}:`, err?.message);
  }
  return { ok: !!verdict.ok, missingScopes: missing };
}

// ─── Rate limiter ────────────────────────────────────────────
//
// In-process token-bucket per (tenantId, providerSlug). Prevents runaway
// loops + protects tenant quotas. Defaults are deliberately generous (one
// call per second sustained, burst of 10) - provider 429s are still surfaced
// to the LLM as ok:false for it to back off.
//
// For multi-instance deployments this should move to Redis; today the bot
// runs as a single process so in-process is correct.

interface BucketState { tokens: number; lastRefillMs: number; }
const RATE_BUCKETS = new Map<string, BucketState>();
const RATE_CAPACITY = Number(process.env.ADAPTER_RATE_BURST ?? 10);
const RATE_REFILL_PER_MS = Number(process.env.ADAPTER_RATE_REFILL_PER_SEC ?? 1) / 1000;

function checkRateLimit(tenantId: string, slug: string): { allowed: boolean; retryAfterMs?: number } {
  const key = `${tenantId}:${slug}`;
  const now = Date.now();
  const b = RATE_BUCKETS.get(key) ?? { tokens: RATE_CAPACITY, lastRefillMs: now };
  // Refill since last check.
  const elapsed = now - b.lastRefillMs;
  b.tokens = Math.min(RATE_CAPACITY, b.tokens + elapsed * RATE_REFILL_PER_MS);
  b.lastRefillMs = now;
  if (b.tokens < 1) {
    RATE_BUCKETS.set(key, b);
    const retryAfterMs = Math.ceil((1 - b.tokens) / RATE_REFILL_PER_MS);
    return { allowed: false, retryAfterMs };
  }
  b.tokens -= 1;
  RATE_BUCKETS.set(key, b);
  return { allowed: true };
}

/** Test-only: drop all rate buckets. */
export function __resetRateLimits() { RATE_BUCKETS.clear(); }

// ─── Audit log ───────────────────────────────────────────────

async function auditAdapterCall(opts: {
  tenantId: string;
  conversationId?: string;
  contactId?: string;
  toolFunctionName: string;
  args: Record<string, unknown>;
  ok: boolean;
  reason?: string;
  durationMs: number;
}): Promise<void> {
  try {
    await (prisma as any).auditLog?.create?.({
      data: {
        tenantId: opts.tenantId,
        actorType: "ai",
        action: `adapter.${opts.ok ? "ok" : "err"}.${opts.toolFunctionName}`,
        targetType: opts.conversationId ? "conversation" : "tenant",
        targetId: opts.conversationId ?? opts.tenantId,
        metadata: {
          tool: opts.toolFunctionName,
          // Strip obvious secrets from args before persisting.
          args: scrubSecrets(opts.args),
          ok: opts.ok,
          reason: opts.reason,
          durationMs: opts.durationMs,
          source: "integration-framework",
        },
      },
    });
  } catch (err: any) {
    // Audit failures must never break tool dispatch.
    console.warn("[integration-framework] audit log failed:", err?.message);
  }
}

function scrubSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE = /(password|secret|api[_-]?key|token|connection[_-]?string|consumer[_-]?secret)/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (SENSITIVE.test(k)) out[k] = "***";
    else if (typeof v === "string" && v.length > 200) out[k] = v.slice(0, 200) + "…";
    else out[k] = v;
  }
  return out;
}

// ─── Adapter registry ────────────────────────────────────────

const REGISTRY = new Map<string, ProviderAdapter>();

export function registerAdapter(adapter: ProviderAdapter): void {
  REGISTRY.set(adapter.slug, adapter);
}

export function getAdapter(slug: string): ProviderAdapter | null {
  return REGISTRY.get(slug) ?? null;
}

/**
 * Declared priority for a dotted tool name ("shopify.variant_information"),
 * or the 50 default when the provider has not ranked it.
 *
 * Used only when the tool surface has to be truncated. Reading it from the
 * adapter keeps the ranking next to the tool it describes, rather than in a
 * list somewhere else that nobody updates when a tool is added.
 */
/**
 * Ask the provider whether an action is still possible, before a human is
 * asked to approve it.
 *
 * Fails OPEN: a precheck that errors, times out, or is not implemented returns
 * eligible. This gate exists to stop pointless approvals, and turning a
 * provider hiccup into a refused cancellation would be a worse failure than
 * the one it prevents.
 */
export async function precheckAdapterAction(opts: {
  tenantId: string;
  conversationId?: string;
  toolFunctionName: string;
  args: Record<string, unknown>;
}): Promise<{ eligible: true } | { eligible: false; reason: string; alreadySatisfied?: boolean }> {
  const dot = opts.toolFunctionName.indexOf(".");
  if (dot < 0) return { eligible: true };
  const slug = opts.toolFunctionName.slice(0, dot);
  const toolName = opts.toolFunctionName.slice(dot + 1);
  const adapter = REGISTRY.get(slug);
  if (!adapter) return { eligible: true };

  // A tool the provider has DECLARED unsupported can never run, so it must
  // never reach a person's approval queue. `shopify.edit_order` raised a
  // PENDING approval for a customer's address change and would have thrown
  // `unsupported_rest` the moment anyone approved it - the request was
  // impossible before it was ever made, and the merchant would have spent a
  // real decision discovering that.
  //
  // Generic on purpose: this holds for every adapter and every future tool
  // that degrades rather than implements.
  try {
    const def = adapter.tools().find((t) => t.name === opts.toolFunctionName);
    if (def?.unsupported) {
      return {
        eligible: false,
        reason:
          `${opts.toolFunctionName} is not supported by this integration: ${def.unsupported} ` +
          `Tell the customer plainly that this cannot be done from here, and offer the nearest thing that can - ` +
          `do not promise the change.`,
      };
    }
  } catch {
    /* tool introspection must never block a legitimate action */
  }

  if (!adapter.precheckEligibility) return { eligible: true };
  try {
    return await adapter.precheckEligibility({
      toolName,
      args: opts.args,
      call: async (t, a) => {
        const r = await executeAdapterTool({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          toolFunctionName: `${slug}.${t}`,
          args: a,
          accessScope: "internal",
        });
        if (!r.ok) throw new Error(r.reason);
        return r.result;
      },
    });
  } catch (err: any) {
    console.warn(`[framework] precheck for ${opts.toolFunctionName} failed open: ${err?.message}`);
    return { eligible: true };
  }
}

export function getToolPriority(dottedName: string): number {
  const dot = dottedName.indexOf(".");
  if (dot < 0) return 50;
  const adapter = REGISTRY.get(dottedName.slice(0, dot));
  if (!adapter) return 50;
  try {
    const def = adapter.tools().find((t) => t.name === dottedName);
    const p = def?.priority;
    return typeof p === "number" && Number.isFinite(p) ? p : 50;
  } catch {
    return 50;
  }
}

// ─── Adapter execution timeout ───────────────────────────────

/**
 * Every provider adapter issued a bare `fetch` with no timeout, so a hung
 * connection blocked the caller indefinitely - and the caller is a customer
 * conversation turn holding a worker. The custom-API path already did this
 * correctly (`custom-api.service.ts` aborts on `AbortSignal`); the adapters
 * simply never got it.
 *
 * This bounds the WAIT rather than cancelling the request. Threading an
 * AbortSignal into each provider's fetch would be the complete fix, but it
 * means touching all sixteen adapters and their differing HTTP clients; a
 * lingering socket is a far smaller problem than a conversation turn that
 * never returns. The stronger fix belongs with the per-adapter work, and the
 * distinction is stated here so nobody reads this as full cancellation.
 *
 * `ADAPTER_TIMEOUT_MS` overrides the default. Deliberately generous: Shopify
 * bulk reads and Salesforce SOQL are legitimately slow, and a timeout that
 * fires on healthy traffic is worse than none at all.
 *
 * NOTE: `CatalogTool.timeoutMs` is NOT consulted. That column, along with
 * `maxRetries`, `retryBackoffMs` and `circuitBreakerThreshold`, is read by
 * nothing in the codebase - populating it would create configuration that
 * appears to work and does not. See the remediation appendix; the columns
 * should be implemented or dropped, not quietly filled in.
 */
const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000;

function adapterTimeoutMs(): number {
  const raw = Number(process.env.ADAPTER_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ADAPTER_TIMEOUT_MS;
}

export async function withAdapterTimeout<T>(
  slug: string,
  toolName: string,
  work: Promise<T>,
): Promise<T> {
  const ms = adapterTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`adapter_timeout_after_${ms}ms: ${slug}.${toolName}`)),
          ms,
        );
      }),
    ]);
  } finally {
    // Always clear: leaving it pending keeps the event loop alive for the full
    // duration on every successful call, which in a worker is a slow leak.
    if (timer) clearTimeout(timer);
  }
}

export function listAdapters(): ProviderAdapter[] {
  return [...REGISTRY.values()];
}

// ─── Tool execution wrapper ──────────────────────────────────

/**
 * Top-level entry: dispatch a `<provider>.<tool>` call. Resolves the
 * adapter, loads the connection, refreshes tokens, executes, and returns
 * a structured result. The dispatcher in agent-tools.ts wraps the result
 * for the LLM.
 */
export async function executeAdapterTool(opts: {
  tenantId: string;
  conversationId?: string;
  contactId?: string;
  toolFunctionName: string; // "stripe.refund_payment"
  args: Record<string, unknown>;
  /**
   * WHO is this call on behalf of?
   *   "customer" - the LLM acting for the customer channel (autonomous bot).
   *     Protected customer/order tools are then AUTHORIZED against the
   *     conversation's authenticated channel identity - a denied lookup never
   *     reaches the model. This is the P0 cross-customer-disclosure fix.
   *   "internal" (default) - server-side/system/staff paths (identity link,
   *     post-conversation CRM, copilot behind authenticated membership,
   *     approval dispatch). Unchanged behavior.
   * The value comes from the CALLER's code path, never from tool args - an
   * AI-supplied "isAuthorized" can never influence it.
   */
  accessScope?: "internal" | "customer";
}): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  const start = Date.now();
  const dot = opts.toolFunctionName.indexOf(".");
  if (dot < 0) return { ok: false, reason: `bad_tool_name:${opts.toolFunctionName}` };
  const slug = opts.toolFunctionName.slice(0, dot);
  const toolName = opts.toolFunctionName.slice(dot + 1);

  // ── Cross-customer access guard (customer channel only) ─────────────────
  let guardIdentity: import("./customer-access-guard").RequesterIdentity | null = null;
  if (opts.accessScope === "customer" && slug === "shopify" && opts.conversationId) {
    const guard = await import("./customer-access-guard");
    // Self-scoped tools carry no selector in their schema, so there is nothing
    // to verify - only something to supply. Whatever the model sent that looks
    // like a selector is discarded here, before the adapter, and replaced with
    // the identity the channel authenticated.
    if (guard.SELF_SCOPED_SHOPIFY_TOOLS.has(toolName)) {
      guardIdentity = await guard.resolveRequesterIdentity(opts.tenantId, opts.conversationId);
      const scoped = guardIdentity ? guard.applySelfScope(guardIdentity, opts.args as Record<string, any>) : null;
      if (!guardIdentity || !scoped) {
        return {
          ok: false,
          reason:
            "access_denied: this conversation has no authenticated identity, so there is no profile to change. " +
            "Do not ask the customer to supply a customer id, phone or email as proof - it would not be accepted.",
        };
      }
      if (scoped.stripped.length) {
        await guard.recordSecurityDenial({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          channelSenderId: guardIdentity.channelSenderId,
          toolName,
          reason: `self_scope_selector_stripped:${scoped.stripped.join(",")}`,
          args: opts.args as Record<string, any>,
        });
      }
      opts.args = scoped.args;
    }
    if (guard.PROTECTED_SHOPIFY_TOOLS.has(toolName)) {
      guardIdentity = await guard.resolveRequesterIdentity(opts.tenantId, opts.conversationId);
      if (!guardIdentity) {
        return { ok: false, reason: "access_denied: requester identity could not be resolved for this conversation" };
      }
      const pre = guard.checkArgsAllowed(guardIdentity, toolName, opts.args as Record<string, any>);
      if (!pre.allowed) {
        await guard.recordSecurityDenial({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          channelSenderId: guardIdentity.channelSenderId,
          toolName,
          reason: pre.reason,
          args: opts.args as Record<string, any>,
        });
        return {
          ok: false,
          reason:
            "access_denied_cross_customer: this chat may only access the customer's own records. " +
            "Do NOT reveal any of the requested data or confirm whether it exists. Offer to send a " +
            "verification code to the contact details already stored on that account, or to hand over to a human agent.",
        };
      }
    }
  }

  const adapter = getAdapter(slug);
  if (!adapter) return { ok: false, reason: `unknown_provider:${slug}` };
  const toolDef = adapter.tools().find((t) => t.name === opts.toolFunctionName);
  if (!toolDef) {
    return { ok: false, reason: `unknown_tool:${opts.toolFunctionName}` };
  }

  // Rate limit BEFORE loading the connection - denial is cheap.
  const rl = checkRateLimit(opts.tenantId, slug);
  if (!rl.allowed) {
    const reason = `rate_limited:${slug}:retry_after_ms=${rl.retryAfterMs}`;
    await auditAdapterCall({
      tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: opts.contactId,
      toolFunctionName: opts.toolFunctionName, args: opts.args, ok: false, reason,
      durationMs: Date.now() - start,
    });
    return { ok: false, reason };
  }

  const conn = await loadConnection({ tenantId: opts.tenantId, slug });
  if (!conn) {
    const reason = `not_connected:${slug}`;
    await auditAdapterCall({
      tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: opts.contactId,
      toolFunctionName: opts.toolFunctionName, args: opts.args, ok: false, reason,
      durationMs: Date.now() - start,
    });
    return { ok: false, reason };
  }

  // Capability gate: a scope the merchant never granted fails identically on
  // every retry - short-circuit locally with NO provider HTTP call and NO
  // audit row (a persisted adapter.err per bot turn was pure noise). The
  // state clears via adapter.validate() (the /test route) or a token refresh
  // whose scope string proves the grant arrived.
  const knownMissing = missingScopesFromConfig(conn.config);
  const blockedScopes = (toolDef.requiredScopes ?? []).filter((s) => knownMissing.includes(s));
  if (blockedScopes.length) {
    return {
      ok: false,
      reason: `missing_scope:${blockedScopes[0]} - ${slug} connection needs re-authorization (merchant approval)`,
    };
  }

  // Proactively refresh on use. Force a refresh when the integration was ERROR
  // so a recoverable (expired-token) integration self-heals on first use.
  let fresh: Record<string, any>;
  try {
    fresh = await ensureFreshToken({
      tenantIntegrationId: conn.tenantIntegrationId,
      credentials: conn.credentials,
      adapter,
      force: conn.status === "ERROR",
      currentStatus: conn.status,
    });
  } catch (err: any) {
    // Refresh itself failed (revoked/invalid refresh token) - unrecoverable.
    const reason = (err?.message || "token_refresh_failed").slice(0, 240);
    await auditAdapterCall({
      tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: opts.contactId,
      toolFunctionName: opts.toolFunctionName, args: opts.args, ok: false, reason,
      durationMs: Date.now() - start,
    });
    return { ok: false, reason };
  }

  const runExecute = (creds: Record<string, any>) =>
    withAdapterTimeout(
      slug,
      toolName,
      adapter.execute({
        ctx: {
          tenantId: opts.tenantId,
          tenantIntegrationId: conn.tenantIntegrationId,
          conversationId: opts.conversationId,
          contactId: opts.contactId,
        },
        toolName,
        args: opts.args,
        credentials: creds,
        config: conn.config,
      }),
    );
  // Lenient 401/expiry detection (superset of the original `/401|unauthorized|
  // invalid.*token/`). NB: a bare `\b401\b` does NOT match "hubspot_401" (an
  // underscore is a word char, so there's no boundary before the digits) - match
  // 401 as a substring instead, as adapters embed it in messages like that.
  const isAuthError = (m: string) =>
    /401|unauthorized|invalid.*token|token.*expired|expired.*token|expired_authentication|tokens? (?:are )?no longer accepted/i.test(m);

  try {
    let result: unknown;
    try {
      result = await runExecute(fresh);
    } catch (err: any) {
      const message = err?.message || "execution_failed";
      if (!isAuthError(message)) throw err;
      // Auth error on a fresh-looking token → the access token expired between
      // the proactive check and the call. Force one refresh + retry. Only if
      // THIS also fails do we mark the integration ERROR.
      console.warn(`[integration-framework] ${slug} auth error, refreshing + retrying once: ${message.slice(0, 120)}`);
      const refreshed = await ensureFreshToken({
        tenantIntegrationId: conn.tenantIntegrationId,
        credentials: fresh,
        adapter,
        force: true,
        currentStatus: conn.status,
      });
      result = await runExecute(refreshed);
    }
    // Success. If the integration was ERROR and we never had to refresh (token
    // was already valid), recover the status now.
    if (conn.status === "ERROR") {
      await setConnectionStatus({ tenantIntegrationId: conn.tenantIntegrationId, status: "CONNECTED" });
    }
    await auditAdapterCall({
      tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: opts.contactId,
      toolFunctionName: opts.toolFunctionName, args: opts.args, ok: true,
      durationMs: Date.now() - start,
    });

    // ── Post-flight owner check (customer channel) ────────────────────────
    // The RESOLVED resource must belong to the requester: an order fetched by
    // number, a customer fetched by id, a list containing other customers.
    // Denied/foreign data never reaches the model; lists are filtered to the
    // requester's own entries.
    if (guardIdentity && opts.conversationId) {
      const guard = await import("./customer-access-guard");
      const post = guard.checkResultAllowed(guardIdentity, toolName, result);
      if (!post.allowed) {
        await guard.recordSecurityDenial({
          tenantId: opts.tenantId,
          conversationId: opts.conversationId,
          channelSenderId: guardIdentity.channelSenderId,
          toolName,
          reason: post.reason,
          args: opts.args as Record<string, any>,
        });
        return {
          ok: false,
          reason:
            "access_denied_cross_customer: the requested record belongs to a different customer. " +
            "Do NOT reveal any of its details or confirm what exists. Offer identity verification " +
            "to the contact details already stored on that account, or a human agent.",
        };
      }
      result = post.result;
      // A self-scoped write may have changed the very identifier ownership is
      // compared against. Record the resolved Shopify customer id on the
      // contact so the next turn still recognises them - the controlled
      // reconciliation path, rather than the customer silently locking
      // themselves out of their own orders by correcting their phone number.
      if (
        guard.SELF_SCOPED_SHOPIFY_TOOLS.has(toolName) &&
        result && typeof result === "object" &&
        (result as any).customer_id
      ) {
        await guard.rememberShopifyCustomer(opts.tenantId, opts.conversationId, (result as any).customer_id);
      }
    }
    // Last gate before the result becomes prompt. `projectOrderForAgent`
    // whitelists the fields of an order, which is the right shape of fix and
    // is also a list somebody has to remember to update - every new tool is
    // another chance to forget. This catches whatever slipped: admin URLs,
    // checkout sessions, the `authenticate?key=` bearer link on an order
    // status page, and access tokens by prefix. A model that can see a
    // credential can repeat one.
    if (slug === "shopify") {
      const { redactPrivateShopifyData } = await import("./shopify-safe-output");
      result = redactPrivateShopifyData(result);
    }
    return { ok: true, result };
  } catch (err: any) {
    const message = err?.message || "execution_failed";
    // A merchant-approval / missing-scope provider error proves the scope is
    // not granted - persist it (idempotent merge) so the NEXT call
    // short-circuits locally instead of re-hitting the provider every turn.
    const provedMissing = extractMissingScopes(message, toolDef);
    if (provedMissing.length) {
      await addMissingScopes(conn.tenantIntegrationId, provedMissing).catch((e: any) =>
        console.warn(`[integration-framework] missing-scope persist failed for ${slug}:`, e?.message));
    }
    if (isAuthError(message)) {
      await setConnectionStatus({
        tenantIntegrationId: conn.tenantIntegrationId,
        status: "ERROR",
        lastError: message.slice(0, 200),
      });
    }
    const reason = message.slice(0, 240);
    await auditAdapterCall({
      tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: opts.contactId,
      toolFunctionName: opts.toolFunctionName, args: opts.args, ok: false, reason,
      durationMs: Date.now() - start,
    });
    return { ok: false, reason };
  }
}

// ─── Idempotency key helper ─────────────────────────────────

/**
 * Deterministic idempotency key for a (tenant, conversation, tool, args)
 * tuple. Adapters use this for write tools to prevent double execution.
 */
export function idempotencyKey(opts: {
  tenantId: string;
  conversationId?: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  const stable = JSON.stringify(stableSort(opts.args));
  // Cheap hash - good enough for provider idempotency keys.
  let h = 0;
  const input = `${opts.tenantId}:${opts.conversationId ?? "noconv"}:${opts.toolName}:${stable}`;
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  return `cc_${Math.abs(h).toString(36)}_${(opts.conversationId ?? "x").slice(-6)}`;
}

function stableSort(value: any): any {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => { (acc as any)[k] = stableSort(value[k]); return acc; }, {} as Record<string, any>);
  }
  return value;
}
