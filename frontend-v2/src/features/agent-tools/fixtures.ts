import {
  customApiToolSchema,
  mcpServerSchema,
  mcpToolSchema,
  pendingServerSchema,
  type CustomApiTool,
  type McpServer,
  type McpTool,
  type PendingServer,
} from '@/api/contracts/agent-tools';

/*
  Test and screenshot data, parsed by the real schemas: a field the schema
  would strip or reject fails here, not on dev ([[fixture-is-a-claim]]).
  The MCP shape is the DRAFT contract until Backend publishes.
*/

export function tool(over: Record<string, unknown> = {}): McpTool {
  return mcpToolSchema.parse({
    name: 'get_order',
    title: 'Look up an order',
    description: 'Finds an order by its number and returns its status.',
    risk: 'read',
    level: 'never',
    ...over,
  });
}

export const TOOLS: readonly McpTool[] = [
  tool(),
  tool({ name: 'update_address', title: 'Change a delivery address', description: 'Updates the address on an open order.', risk: 'change', level: 'ask' }),
  tool({ name: 'cancel_order', title: 'Cancel an order', description: 'Cancels an order that has not shipped.', risk: 'irreversible' }),
  tool({ name: 'issue_refund', title: 'Refund a payment', description: 'Refunds all or part of a payment.', risk: 'money' }),
  tool({ name: 'sync_inventory', title: null, description: null, effect: 'somethingNew', risk: undefined, changedSinceLastDiscovery: 'added' }),
];

export function server(over: Record<string, unknown> = {}): McpServer {
  return mcpServerSchema.parse({
    id: 'srv_1',
    name: 'Orders system',
    url: 'https://mcp.shop-example.co.il/mcp',
    auth: { kind: 'bearer' },
    hasSecret: true,
    status: 'READY',
    submittedAt: '2026-11-16T08:12:00.000Z',
    decidedAt: '2026-11-16T09:00:00.000Z',
    lastCheckedAt: '2026-11-16T09:01:00.000Z',
    tools: TOOLS,
    ...over,
  });
}

export function pending(over: Record<string, unknown> = {}): PendingServer {
  return pendingServerSchema.parse({
    ...server({ status: 'PENDING_APPROVAL', tools: [], decidedAt: null, lastCheckedAt: null }),
    tenant: { id: 'ten_1', name: 'Shop Example' },
    submittedBy: { id: 'usr_1', name: 'Dana Levi' },
    ...over,
  });
}

export function customTool(over: Record<string, unknown> = {}): CustomApiTool {
  return customApiToolSchema.parse({
    id: 'cat_1',
    slug: 'lookup_order',
    name: 'Look up an order',
    description: 'Look up an order in our internal API.',
    whenToUse: 'When the customer gives an order number.',
    whenNotToUse: null,
    method: 'GET',
    urlTemplate: 'https://api.shop-example.co.il/orders/{{order_id}}',
    headers: {},
    auth: { kind: 'bearer' },
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
    },
    bodyTemplate: null,
    responseFields: ['data.status'],
    allowedHosts: ['api.shop-example.co.il'],
    category: 'READ',
    riskLevel: 'LOW',
    isActive: true,
    timeoutMs: 10000,
    hasSecrets: true,
    ...over,
  });
}
