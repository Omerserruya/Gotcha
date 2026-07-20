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
  if (!res.ok) {
    // Preserve the server's answer. Routes reject with an actionable JSON body
    // (e.g. /builder/:id/complete → 422 `{error:"draft_not_ready", missing:[…]}`),
    // and throwing a bare "failed: 422" discarded exactly the detail the UI
    // needs to tell the user WHY - which is how a blocked "go live" ended up
    // looking like a dead button.
    const body = await res.json().catch(() => null as any);
    const err = new Error(
      body?.error
        ? `${body.error}${body.message ? `: ${body.message}` : ""}`
        : `${method} ${path} failed: ${res.status}`,
    );
    throw Object.assign(err, { status: res.status, body });
  }
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
  const res = await fetch(`${API_URL}/api/agent/run`, {
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
        // Malformed event - skip rather than blow up the loop.
      }
    }
  }
}

export function clearAgentMemory(token: string) {
  return req<{ removed: number }>("POST", "/api/agent/clear", token);
}

// ─── AI Employee Builder (dynamic creation agent) ───────────
//
// Replaces the old static creation wizard. The builder interviews the admin
// and assembles one AIAgent config via tool-calls. The DRAFT row's id IS the
// session id; each turn streams tokens + draft updates over SSE.

export interface BuilderDraftSnapshot {
  id: string;
  name: string;
  role: string;
  status: string;
  /** Wizard progress: "chat"|"kb"|"refine"|"tools" while incomplete, null once done. */
  builderStep: string | null;
  companyOverview: string | null;
  goal: string | null;
  successCriteria: string | null;
  tone: string;
  style: Record<string, boolean>;
  languages: Record<string, boolean>;
  persona: Record<string, unknown> | null;
  escalationRules: Array<{ label?: string; enabled?: boolean }>;
  escalationMessage: string;
  conversationFlow: Array<{ id?: string; action?: string; details?: string }>;
  customGuardrails: string[];
  channels: string[];
  funnel: { id: string; funnelId: string; stageCount: number } | null;
  knowledge: Array<{ id: string; name: string }>;
  tools: Array<{ tenantToolId: string; name: string; integration: string }>;
}

export type BuilderSSEEvent =
  | { type: "ready"; sessionId: string }
  | { type: "token"; text: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; ok: boolean; resultSummary: string }
  | { type: "draft_update"; draft: BuilderDraftSnapshot }
  | { type: "round_end"; round: number; hadToolCalls: boolean }
  | { type: "finalized"; draft: BuilderDraftSnapshot; ready: boolean; missing: string[] }
  | { type: "done"; usage: unknown; rounds: number }
  | { type: "error"; message: string }
  | { type: "close" };

// `goal` activates the goal-first (system-led) entry: the backend seeds the
// whole draft from the goal + business twin and the greeting presents it.
export function builderStart(token: string, departmentId?: string | null, locale?: string, forceNew?: boolean, goal?: string) {
  return req<{ data: { agentId: string; draft: BuilderDraftSnapshot; greeting: string; resumed?: boolean } }>(
    "POST",
    "/api/ai-agents/builder/start",
    token,
    { departmentId: departmentId ?? null, locale, forceNew: !!forceNew, ...(goal ? { goal } : {}) },
  );
}

// Persist wizard progress so an abandoned session resumes from this step.
export function builderSaveStep(token: string, agentId: string, step: string) {
  return req<{ data: { ok: boolean; step: string } }>(
    "POST",
    `/api/ai-agents/builder/${agentId}/step`,
    token,
    { step },
  );
}

// Finish the wizard: clears the resume pointer and promotes DRAFT → ACTIVE so
// the hand-off lands in the editor (not back in the builder).
export function builderComplete(token: string, agentId: string) {
  return req<{ data: { ok: boolean } }>(
    "POST",
    `/api/ai-agents/builder/${agentId}/complete`,
    token,
    {},
  );
}

export function builderGetDraft(token: string, agentId: string) {
  return req<{ data: { draft: BuilderDraftSnapshot; ready: boolean; missing: string[] } }>(
    "GET",
    `/api/ai-agents/builder/${agentId}/draft`,
    token,
  );
}

// Knowledge + tool options for the builder's checkbox-card UI.
export interface BuilderOptionTool { tenantToolId: string; name: string; integration: string; risk: string; attached: boolean }
export interface BuilderOptionKb { id: string; name: string; attached: boolean }
export function builderGetOptions(token: string, agentId: string) {
  return req<{ data: { tools: BuilderOptionTool[]; knowledgeBases: BuilderOptionKb[] } }>(
    "GET",
    `/api/ai-agents/builder/${agentId}/options`,
    token,
  );
}
export function builderToggleTool(token: string, agentId: string, tenantToolId: string, attach: boolean) {
  return req<{ data: { draft: BuilderDraftSnapshot } }>(
    "POST",
    `/api/ai-agents/builder/${agentId}/tool`,
    token,
    { tenantToolId, attach },
  );
}
export function builderToggleKnowledge(token: string, agentId: string, knowledgeBaseId: string, attach: boolean) {
  return req<{ data: { draft: BuilderDraftSnapshot } }>(
    "POST",
    `/api/ai-agents/builder/${agentId}/knowledge`,
    token,
    { knowledgeBaseId, attach },
  );
}
// Attach/detach many tools at once (Select all / per-category select-all).
export function builderToggleToolsBulk(token: string, agentId: string, tenantToolIds: string[], attach: boolean) {
  return req<{ data: { draft: BuilderDraftSnapshot } }>(
    "POST",
    `/api/ai-agents/builder/${agentId}/tools/bulk`,
    token,
    { tenantToolIds, attach },
  );
}

