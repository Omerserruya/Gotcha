import { BookOpen, MessageCircle, ShieldCheck, Tag, User, Wrench } from 'lucide-react';

import { humaniseCode } from '@/api/contracts/capabilities';
import type { ToolChoice } from '@/api/contracts/skills';
import { INTEGRATION_LOGOS } from '@/features/capabilities/IntegrationLogo';
import { appPath } from '@/lib/base-path';

import styles from './Skills.module.css';

/**
 * A tool as 09/09b draw it: "Shopify · Find order", with the provider's mark.
 *
 * ★ The provider's spelling is the brand's (`humaniseCode`: "WooCommerce",
 *   never "Woocommerce"); the action is the tool's own name in sentence case;
 *   the mark is the one Integrations shows (`public/integrations/`). A tool of
 *   GOTCHA's own gets an icon for what it is about.
 */
export function toolLabel(
  name: string,
  tools: ReadonlyMap<string, ToolChoice> | readonly ToolChoice[] | null,
  detail?: {
    readonly provider: string | null;
    readonly providerLabel: string | null;
    readonly actionLabel: string | null;
  } | null,
): { readonly provider: string | null; readonly action: string; readonly slug: string | null } {
  const tool =
    tools === null
      ? undefined
      : Array.isArray(tools)
        ? (tools as readonly ToolChoice[]).find((x) => x.name === name)
        : (tools as ReadonlyMap<string, ToolChoice>).get(name);
  /* Backend's labels first (ab173090): the step's own details, then the tool list's. */
  const labelled = detail?.actionLabel ? detail : tool?.actionLabel ? tool : null;
  if (labelled) {
    return {
      provider: labelled.providerLabel,
      action: labelled.actionLabel!,
      slug: labelled.provider,
    };
  }
  /* An older service without labels: the name, made legible, the brand spelled right. */
  const bare = name.includes('.') ? name.split('.').pop()! : name;
  const action = humaniseCode((tool?.displayName || bare).toLowerCase());
  if (tool?.source === 'integration' && tool.integrationSlug) {
    return { provider: humaniseCode(tool.integrationSlug), action, slug: tool.integrationSlug };
  }
  if (!tool && name.includes('.')) {
    const prefix = name.split('.')[0]!;
    return { provider: humaniseCode(prefix), action, slug: prefix };
  }
  return { provider: null, action, slug: null };
}

/** The icon for one of GOTCHA's own tools, by what its name is about. */
function ownIcon(name: string) {
  const props = {
    className: styles.toolMark,
    size: 11,
    strokeWidth: 2,
    'aria-hidden': true,
  } as const;
  if (/knowledge|policy|faq|search_kb/.test(name)) return <BookOpen {...props} />;
  if (/approval/.test(name)) return <ShieldCheck {...props} />;
  if (/tag/.test(name)) return <Tag {...props} />;
  if (/message|send|reply/.test(name)) return <MessageCircle {...props} />;
  if (/contact|customer|note|profile/.test(name)) return <User {...props} />;
  return <Wrench {...props} />;
}

/** The mark for a provider slug or a tool: its logo, or an icon. Decorative. */
export function ToolMark({ name, slug }: { readonly name: string; readonly slug: string | null }) {
  const file = slug ? INTEGRATION_LOGOS[slug] : undefined;
  if (!file) return ownIcon(name);
  const src = appPath(`/integrations/${file}`);
  // A 1-9 KB local mark: `next/image` would optimise nothing here.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.toolMark} src={src} alt="" aria-hidden="true" />;
}
