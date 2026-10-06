import { humanizeTag } from '@/api/contracts/approvals';
import type { Skill, ToolChoice } from '@/api/contracts/skills';

/**
 * The systems a skill's steps use, in step order and once each - 09's chips
 * ("Shopify", "Knowledge", "Customer card"). An integration tool is its
 * integration; a system tool is its own name. With the catalogue unread, the
 * tool name's prefix, made legible.
 */
export function skillSystems(
  skill: Pick<Skill, 'steps'>,
  tools: ReadonlyMap<string, ToolChoice> | null,
): string[] {
  const systemOf = (name: string): string => {
    const tool = tools?.get(name);
    if (tool?.source === 'integration' && tool.integrationSlug)
      return humanizeTag(tool.integrationSlug);
    if (tool?.displayName) return tool.displayName;
    return humanizeTag(name.includes('.') ? name.split('.')[0]! : name);
  };
  return [...new Set(skill.steps.flatMap((s) => s.tools.map(systemOf)))];
}

/** Two letters for an employee's avatar: "Shira" → "SH", "Noa Cohen" → "NC". */
export function employeeInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** One of the three avatar fills, stable per employee. */
export function avatarTone(id: string): 1 | 2 | 3 {
  let sum = 0;
  for (const ch of id) sum = (sum + ch.charCodeAt(0)) % 9973;
  return ((sum % 3) + 1) as 1 | 2 | 3;
}
