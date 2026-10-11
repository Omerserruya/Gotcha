import type { ReactNode } from 'react';
import type { LucideProps } from 'lucide-react';

/*
 * The channel marks - one drawing per channel, across the product.
 *
 * Here, in the design system, since the desktop notification for an incoming
 * message (`shell/notification-icon.tsx`) draws the same mark: the shell may
 * not import a feature. `features/inbox/channel-marks.tsx` re-exports it, so
 * every screen that drew it still does, from this one table.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE BRANDS' OWN MARKS, NOT A LUCIDE STAND-IN (Omer, 2026-10-11)
 * ════════════════════════════════════════════════════════════════════════════
 * "Put the channels' official icons in the inbox instead of what's there
 * today." The path data is copied from the design reference,
 * `Redesigning GOTCHA from scratch 6/assets/icons/*.svg`, verbatim - the
 * files' c2pa metadata and fixed 64px size dropped, nothing else. Each one
 * says below which file it came from.
 *
 * ⚠ INLINE ATTRIBUTES ONLY, NO STYLESHEET. The notification icon renders this
 *   component to markup and rasterises it from a `data:` URL, where no CSS
 *   module reaches - so every colour that matters is on the element itself.
 *   That is also why the brand colours are literals and not tokens: a
 *   `var()` inside an SVG image resolves against nothing.
 *
 * ⚠ THE NEUTRAL GLYPHS PAINT WITH `currentColor`. Web chat, phone calls,
 *   plain email and an unknown channel have no third-party brand; they take
 *   the colour of whatever holds them, so they are right on a light panel
 *   and on the dark wall without a second drawing.
 */

/** One channel's drawing: its viewBox, and either the brand's fill or a neutral stroke. */
interface Drawing {
  /** `data-glyph` - which drawing this is, for a test or a stylesheet to find. */
  readonly glyph: string;
  readonly viewBox: string;
  /**
   * `brand`: the paths carry their own colour (a `fill` on the svg, or one per
   * path). `neutral`: a stroked line glyph in `currentColor`.
   */
  readonly paint: { readonly kind: 'brand'; readonly fill?: string } | { readonly kind: 'neutral' };
  readonly body: ReactNode;
}

/* `assets/icons/whatsapp.svg` - WhatsApp's glyph in its own #25D366. */
const WHATSAPP: Drawing = {
  glyph: 'whatsapp',
  viewBox: '0 0 24 24',
  paint: { kind: 'brand', fill: '#25D366' },
  body: (
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
  ),
};

/* `assets/icons/instagram.svg` - the glyph, flat in #E4405F (the file has no gradient). */
const INSTAGRAM: Drawing = {
  glyph: 'instagram',
  viewBox: '0 0 24 24',
  paint: { kind: 'brand', fill: '#E4405F' },
  body: (
    <path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" />
  ),
};

/* `assets/icons/messenger.svg` - the bolt-in-bubble, flat in #0084FF. */
const MESSENGER: Drawing = {
  glyph: 'messenger',
  viewBox: '0 0 24 24',
  paint: { kind: 'brand', fill: '#0084FF' },
  body: (
    <path d="M12 1.5C5.9 1.5 1.5 6.03 1.5 11.86c0 3.05 1.22 5.7 3.2 7.52.17.16.27.37.28.6l.05 1.82a.84.84 0 0 0 1.2.73l2.03-.9c.17-.08.37-.09.55-.04 1.01.28 2.09.42 3.19.42 6.1 0 10.5-4.53 10.5-10.15S18.1 1.5 12 1.5Zm6.3 7.86-3.08 4.9a1.58 1.58 0 0 1-2.27.42l-2.45-1.84a.63.63 0 0 0-.76 0l-3.31 2.51c-.44.34-1.02-.19-.72-.66l3.08-4.9a1.58 1.58 0 0 1 2.27-.42l2.45 1.84a.63.63 0 0 0 .76 0l3.31-2.51c.44-.34 1.02.19.72.66Z" />
  ),
};

