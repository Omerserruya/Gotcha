/**
 * The Admin GraphQL request layer.
 *
 * Shopify's App Store requirement 2.2.4 forbids core Admin REST calls, so every
 * resource family in the adapter moves here. The migration's whole risk is that
 * GraphQL answers the same questions in a different SHAPE - global ids instead
 * of numbers, connections instead of arrays, `MoneyV2` instead of a decimal
 * string - and every one of those differences is a chance to change behaviour
 * the rest of GOTCHA depends on. So this module owns the transport and the id
 * translation, and nothing else: mapping a node to an internal DTO stays with
 * the resource family that knows what its callers expect.
 *
 * ── What this layer distinguishes (REST collapsed all of it into one throw) ──
 *
 *   * HTTP failure                → `shopify_<status>`, unchanged from REST so
 *                                   existing callers that match on it keep
 *                                   working (orderById treats 404/400 as "not
 *                                   found" and anything else as fatal).
 *   * top-level `errors`          → `shopify_graphql_error`, or the scope-named
 *                                   `shopify_graphql_access_denied`.
 *   * `userErrors` on a mutation  → `shopify_user_error`, because a mutation
 *                                   that returns 200 with userErrors DID NOT
 *                                   HAPPEN, and treating that as success is the
 *                                   single most dangerous mistake available
 *                                   here.
 *   * throttling                  → retried, with the cost extensions read for
 *                                   how long to wait.
 */
import { assertPublicUrl, shopifyApiVersion, checkShopifyResponseVersion } from "@chatcenter/shared";

export interface ShopifyCtx {
  token: string;
  /** `https://<shop>/admin/api/<version>` - shared with the REST base. */
  base: string;
}

export interface GraphQLCallOptions {
  /**
   * Mutations are NEVER retried unless the caller proves it is safe: a retried
   * `refundCreate` is a second refund. Reads are retryable by default.
   */
  retryable?: boolean;
  /** Overall attempt budget for retryable calls, including the first. */
  maxAttempts?: number;
  /** Where a mutation puts its userErrors, e.g. "customerUpdate". */
  userErrorsAt?: string;
}

/** Shopify's throttle backoff, bounded so a wedged store cannot hang a turn. */
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * A `gid://shopify/Order/12345` for a numeric id, passed through unchanged if
 * it is already a gid.
 *
 * Explicit rather than implicit because the two id shapes are the migration's
 * most common failure: GOTCHA stores and compares NUMERIC ids everywhere - tool
 * arguments, conversation metadata, the Shopify context panel - and a gid that
 * leaks into any of those silently stops matching.
 */
