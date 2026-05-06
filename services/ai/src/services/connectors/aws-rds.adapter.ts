/**
 * AWS RDS adapter — production-grade.
 *
 * AWS RDS itself is just managed Postgres / MySQL behind a connection
 * string. We expose a small adapter that delegates to the official
 * `pg` driver for Postgres engines and `mysql2` for MySQL/MariaDB.
 *
 * Why a separate adapter (vs. just using the postgres adapter)?
 *   - Distinct catalog entry in the marketplace UI ("AWS RDS" vs "PostgreSQL")
 *   - Per-engine connection handling (Postgres vs MySQL drivers)
 *   - Allows tenants to encode `engine=mysql` in config and still have
 *     CRUD tools with table-level permissions, the same shape as the
 *     Postgres adapter.
 *
 * Permissions (`config`):
 *   {
 *     engine:       "postgres" | "mysql",
 *     allowReads:   string[],
 *     allowWrites:  string[],
 *     maxRows:      number,
 *   }
 *
 * Credentials: { connectionString }
 *
 * Tools mirror postgres.adapter.ts:
 *   aws_rds.query_table | get_row | insert_row | update_row
 */

import { registerAdapter, type ProviderAdapter, type ToolDefinition } from "./integration-framework";
import { quoteIdent } from "./postgres.adapter";

let pgPromise: Promise<any> | null = null;
async function pg(): Promise<any> {
  if (!pgPromise) pgPromise = import("pg");
  return pgPromise;
}

let mysqlPromise: Promise<any> | null = null;
async function mysql(): Promise<any> {
  if (!mysqlPromise) {
    mysqlPromise = (async () => {
      try {
        // Dynamic import — kept as a runtime require so TypeScript doesn't
        // need @types/mysql2 at build time. Tenants on Postgres engines never
        // hit this path; MySQL/MariaDB tenants must `npm install mysql2`.
        const moduleName = "mysql2/promise";
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(moduleName);
      } catch {
        throw new Error("mysql2_module_not_installed: run `npm install mysql2` in services/ai");
      }
    })();
  }
  return mysqlPromise;
}

// pool/connection cache keyed by tenantIntegrationId
const PG_POOLS = new Map<string, any>();
const MYSQL_POOLS = new Map<string, any>();

const TOOLS: ToolDefinition[] = [
  {
    name: "aws_rds.query_table",
    description: "SELECT rows from a whitelisted table with optional equality filters.",
    whenToUse: "You need rows matching a simple condition.",
    whenNotToUse: "Joins / aggregations — not supported here for safety.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "Whitelisted table name." },
        where: { type: "object", description: "Map of column → value, ANDed." },
        limit: { type: "number" },
        order_by: { type: "string" },
        order_dir: { type: "string", enum: ["ASC", "DESC"] },
      },
      required: ["table"],
    },
  },
  {
    name: "aws_rds.get_row",
    description: "Fetch a single row by primary-key column = value.",
    whenToUse: "You have a known id.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string" },
        pk_column: { type: "string" },
        pk_value: {},
      },
      required: ["table", "pk_column", "pk_value"],
    },
  },
  {
    name: "aws_rds.insert_row",
    description: "Insert one row into a writable table.",
    whenToUse: "Recording a new row in the tenant's RDS DB.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string" },
        row: { type: "object" },
      },
      required: ["table", "row"],
    },
  },
  {
    name: "aws_rds.update_row",
    description: "Update one row by primary key on a writable table.",
    whenToUse: "Patching a known row.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string" },
        pk_column: { type: "string" },
        pk_value: {},
        set: { type: "object" },
      },
      required: ["table", "pk_column", "pk_value", "set"],
    },
  },
];

const AwsRdsAdapter: ProviderAdapter = {
  slug: "aws_rds",
  tools: () => TOOLS,

  async execute({ ctx, toolName, args, credentials, config }) {
    const connStr = credentials.connectionString || credentials.connection_string;
    if (!connStr) throw new Error("no_connection_string");
    const engine = String(config.engine || "postgres").toLowerCase();
    const allowReads: string[] = Array.isArray(config.allowReads) ? config.allowReads : [];
    const allowWrites: string[] = Array.isArray(config.allowWrites) ? config.allowWrites : [];
    const maxRows: number = Number(config.maxRows ?? 100);

    const table = String(args.table || "");
    const isRead = toolName === "query_table" || toolName === "get_row";
    const isWrite = toolName === "insert_row" || toolName === "update_row";
    if (isRead && !allowReads.includes(table)) {
      throw new Error(`table_not_in_read_allowlist:${table}`);
    }
    if (isWrite && !allowWrites.includes(table)) {
      throw new Error(`table_not_in_write_allowlist:${table}`);
    }

    if (engine === "mysql" || engine === "mariadb") {
      return await mysqlExecute(ctx.tenantIntegrationId, connStr, toolName, table, args, maxRows);
    }
    return await pgExecute(ctx.tenantIntegrationId, connStr, toolName, table, args, maxRows);
  },
};

// ─── Postgres path ───────────────────────────────────────────