// Optional creation-wizard refinements (name / conversation flow / guardrails).
// Saved deterministically from the dedicated wizard step. Send only the fields
// you're changing; an empty array clears that field. Returns the fresh draft.
export interface BuilderRefinements {
  name?: string;
  conversationFlow?: Array<{ id?: string; action: string; details?: string }>;
  customGuardrails?: string[];
  /** Brand-voice archetype key (persona.brand_archetype). "" clears it. */
  brandArchetype?: string;
}
export function builderSaveRefinements(token: string, agentId: string, refinements: BuilderRefinements) {
  return req<{ data: { draft: BuilderDraftSnapshot } }>(
    "POST",
    `/api/ai-agents/builder/${agentId}/refinements`,
    token,
    refinements,
  );
}

// ─── Readiness Test ─────────────────────────────────────────
export type ReadinessCoverage = "full" | "partial" | "none";
export interface ReadinessQuestion {
  question: string;
  coverage: ReadinessCoverage;
  reason: string;
  gapType: "knowledge" | "tool" | "data" | "none";
}
export interface ReadinessRecommendation {
  type: "add_knowledge" | "connect_tool" | "add_business_data" | "add_faq" | "create_workflow" | "other";
  title: string;
  detail: string;
}
export interface ReadinessReport {
  score: number;
  totals: { full: number; partial: number; none: number; total: number };
  questions: ReadinessQuestion[];
  recommendations: ReadinessRecommendation[];
  generatedAt: string;
}
export function builderReadinessTest(token: string, agentId: string, locale?: string) {
  return req<{ data: ReadinessReport }>(
    "POST",
    `/api/ai-agents/builder/${agentId}/readiness-test`,
    token,
    { locale },
  );
}