/* `assets/icons/gmail.svg` - the M, flat in #EA4335. */
const GMAIL: Drawing = {
  glyph: 'gmail',
  viewBox: '0 0 24 24',
  paint: { kind: 'brand', fill: '#EA4335' },
  body: (
    <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
  ),
};

/*
 * `assets/icons/outlook.svg` - five layers, each with its own colour.
 *
 * ⚠ THE ONE MARK WITH A NEAR-BLACK PART: `#0A2767` measures 1.02:1 on the
 *   wall's `--copilot-well`, so on a dark surface it vanishes. The wall sets
 *   every mark on the light plate (`--channel-mark-plate`) for that reason.
 */
const OUTLOOK: Drawing = {
  glyph: 'outlook',
  viewBox: '0 0 24 24',
  paint: { kind: 'brand' },
  body: (
    <>
      <path fill="#0364B8" d="M22 5.5v13a1.5 1.5 0 0 1-1.5 1.5H10V4h10.5A1.5 1.5 0 0 1 22 5.5z" />
      <path fill="#0A2767" d="M22 12.1l-6 3.9-6-3.9V9.9l6 3.6 6-3.6z" opacity=".9" />
      <path fill="#28A8EA" d="M22 5.5V9.9l-6 3.6-6-3.6V4h10.5A1.5 1.5 0 0 1 22 5.5z" />
      <rect x="2" y="6" width="11" height="12" rx="1.5" fill="#0078D4" />
      <path
        fill="#fff"
        d="M7.5 8.6c-1.9 0-3.1 1.4-3.1 3.4s1.2 3.4 3.1 3.4 3.1-1.4 3.1-3.4-1.2-3.4-3.1-3.4zm0 1.3c1 0 1.6.9 1.6 2.1s-.6 2.1-1.6 2.1-1.6-.9-1.6-2.1.6-2.1 1.6-2.1z"
      />
    </>
  ),
};

/* `assets/icons/slack.svg` - the four-colour hash. */
const SLACK: Drawing = {
  glyph: 'slack',
  viewBox: '0 0 24 24',
  paint: { kind: 'brand' },
  body: (
    <>
      <path
        fill="#E01E5A"
        d="M5.04 15.12a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.3a2.52 2.52 0 0 1-5.04 0v-6.3z"
      />
      <path
        fill="#36C5F0"
        d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 0 1 0-5.04h6.31z"
      />
      <path
        fill="#2EB67D"
        d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 0 1 5.04 0v6.31z"
      />
      <path
        fill="#ECB22E"
        d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 0 1 0 5.04h-6.31z"
      />
    </>
  ),
};

/* `assets/icons/shopify.svg` - the bag, flat in #7AB55C. Shopify's chat is Shopify's. */
const SHOPIFY: Drawing = {
  glyph: 'shopify',
  viewBox: '0 0 24 24',
  paint: { kind: 'brand', fill: '#7AB55C' },
  body: (
    <path d="M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z" />
  ),
};

/* `assets/icons/globe.svg` - web chat has no third-party brand. */
const WEB: Drawing = {
  glyph: 'globe',
  viewBox: '0 0 24 24',
  paint: { kind: 'neutral' },
  body: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
};

/* `assets/icons/phone.svg` - a call, not a website. */
const PHONE: Drawing = {
  glyph: 'phone',
  viewBox: '0 0 24 24',
  paint: { kind: 'neutral' },
  body: (
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
  ),
};

/*
 * Plain email (IMAP/SMTP) is nobody's brand: lucide's `mail`, the glyph it
 * wore before, as path data so it draws through this one component.
 */
const MAIL: Drawing = {
  glyph: 'mail',
  viewBox: '0 0 24 24',
  paint: { kind: 'neutral' },
  body: (
    <>
      <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </>
  ),
};

/*
 * ⚠⚠ AN UNKNOWN CHANNEL GETS A PLAIN SPEECH BUBBLE - not nothing, and no
 *    longer the globe. `channel` is an unconstrained column; a globe called
 *    an unknown channel "your website", which is a guess. lucide's
 *    `message-square` says only "a conversation", which is all we know.
 */
const UNKNOWN: Drawing = {
  glyph: 'unknown',
  viewBox: '0 0 24 24',
  paint: { kind: 'neutral' },
  body: (
    <path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
  ),
};

