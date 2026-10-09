import type { Skill, ToolChoice } from '@/api/contracts/skills';

import { toolLabel } from './ToolChip';

/**
 * The systems a skill's steps use, in step order and once each - 09's chips
 * ("Shopify", "Knowledge"). A provider is its brand-spelled name; one of
 * GOTCHA's own tools is its own name. Each with the tool it came from, for
 * the chip's mark.
 */
export function skillSystems(
  skill: { readonly steps: readonly Pick<Skill['steps'][number], 'tools' | 'toolDetails'>[] },
  tools: ReadonlyMap<string, ToolChoice> | null,
): { readonly label: string; readonly tool: string; readonly slug: string | null }[] {
  const seen = new Map<string, { label: string; tool: string; slug: string | null }>();
  for (const step of skill.steps)
    for (const name of step.tools) {
      const detail = step.toolDetails.find((d) => d.name === name) ?? null;
      const { provider, action, slug } = toolLabel(name, tools, detail);
      const label = provider ?? action;
      if (!seen.has(label)) seen.set(label, { label, tool: name, slug });
    }
  return [...seen.values()];
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
