import { getTranslations } from 'next-intl/server';

import { ACTIVITY_LABELS, type ActivityLabel } from '@/api/contracts/ai-activity';
import { humanizeTag } from '@/api/contracts/approvals';

/**
 * A tool in the reader's words, as the inbox panel says it: the server's
 * `labelKey` (Backend's one shared map - on the timeline, the audit log and
 * approvals). With no key (an older service, a row that is not a tool),
 * "working", or a key this screen has no words for: the tool's own name made
 * legible. Never a guess of ours.
 */
export async function toolWords(): Promise<(tool: string, labelKey: string | null) => string> {
  const steps = await getTranslations('inbox.wall.activity');
  return (tool, labelKey) =>
    labelKey && labelKey !== 'working' && (ACTIVITY_LABELS as readonly string[]).includes(labelKey)
      ? steps(`label.${labelKey as ActivityLabel}`)
      : humanizeTag(tool.split('.').pop() ?? tool);
}
