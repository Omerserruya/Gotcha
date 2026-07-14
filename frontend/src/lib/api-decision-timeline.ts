/**
 * Decision Timeline API helper - talks to /api/decision-timeline on the AI
 * service (backend: services/ai/src/routes/decision-timeline.ts, nginx-mounted).
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

async function authedFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export interface DecisionIteration {
  iteration: number;
  reasoningSummary: string;
  decisionType: string;
  proposedOperation?: string | null;
  runtimeResult?: string | null;
  observation?: string | null;
  progressed?: boolean | null;
  facts?: { billing?: string; withinLimits?: boolean; menu: string[]; allowed: string[] };
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
}

export interface DecisionRun {
  loopId: string;
  turnId: string;
  mode: string;
  goal?: string | null;
  terminationReason: string;
  iterationCount: number;
  spentUnits: number;
  wallMs: number;
  model: string;
  provider: string;
  reply?: string | null;
  createdAt: string;
  iterations: DecisionIteration[];
}

export interface DecisionTimeline {
  conversationId: string;
  runs: DecisionRun[];
}

export async function fetchDecisionTimeline(token: string, conversationId: string) {
  return authedFetch<{ data: DecisionTimeline }>(
    `/api/decision-timeline/conversation/${encodeURIComponent(conversationId)}`,
    token,
  );
}
