/**
 * Funnel API helpers - CRUD over the tenant's TenantFunnel rows.
 *
 * Mirrors services/ai/src/routes/funnel-admin.ts. Token from AuthContext;
 * backend enforces ADMIN.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

async function authedFetch<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export type ConversationStage = "initial" | "exploration" | "objection" | "decision" | "support";
export type Intent = "informational" | "transactional" | "support" | "unclear";
export type UserType = "unknown" | "new_lead" | "returning" | "customer";
export type StrategyName = "QUALIFY" | "GUIDE" | "CONVERT" | "RESOLVE" | "RETAIN" | "REASSURE" | "N/A";
export type PlaybookId =
  | "lead_qualification"
  | "price_objection"
  | "deferral_handling"
  | "trust_concern"
  | "demo_request"
  | "support_resolution"
  | "feature_inquiry";

export interface StageGuard {
  intents?: Intent[];
  userTypes?: UserType[];
  markers?: string[];
}

export interface StageCopilotQuestion {
  id: string;
  text: string;
  required: boolean;
}

export interface StageCopilotDataField {
  field: string;
  label: string;
  required: boolean;
}

export interface StageExitCriteria {
  mustHaveFields?: string[];
  mustAskQuestions?: string[];
  positiveSignals?: string[];
  negativeSignals?: string[];
}

export interface StageCopilotConfig {
  goal?: string;
  requiredQuestions?: StageCopilotQuestion[];
  requiredDataFields?: StageCopilotDataField[];
  exitCriteria?: StageExitCriteria;
  nextStageId?: string;
}

export interface FunnelStage {
  id: string;
  label: string;
  baseStage: ConversationStage;
  entry?: StageGuard;
  exit?: StageGuard;
  /**
   * Vendor CRM stage value this funnel stage maps to. Used to resolve
   * the customer's current stage from the CRM context fetch and as the
   * value written when an auto-advance fires.
   */
  crmValue?: string;
  /**
   * Stage-scoped copilot configuration: per-stage goal, required questions,
   * required data fields, exit criteria, and explicit nextStageId. When
   * present, supersedes the channel-level copilot goals/questions/fields
   * during live cue generation and post-call evaluation.
   */
  copilot?: StageCopilotConfig;
}

export interface FunnelTransition {
  from: string;
  to: string;
  when?: StageGuard;
}

export interface StrategyOverride {
  match: { stageId?: string; baseStage?: ConversationStage; intent?: Intent; userType?: UserType };
  strategy: StrategyName;
  reason: string;
}

export interface PlaybookOverride {
  match: { stageId?: string; baseStage?: ConversationStage; intent?: Intent; strategy?: StrategyName };
  playbookIds: PlaybookId[];
  reason: string;
}

export interface FunnelRow {
  id: string;
  tenantId: string;
  funnelId: string;
  /** null = tenant default; string = department-scoped. */
  departmentId: string | null;
  isActive: boolean;
  stages: FunnelStage[];
  transitions: FunnelTransition[];
  strategyOverrides: StrategyOverride[] | null;
  playbookOverrides: PlaybookOverride[] | null;
  createdAt: string;
  updatedAt: string;
}

/** departmentId: null lists tenant-default funnels; omit to list all. */
export function listFunnels(token: string, departmentId?: string | null) {
  let qs = "";
  if (departmentId !== undefined) {
    qs = `?departmentId=${departmentId === null ? "null" : encodeURIComponent(departmentId)}`;
  }
  return authedFetch<{ data: FunnelRow[] }>(`/api/funnels${qs}`, token);
}

/** Lightweight summary for selector dropdowns - caller doesn't need stages JSON. */
export interface FunnelSummary {
  id: string;
  funnelId: string;
  departmentId: string | null;
  isActive: boolean;
  stageCount: number;
}

export async function listFunnelSummaries(token: string): Promise<FunnelSummary[]> {
  const r = await listFunnels(token);
  return r.data.map((f) => ({
    id: f.id,
    funnelId: f.funnelId,
    departmentId: f.departmentId,
    isActive: f.isActive,
    stageCount: Array.isArray(f.stages) ? f.stages.length : 0,
  }));
}

export function getFunnel(token: string, id: string) {
  return authedFetch<{ data: FunnelRow }>(`/api/funnels/${id}`, token);
}

export function createFunnel(token: string, body: Partial<FunnelRow>) {
  return authedFetch<{ data: FunnelRow }>(`/api/funnels`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateFunnel(token: string, id: string, body: Partial<FunnelRow>) {
  return authedFetch<{ data: FunnelRow }>(`/api/funnels/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function activateFunnel(token: string, id: string) {
  return authedFetch<{ ok: true }>(`/api/funnels/${id}/activate`, token, { method: "POST" });
}

export function deleteFunnel(token: string, id: string) {
  return authedFetch<{ ok: true }>(`/api/funnels/${id}`, token, { method: "DELETE" });
}
