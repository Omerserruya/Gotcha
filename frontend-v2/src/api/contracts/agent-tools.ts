import { z } from 'zod';

import { knownOrUnknown } from './known-or-unknown';

/**
 * A business's own tools for its AI employees: an MCP server it connects, or
 * a custom API it describes (Omer, 2026-11-16, through Supervisior).
 *
 * ★ DRAFT for MCP. Backend publishes the contract with the AI engine rewrite;
 *   until then this is the plan's shape, and every value the server may add
 *   later degrades to UNKNOWN rather than rejecting the read. Supervisior's
 *   decisions so far:
 *     - only GOTCHA (SYSTEM_ADMIN) approves an MCP server;
 *     - auth is none, bearer, or one custom header (no OAuth yet);
 *     - a new URL or new auth goes back for approval, a new name does not;
 *     - access is per AI employee, the existing allowlist (`custom:<id>`).
 *
 * The custom API part is NOT a draft: it is the ai service's
 * `/api/custom-api-tools` (custom-api-admin.ts), ADMIN only, kept as it is.
 */

/*
 * Backend's provisional answers (2026-11-16, Backend-Team), full contract
 * after the engine build:
 *   a) `effect` read | change | irreversible | money replaces LOW/MEDIUM/HIGH
 *      on MCP tools; custom API tools map category + riskLevel onto it.
 *   b) levels execute | ask | never - the employee screen's; tool names
 *      `mcp.<serverSlug>.<tool>`; every MCP tool starts at never.
 *   c) per employee: integrationAccess key `mcp:<serverId>`.
 *   f) FAILED carries `lastError`; a tool carries `changedSinceLastDiscovery`.
 *   h) `{ data }` envelopes, unwrapped by the client.
 */

/* ── Risk: what a tool can do, four levels ── */

export const TOOL_RISKS = ['read', 'change', 'irreversible', 'money'] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number] | 'UNKNOWN';

/** The platform's three levels (employees.ts): run it, ask first, never. */
export const TOOL_LEVELS = ['execute', 'ask', 'never'] as const;
export type ToolLevel = (typeof TOOL_LEVELS)[number] | 'UNKNOWN';

/**
 * Which levels an admin may choose for a tool of this risk. "On its own" is
 * never offered for a tool that cannot be undone or moves money, nor for one
 * whose risk we could not read: the safe answer to "is this dangerous" when
 * we do not know is yes ([[safe-default-for-unknown-is-true]]).
 */
export function levelsFor(risk: ToolRisk): readonly (typeof TOOL_LEVELS)[number][] {
  return risk === 'read' || risk === 'change' ? TOOL_LEVELS : ['ask', 'never'];
}

/** The level a tool lands on when an admin first turns it on. */
export function firstLevelFor(risk: ToolRisk): (typeof TOOL_LEVELS)[number] {
  return risk === 'read' ? 'execute' : 'ask';
}

/* ── MCP servers ── */

export const MCP_SERVER_STATUSES = [
  /** Sent; waiting for GOTCHA to approve. Also after a new URL or new auth. */
  'PENDING_APPROVAL',
  /** Approved; the tool list is being read from the server. */
  'DISCOVERING',
  /** Approved and the tools are listed. */
  'READY',
  /** Approved, but the server could not be reached or refused us. */
  'FAILED',
  /** GOTCHA said no, with a reason. */
  'REJECTED',
] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number] | 'UNKNOWN';

export const MCP_AUTH_KINDS = ['none', 'bearer', 'header'] as const;
export type McpAuthKind = (typeof MCP_AUTH_KINDS)[number];

const nullableText = z.string().nullish().default(null);

