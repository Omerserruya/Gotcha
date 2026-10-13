import { readDurableSetting, writeDurableSetting } from "./durable-settings";

/**
 * An AI employee's own level for a tool (A1, Omer 2026-10-13): equal to or
 * STRICTER than the workspace's, never looser. Workspace "Execute" lets an
 * employee keep Execute, or choose Ask or Never; workspace "Ask" allows Ask or
 * Never; workspace "Never" leaves Never.
 *
 * Stored as TenantSetting "agent:tool-levels:<aiAgentId>" = {toolName: "ask" |
 * "never"} (no migration). "execute" is never stored: absent means "the same as
 * the workspace", so a stored value can only ever tighten.
 */
export type ToolLevel = "execute" | "ask" | "never";
export type EmployeeToolLevel = Exclude<ToolLevel, "execute">;

const RANK: Record<ToolLevel, number> = { execute: 0, ask: 1, never: 2 };

export function agentToolLevelsKey(aiAgentId: string): string {
  return `agent:tool-levels:${aiAgentId}`;
}

export function stricterLevel(a: ToolLevel, b: ToolLevel): ToolLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The levels an employee may choose under this workspace level. */
export function allowedEmployeeLevels(workspace: ToolLevel): ToolLevel[] {
  return (["execute", "ask", "never"] as ToolLevel[]).filter((l) => RANK[l] >= RANK[workspace]);
}

export async function readAgentToolLevels(tenantId: string, aiAgentId: string): Promise<Record<string, EmployeeToolLevel>> {
  const raw = await readDurableSetting(tenantId, agentToolLevelsKey(aiAgentId));
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    const out: Record<string, EmployeeToolLevel> = {};
    for (const [k, l] of Object.entries(v ?? {})) if (l === "ask" || l === "never") out[k] = l;
    return out;
  } catch {
    return {};
  }
}

/** Set one tool's level; "execute" (or null) removes the employee's own level. */
export async function writeAgentToolLevel(
  tenantId: string,
  aiAgentId: string,
  toolName: string,
  level: ToolLevel | null,
  updatedBy?: string,
): Promise<Record<string, EmployeeToolLevel>> {
  const current = await readAgentToolLevels(tenantId, aiAgentId);
  if (level === "ask" || level === "never") current[toolName] = level;
  else delete current[toolName];
  await writeDurableSetting(tenantId, agentToolLevelsKey(aiAgentId), JSON.stringify(current), updatedBy);
  return current;
}
