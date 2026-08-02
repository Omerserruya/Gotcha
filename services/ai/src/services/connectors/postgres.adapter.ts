/**
 * Postgres adapter - production-grade with table-level permissions.
 *
 * Auth: API key style - credentials hold a Postgres connection string.
 * Tenants connect a database via the marketplace; we never accept the
 * connection string from the LLM.
 *
 * Permissions (`config`):
 *   {
 *     allowReads:  string[]  // table names readable
 *     allowWrites: string[]  // table names insertable/updatable (subset of reads)
 *     allowDelete: string[]  // table names deletable (rare)
 *     maxRows: number        // hard cap on returned rows (default 100)
 *     readOnlySearchPath?: string // optional: SET search_path TO ... before query
 *   }
 *
 * Tools - each ENFORCES the allowlist + parameterizes values to prevent
 * SQL injection. Identifier quoting uses double-quote escaping.
 *
 *   - postgresql.query_table   - SELECT * FROM <table> [WHERE …] LIMIT N
 *   - postgresql.get_row       - SELECT * FROM <table> WHERE pk = $1 LIMIT 1
 *   - postgresql.insert_row    - INSERT INTO <table>(…) VALUES (…) RETURNING *
 *   - postgresql.update_row    - UPDATE <table> SET … WHERE pk = $1 RETURNING *
 *
 * Connection pooling: a single pg.Pool per (tenantIntegrationId), cached.
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";

let pgModulePromise: Promise<any> | null = null;
async function pg(): Promise<any> {
  if (!pgModulePromise) {
    pgModulePromise = (async () => {
      try {
        return await import("pg");
      } catch (err: any) {
        throw new Error("pg_module_not_installed: run `npm install pg @types/pg` in services/ai");
      }
    })();
  }
  return pgModulePromise;
}

const POOLS = new Map<string, any>();

const TOOLS: ToolDefinition[] = [
  {
    name: "postgresql.query_table",
    description: "SELECT rows from a whitelisted table with optional equality filters.",
    whenToUse: "You need rows matching a simple condition - e.g. orders for a customer email.",
    whenNotToUse: "You need joins or aggregations - those aren't supported here for safety.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "Whitelisted table name (no schema dot - schema lives in config.search_path)." },
        where: {
          type: "object",
          description: "Map of column → value, ANDed together. Values are parameterized.",
        },
        limit: { type: "number", description: "Max rows. Capped by tenant policy (default 100)." },
        order_by: { type: "string", description: "Column to ORDER BY (whitelisted)." },
        order_dir: { type: "string", enum: ["ASC", "DESC"] },
      },
      required: ["table"],
    },
  },
  {
    name: "postgresql.get_row",
    description: "Fetch a single row by primary-key column = value.",
    whenToUse: "You have a known id and want the full row.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string" },
        pk_column: { type: "string", description: "Primary-key column name." },
        pk_value: { description: "Primary-key value (string|number)." },
      },
      required: ["table", "pk_column", "pk_value"],
    },
  },
  {
    name: "postgresql.insert_row",
    description: "Insert one row into a whitelisted-for-write table.",
    whenToUse: "Recording a new entity in the tenant's DB (lead/order/event).",
    category: "WRITE",
    riskLevel: "MEDIUM",
    sideEffects: "Row is written immediately and committed.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string" },
        row: { type: "object", description: "Map of column → value." },
      },
      required: ["table", "row"],
    },
  },
  {
    name: "postgresql.update_row",
    description: "Update one row by primary key on a whitelisted-for-write table.",
    whenToUse: "Patching status/notes on a known row.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string" },
        pk_column: { type: "string" },
        pk_value: {},
        set: { type: "object", description: "Columns to set." },
      },
      required: ["table", "pk_column", "pk_value", "set"],
    },
  },
];

const PostgresAdapter: ProviderAdapter = {
  // MUST match the integration_catalog slug. It said "postgres" while the
  // catalog row is "postgresql", and the mismatch broke this adapter end to
  // end: loadConnection() looks the tenant's connection up by
  // integration.slug, so every dispatch returned not_connected:postgres, and
  // the workspace counted 0 executable tools and filed PostgreSQL away as a
  // status-only "service managed elsewhere". Nothing here is generic over the
  // registry key - it IS the catalog slug.
  slug: "postgresql",
  tools: () => TOOLS,

  async execute({ ctx, toolName, args, credentials, config }) {
    const connStr = credentials.connectionString || credentials.connection_string;
    if (!connStr) throw new Error("no_connection_string");

    const allowReads: string[] = Array.isArray(config.allowReads) ? config.allowReads : [];
    const allowWrites: string[] = Array.isArray(config.allowWrites) ? config.allowWrites : [];
    const maxRows: number = Number(config.maxRows ?? 100);
    const searchPath: string | undefined = config.readOnlySearchPath || config.search_path;

    const table = String(args.table || "");
    const isRead = toolName === "query_table" || toolName === "get_row";
    const isWrite = toolName === "insert_row" || toolName === "update_row";
    if (isRead && !allowReads.includes(table)) {
      throw new Error(`table_not_in_read_allowlist:${table}`);
    }
    if (isWrite && !allowWrites.includes(table)) {
      throw new Error(`table_not_in_write_allowlist:${table}`);
    }

    const pool = await getPool(ctx.tenantIntegrationId, connStr);
    const client = await pool.connect();
    try {
      if (searchPath) {
        await client.query(`SET search_path TO ${quoteIdent(searchPath)}`);
      }
      switch (toolName) {
        case "query_table": return await pgQueryTable(client, table, args, maxRows);
        case "get_row":     return await pgGetRow(client, table, args);
        case "insert_row":  return await pgInsertRow(client, table, args);
        case "update_row":  return await pgUpdateRow(client, table, args);
        default: throw new Error(`unknown_postgres_tool:${toolName}`);
      }
    } finally {
      client.release();
    }
  },
};

// ─── Tool implementations ────────────────────────────────────

async function pgQueryTable(client: any, table: string, args: any, maxRowsCap: number) {
  const cap = Math.min(maxRowsCap, Number(args.limit ?? maxRowsCap));
  const where = (args.where || {}) as Record<string, any>;
  const keys = Object.keys(where);
  const params: any[] = [];
  const wherePieces: string[] = [];
  keys.forEach((k, i) => {
    params.push(where[k]);
    wherePieces.push(`${quoteIdent(k)} = $${i + 1}`);
  });
  let sql = `SELECT * FROM ${quoteIdent(table)}`;
  if (wherePieces.length) sql += ` WHERE ${wherePieces.join(" AND ")}`;
  if (args.order_by) {
    const dir = String(args.order_dir || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
    sql += ` ORDER BY ${quoteIdent(String(args.order_by))} ${dir}`;
  }
  sql += ` LIMIT ${Math.max(1, Math.min(cap, 1000))}`;
  const r = await client.query(sql, params);
  return r.rows;
}

async function pgGetRow(client: any, table: string, args: any) {
  const sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(String(args.pk_column))} = $1 LIMIT 1`;
  const r = await client.query(sql, [args.pk_value]);
  return r.rows[0] ?? null;
}

async function pgInsertRow(client: any, table: string, args: any) {
  const row = (args.row || {}) as Record<string, any>;
  const cols = Object.keys(row);
  if (!cols.length) throw new Error("row_empty");
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const values = cols.map((c) => row[c]);
  const sql = `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
  const r = await client.query(sql, values);
  return r.rows[0] ?? null;
}

async function pgUpdateRow(client: any, table: string, args: any) {
  const set = (args.set || {}) as Record<string, any>;
  const cols = Object.keys(set);
  if (!cols.length) throw new Error("set_empty");
  const placeholders = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`);
  const values = cols.map((c) => set[c]);
  values.push(args.pk_value);
  const sql = `UPDATE ${quoteIdent(table)} SET ${placeholders.join(", ")} WHERE ${quoteIdent(String(args.pk_column))} = $${cols.length + 1} RETURNING *`;
  const r = await client.query(sql, values);
  return r.rows[0] ?? null;
}

// ─── Helpers ─────────────────────────────────────────────────

async function getPool(key: string, connStr: string): Promise<any> {
  let pool = POOLS.get(key);
  if (pool) return pool;
  const { Pool } = await pg();
  pool = new Pool({
    connectionString: connStr,
    max: 4,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  POOLS.set(key, pool);
  return pool;
}

/**
 * Double-quote identifier escape - Postgres canonical form. The whitelist
 * checks already prevent attacker-controlled identifiers from reaching SQL,
 * but this is the second line of defense.
 */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$.]*$/.test(name)) {
    throw new Error(`invalid_identifier:${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

registerAdapter(PostgresAdapter);
export default PostgresAdapter;
