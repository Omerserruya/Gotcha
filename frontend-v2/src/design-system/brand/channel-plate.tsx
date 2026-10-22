import { ChannelMark } from './channel-marks';
import styles from './channel-plate.module.css';

/*
 * The plate every channel's mark sits on - ONE drawing of it, everywhere.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ ONE PLATE, NOT A TINT PER CHANNEL (Omer, 2026-10-11)
 * ════════════════════════════════════════════════════════════════════════════
 * "The channel marks must look the same everywhere." The inbox drew the
 * brands' own marks on a white plate (`--channel-mark-plate`), styled three
 * times over; Automations, Channels, Customers and Employees still drew them
 * on per-channel tinted tiles - WhatsApp's green on a pale green is about
 * 1.7:1, the weakest contrast either colour could have. A brand draws its
 * mark for a white ground, so every site now draws this one plate: the
 * token's white, a hairline, a radius and the mark centred with room around
 * it, in proportion to the plate.
 *
 * ⚠ A SITE SIZES IT, IT DOES NOT RESTYLE IT. `size` picks a preset; a
 *   site's own class is for placing the plate (a badge's corner, a ring
 *   around a chosen filter) - never its ground, border or radius.
 *
 * The desktop notification (`shell/notification-icon.tsx`) is rasterised
 * from a `data:` URL where no stylesheet reaches, so it cannot render this
 * component - it draws the same plate from `PLATE_GEOMETRY` and the same
 * tokens instead.
 */

/**
 * Each preset: the plate's box, the mark's size inside it, and its radius, in
 * px. The stylesheet draws the box and radius from tokens
 * (`channel-plate.module.css`); `channel-plate.test.tsx` holds the two to
 * the same numbers. The mark is about 0.6 of the box at every size, so the
 * plate's margin around it scales with it.
 */
export const PLATE_GEOMETRY = {
  /** A corner badge on an avatar; a row of a step's channels. */
  xs: { box: 16, mark: 10, radius: 5 },
  /** A list item's leading mark (an employee's channels). */
  sm: { box: 20, mark: 12, radius: 6 },
  /** The wall's history, a customer's channel filters and timeline. */
  md: { box: 24, mark: 14, radius: 8 },
  /** The inbox's channel filters; an automation's row. */
  lg: { box: 28, mark: 16, radius: 8 },
  /** A Channels-page row's tile. */
  xl: { box: 34, mark: 20, radius: 9 },
  /** A channel's own panel header. */
  xxl: { box: 40, mark: 24, radius: 11 },
} as const;

export type PlateSize = keyof typeof PLATE_GEOMETRY;

type Naming =
  /** The channel's name, already translated: the mark is the only statement of it. */
  | { readonly label: string; readonly decorative?: never }
  /** Only where the channel's name is already said beside it, or by its container. */
  | { readonly decorative: true; readonly label?: never };

/**
 * A channel's mark on the plate. `label` is required unless the site says
 * `decorative` - the same rule as `ChannelMark`, whose naming this passes on.
 */
export function ChannelPlate({
  channel,
  size,
  className,
  ...naming
}: {
  readonly channel: string | null;
  readonly size: PlateSize;
  /** Placement only: position, a badge's cut, a selected ring. Never the plate's look. */
  readonly className?: string;
} & Naming) {
  const { mark } = PLATE_GEOMETRY[size];
  return (
    <span
      className={[styles.plate, styles[size], className].filter(Boolean).join(' ')}
      data-channel-plate={size}
    >
      {naming.decorative ? (
        <ChannelMark channel={channel} size={mark} decorative />
      ) : (
        <ChannelMark channel={channel} size={mark} label={naming.label} />
      )}
    </span>
  );
}
