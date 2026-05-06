/**
 * Action Contracts API helpers — CRUD over the tenant's ActionContract rows.
 * Mirrors services/ai/src/routes/action-contracts-admin.ts.
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

export type ExecutionMode = "ALL_REQUIRED" | "SEQUENCE" | "AT_LEAST_ONE";

export interface ActionContractRow {
  id: string;
  tenantId: string;
  trigger: string;
  requiredTools: { name: string }[];
  executionMode: ExecutionMode;
  order: string[] | null;
  blocking: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const STANDARD_TRIGGERS: Array<{ value: string; label: string }> = [
  { value: "booking", label: "Booking" },
  { value: "refund", label: "Refund" },
  { value: "follow_up", label: "Follow-up" },
  { value: "close_conversation", label: "Close conversation" },
];

export function listActionContracts(token: string) {
  return authedFetch<{ data: ActionContractRow[] }>(`/api/action-contracts`, token);
}
export function createActionContract(token: string, body: Partial<ActionContractRow>) {
  return authedFetch<{ data: ActionContractRow }>(`/api/action-contracts`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
export function updateActionContract(token: string, id: string, body: Partial<ActionContractRow>) {
  return authedFetch<{ data: ActionContractRow }>(`/api/action-contracts/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
export function deleteActionContract(token: string, id: string) {
  return authedFetch<{ ok: true }>(`/api/action-contracts/${id}`, token, { method: "DELETE" });
}
