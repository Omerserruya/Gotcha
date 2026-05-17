/**
 * Client wrappers for the new GOTCHA AI backend endpoints
 * (F1 identity, F2/F3/F4 action planner + executor, F7 customer state,
 * F8 policy). Kept in a separate file from lib/api.ts so frontend UI
 * work can import these without merge conflicts against the main API
 * client.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

async function req<T = any>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

// ─── F1: Identity ──────────────────────────────────────────

export interface ResolveIdentityInput {
  email?: string;
  phone?: string;
  externalId?: string;
  channel?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export function resolveIdentity(token: string, input: ResolveIdentityInput) {
  return req("POST", "/api/identity/resolve", token, input);
}

export function mergeIdentities(token: string, targetId: string, sourceId: string) {
  return req("POST", "/api/identity/merge", token, { targetId, sourceId });
}

export function getCustomerTimeline(token: string, contactId: string) {
  return req("GET", `/api/identity/${contactId}/timeline`, token);
}

// ─── F2/F3/F4: Action Planner / Executor / Approval ───────

export interface PlannedAction {
  tool: string;
  params: Record<string, unknown>;
  reason: string;
  riskLevel: "low" | "medium" | "high";
}

export interface ExecutionPlan {
  summary: string;
  steps: PlannedAction[];
  requiresApproval: boolean;
}

export function planAction(token: string, prompt: string, context?: unknown) {
  return req<{ plan: ExecutionPlan }>("POST", "/api/action-planner/plan", token, {
    prompt,
    context,
  });
}

export function executePlan(
  token: string,
  plan: ExecutionPlan,
  opts: { approved?: boolean; dryRun?: boolean } = {},
) {
  return req("POST", "/api/action-planner/execute", token, { plan, ...opts });
}

export function getApprovalQueue(token: string) {
  return req("GET", "/api/action-planner/approvals", token);
}

// ─── System Copilot agent runtime (Command Center) ─────────
//
// Streams an `AgentRuntimeEvent` sequence from POST /api/agent/run via
// `text/event-stream`. We use fetch + ReadableStream (not the native
// EventSource) so we can attach an Authorization header and POST a body.
//
// The caller passes a stable `sessionId` (one per modal-open) so the
// backend can group memory rows and (later) summarise per session.

export type AgentSSEEvent =
  | { type: "ready"; sessionId: string }
  | { type: "context_attached"; resolved: { conversationId: string | null; contactId: string | null; route: string | null } }
  | { type: "token"; text: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; ok: boolean; resultSummary: string }
  | { type: "plan_proposed"; approvalRequestId: string; summary: string }
  | { type: "awaiting_approval"; approvalRequestId: string; tool: string }
  | { type: "denied"; tool: string; reason: string }
  | { type: "round_end"; round: number; hadToolCalls: boolean }
  | { type: "done"; usage: { input_tokens: number; output_tokens: number; total_tokens: number }; rounds: number }
  | { type: "error"; message: string }
  | { type: "close" };

export interface AgentRunInput {
  message: string;
  sessionId: string;
  client?: {
    route?: string | null;
    conversationId?: string | null;
    contactId?: string | null;
    extras?: Record<string, unknown> | null;
  };
  model?: string;
  ephemeral?: boolean;
  aiAgentId?: string | null;
}

export async function runAgentStream(
  token: string,
  input: AgentRunInput,
  onEvent: (ev: AgentSSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/agent/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    onEvent({ type: "error", message: text || `agent run failed (${res.status})` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE framing: events separated by "\n\n", each event has lines like
  // "event: <type>\n", "data: <json>\n". Comment lines (": …") are heartbeats.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (!frame.trim() || frame.startsWith(":")) continue;
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (dataLines.length === 0) continue;
      const json = dataLines.join("\n");
      try {
        const ev = JSON.parse(json) as AgentSSEEvent;
        onEvent(ev);
      } catch {
        // Malformed event — skip rather than blow up the loop.
      }
    }
  }
}

export function clearAgentMemory(token: string) {
  return req<{ removed: number }>("POST", "/api/agent/clear", token);
}

// ─── F4 bot-surface approvals (new) ────────────────────────
// These target the NEW conversation-service /api/approvals route
// (not the legacy action-planner one) and power the in-inbox
// approval card flow.

export interface ApprovalRequestRow {
  id: string;
  tenantId: string;
  conversationId: string;
  contactId: string | null;
  messageId: string | null;
  tool: string;
  params: Record<string, unknown>;
  summary: string;
  reason: string;
  policyRuleName: string | null;
  riskLevel: "low" | "medium" | "high";
  riskTags: string[];
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  expiresAt: string;
  createdAt: string;
  // Display-name resolutions populated by the list endpoint so the UI
  // doesn't render raw user cuids. `null` when the id wasn't a real user
  // (e.g. requestedBy = "bot" / "flow:xxx" / "ai-agent:xxx").
  decidedByName?: string | null;
  requestedByName?: string | null;
}

export interface ApprovalDetailResponse {
  approval: ApprovalRequestRow;
  conversation: any;
  contact: any;
  recentMessages: Array<{
    id: string;
    direction: "INBOUND" | "OUTBOUND";
    body: string | null;
    createdAt: string;
    senderName: string | null;
  }>;
}

export function listApprovals(
  token: string,
  opts: { status?: string; conversationId?: string; contactId?: string } = {},
) {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.conversationId) qs.set("conversationId", opts.conversationId);
  if (opts.contactId) qs.set("contactId", opts.contactId);
  const q = qs.toString();
  return req<{ data: ApprovalRequestRow[] }>(
    "GET",
    `/api/approvals${q ? `?${q}` : ""}`,
    token,
  );
}

export function getApprovalDetail(token: string, id: string) {
  return req<ApprovalDetailResponse>("GET", `/api/approvals/${id}`, token);
}

export function approveApproval(
  token: string,
  id: string,
  opts: { modifiedParams?: Record<string, unknown>; decisionReason?: string } = {},
) {
  return req("POST", `/api/approvals/${id}/approve`, token, opts);
}

export function rejectApproval(token: string, id: string, decisionReason: string) {
  return req("POST", `/api/approvals/${id}/reject`, token, { decisionReason });
}

export interface SimulateResponse {
  mode: "chat" | "execution";
  plan: ExecutionPlan | null;
  results: any[];
  answer?: string;
  clarification?: string | null;
}

export function simulateCommand(token: string, prompt: string, context?: unknown) {
  return req<SimulateResponse>(
    "POST",
    "/api/action-planner/simulate",
    token,
    { prompt, context },
  );
}

export function classifyIntent(token: string, prompt: string, context?: unknown) {
  return req<{ mode: "chat" | "execution"; confidence: number; answer: string | null; clarification: string | null }>(
    "POST",
    "/api/action-planner/classify",
    token,
    { prompt, context },
  );
}

// ─── F5/F7: Copilot + Customer State ──────────────────────

export function getSuggestions(token: string, conversationId: string) {
  return req("GET", `/api/ai-assist/${conversationId}/suggestions`, token);
}

export function getCustomerState(token: string, contactId: string) {
  return req("GET", `/api/ai-assist/customer-state/${contactId}`, token);
}

export function generateFollowup(token: string, conversationId: string) {
  return req("POST", `/api/ai-assist/${conversationId}/followup`, token);
}

// ─── F8: Business Policy ───────────────────────────────────

export interface BusinessPolicy {
  maxDiscountPercent: number;
  refundRequiresApproval: boolean;
  escalationKeywords: string[];
  blockedTopics: string[];
  outboundQuietHours?: { startHour: number; endHour: number; tz?: string };
}

export function getPolicy(token: string) {
  return req<{ data: BusinessPolicy }>("GET", "/api/ai-assist/policy", token);
}

export function updatePolicy(token: string, patch: Partial<BusinessPolicy>) {
  return req<{ data: BusinessPolicy }>("PUT", "/api/ai-assist/policy", token, patch);
}

// ─── Post-Conversation Config ───────────────────────────────

export interface SummaryFieldDef {
  key: string;
  label: string;
  description?: string;
  type?: string;
  options?: string[];
}

export interface PostConvRuleWhen {
  intent?: string;
  intents?: string[];
  sentiment?: "positive" | "neutral" | "negative" | "mixed";
  keywords?: string[];
}

export interface TaskRule {
  id: string;
  when: PostConvRuleWhen;
  task: { subject: string; body?: string; priority?: "low" | "normal" | "high" | "urgent" };
}

export interface CrmRule {
  id: string;
  when: PostConvRuleWhen;
  patch: Record<string, unknown>;
}

export interface PostConversationConfig {
  summaryFields: SummaryFieldDef[];
  taskRules: TaskRule[];
  crmRules: CrmRule[];
}

export function getPostConversationConfig(token: string) {
  return req<{ ok: true; config: PostConversationConfig }>(
    "GET",
    "/api/post-conversation-config",
    token,
  );
}

export function updatePostConversationConfig(
  token: string,
  patch: Partial<PostConversationConfig>,
) {
  return req<{ ok: true; config: PostConversationConfig }>(
    "PUT",
    "/api/post-conversation-config",
    token,
    patch,
  );
}

// ─── F4/F8: Tenant Tool Permissions ────────────────────────

export interface ToolPermissionRow {
  toolName: string;
  kind: "system" | "action" | "integration";
  category: string;
  description: string;
  enabled: boolean;
  requiresApproval: boolean;
  isDefault: boolean;
  approverRole: string | null;
  expiresAfterMin: number;
  allowModification: boolean;
  updatedAt: string | null;
}

export function listToolPermissions(token: string) {
  return req<{ data: ToolPermissionRow[] }>("GET", "/api/tool-permissions", token);
}

export function updateToolPermission(
  token: string,
  toolName: string,
  patch: Partial<Pick<ToolPermissionRow, "enabled" | "requiresApproval" | "approverRole" | "expiresAfterMin" | "allowModification">>,
) {
  return req("PUT", `/api/tool-permissions/${encodeURIComponent(toolName)}`, token, patch);
}