export async function builderRunStream(
  token: string,
  input: { agentId: string; message: string; locale?: string },
  onEvent: (ev: BuilderSSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/ai-agents/builder/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    onEvent({ type: "error", message: text || `builder run failed (${res.status})` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
      try {
        onEvent(JSON.parse(dataLines.join("\n")) as BuilderSSEEvent);
      } catch {
        // skip malformed frame
      }
    }
  }
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
  /** What happened to the ACTION after a human said yes (distinct from the
   *  decision above): a manager approving is not the action succeeding. */
  executionState?: "NOT_STARTED" | "EXECUTING" | "SUCCEEDED" | "FAILED" | "LEGACY_UNVERIFIED";
  executionError?: string | null;
  customerNotifiedAt?: string | null;
  decisionChannel?: string | null;
  /** Out-of-band WhatsApp ping: "sent" | "skipped" | "failed". `skipped` is a
   *  first-class state carrying an actionable reason. */
  managerNotifyState?: "sent" | "skipped" | "failed" | null;
  managerNotifyReason?: string | null;
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

/** Re-run an approved action whose execution FAILED. The decision stands. */
export function retryApprovalExecution(token: string, id: string) {
  return req<{ data: { approvalId: string; executed: boolean; error: string | null } }>(
    "POST",
    `/api/approvals/${id}/retry-execution`,
    token,
  );
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

// ─── Customer Intelligence V2 - Industry Packs + Field Registry ──

export type FieldScope = "customer" | "opportunity" | "conversation" | "review_required";
export type FieldTypeName = "text" | "number" | "boolean" | "enum" | "date" | "entity_ref";
export type FieldOriginName = "pack" | "custom" | "discovered";

export interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  description?: string | null;
  type: FieldTypeName;
  scope: FieldScope;
  options: string[];
  required: boolean;
  stageRelevance: string[];
  aiExtract: boolean;
  syncToCrm: boolean;
  crmFieldMap?: Record<string, unknown> | null;
  origin: FieldOriginName;
  packSlug?: string | null;
  examples?: string[];
  negativeExamples?: string[];
  confidenceThreshold?: number | null;
}

export interface PackFieldTemplate {
  key: string;
  label: string;
  type: FieldTypeName;
  scope: FieldScope;
  options?: string[];
  required?: boolean;
}

export interface IntelligencePack {
  id: string;
  slug: string;
  name: string;
  version: number;
  isSystem: boolean;
  fields: PackFieldTemplate[];
}

export type FieldDefinitionInput = Partial<Omit<FieldDefinition, "id" | "origin">>;

export function listIndustryPacks(token: string) {
  return req<{ ok: boolean; packs: IntelligencePack[] }>("GET", "/api/industry-packs", token);
}

export function applyIndustryPack(token: string, slug: string) {
  return req<{ ok: boolean; applied: string[]; skipped: string[]; pack: IntelligencePack }>(
    "POST", "/api/industry-packs/apply", token, { slug },
  );
}

export function listFieldDefinitions(token: string, scope?: FieldScope) {
  const q = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  return req<{ ok: boolean; fields: FieldDefinition[] }>("GET", `/api/field-definitions${q}`, token);
}

export function createFieldDefinition(token: string, input: FieldDefinitionInput) {
  return req<{ ok: boolean; field: FieldDefinition }>("POST", "/api/field-definitions", token, input);
}

export function updateFieldDefinition(token: string, id: string, patch: FieldDefinitionInput) {
  return req<{ ok: boolean; field: FieldDefinition }>("PUT", `/api/field-definitions/${encodeURIComponent(id)}`, token, patch);
}

export function deleteFieldDefinition(token: string, id: string) {
  return req<{ ok: boolean }>("DELETE", `/api/field-definitions/${encodeURIComponent(id)}`, token);
}

// ─── Customer Intelligence V2 - Snapshot (Phase 3) ──────────

export interface SnapshotFact {
  key: string;
  label: string;
  value: unknown;
  type: string;
  confidence: number;
  source: string;
  uncertain: boolean;
}

export interface SnapshotGap {
  key: string;
  label: string;
  scope: FieldScope;
  required: boolean;
  importance: "high" | "medium" | "low";
}

export interface SnapshotOpportunity {
  id: string;
  type: string;
  title: string | null;
  stage: string | null;
  status: string;
  estimatedValue: number | null;
  nextAction: string | null;
  facts: SnapshotFact[];
  missing: SnapshotGap[];
  openedAt: string;
  lastActivityAt: string | null;
}

export interface CustomerSnapshot {
  ok: boolean;
  reason?: string;
  who: {
    identityKey: string | null;
    displayName: string | null;
    phone: string | null;
    email: string | null;
    language: string | null;
    vipTier: string | null;
    sentiment: string | null;
    signals: Record<string, unknown>;
  };
  customerFacts: SnapshotFact[];
  opportunities: SnapshotOpportunity[];
  now: {
    conversationId: string | null;
    channel: string | null;
    lastAt: string | null;
    intent: string | null;
    sentiment: string | null;
    summary: string | null;
  } | null;
  missing: SnapshotGap[];
  next: string | null;
  narrative: string | null;
  generatedAt: string;
}

export function getCustomerSnapshot(token: string, opts: { conversationId?: string; identityKey?: string }) {
  const q = new URLSearchParams();
  if (opts.conversationId) q.set("conversationId", opts.conversationId);
  if (opts.identityKey) q.set("identityKey", opts.identityKey);
  return req<{ ok: boolean; snapshot: CustomerSnapshot }>("GET", `/api/customer-snapshot?${q.toString()}`, token);
}

// ─── Customer Intelligence V2 - Review Queue ─────────────────

export interface IntelligenceReview {
  id: string;
  entityType: string;
  entityId: string;
  fieldKey: string;
  proposedValue: unknown;
  currentValue: unknown;
  confidence: number;
  evidence: string | null;
  reason: string;
  status: string;
  conversationId: string | null;
  createdAt: string;
}

export function listIntelligenceReviews(token: string) {
  return req<{ reviews: IntelligenceReview[]; pending: number }>(
    "GET",
    "/api/intelligence-reviews",
    token,
  );
}

export function approveIntelligenceReview(token: string, id: string) {
  return req("POST", `/api/intelligence-reviews/${encodeURIComponent(id)}/approve`, token);
}

export function rejectIntelligenceReview(token: string, id: string) {
  return req("POST", `/api/intelligence-reviews/${encodeURIComponent(id)}/reject`, token);
}

// ─── Business Rules (AI action policies) ─────────────────────

export interface BusinessPolicyRow {
  id: string;
  actionKind: string;
  enabled: boolean;
  version: number;
  config: Record<string, unknown>;
}

export function listBusinessPolicies(token: string) {
  return req<{ data: { actionKinds: string[]; policies: BusinessPolicyRow[] } }>(
    "GET",
    "/api/business-policies",
    token,
  );
}

export function saveBusinessPolicy(
  token: string,
  actionKind: string,
  body: { enabled: boolean; config: Record<string, unknown> },
) {
  return req<{ data: BusinessPolicyRow }>("PUT", `/api/business-policies/${actionKind}`, token, body);
}

export function previewBusinessPolicy(
  token: string,
  actionKind: string,
  facts: Record<string, unknown>,
) {
  return req<{ data: { decision: string; maxAmount?: number; reasonCodes: string[] } }>(
    "POST",
    `/api/business-policies/${actionKind}/preview`,
    token,
    { facts },
  );
}
