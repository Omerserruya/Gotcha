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
}

export function getPolicy(token: string) {
  return req<{ data: BusinessPolicy }>("GET", "/api/ai-assist/policy", token);
}

export function updatePolicy(token: string, patch: Partial<BusinessPolicy>) {
  return req<{ data: BusinessPolicy }>("PUT", "/api/ai-assist/policy", token, patch);
}
