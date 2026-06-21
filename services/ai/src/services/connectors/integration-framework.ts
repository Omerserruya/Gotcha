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
  // token — excluding ERROR here is what created the deadlock (ERROR → never
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
  if (!needsRefresh || !opts.adapter.refreshTokens || !opts.credentials.refreshToken) {
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
    // Self-heal: a successful refresh proves the integration works again.
    if (opts.currentStatus === "ERROR") {
      await setConnectionStatus({ tenantIntegrationId: opts.tenantIntegrationId, status: "CONNECTED" });
      console.log(`[integration-framework] recovered ${opts.adapter.slug} ERROR→CONNECTED via token refresh`);
    }
    return next;
  } catch (err: any) {
    // Only a refresh FAILURE (e.g. revoked/invalid refresh token) is a real,
    // unrecoverable error — a mere access-token expiry is handled above.
    await setConnectionStatus({
      tenantIntegrationId: opts.tenantIntegrationId,
      status: "ERROR",
      lastError: `token_refresh_failed:${err?.message || "unknown"}`,
    });
    throw new Error(`Token refresh failed for ${opts.adapter.slug}: ${err?.message || "unknown"}`);
  }
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
}): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  const start = Date.now();
  const dot = opts.toolFunctionName.indexOf(".");
  if (dot < 0) return { ok: false, reason: `bad_tool_name:${opts.toolFunctionName}` };
  const slug = opts.toolFunctionName.slice(0, dot);
  const toolName = opts.toolFunctionName.slice(dot + 1);
  const adapter = getAdapter(slug);
  if (!adapter) return { ok: false, reason: `unknown_provider:${slug}` };
  if (!adapter.tools().some((t) => t.name === opts.toolFunctionName)) {
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
    // Refresh itself failed (revoked/invalid refresh token) — unrecoverable.
    const reason = (err?.message || "token_refresh_failed").slice(0, 240);
    await auditAdapterCall({
      tenantId: opts.tenantId, conversationId: opts.conversationId, contactId: opts.contactId,
      toolFunctionName: opts.toolFunctionName, args: opts.args, ok: false, reason,
      durationMs: Date.now() - start,
    });
    return { ok: false, reason };
  }

  const runExecute = (creds: Record<string, any>) =>
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
    });
  // Lenient 401/expiry detection (superset of the original `/401|unauthorized|
  // invalid.*token/`). NB: a bare `\b401\b` does NOT match "hubspot_401" (an
  // underscore is a word char, so there's no boundary before the digits) — match
  // 401 as a substring instead, as adapters embed it in messages like that.
  const isAuthError = (m: string) => /401|unauthorized|invalid.*token|token.*expired|expired.*token|expired_authentication/i.test(m);

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
    return { ok: true, result };
  } catch (err: any) {
    const message = err?.message || "execution_failed";
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
