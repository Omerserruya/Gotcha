import { getTranslations } from 'next-intl/server';

import { labelForTool } from '@/api/contracts/ai-activity';
import { humanizeTag } from '@/api/contracts/approvals';

/**
 * A tool in the reader's words: the inbox panel's label for it (Backend's own
 * LABEL_RULES, mirrored in `labelForTool`), else its name made legible.
 * "Escalate to human" inside a Hebrew sentence was the raw tool, translated
 * by nobody (measured on dev, 04e).
 */
export async function toolWords(): Promise<(tool: string) => string> {
  const steps = await getTranslations('inbox.wall.activity');
  return (tool) => {
    const known = labelForTool(tool);
    return known ? steps(`label.${known}`) : humanizeTag(tool.split('.').pop() ?? tool);
  };
}
