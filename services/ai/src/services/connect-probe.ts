/**
 * One cheap, read-only call with the credentials a form just sent, BEFORE the
 * connect route stores them as CONNECTED (2026-10-09).
 *
 * Seven form systems were saved CONNECTED unchecked: a wrong key surfaced only
 * when a customer asked something. Their adapters have no validate() and the
 * adapter files are not this module's to change, so the probe lives here and
 * reuses each adapter's own request code where it can run without a stored row.
 *
 * Verdict per slug:
 *   - null: no probe for this slug (or this engine); the route keeps today's
 *     behaviour.
 *   - missing: a required field is empty; nothing was called.
 *   - CREDENTIALS_INVALID: the system answered and refused the credentials.
 *   - CONNECTION_FAILED: the system could not be reached at all.
 * Any other provider answer counts as "reached, credentials accepted", the
 * same rule the /test route applies to a read tool that needs arguments.
 * Messages are ours, never the provider's raw text: a connection string or a
 * provider HTML page must not travel back to the browser.
 */
import FireberryAdapter from "./connectors/fireberry.adapter";
import ReturnGoAdapter from "./connectors/returngo.adapter";
import PayPalAdapter from "./connectors/paypal.adapter";
import { airtableListBases } from "./connectors/airtable.adapter";
import type { KnownErrorCode } from "../lib/error-code";

export type ConnectProbeVerdict =
  | { ok: true }
  | { ok: false; missing: string[] }
  | { ok: false; code: Extract<KnownErrorCode, "CREDENTIALS_INVALID" | "CONNECTION_FAILED">; message: string };

type Creds = Record<string, any>;
type Probe = (creds: Creds, config: Record<string, any>, tenantId: string) => Promise<ConnectProbeVerdict | null>;

/** A provider that never answers must not hold the connect request open. */
const PROBE_TIMEOUT_MS = 10_000;

const PROVIDER_NAME: Record<string, string> = {
  fireberry: "Fireberry",
  returngo: "ReturnGO",
  paypal: "PayPal",
  airtable: "Airtable",
};

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("probe_timeout")), PROBE_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function missingOf(fields: Array<[string, unknown]>): ConnectProbeVerdict | null {
  const missing = fields.filter(([, v]) => typeof v !== "string" || !v.trim()).map(([k]) => k);
  return missing.length ? { ok: false, missing } : null;
}

/**
 * The adapters throw "<slug>_<status>: text" (or "paypal_token_<status>")
 * when the provider answered. No status means the request never got an
 * answer: DNS, refused, TLS, timeout, or the SSRF guard.
 */
async function httpProbe(slug: string, call: () => Promise<unknown>): Promise<ConnectProbeVerdict> {
  const name = PROVIDER_NAME[slug] ?? slug;
  try {
    await withTimeout(call());
    return { ok: true };
  } catch (err: any) {
    const m = /_(\d{3})(?::|$)/.exec(String(err?.message ?? ""));
    if (!m) return { ok: false, code: "CONNECTION_FAILED", message: `${name} could not be reached. Try again in a moment.` };
    const status = Number(m[1]);
    if (status === 401 || status === 403) {
      return { ok: false, code: "CREDENTIALS_INVALID", message: `${name} rejected these credentials.` };
    }
    return { ok: true };
  }
}

/** pg: an auth or database-name refusal is the credentials; anything else is reach. */
const PG_REFUSED = new Set(["28P01", "28000", "3D000"]);