export const mcpToolSchema = z.preprocess(
  /* Backend (a) names the risk `effect`, (f) the change flag `changedSinceLastDiscovery`. */
  (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const row = raw as Record<string, unknown>;
    const changed = row.changedSinceLastDiscovery;
    return {
      ...row,
      risk: row.risk ?? row.effect,
      isNew: row.isNew ?? changed === 'added',
      gone: row.gone ?? changed === 'removed',
    };
  },
  z.object({
    /** The server's own tool name, as the AI calls it. */
    name: z.string(),
    title: nullableText,
    description: nullableText,
    risk: knownOrUnknown(TOOL_RISKS),
    /** Every tool arrives `never` (OFF) until an admin turns it on. */
    level: knownOrUnknown(TOOL_LEVELS),
    /** Appeared since the previous read of the server's tools. */
    isNew: z.boolean().catch(false).default(false),
    /** The server no longer offers it; kept so its level is not silently lost. */
    gone: z.boolean().catch(false).default(false),
  }),
);
export type McpTool = z.infer<typeof mcpToolSchema>;

const mcpServerShape = z.object({
  id: z.string(),
  /** Its tools reach the AI as `mcp.<slug>.<tool>`. */
  slug: nullableText,
  name: z.string(),
  url: z.string(),
  auth: z
    .object({
      kind: z.enum(MCP_AUTH_KINDS).catch('none'),
      /** The header's name, for `header`. Its value is a secret, never sent back. */
      headerName: nullableText,
    })
    .catch({ kind: 'none', headerName: null }),
  hasSecret: z.boolean().catch(false).default(false),
  status: knownOrUnknown(MCP_SERVER_STATUSES),
  submittedAt: nullableText,
  decidedAt: nullableText,
  /** GOTCHA's words when it said no. */
  rejectionReason: nullableText,
  /** Why the last connect or read failed, as a code (see MCP_FAILURES); Backend's `lastError`. */
  lastErrorCode: nullableText,
  lastCheckedAt: nullableText,
  tools: z.array(mcpToolSchema).catch([]).default([]),
});

/** Backend's names: the failure `lastError` (f), the secret flag on `auth.hasSecret`; either reads. */
function withLastError(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const row = raw as Record<string, unknown>;
  const auth = row.auth as Record<string, unknown> | undefined;
  return {
    ...row,
    lastErrorCode: row.lastErrorCode ?? row.lastError,
    /* Backend reads `auth.hasSecret`. */
    hasSecret: row.hasSecret ?? auth?.hasSecret,
  };
}

export const mcpServerSchema = z.preprocess(withLastError, mcpServerShape);
export type McpServer = z.infer<typeof mcpServerShape>;

export const mcpServerListSchema = z.array(mcpServerSchema);

/** Why a server failed to connect, each its own sentence; anything else reads generic. */
export const MCP_FAILURES = [
  'unreachable',
  'tls',
  'auth_rejected',
  'not_mcp',
  'timeout',
  'protocol',
] as const;
export type McpFailure = (typeof MCP_FAILURES)[number] | 'unknown';

export function mcpFailureOf(code: string | null): McpFailure {
  return code !== null && (MCP_FAILURES as readonly string[]).includes(code)
    ? (code as McpFailure)
    : 'unknown';
}

/** The route's refusals on a write, each its own sentence. */
export const MCP_REFUSALS = [
  'url_invalid',
  'url_not_https',
  'url_private_host',
  'duplicate_server',
  'not_found',
  'not_pending',
] as const;
export type McpRefusal = (typeof MCP_REFUSALS)[number];

/**
 * An edit that sends the server back to GOTCHA (Supervisior (e)): a new URL,
 * a new auth kind or header name, or a new secret. A new name does not.
 */
export function editNeedsApproval(
  server: Pick<McpServer, 'url' | 'auth'>,
  edit: {
    readonly url: string;
    readonly authKind: McpAuthKind;
    readonly headerName: string | null;
    readonly secret: string;
  },
): boolean {
  return (
    edit.url.trim() !== server.url ||
    edit.authKind !== server.auth.kind ||
    (edit.authKind === 'header' && (edit.headerName ?? '') !== (server.auth.headerName ?? '')) ||
    edit.secret !== ''
  );
}

