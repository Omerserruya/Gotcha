import 'server-only';

import { serverApi } from '@/api/client/server-api';
import {
  customApiToolListSchema,
  mcpServerListSchema,
  pendingServerListSchema,
  type CustomApiTool,
  type McpServer,
  type PendingServer,
} from '@/api/contracts/agent-tools';
import { customApiToolEndpoints, mcpServerEndpoints } from '@/api/endpoints/registry';
import { logger } from '@/observability/logger';

/*
  Each read is `null` when it failed - never an empty list. "You have no
  servers" over a failed read would invite a second connect of a server
  that is already there.
*/

/** The workspace's MCP servers, each with its tools. */
export async function loadMcpServers(): Promise<readonly McpServer[] | null> {
  try {
    return await serverApi().get({ endpoint: mcpServerEndpoints.list(), payload: mcpServerListSchema });
  } catch (cause) {
    logger.warn('agent_tools.mcp_servers_failed', { cause });
    return null;
  }
}

/** The workspace's custom API tools (`{ data }`, unwrapped by the client). */
export async function loadCustomApiTools(): Promise<readonly CustomApiTool[] | null> {
  try {
    return await serverApi().get({
      endpoint: customApiToolEndpoints.list(),
      payload: customApiToolListSchema,
    });
  } catch (cause) {
    logger.warn('agent_tools.custom_api_failed', { cause });
    return null;
  }
}

/** The console's queue: servers waiting for GOTCHA, every workspace. SYSTEM_ADMIN. */
export async function loadPendingServers(): Promise<readonly PendingServer[] | null> {
  try {
    return await serverApi().get({
      endpoint: mcpServerEndpoints.queue(),
      payload: pendingServerListSchema,
    });
  } catch (cause) {
    logger.warn('console.mcp_queue_failed', { cause });
    return null;
  }
}
