import { hasOwnWords, humaniseToolName } from '@/api/contracts/capabilities';
import type { EmployeeTool } from '@/api/contracts/employees';

import type { ToolLevelRow } from './EmployeeToolLevels';

/**
 * An action's name for E5's list and the employee's card (dev, 2026-10-13:
 * the card listed "Close conversation", "Create task" in English on a
 * Hebrew page).
 *
 *   an integration's action   "{integration} · {the catalogue's name}" -
 *                             the server's `label`, in the reader's language
 *   GOTCHA's own action       our own words (capabilities `tool.*`); the
 *                             server has none and sends the tool's name
 *   neither                   the name made readable
 */
export function toolLabel(
  tool: Pick<EmployeeTool, 'toolName' | 'label' | 'integration'>,
  integrationName: (slug: string) => string | null,
  ownWords: (toolName: string) => string,
): string {
  const label = tool.label?.trim();
  if (tool.integration && label && label !== tool.toolName) {
    const name = integrationName(tool.integration);
    return name ? `${name} · ${label}` : label;
  }
  return hasOwnWords(tool.toolName) ? ownWords(tool.toolName) : humaniseToolName(tool.toolName);
}

/** The server's rows, named. */
export function toolLevelRows(
  tools: readonly EmployeeTool[] | null,
  integrationName: (slug: string) => string | null,
  ownWords: (toolName: string) => string,
): readonly ToolLevelRow[] | null {
  return tools
    ? tools.map((tool) => ({
        toolName: tool.toolName,
        label: toolLabel(tool, integrationName, ownWords),
        workspaceLevel: tool.workspaceLevel,
        ownLevel: tool.ownLevel ?? null,
        employeeLevel: tool.employeeLevel,
        allowedLevels: tool.allowedLevels,
      }))
    : null;
}