/**
 * Every channel the platform models (`CHANNEL_TYPES` in `api/contracts/
 * channels.ts` - the design system may not import it, so the test that
 * enumerates that list is `features/inbox/channel-marks.test.tsx`).
 */
const DRAWINGS: Readonly<Record<string, Drawing>> = {
  WHATSAPP,
  MESSENGER,
  INSTAGRAM,
  EMAIL: MAIL,
  GMAIL,
  OUTLOOK,
  SLACK,
  VOICE: PHONE,
  WEBCHAT: WEB,
  SHOPIFY_LIVE_CHAT: SHOPIFY,
};

function drawingOf(channel: string | null): Drawing {
  return (channel !== null && Object.hasOwn(DRAWINGS, channel) && DRAWINGS[channel]) || UNKNOWN;
}

type Labelled =
  /** The channel's name, already translated - the mark's accessible name. */
  | { readonly label: string; readonly decorative?: never }
  /**
   * Only where the channel's name is written as text right beside the mark:
   * a screen reader would otherwise hear it twice.
   */
  | { readonly decorative: true; readonly label?: never };

/**
 * The channel's mark - the one component every channel badge, chip and tile
 * draws through.
 *
 * `label` is required unless the site says `decorative`: a mark that is the
 * only statement of the channel must say it to a screen reader too.
 */
export function ChannelMark({
  channel,
  size = 16,
  ...naming
}: {
  readonly channel: string | null;
  /** Rendered width and height in px. 16 is the size it is drawn to read at. */
  readonly size?: number;
} & Labelled) {
  const drawing = drawingOf(channel);
  const neutral = drawing.paint.kind === 'neutral';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={drawing.viewBox}
      {...(naming.decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': naming.label })}
      focusable="false"
      data-channel-mark=""
      data-glyph={drawing.glyph}
      {...(neutral
        ? {
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round' as const,
            strokeLinejoin: 'round' as const,
          }
        : drawing.paint.kind === 'brand' && drawing.paint.fill
          ? { fill: drawing.paint.fill }
          : {})}
    >
      {drawing.body}
    </svg>
  );
}

/**
 * lucide's own `instagram` outline, copied from 02's rendered DOM - for the
 * onboarding's "Instagram" source, which sits in a row of lucide line icons
 * and names a place to import from, not a channel. Channels draw
 * `ChannelMark`.
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
      data-glyph="instagram-outline"
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

/**
 * Which tinted surface a channel's tile sits on, for the screens that draw
 * one (Automations, Channels, Customers, Employees). The mark itself is
 * `ChannelMark`; this is only the tile behind it.
 */
const TONES: Readonly<Record<string, string>> = {
  WHATSAPP: 'whatsapp',
  INSTAGRAM: 'instagram',
  MESSENGER: 'messenger',
  EMAIL: 'email',
  GMAIL: 'email',
  OUTLOOK: 'email',
};

export function channelTone(channel: string | null): string {
  return (channel !== null && Object.hasOwn(TONES, channel) && TONES[channel]) || 'web';
}

/**
 * The mark as an icon component plus its tile's tone - the shape the other
 * screens already call. `Icon` IS `ChannelMark`, decorative, because each of
 * those sites writes the channel's name beside it or labels its container.
 */
type MarkIcon = (props: Pick<LucideProps, 'size' | 'strokeWidth'>) => ReactNode;

/*
 * ⚠ ONE `Icon` PER CHANNEL, KEPT. A component made inside each call is a new
 *   component type on every render, and React remounts its subtree each time.
 */
const icons = new Map<string, MarkIcon>();

export function channelMark(channel: string | null): {
  readonly Icon: MarkIcon;
  readonly tone: string;
} {
  const key = channel ?? '';
  let Icon = icons.get(key);
  if (!Icon) {
    Icon = function Mark({ size }) {
      return <ChannelMark channel={channel} size={Number(size ?? 16)} decorative />;
    };
    icons.set(key, Icon);
  }
  return { Icon, tone: channelTone(channel) };
}
