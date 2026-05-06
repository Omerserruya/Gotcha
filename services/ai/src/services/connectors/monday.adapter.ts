/**
 * Monday.com adapter — production-grade.
 *
 * Auth: Monday OAuth (Authorization Code grant). Tokens last 1 year so we
 * mostly don't refresh — but if `refreshToken` is present we honor it.
 *
 * Setup:
 *   - Tenant connects via OAuth → we list boards for selection.
 *   - Optionally pin one default board id in `config.defaultBoardId`.
 *
 * Tools (top patterns from Monday automation use-cases):
 *   - monday.list_boards       — admin selector + AI discovery
 *   - monday.list_items        — items on a board (paginated)
 *   - monday.get_item          — full item detail
 *   - monday.create_item       — new item on a board
 *   - monday.update_item_column — patch one column on an item
 *   - monday.add_item_update   — add a comment/update on an item
 *
 * API: GraphQL — single endpoint at https://api.monday.com/v2.
 */

import {
  registerAdapter,
  type ProviderAdapter,
  type ToolDefinition,
} from "./integration-framework";

const MONDAY_GQL = "https://api.monday.com/v2";
const MONDAY_TOKEN = "https://auth.monday.com/oauth2/token";

const TOOLS: ToolDefinition[] = [
  {
    name: "monday.list_boards",
    description: "List Monday.com boards visible to the connected user.",
    whenToUse: "Admin selecting a board, or AI discovering available boards.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 25, max 200." },
      },
    },
  },
  {
    name: "monday.list_items",
    description: "List items on a board (paginated).",
    whenToUse: "Finding existing items by board context.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        board_id: { type: "string", description: "Board id. Falls back to config.defaultBoardId." },
        limit: { type: "number", description: "Default 25, max 100." },
        cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
      },
    },
  },
  {
    name: "monday.get_item",
    description: "Get one Monday item with all its column values.",
    whenToUse: "You have an item id and need full detail.",
    category: "READ",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "string" },
      },
      required: ["item_id"],
    },
  },
  {
    name: "monday.create_item",
    description: "Create a new item on a Monday board.",
    whenToUse: "Recording a new lead/ticket/task in Monday from a conversation.",
    category: "WRITE",
    riskLevel: "MEDIUM",
    parameters: {
      type: "object",
      properties: {
        board_id: { type: "string", description: "Board id. Falls back to config.defaultBoardId." },
        item_name: { type: "string" },
        column_values: { type: "object", description: "Map of column id → value (Monday's strict shapes apply)." },
        group_id: { type: "string", description: "Optional group to drop the item into." },
      },
      required: ["item_name"],
    },
  },
  {
    name: "monday.update_item_column",
    description: "Update one column on a Monday item.",
    whenToUse: "Changing status / owner / dates on a known item.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        board_id: { type: "string" },
        item_id: { type: "string" },
        column_id: { type: "string" },
        value: { description: "New value (Monday accepts JSON strings for complex columns)." },
      },
      required: ["board_id", "item_id", "column_id", "value"],
    },
  },
  {
    name: "monday.add_item_update",
    description: "Add a comment/update to a Monday item.",
    whenToUse: "Recording a customer interaction or ops note on the item.",
    category: "WRITE",
    riskLevel: "LOW",
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        body: { type: "string", description: "Update text (HTML allowed)." },
      },
      required: ["item_id", "body"],
    },
  },
];

const MondayAdapter: ProviderAdapter = {
  slug: "monday",
  tools: () => TOOLS,

  async refreshTokens(creds) {
    const clientId = process.env.MONDAY_CLIENT_ID;
    const clientSecret = process.env.MONDAY_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("MONDAY_CLIENT_ID/SECRET not configured");
    if (!creds.refreshToken) throw new Error("no_refresh_token");
    const res = await fetch(MONDAY_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refreshToken,
      }).toString(),
    });
    if (!res.ok) throw new Error(`monday_refresh_${res.status}`);
    const j: any = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || creds.refreshToken,
      expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : undefined,
      scope: j.scope,
    };
  },

  async execute({ toolName, args, credentials, config }) {
    const token = credentials.accessToken;
    if (!token) throw new Error("no_access_token");
    const defaultBoardId = config.defaultBoardId || config.boardId;
    const boardId = args.board_id || defaultBoardId;

    switch (toolName) {
      case "list_boards": {
        const limit = Math.min(200, Number(args.limit ?? 25));
        const r: any = await mondayGql(token, `query($limit: Int!) { boards(limit: $limit) { id name description state } }`, { limit });
        return r.data?.boards || [];
      }
      case "list_items": {
        if (!boardId) throw new Error("board_id_required");
        const limit = Math.min(100, Number(args.limit ?? 25));
        const cursor = args.cursor ? String(args.cursor) : null;
        const q = `query($id: [ID!]!, $limit: Int!, $cursor: String) {
          boards(ids: $id) {
            items_page(limit: $limit, cursor: $cursor) {
              cursor
              items { id name state column_values { id text value } }
            }
          }
        }`;
        const r: any = await mondayGql(token, q, { id: [String(boardId)], limit, cursor });
        const page = r.data?.boards?.[0]?.items_page;
        return { items: page?.items || [], cursor: page?.cursor };
      }
      case "get_item": {
        const q = `query($id: [ID!]!) {
          items(ids: $id) {
            id name state board { id name }
            column_values { id text value type }
            updates(limit: 5) { id body created_at }
          }
        }`;
        const r: any = await mondayGql(token, q, { id: [String(args.item_id)] });
        return r.data?.items?.[0] || null;
      }
      case "create_item": {
        if (!boardId) throw new Error("board_id_required");
        const q = `mutation($boardId: ID!, $itemName: String!, $columnValues: JSON, $groupId: String) {
          create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, group_id: $groupId) {
            id name
          }
        }`;
        const r: any = await mondayGql(token, q, {
          boardId: String(boardId),
          itemName: String(args.item_name),
          columnValues: args.column_values ? JSON.stringify(args.column_values) : undefined,
          groupId: args.group_id || undefined,
        });
        return r.data?.create_item;
      }
      case "update_item_column": {
        const q = `mutation($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
          change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
        }`;
        const r: any = await mondayGql(token, q, {
          boardId: String(args.board_id),
          itemId: String(args.item_id),
          columnId: String(args.column_id),
          value: typeof args.value === "string" ? JSON.stringify(args.value) : JSON.stringify(args.value),
        });
        return r.data?.change_column_value;
      }
      case "add_item_update": {
        const q = `mutation($itemId: ID!, $body: String!) {
          create_update(item_id: $itemId, body: $body) { id created_at }
        }`;
        const r: any = await mondayGql(token, q, { itemId: String(args.item_id), body: String(args.body) });
        return r.data?.create_update;
      }
      default:
        throw new Error(`unknown_monday_tool:${toolName}`);
    }
  },
};

async function mondayGql(token: string, query: string, variables?: any): Promise<any> {
  const res = await fetch(MONDAY_GQL, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`monday_${res.status}: ${text.slice(0, 240)}`);
  }
  const j: any = await res.json();
  if (j.errors?.length) {
    throw new Error(`monday_gql: ${j.errors.map((e: any) => e.message).join("; ").slice(0, 240)}`);
  }
  return j;
}

// Setup helper used by the admin route to populate the board selector.
export async function mondayListBoards(token: string): Promise<Array<{ id: string; name: string }>> {
  const r = await mondayGql(token, `query { boards(limit: 200) { id name } }`);
  return (r.data?.boards || []).map((b: any) => ({ id: b.id, name: b.name }));
}

registerAdapter(MondayAdapter);
export default MondayAdapter;
