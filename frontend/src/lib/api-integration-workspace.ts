/**
 * Client for the Integrations & Tools workspace.
 *
 * Mirrors the server's classification rather than re-deriving it: the sidebar
 * grouping and every tool's availability verdict are computed once, on the
 * backend, from the same sources the runtime enforces against. The UI renders
 * what it is told.
 */

import type { PermissionState, RiskGroup, ToolAvailability } from "./tool-availability-client";

// Local helper, matching the other api-* modules in this directory (api.ts does
// not export its own).
const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

interface FetchOptions extends RequestInit {
  token?: string;
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, headers: extraHeaders, ...rest } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((extraHeaders as Record<string, string>) || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { headers, ...rest });
  if (!res.ok) {
    // Preserve the server's reason. Collapsing a 403 or 500 into a generic
    // failure is how "not entitled" becomes "not connected" in the UI.
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type WorkspaceEntryKind = "tool_integration" | "external_connection";
export type ExternalOwner = "channels" | "knowledge" | "integration_setup";
export type ConnectionState =
  | "connected" | "warning" | "disconnected" | "available" | "not_entitled";

export interface WorkspaceEntry {
  id: string;
  name: string;
  kind: WorkspaceEntryKind;
  state: ConnectionState;
  category: string | null;
  description: string | null;
  logoUrl: string | null;
  /** null for external connections - never 0, so the UI cannot imply "no tools". */
  toolCount: number | null;
  owner?: ExternalOwner;
  href?: string;
  warning?: { reason: "missing_scopes" | "capability_error" | "stale"; scopes?: string[] };
  internal?: boolean;
}

export interface WorkspaceSidebar {
  toolIntegrations: {
    connected: WorkspaceEntry[];
    available: WorkspaceEntry[];
    unavailable: WorkspaceEntry[];
  };
  externalConnections: WorkspaceEntry[];
}

export interface WorkspaceTool {
  name: string;
  displayName: string;
  description: string;
  riskGroup: RiskGroup;
  availability: ToolAvailability;
  provisioned: boolean;
  requiredScopes: string[];
  execution?: "adapter" | "http";
  isDefault: boolean;
}

export interface IntegrationDetail {
  id: string;
  name: string;
  internal: boolean;
  connected?: boolean;
  missingScopes?: string[];
  grantedScopes?: string[];
  capabilityStatus?: string | null;
  capabilityFresh?: boolean;
  counts: {
    total: number; enabled: number; alwaysAllow: number;
    requireApproval: number; disabled: number; unavailable: number;
  };
  groups: Array<{ riskGroup: RiskGroup; tools: WorkspaceTool[] }>;
}

export function getIntegrationWorkspace(token: string) {
  return apiFetch<{ data: WorkspaceSidebar }>("/api/integration-workspace", { token });
}

export function getIntegrationDetail(token: string, id: string) {
  return apiFetch<{ data: IntegrationDetail }>(
    `/api/integration-workspace/${encodeURIComponent(id)}`,
    { token },
  );
}

/**
 * Set a tool's policy. The three UI states map onto the two stored booleans in
 * ONE place so the control cannot drift from what it writes; the server
 * provisions the tool row when a non-disabled state is chosen.
 */
export function setToolPolicy(
  token: string,
  toolName: string,
  state: Exclude<PermissionState, "unavailable">,
) {
  const body =
    state === "disabled"
      ? { enabled: false }
      : { enabled: true, requiresApproval: state === "require_approval" };
  return apiFetch<{ data: unknown }>(
    `/api/tool-permissions/${encodeURIComponent(toolName)}`,
    { token, method: "PUT", body: JSON.stringify(body) },
  );
}
