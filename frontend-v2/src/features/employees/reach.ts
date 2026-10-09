import type { Reachability } from '@/api/contracts/employees';
import { WIDGET_CHANNELS } from '@/api/contracts/website-widget';

type Reach = NonNullable<Reachability['channels']>[number];

/** A channel as "Answers on" lists it: the Website widget is one, whatever it is made of. */
export interface FoldedReach {
  readonly channel: string;
  readonly reach: Reach['reach'];
  /** The Website widget's row: the web chat and the Shopify chats, folded. */
  readonly widget: boolean;
}

/**
 * ★ The Website widget is ONE row (supervisor, 2026-10-07, as the channel
 * list draws it): its web chat and Shopify chats fold into it, in the place
 * of the first of them. "Always" when every one of them the playbook lists
 * is always; otherwise "sometimes". A widget channel the read does not list
 * is not counted against it: the read lists only the workspace's ACTIVE
 * channels, so its absence may mean "not set up", not "not reached".
 */
export function foldWidget(channels: readonly Reach[]): FoldedReach[] {
  const isWidget = (channel: string) => (WIDGET_CHANNELS as readonly string[]).includes(channel);
  const parts = channels.filter((c) => isWidget(c.channel));
  const out: FoldedReach[] = [];
  for (const c of channels) {
    if (!isWidget(c.channel)) {
      out.push({ ...c, widget: false });
    } else if (c === parts[0]) {
      out.push({
        channel: c.channel,
        reach: parts.every((p) => p.reach === 'always') ? 'always' : 'sometimes',
        widget: true,
      });
    }
  }
  return out;
}
