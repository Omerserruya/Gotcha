import type { ReactNode } from 'react';
import {
  Globe,
  Mail,
  MessageCircle,
  MessagesSquare,
  Phone,
  ShoppingBag,
  type LucideProps,
} from 'lucide-react';

/*
 * The channel marks - which glyph and which tint each channel wears. Lifted
 * out of the inbox's queue so Customers (04) draws the same badge: one mark
 * per channel across the product, not one per screen.
 */

/**
 * lucide's own `instagram` glyph, copied from 02's rendered DOM.
 *
 * ⚠⚠ THE FILTER ROW MADE THE STAND-IN UNTENABLE. A globe for Instagram was a
 *    tolerable gap on a row badge; in 02's header the five channels sit side
 *    by side, and the stand-in put TWO identical globes next to each other,
 *    one meaning Instagram and one meaning web chat.
 *
 * ★ Not a camera or a lookalike: these are the exact three shapes 02 renders
 *   (`data-lucide="instagram"`, from lucide's CDN build, which still ships
 *   it). `lucide-react@1.38` dropped brand marks from the package, not from
 *   the design.
 */
export function InstagramGlyph({
  size = 24,
  strokeWidth = 2,
}: Pick<LucideProps, 'size' | 'strokeWidth'>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-glyph="instagram"
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

/**
 * The channel's mark: which lucide glyph, and which tint.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ I REPORTED THIS AS UNBUILDABLE. IT WAS A MISREADING OF WHICH FILE.
 * ════════════════════════════════════════════════════════════════════════════
 * `GOTCHA Prototype.dc.html` is a TEMPLATE and draws the badge as
 * `background: url({{ c.chIcon }})` - so I concluded the design wanted brand
 * images we do not have. `GOTCHA Directions.dc.html` renders the same badge
 * as `<i data-lucide="message-circle">`, and we have lucide.
 *
 * ★ Two files, two representations of one design. The prose and the mock were
 *   two documents; the prototype and the directions are two more.
 *
 * ⚠ AN UNKNOWN CHANNEL GETS THE GLOBE, not nothing and not a guess. `channel`
 *   is an unconstrained column - the same reason `channelName` answers
 *   "another channel" rather than echoing a raw enum.
 */
const CHANNEL_MARKS = {
  WHATSAPP: { Icon: MessageCircle, tone: 'whatsapp' },
  EMAIL: { Icon: Mail, tone: 'email' },
  INSTAGRAM: { Icon: InstagramGlyph, tone: 'instagram' },
  /* 02's filter row: `messages-square` on `#E3E8F2`/`#3E5C99`. It fell to the
     globe before, which is web chat's mark. */
  MESSENGER: { Icon: MessagesSquare, tone: 'messenger' },
  WEBCHAT: { Icon: Globe, tone: 'web' },
  /* Shopify's chat beside the web chat in the filter row: a bag, not a second globe. */
  SHOPIFY_LIVE_CHAT: { Icon: ShoppingBag, tone: 'web' },
  /* The wall's history lists calls beside chats; a globe would call one a website. */
  VOICE: { Icon: Phone, tone: 'web' },
} as const;

export function channelMark(channel: string | null): {
  readonly Icon: (props: Pick<LucideProps, 'size' | 'strokeWidth'>) => ReactNode;
  readonly tone: string;
} {
  if (channel === null) return { Icon: Globe, tone: 'web' };
  return CHANNEL_MARKS[channel as keyof typeof CHANNEL_MARKS] ?? { Icon: Globe, tone: 'web' };
}