async function pgExecute(key: string, connStr: string, toolName: string, table: string, args: any, maxRows: number): Promise<any> {
  let pool = PG_POOLS.get(key);
  if (!pool) {
    const { Pool } = await pg();
    pool = new Pool({
      connectionString: connStr,
      max: 4,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      connectionTimeoutMillis: 5_000,
      ssl: requiresSsl(connStr) ? { rejectUnauthorized: false } : undefined,
    });
    PG_POOLS.set(key, pool);
  }
  const client = await pool.connect();
  try {
    switch (toolName) {
      case "query_table": {
        const where = (args.where || {}) as Record<string, any>;
        const keys = Object.keys(where);
        const params: any[] = [];
        const wherePieces: string[] = [];
        keys.forEach((k, i) => { params.push(where[k]); wherePieces.push(`${quoteIdent(k)} = $${i + 1}`); });
        let sql = `SELECT * FROM ${quoteIdent(table)}`;
        if (wherePieces.length) sql += ` WHERE ${wherePieces.join(" AND ")}`;
        if (args.order_by) {
          const dir = String(args.order_dir || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
          sql += ` ORDER BY ${quoteIdent(String(args.order_by))} ${dir}`;
        }
        const cap = Math.min(maxRows, Number(args.limit ?? maxRows));
        sql += ` LIMIT ${Math.max(1, cap)}`;
        const r = await client.query(sql, params);
        return r.rows;
      }
      case "get_row": {
        const sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(String(args.pk_column))} = $1 LIMIT 1`;
        const r = await client.query(sql, [args.pk_value]);
        return r.rows[0] ?? null;
      }
      case "insert_row": {
        const row = (args.row || {}) as Record<string, any>;
        const cols = Object.keys(row);
        if (!cols.length) throw new Error("row_empty");
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const values = cols.map((c) => row[c]);
        const sql = `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
        const r = await client.query(sql, values);
        return r.rows[0] ?? null;
      }
      case "update_row": {
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
      default: throw new Error(`unknown_aws_rds_tool:${toolName}`);
    }
  } finally {
    client.release();
  }
}

// ─── MySQL path ──────────────────────────────────────────────

function quoteMysqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$.]*$/.test(name)) {
    throw new Error(`invalid_identifier:${name}`);
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

async function mysqlExecute(key: string, connStr: string, toolName: string, table: string, args: any, maxRows: number): Promise<any> {
  let pool = MYSQL_POOLS.get(key);
  if (!pool) {
    const m = await mysql();
    pool = m.createPool({
      uri: connStr,
      connectionLimit: 4,
      connectTimeout: 5000,
      ssl: requiresSsl(connStr) ? { rejectUnauthorized: false } : undefined,
    });
    MYSQL_POOLS.set(key, pool);
  }

  switch (toolName) {
    case "query_table": {
      const where = (args.where || {}) as Record<string, any>;
      const keys = Object.keys(where);
      const params: any[] = [];
      const wherePieces: string[] = [];
      keys.forEach((k) => { params.push(where[k]); wherePieces.push(`${quoteMysqlIdent(k)} = ?`); });
      let sql = `SELECT * FROM ${quoteMysqlIdent(table)}`;
      if (wherePieces.length) sql += ` WHERE ${wherePieces.join(" AND ")}`;
      if (args.order_by) {
        const dir = String(args.order_dir || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC";
        sql += ` ORDER BY ${quoteMysqlIdent(String(args.order_by))} ${dir}`;
      }
      const cap = Math.min(maxRows, Number(args.limit ?? maxRows));
      sql += ` LIMIT ${Math.max(1, cap)}`;
      const [rows] = await pool.query(sql, params);
      return rows;
    }
    case "get_row": {
      const sql = `SELECT * FROM ${quoteMysqlIdent(table)} WHERE ${quoteMysqlIdent(String(args.pk_column))} = ? LIMIT 1`;
      const [rows]: any = await pool.query(sql, [args.pk_value]);
      return Array.isArray(rows) ? (rows[0] ?? null) : null;
    }
    case "insert_row": {
      const row = (args.row || {}) as Record<string, any>;
      const cols = Object.keys(row);
      if (!cols.length) throw new Error("row_empty");
      const sql = `INSERT INTO ${quoteMysqlIdent(table)} (${cols.map(quoteMysqlIdent).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      const [r]: any = await pool.query(sql, cols.map((c) => row[c]));
      return { insertId: r?.insertId ?? null, affected: r?.affectedRows ?? 0 };
    }
    case "update_row": {
      const set = (args.set || {}) as Record<string, any>;
      const cols = Object.keys(set);
      if (!cols.length) throw new Error("set_empty");
      const setSql = cols.map((c) => `${quoteMysqlIdent(c)} = ?`).join(", ");
      const sql = `UPDATE ${quoteMysqlIdent(table)} SET ${setSql} WHERE ${quoteMysqlIdent(String(args.pk_column))} = ?`;
      const params = cols.map((c) => set[c]);
      params.push(args.pk_value);
      const [r]: any = await pool.query(sql, params);
      return { affected: r?.affectedRows ?? 0 };
    }
    default: throw new Error(`unknown_aws_rds_tool:${toolName}`);
  }
}

function requiresSsl(connStr: string): boolean {
  // RDS endpoints use SSL by default; force it on when sslmode= is missing.
  return /\.rds\.amazonaws\.com/i.test(connStr) || /sslmode=(require|verify-ca|verify-full)/i.test(connStr);
}

registerAdapter(AwsRdsAdapter);
export default AwsRdsAdapter;
