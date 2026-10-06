import { getTranslations } from 'next-intl/server';

import { ACTIVITY_LABELS, labelForTool, type ActivityLabel } from '@/api/contracts/ai-activity';
import { humanizeTag } from '@/api/contracts/approvals';

/**
 * A tool in the reader's words, as the inbox panel says it.
 *
 *   labelKey given   the server's key (a9c79156, Backend's one map). `null` -
 *                    an older service - or "working", or a key this screen
 *                    has no words for: the tool's own name made legible.
 *   labelKey absent  a row that never carries one (04e's audit events and
 *                    approvals): `labelForTool`, the copy of that map.
 */
export async function toolWords(): Promise<(tool: string, labelKey?: string | null) => string> {
  const steps = await getTranslations('inbox.wall.activity');
  const legible = (tool: string) => humanizeTag(tool.split('.').pop() ?? tool);
  const words = (key: string | null): string | null =>
    key && key !== 'working' && (ACTIVITY_LABELS as readonly string[]).includes(key)
      ? steps(`label.${key as ActivityLabel}`)
      : null;
  return (tool, labelKey) =>
    (labelKey === undefined ? words(labelForTool(tool)) : words(labelKey)) ?? legible(tool);
}
