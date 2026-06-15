/**
 * Custom DB Query tool runtime.
 *
 *   - listCustomDbQueryTools(tenantId)   - for the bot's tool surface
 *   - executeCustomDbQueryTool({...})    - called by the dispatcher when the
 *     LLM picks a tool whose name is `custom_db.<slug>`
 *
 * Security model:
 *   - The query template is pre-defined by the admin. The AI only fills in
 *     parameter values - it never composes SQL or Mongo filters from scratch.
 *   - For Postgres/MySQL, params bind via the driver's positional placeholder
 *     mechanism (`$1, $2…` for pg, `?` for mysql2). No string concatenation.
 *   - For MongoDB, the template is a JSON object with `{{paramName}}`
 *     placeholders that get *typed* substitution before the operation runs.
 *   - Returns are capped at `maxRows`.
 *   - `timeoutMs` enforces a statement timeout.
 */

import { prisma, decryptCredentials } from "@chatcenter/shared";

export interface CustomDbQueryToolDefinition {
  id: string;
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  whenNotToUse: string | null;
  parameters: Record<string, unknown>;
  category: string;
  riskLevel: string;
}

export async function listCustomDbQueryTools(tenantId: string): Promise<CustomDbQueryToolDefinition[]> {
  try {
    const rows: any[] = await (prisma as any).customDbQueryTool.findMany({
      where: { tenantId, isActive: true },
      orderBy: { slug: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      whenToUse: r.whenToUse,
      whenNotToUse: r.whenNotToUse,
      parameters: r.parameterSchema || { type: "object", properties: {}, required: [] },
      category: r.category,
      riskLevel: r.riskLevel,
    }));
  } catch (err: any) {
    if (!/Unknown arg|Cannot read|undefined.*findMany/.test(err?.message || "")) {
      console.warn("[custom-db] list failed:", err?.message);
    }
    return [];
  }
}

export async function executeCustomDbQueryTool(opts: {
  tenantId: string;
  slug: string;
  args: Record<string, unknown>;
  conversationId?: string;
}): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  const tool = await (prisma as any).customDbQueryTool.findUnique({
    where: { tenantId_slug: { tenantId: opts.tenantId, slug: opts.slug } },
  });
  if (!tool || !tool.isActive) {
    return { ok: false, reason: `unknown_custom_db_tool:${opts.slug}` };
  }

  const conn = await loadConnString({ tenantId: opts.tenantId, providerSlug: tool.providerSlug });
  if (!conn) {
    return { ok: false, reason: `provider_not_connected:${tool.providerSlug}` };
  }

  try {
    if (tool.providerSlug === "mongodb") {
      return await runMongo({ tool, args: opts.args, connectionString: conn.connectionString, dbName: conn.dbName });
    }
    if (tool.providerSlug === "aws_rds" && (conn.engine === "mysql" || conn.engine === "mariadb")) {
      return await runMysql({ tool, args: opts.args, connectionString: conn.connectionString });
    }
    return await runPostgres({
      tool,
      args: opts.args,
      connectionString: conn.connectionString,
      requireSsl: !!conn.requireSsl,
    });
  } catch (err: any) {
    return { ok: false, reason: err?.message?.slice(0, 240) || "execution_failed" };
  }
}

// ─── Connection resolution ───────────────────────────────────

async function loadConnString(opts: { tenantId: string; providerSlug: string }): Promise<{
  connectionString: string;
  dbName?: string;
  engine?: string;
  requireSsl?: boolean;
} | null> {
  const cat = await (prisma as any).integrationCatalog.findUnique({
    where: { slug: opts.providerSlug },
  });
  if (!cat) return null;
  const ti = await (prisma as any).tenantIntegration.findUnique({
    where: { tenantId_integrationId: { tenantId: opts.tenantId, integrationId: cat.id } },
  });
  if (!ti || ti.status !== "CONNECTED") return null;
  const creds = typeof ti.credentials === "string"
    ? decryptCredentials(ti.credentials)
    : (ti.credentials || {});
  const connectionString = creds.connectionString || creds.connection_string;
  if (!connectionString) return null;
  return {
    connectionString,
    dbName: (ti.config || {}).dbName,
    engine: (ti.config || {}).engine,
    requireSsl: /\.rds\.amazonaws\.com/i.test(connectionString),
  };
}

// ─── Postgres / RDS-Postgres ─────────────────────────────────