async function pgProbe(connectionString: string, ssl: boolean): Promise<ConnectProbeVerdict> {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await withTimeout(client.connect());
    await withTimeout(client.query("SELECT 1"));
    return { ok: true };
  } catch (err: any) {
    if (PG_REFUSED.has(String(err?.code ?? ""))) {
      return { ok: false, code: "CREDENTIALS_INVALID", message: "The database refused this connection string. Check the user, password and database name." };
    }
    return { ok: false, code: "CONNECTION_FAILED", message: "The database could not be reached at this address." };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Mongo code 18 is AuthenticationFailed; the handshake runs inside connect(). */
async function mongoProbe(connectionString: string): Promise<ConnectProbeVerdict> {
  const { MongoClient } = await import("mongodb");
  let client: any;
  try {
    client = new MongoClient(connectionString, { connectTimeoutMS: 5_000, serverSelectionTimeoutMS: 5_000 });
    await withTimeout(client.connect());
    await withTimeout(client.db("admin").command({ ping: 1 }));
    return { ok: true };
  } catch (err: any) {
    if (err?.code === 18 || err?.codeName === "AuthenticationFailed") {
      return { ok: false, code: "CREDENTIALS_INVALID", message: "The database refused this connection string. Check the user and password." };
    }
    return { ok: false, code: "CONNECTION_FAILED", message: "The database could not be reached at this address." };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

const connStr = (c: Creds) => c.connectionString || c.connection_string;
/** Same rule as the aws_rds adapter: RDS hosts and explicit sslmode use TLS. */
const rdsNeedsSsl = (s: string) => /\.rds\.amazonaws\.com/i.test(s) || /sslmode=(require|verify-ca|verify-full)/i.test(s);

const PROBES: Record<string, Probe> = {
  fireberry: async (c, config, tenantId) => {
    const token = c.tokenid || c.apiKey || c.accessToken;
    return missingOf([["tokenid", token]]) ?? httpProbe("fireberry", () =>
      FireberryAdapter.execute({
        ctx: { tenantId, tenantIntegrationId: "" },
        toolName: "query_records",
        args: { query: "", page_size: 1, fields: "accountid" },
        credentials: c,
        config,
      }));
  },
  returngo: async (c, config, tenantId) => {
    const shopName = c.shopName || c.shop_name || config.shopName || config.shop_name;
    return missingOf([["apiKey", c.apiKey || c.api_key], ["shopName", shopName]]) ?? httpProbe("returngo", () =>
      ReturnGoAdapter.execute({
        ctx: { tenantId, tenantIntegrationId: "" },
        toolName: "get_transactions",
        args: { limit: 1 },
        credentials: c,
        config,
      }));
  },
  // Minting an app token is PayPal's cheapest authenticated call and writes nothing.
  paypal: async (c) =>
    missingOf([["clientId", c.clientId], ["clientSecret", c.clientSecret]]) ??
    httpProbe("paypal", () => PayPalAdapter.refreshTokens!(c)),
  // Listing bases needs no base or table yet; the form sends only the token.
  airtable: async (c) => {
    const pat = c.apiKey || c.accessToken;
    return missingOf([["apiKey", pat]]) ?? httpProbe("airtable", () => airtableListBases(pat));
  },
  postgresql: async (c) => missingOf([["connectionString", connStr(c)]]) ?? pgProbe(connStr(c), false),
  mongodb: async (c) => missingOf([["connectionString", connStr(c)]]) ?? mongoProbe(connStr(c)),
  // MySQL/MariaDB need mysql2, which is not installed: those keep today's
  // behaviour. A non-postgres URL under the default engine is not guessed at.
  aws_rds: async (c, config) => {
    const missing = missingOf([["connectionString", connStr(c)]]);
    if (missing) return missing;
    const engine = String(config.engine || "postgres").toLowerCase();
    if (engine !== "postgres" && engine !== "postgresql") return null;
    if (!/^postgres(ql)?:\/\//i.test(String(connStr(c)))) return null;
    return pgProbe(connStr(c), rdsNeedsSsl(connStr(c)));
  },
};

/** The verdict for a slug, or null when this slug has no probe. */
export async function probeConnectCredentials(opts: {
  slug: string;
  tenantId: string;
  credentials: Creds;
  config: Record<string, any>;
}): Promise<ConnectProbeVerdict | null> {
  const probe = PROBES[opts.slug];
  if (!probe) return null;
  return probe(opts.credentials, opts.config, opts.tenantId);
}

export const PROBED_SLUGS = Object.keys(PROBES);