/** A URL the form may send: https, a host, no credentials in it. */
export function isSendableUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/* ── The console's queue (SYSTEM_ADMIN) ── */

const pendingServerShape = mcpServerShape.extend({
  tenant: z.object({ id: z.string(), name: nullableText }),
  submittedBy: z.object({ id: z.string(), name: nullableText }).nullish().catch(null).default(null),
});
export const pendingServerSchema = z.preprocess(withLastError, pendingServerShape);
export type PendingServer = z.infer<typeof pendingServerShape>;
export const pendingServerListSchema = z.array(pendingServerSchema);

/* ── Custom API tools: the existing route, as it answers today ── */

export const CUSTOM_API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type CustomApiMethod = (typeof CUSTOM_API_METHODS)[number];
export const CUSTOM_API_AUTH_KINDS = ['none', 'bearer', 'api_key', 'basic'] as const;
export type CustomApiAuthKind = (typeof CUSTOM_API_AUTH_KINDS)[number];
export const CUSTOM_API_CATEGORIES = ['READ', 'WRITE', 'DELETE', 'ACTION'] as const;

export const customApiToolSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().default(''),
  whenToUse: z.string().default(''),
  whenNotToUse: nullableText,
  method: z.enum(CUSTOM_API_METHODS).catch('GET'),
  urlTemplate: z.string(),
  headers: z.record(z.string(), z.string()).catch({}).default({}),
  auth: z
    .object({
      kind: z.enum(CUSTOM_API_AUTH_KINDS).catch('none'),
      in: z.enum(['header', 'query']).nullish().catch(null).default(null),
      name: nullableText,
    })
    .catch({ kind: 'none', in: null, name: null }),
  /** Input: JSON schema in function-calling shape, kept as the server sent it. */
  parameters: z.unknown().optional(),
  bodyTemplate: nullableText,
  /** Output: dotted paths kept from the response; null keeps all of it. */
  responseFields: z.array(z.string()).nullish().catch(null).default(null),
  allowedHosts: z.array(z.string()).catch([]).default([]),
  category: knownOrUnknown(CUSTOM_API_CATEGORIES),
  riskLevel: knownOrUnknown(['LOW', 'MEDIUM', 'HIGH'] as const),
  isActive: z.boolean().catch(false).default(false),
  timeoutMs: z.number().int().positive().catch(10_000).default(10_000),
  hasSecrets: z.boolean().catch(false).default(false),
});
export type CustomApiTool = z.infer<typeof customApiToolSchema>;
export const customApiToolListSchema = z.array(customApiToolSchema);

/**
 * A custom API tool's risk in the four-level words - Backend (a)'s mapping
 * of the stored category + riskLevel: READ and not HIGH reads; a HIGH read
 * changes; WRITE and ACTION change, and HIGH on one cannot be undone. A
 * DELETE (category or method) cannot be undone. Money is not something these
 * fields can say, so no custom tool reads "money".
 */
export function customApiRisk(
  tool: Pick<CustomApiTool, 'category' | 'method' | 'riskLevel'>,
): ToolRisk {
  if (tool.category === 'UNKNOWN') return 'UNKNOWN';
  if (tool.category === 'DELETE' || tool.method === 'DELETE') return 'irreversible';
  if (tool.category === 'READ') return tool.riskLevel === 'HIGH' ? 'change' : 'read';
  return tool.riskLevel === 'HIGH' ? 'irreversible' : 'change';
}

export const customApiTestSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  reason: nullableText,
  meta: z
    .object({
      status: z.number().int().nullish().default(null),
      durationMs: z.number().nullish().default(null),
    })
    .nullish()
    .catch(null)
    .default(null),
});
export type CustomApiTest = z.infer<typeof customApiTestSchema>;

/** A slug as the route keeps it: lowercase letters, digits, underscores. */
export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