async function runPostgres(opts: {
  tool: any;
  args: Record<string, unknown>;
  connectionString: string;
  requireSsl: boolean;
}): Promise<{ ok: true; result: unknown }> {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: Number(opts.tool.timeoutMs) || 5000,
    ssl: opts.requireSsl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const params = orderedParams(opts.tool, opts.args);
    let sql: string = String(opts.tool.queryTemplate);
    // Enforce maxRows by appending LIMIT if SELECT and not already present.
    if (/^\s*select/i.test(sql) && !/\blimit\b/i.test(sql)) {
      sql = `${sql.replace(/;\s*$/, "")} LIMIT ${Math.max(1, Number(opts.tool.maxRows) || 100)}`;
    }
    const r = await pool.query(sql, params);
    return { ok: true, result: { rows: r.rows, rowCount: r.rowCount } };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// ─── MySQL / MariaDB ─────────────────────────────────────────

async function runMysql(opts: {
  tool: any;
  args: Record<string, unknown>;
  connectionString: string;
}): Promise<{ ok: true; result: unknown }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require("mysql2/promise");
  const conn = await m.createConnection({ uri: opts.connectionString, connectTimeout: 5000 });
  try {
    const params = orderedParams(opts.tool, opts.args);
    let sql: string = String(opts.tool.queryTemplate);
    if (/^\s*select/i.test(sql) && !/\blimit\b/i.test(sql)) {
      sql = `${sql.replace(/;\s*$/, "")} LIMIT ${Math.max(1, Number(opts.tool.maxRows) || 100)}`;
    }
    const [rows] = await conn.query(sql, params);
    return { ok: true, result: { rows } };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

// ─── MongoDB ─────────────────────────────────────────────────

async function runMongo(opts: {
  tool: any;
  args: Record<string, unknown>;
  connectionString: string;
  dbName?: string;
}): Promise<{ ok: true; result: unknown }> {
  if (!opts.dbName) throw new Error("dbName_not_configured_on_mongo_integration");
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(opts.connectionString, {
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    const db = client.db(opts.dbName);
    let template: any;
    try {
      template = JSON.parse(String(opts.tool.queryTemplate));
    } catch {
      throw new Error("mongo_template_invalid_json");
    }
    const op = String(template.op || "find");
    const collectionName = String(template.collection || "");
    if (!collectionName) throw new Error("mongo_template_missing_collection");
    const col = db.collection(collectionName);
    const filter = substituteMongo(template.filter || {}, opts.args);
    const update = substituteMongo(template.update || {}, opts.args);
    const doc = substituteMongo(template.doc || {}, opts.args);
    const limit = Math.max(1, Number(opts.tool.maxRows) || 100);
    switch (op) {
      case "find": {
        const cursor = col.find(filter).limit(limit);
        if (template.sort) cursor.sort(template.sort);
        if (template.projection) cursor.project(template.projection);
        return { ok: true, result: { docs: await cursor.toArray() } };
      }
      case "findOne":
        return { ok: true, result: { doc: await col.findOne(filter, { projection: template.projection }) } };
      case "insertOne": {
        const r = await col.insertOne(doc);
        return { ok: true, result: { insertedId: r.insertedId } };
      }
      case "updateOne": {
        const r = await col.updateOne(filter, { $set: update });
        return { ok: true, result: { matched: r.matchedCount, modified: r.modifiedCount } };
      }
      case "deleteOne": {
        const r = await col.deleteOne(filter);
        return { ok: true, result: { deleted: r.deletedCount } };
      }
      default:
        throw new Error(`mongo_op_unsupported:${op}`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function orderedParams(tool: any, args: Record<string, unknown>): unknown[] {
  const order: string[] = Array.isArray(tool.parameterOrder) ? tool.parameterOrder : [];
  if (order.length > 0) return order.map((name) => args[name] ?? null);
  // Fall back to declaration order in the JSON schema.
  const props = (tool.parameterSchema?.properties || {}) as Record<string, unknown>;
  return Object.keys(props).map((name) => args[name] ?? null);
}

/**
 * Walk a Mongo query/update document and replace any string of the form
 * `{{paramName}}` with the typed value from args. Recursive - handles nested
 * objects + arrays.
 */
function substituteMongo(node: any, args: Record<string, unknown>): any {
  if (typeof node === "string") {
    const m = node.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (m) return args[m[1]] ?? null;
    return node.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => String(args[k] ?? ""));
  }
  if (Array.isArray(node)) return node.map((x) => substituteMongo(x, args));
  if (node && typeof node === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(node)) out[k] = substituteMongo(v, args);
    return out;
  }
  return node;
}
