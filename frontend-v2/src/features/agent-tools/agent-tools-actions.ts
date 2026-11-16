'use server';

import { z } from 'zod';

import { isApiError } from '@/api/client/api-error';
import { serverApi } from '@/api/client/server-api';
import { signInIfSignedOut } from '@/api/client/signed-out';
import {
  customApiTestSchema,
  MCP_REFUSALS,
  type CustomApiAuthKind,
  type CustomApiMethod,
  type CustomApiTest,
  type McpAuthKind,
  type McpRefusal,
} from '@/api/contracts/agent-tools';
import { customApiToolEndpoints, mcpServerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/**
 * Writes for a business's own tools. Every one is real: sending a server
 * puts it in GOTCHA's queue, a level decides what the AI may do on its own,
 * a custom API test fires the request at the business's own API. Mocked in
 * every test. The ★ secrets travel one way: in a body, never back.
 */
export type ToolsRefusal =
  | McpRefusal
  | 'slug_taken'
  | 'invalid'
  | 'forbidden'
  | 'failed';

export type ToolsWrite = { readonly ok: true } | { readonly ok: false; readonly reason: ToolsRefusal };

/** After `signInIfSignedOut` in the catch: a 401 never reaches here. */
function refusalOf(cause: unknown, event: string): ToolsWrite & { ok: false } {
  if (isApiError(cause)) {
    for (const candidate of [cause.code, cause.developerMessage]) {
      if (candidate && (MCP_REFUSALS as readonly string[]).includes(candidate)) {
        return { ok: false, reason: candidate as McpRefusal };
      }
    }
    if (cause.kind === 'authorization') return { ok: false, reason: 'forbidden' };
    // The custom API route answers in English text: its status is the code.
    if (cause.status === 409) return { ok: false, reason: 'slug_taken' };
    if (cause.status === 400 || cause.status === 422) return { ok: false, reason: 'invalid' };
  }
  logger.warn(event, { status: isApiError(cause) ? cause.status : undefined });
  return { ok: false, reason: 'failed' };
}

async function write(event: string, call: () => Promise<unknown>): Promise<ToolsWrite> {
  try {
    await call();
    return { ok: true };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, event);
  }
}

export interface McpServerInput {
  readonly name: string;
  readonly url: string;
  readonly authKind: McpAuthKind;
  readonly headerName: string | null;
  /** Empty keeps the stored one on an edit. */
  readonly secret: string;
}

/**
 * Backend's body (2026-11-16): `{ name, url, auth }`, the auth one of
 * `{ kind: 'none' }`, `{ kind: 'bearer', token }`,
 * `{ kind: 'header', headerName, headerValue }` - token and value write-only.
 * An edit sends `auth` only when the sign-in changed: a PATCH that carries
 * auth sends the server back to GOTCHA, and a rename must not.
 */
function mcpBody(input: McpServerInput, authChanged: boolean) {
  const secret = input.secret !== '' ? input.secret : undefined;
  const auth =
    input.authKind === 'bearer'
      ? { kind: 'bearer', ...(secret ? { token: secret } : {}) }
      : input.authKind === 'header'
        ? { kind: 'header', headerName: (input.headerName ?? '').trim(), ...(secret ? { headerValue: secret } : {}) }
        : { kind: 'none' };
  return {
    name: input.name.trim(),
    url: input.url.trim(),
    ...(authChanged ? { auth } : {}),
  };
}

/** Send a new server to GOTCHA's queue. */
export async function sendMcpServer(input: McpServerInput): Promise<ToolsWrite> {
  return write('agent_tools.mcp_send_failed', () =>
    serverApi().post({ endpoint: mcpServerEndpoints.list(), body: mcpBody(input, true), payload: z.unknown() }),
  );
}

/** Edit one; a new URL or auth sends it back to the queue (the route decides). */
export async function editMcpServer(
  serverId: string,
  input: McpServerInput,
  authChanged: boolean,
): Promise<ToolsWrite> {
  return write('agent_tools.mcp_edit_failed', () =>
    serverApi().patch({
      endpoint: mcpServerEndpoints.server(serverId),
      body: mcpBody(input, authChanged),
      payload: z.unknown(),
    }),
  );
}

/** Withdraw a pending server, or remove one: its tools stop for every employee. */
export async function removeMcpServer(serverId: string): Promise<ToolsWrite> {
  return write('agent_tools.mcp_remove_failed', () =>
    serverApi().delete({ endpoint: mcpServerEndpoints.server(serverId), payload: z.unknown() }),
  );
}