export function toGid(type: string, id: string | number): string {
  const s = String(id);
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/${type}/${encodeURIComponent(s)}`;
}

/**
 * The numeric id out of a gid, for handing back to callers that expect what
 * REST returned.
 *
 * Prefers an explicit `legacyResourceId` when the query selected one - that is
 * Shopify's own answer and survives any future gid format change - and falls
 * back to the last path segment.
 */
export function numericId(node: { id?: string; legacyResourceId?: string | number } | null | undefined): number | null {
  if (!node) return null;
  if (node.legacyResourceId != null && node.legacyResourceId !== "") {
    const n = Number(node.legacyResourceId);
    if (Number.isFinite(n)) return n;
  }
  const raw = String(node.id ?? "");
  const tail = raw.split("/").pop() ?? "";
  const q = tail.split("?")[0];
  const n = Number(q);
  return Number.isFinite(n) && q !== "" ? n : null;
}

/**
 * Escape a value for a Shopify search query string.
 *
 * Search terms go into a query LANGUAGE, not a URL parameter: an unescaped
 * quote in a customer's name or an order note ends the term and the rest is
 * parsed as syntax. REST's `search.json?query=` had the same exposure and the
 * same lack of escaping; this is where it stops.
 */
export function escapeSearchValue(value: unknown): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function summarize(text: string): string {
  try {
    const body = JSON.parse(text);
    const errs = body?.errors ?? body?.error;
    if (typeof errs === "string") return errs.slice(0, 240);
    if (Array.isArray(errs)) return errs.map((e: any) => e?.message ?? String(e)).join("; ").slice(0, 240);
  } catch {
    /* fall through to the raw text */
  }
  return text.slice(0, 240);
}

function reportDrift(res: Response, url: string): void {
  try {
    checkShopifyResponseVersion({
      requested: shopifyApiVersion(),
      headerValue: res.headers.get("X-Shopify-API-Version"),
      surface: "GraphQL",
      // Host only - a path or query can carry customer data.
      shop: (() => { try { return new URL(url).host; } catch { return undefined; } })(),
    });
  } catch {
    /* telemetry must never break a request */
  }
}

/** Reads a nested value like "customerUpdate" off the data object. */
function at(data: any, path: string): any {
  return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), data);
}

export class ShopifyUserError extends Error {
  constructor(readonly userErrors: Array<{ field?: string[] | null; message: string; code?: string | null }>) {
    const detail = userErrors
      .map((e) => `${(e.field || []).join(".") || "-"}: ${e.message}${e.code ? ` (${e.code})` : ""}`)
      .join("; ");
    super(`shopify_user_error: ${detail.slice(0, 300)}`);
    this.name = "ShopifyUserError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one Admin GraphQL operation.
 *
 * Returns the `data` object. A mutation that declares `userErrorsAt` throws
 * ShopifyUserError when Shopify reports one, so a caller can never mistake a
 * refused mutation for a successful one.
 */
export async function shopifyGraphQLRequest(
  ctx: ShopifyCtx,
  query: string,
  variables: Record<string, unknown> = {},
  options: GraphQLCallOptions = {},
): Promise<any> {
  const url = `${ctx.base}/graphql.json`;
  // SSRF guard at the sink: ctx.base derives from per-tenant stored config.
  await assertPublicUrl(url);

  const maxAttempts = options.retryable ? Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) : 1;
  let lastThrottle: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": ctx.token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    // Checked before the ok/throw branch: a 4xx still carries the version
    // header, and a drifted version is a plausible cause of that 4xx.
    reportDrift(res, url);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 429 and 5xx are the only HTTP failures worth repeating, and only for a
      // call the caller marked retryable.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await sleep(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1)));
        continue;
      }
      throw new Error(`shopify_${res.status}: ${summarize(text)}`);
    }

    const json: any = await res.json();

    if (Array.isArray(json.errors) && json.errors.length) {
      const msg = json.errors.map((e: any) => e?.message).filter(Boolean).join("; ");

      // Throttling arrives as a 200 with a THROTTLED error code - the one
      // GraphQL error that is worth repeating rather than reporting.
      const throttled = json.errors.some((e: any) => e?.extensions?.code === "THROTTLED");
      if (throttled && attempt < maxAttempts) {
        lastThrottle = new Error(`shopify_graphql_throttled: ${msg.slice(0, 160)}`);
        await sleep(throttleWaitMs(json, attempt));
        continue;
      }
      if (throttled) throw lastThrottle ?? new Error(`shopify_graphql_throttled: ${msg.slice(0, 160)}`);

      if (/access denied|not approved|requires merchant approval|read_[a-z_]+|write_[a-z_]+/i.test(msg)) {
        // Name the scope Shopify actually asked for rather than guessing one.
        const named = /`?([a-z_]*(?:read|write)_[a-z_]+)`?\s*(?:access\s*)?scope/i.exec(msg)?.[1];
        throw new Error(
          `shopify_graphql_access_denied: ${msg.slice(0, 160)} - re-connect Shopify to grant ` +
            (named ? `the ${named} scope.` : `the scope it names.`),
        );
      }
      throw new Error(`shopify_graphql_error: ${msg.slice(0, 200)}`);
    }

    const data = json.data;
    if (options.userErrorsAt) {
      const payload = at(data, options.userErrorsAt);
      const userErrors = payload?.userErrors ?? payload?.[`${options.userErrorsAt.split(".").pop()}UserErrors`];
      if (Array.isArray(userErrors) && userErrors.length) throw new ShopifyUserError(userErrors);
    }
    return data;
  }

  throw lastThrottle ?? new Error("shopify_graphql_error: exhausted attempts");
}

/**
 * How long to wait before repeating a throttled call.
 *
 * Shopify reports the cost state in `extensions.cost`; when it is present the
 * wait is derived from how far the query is from affordable, which is far
 * better than a fixed sleep on a store whose bucket refills slowly.
 */
function throttleWaitMs(json: any, attempt: number): number {
  const cost = json?.extensions?.cost;
  const requested = Number(cost?.requestedQueryCost ?? 0);
  const available = Number(cost?.throttleStatus?.currentlyAvailable ?? 0);
  const restoreRate = Number(cost?.throttleStatus?.restoreRate ?? 0);
  if (requested > 0 && restoreRate > 0 && available < requested) {
    const seconds = (requested - available) / restoreRate;
    return Math.min(MAX_BACKOFF_MS, Math.max(BASE_BACKOFF_MS, Math.ceil(seconds * 1000)));
  }
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Walk a connection until `limit` nodes are collected or the pages run out.
 *
 * REST paged with `since_id` / `page`; GraphQL pages with an opaque cursor. The
 * callers being migrated all want "up to N of these", so that is what this
 * offers - the cursor never reaches them, and a caller cannot accidentally
 * fetch the whole catalogue by forgetting to stop.
 */
export async function paginate<T>(
  ctx: ShopifyCtx,
  query: string,
  variables: Record<string, unknown>,
  connectionAt: string,
  limit: number,
  options: GraphQLCallOptions = {},
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  // Shopify caps a connection page at 250 regardless of what is asked for.
  const pageSize = Math.min(250, Math.max(1, limit));

  // Bounded independently of `limit`: a connection that keeps reporting
  // hasNextPage while returning nothing would otherwise spin forever.
  for (let page = 0; page < 20 && out.length < limit; page += 1) {
    const data = await shopifyGraphQLRequest(
      ctx,
      query,
      { ...variables, first: Math.min(pageSize, limit - out.length), after: cursor },
      { retryable: true, ...options },
    );
    const conn = at(data, connectionAt);
    const nodes: T[] = conn?.nodes ?? (conn?.edges || []).map((e: any) => e?.node).filter(Boolean) ?? [];
    out.push(...nodes);
    const info: PageInfo | undefined = conn?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor || nodes.length === 0) break;
    cursor = info.endCursor;
  }
  return out.slice(0, limit);
}
