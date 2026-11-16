# Your own tools: MCP servers and the Custom API (contract v0, 2026-11-16)

This contract was agreed with Frontend while the screen was being built. The backend is not built yet.

**Where it lives in the app:** Studio · Capabilities, in the rail group "Your own tools".

**Response shape:** every response is wrapped as `{data}`. Frontend reads any status it does not know as UNKNOWN.

## MCP servers

### Who approves

- A tenant ADMIN connects a server.
- Before it can be used, a SYSTEM_ADMIN approves it (Omer 2026-11-16: only we approve a server).

### Statuses

| Status | Meaning |
|---|---|
| `PENDING_APPROVAL` | Waiting for a SYSTEM_ADMIN. |
| `REJECTED` | Rejected, with `rejectReason`. |
| `DISCOVERING` | Reading the server's tools. This runs async after approval or a rediscover. |
| `READY` | Tools are discovered and usable. |
| `FAILED` | Something went wrong; see `lastError`. |

`lastError` is one of `unreachable`, `tls`, `auth_rejected`, `not_mcp`, `timeout` or `protocol`.

### Auth (write-only secrets)

The `auth` object takes one of these shapes:

- `{kind:"none"}`
- `{kind:"bearer", token}`
- `{kind:"header", headerName, headerValue}`

Reads return `auth: {kind, headerName?, hasSecret}`. The token or header value is never returned. OAuth comes later.

### Routes (ADMIN)

| Method and path | Body or effect |
|---|---|
| `GET /api/mcp-servers` | Lists the tenant's servers. |
| `POST /api/mcp-servers` | `{name, url, auth}`. The new server starts as `PENDING_APPROVAL`. |
| `PATCH /api/mcp-servers/:id` | Changing `url` or `auth` sends it back to `PENDING_APPROVAL`. Changing `name` only does not. |
| `DELETE /api/mcp-servers/:id` | Deletes the server. |
| `POST /api/mcp-servers/:id/rediscover` | Moves it to `DISCOVERING`. |
| `PUT /api/mcp-servers/:id/tools/:toolName` | `{level: "execute"\|"ask"\|"never"}`. This is the workspace level. |

### Routes (SYSTEM_ADMIN)

| Method and path | Body or effect |
|---|---|
| `GET /api/system/mcp-servers/pending` | Lists servers waiting for approval. |
| `POST /api/system/mcp-servers/:id/approve` | Approves; discovery starts. |
| `POST /api/system/mcp-servers/:id/reject` | `{reason}` |

### Tools

**Wire name:** `mcp.<serverSlug>.<tool>`.

**Fields on each tool:**
- `effect`: `read`, `change`, `irreversible` or `money` (also exposed as `risk`);
- `level`;
- `changedSinceLastDiscovery`: `added` or `removed`.

**Default levels:**
- Every tool starts at `never`.
- A `read` or `change` tool can be raised to `execute`.
- An `irreversible`, `money` or unknown tool is capped at `ask`.
- A `change` tool that someone switches on defaults to `ask`.

**Employee level:** set through the existing `PUT /api/ai-agents/:id/tool-levels/:toolName`. It is never looser than the workspace level.

**Per employee access:** `AIAgent.integrationAccess` gets the key `mcp:<serverId>`.

### Runtime (reply engine v2)

- A READY server's tools join the employee's surface, but only those whose levels allow them.
- They go through Gate 2 like every other tool: `ask` means a person's approval, and `never` means the tool is not offered at all.

## Custom API

- The existing `/api/custom-api-tools` routes (ADMIN, ai service) stay as they are.
- `effect` is derived from the existing `category` + `riskLevel` fields:

| Existing fields | effect |
|---|---|
| READ, not HIGH | `read` |
| other READ, or WRITE | `change` |
| HIGH on a write, or DELETE (category or method) | `irreversible` |