/** Read the server's tools again. New tools arrive off. */
export async function rediscoverMcpServer(serverId: string): Promise<ToolsWrite> {
  return write('agent_tools.mcp_discover_failed', () =>
    serverApi().post({
      endpoint: mcpServerEndpoints.discover(serverId),
      body: {},
      payload: z.unknown(),
    }),
  );
}

/** One tool's level: on its own, ask first, or never. */
export async function setMcpToolLevel(
  serverId: string,
  toolName: string,
  level: 'execute' | 'ask' | 'never',
): Promise<ToolsWrite> {
  return write('agent_tools.mcp_level_failed', () =>
    serverApi().put({
      endpoint: mcpServerEndpoints.tool(serverId, toolName),
      body: { level },
      payload: z.unknown(),
    }),
  );
}

/** GOTCHA's answer on a waiting server. SYSTEM_ADMIN; a rejection carries its reason. */
export async function decideMcpServer(
  serverId: string,
  decision: 'approve' | 'reject',
  reason: string,
): Promise<ToolsWrite> {
  return write('console.mcp_decision_failed', () =>
    decision === 'approve'
      ? serverApi().post({
          endpoint: mcpServerEndpoints.approve(serverId),
          body: {},
          payload: z.unknown(),
        })
      : serverApi().post({
          endpoint: mcpServerEndpoints.reject(serverId),
          body: { reason: reason.trim() },
          payload: z.unknown(),
        }),
  );
}

/* ── Custom API tools: the existing route ── */

export interface CustomApiInput {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse: string;
  readonly whenNotToUse: string;
  readonly method: CustomApiMethod;
  readonly urlTemplate: string;
  readonly allowedHosts: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly authKind: CustomApiAuthKind;
  readonly authIn: 'header' | 'query';
  readonly authName: string;
  /** Write-only. Empty fields keep what is stored. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Input: the JSON schema text as typed. */
  readonly parameters: unknown;
  readonly bodyTemplate: string;
  /** Output: dotted paths kept from the response. */
  readonly responseFields: readonly string[];
  readonly category: 'READ' | 'WRITE' | 'DELETE' | 'ACTION';
  readonly riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly isActive: boolean;
  readonly timeoutMs: number;
}

function customBody(input: CustomApiInput, isNew: boolean) {
  const secrets = Object.fromEntries(Object.entries(input.secrets).filter(([, v]) => v !== ''));
  return {
    ...(isNew ? { slug: input.slug } : {}),
    name: input.name.trim(),
    description: input.description.trim(),
    whenToUse: input.whenToUse.trim(),
    whenNotToUse: input.whenNotToUse.trim() || null,
    method: input.method,
    urlTemplate: input.urlTemplate.trim(),
    allowedHosts: input.allowedHosts,
    headers: input.headers,
    auth:
      input.authKind === 'api_key'
        ? { kind: 'api_key', in: input.authIn, name: input.authName.trim() }
        : { kind: input.authKind },
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    parameters: input.parameters,
    bodyTemplate: input.bodyTemplate.trim() || null,
    responseFields: input.responseFields.length > 0 ? input.responseFields : null,
    category: input.category,
    riskLevel: input.riskLevel,
    isActive: input.isActive,
    timeoutMs: input.timeoutMs,
  };
}

/** Create (`toolId` null) or edit one tool. The slug is fixed once created. */
export async function saveCustomApiTool(
  toolId: string | null,
  input: CustomApiInput,
): Promise<ToolsWrite> {
  return write('agent_tools.custom_api_save_failed', () =>
    toolId === null
      ? serverApi().post({
          endpoint: customApiToolEndpoints.list(),
          body: customBody(input, true),
          payload: z.unknown(),
        })
      : serverApi().patch({
          endpoint: customApiToolEndpoints.tool(toolId),
          body: customBody(input, false),
          payload: z.unknown(),
        }),
  );
}

export async function deleteCustomApiTool(toolId: string): Promise<ToolsWrite> {
  return write('agent_tools.custom_api_delete_failed', () =>
    serverApi().delete({ endpoint: customApiToolEndpoints.tool(toolId), payload: z.unknown() }),
  );
}

/** Fire the real request with sample input. Asked first on screen: it reaches their API. */
export async function testCustomApiTool(
  toolId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ readonly ok: true; readonly test: CustomApiTest } | (ToolsWrite & { ok: false })> {
  try {
    const test = await serverApi().post({
      endpoint: customApiToolEndpoints.test(toolId),
      body: { args },
      payload: customApiTestSchema,
    });
    return { ok: true, test };
  } catch (cause) {
    await signInIfSignedOut(cause);
    return refusalOf(cause, 'agent_tools.custom_api_test_failed');
  }
}
