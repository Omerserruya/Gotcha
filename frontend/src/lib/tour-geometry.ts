// Pure geometry for the guided tour's spotlight hole + tooltip placement.
//
// Extracted from GuidedTour so the placement rules are unit-testable and hold
// everywhere by construction:
//   1. The tooltip NEVER covers the spotlit element (side placements are
//      separated on the main axis; clamping only slides along the free axis).
//   2. The whole tooltip - including its footer buttons - stays inside the
//      viewport. When no side has room for the full height, the tooltip gets a
//      maxHeight instead of bleeding off-screen (the component scrolls its body
//      and keeps the controls pinned).
//   3. "left"/"right" hints are LOGICAL: in RTL they flip, because a sidebar
//      that sits on the left in LTR sits on the right in RTL.
//   4. A hinted side that doesn't fit falls back to the best-fitting side
//      instead of being clamped into the target.

export type Side = "top" | "bottom" | "left" | "right";

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TourGeometryInput {
  /** Target element's viewport rect. */
  rect: Rect;
  viewport: { w: number; h: number };
  /** Measured tooltip size (fall back to an estimate before first paint). */
  popup: { w: number; h: number };
  /** Step's placement hint; "auto"/null = pick the roomiest side. */
  preferred?: Side | "auto" | null;
  /** Right-to-left UI: flips left/right hints (logical placement). */
  rtl?: boolean;
  /** Spotlight padding around the target. */
  padding?: number;
  /** Gap between the hole and the tooltip. */
  gap?: number;
  /** Minimum distance from the viewport edges. */
  margin?: number;
}

export interface TourGeometryResult {
  hole: Rect;
  popup: {
    top: number;
    left: number;
    placement: Side;
    /** Set when no side fits the full tooltip: cap the height and scroll. */
    maxHeight: number | null;
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/** Free space on each side of the hole, in the main axis of that side. */
function sideSpace(hole: Rect, vp: { w: number; h: number }): Record<Side, number> {
  return {
    top: hole.top,
    bottom: vp.h - (hole.top + hole.height),
    left: hole.left,
    right: vp.w - (hole.left + hole.width),
  };
}

function positionFor(
  side: Side,
  hole: Rect,
  vp: { w: number; h: number },
  popup: { w: number; h: number },
  gap: number,
  margin: number,
): { top: number; left: number } {
  // Perpendicular axis is centered on the hole, then clamped to the viewport -
  // clamping there can never push the tooltip INTO the hole.
  const centeredLeft = clamp(hole.left + hole.width / 2 - popup.w / 2, margin, Math.max(margin, vp.w - margin - popup.w));
  const centeredTop = clamp(hole.top + hole.height / 2 - popup.h / 2, margin, Math.max(margin, vp.h - margin - popup.h));
  switch (side) {
    case "bottom":
      return { top: hole.top + hole.height + gap, left: centeredLeft };
    case "top":
      return { top: hole.top - gap - popup.h, left: centeredLeft };
    case "right":
      return { top: centeredTop, left: hole.left + hole.width + gap };
    case "left":
      return { top: centeredTop, left: hole.left - gap - popup.w };
  }
}

function fits(side: Side, space: Record<Side, number>, popup: { w: number; h: number }, gap: number, margin: number): boolean {
  const need = (side === "top" || side === "bottom" ? popup.h : popup.w) + gap + margin;
  return space[side] >= need;
}

export function computeTourGeometry(input: TourGeometryInput): TourGeometryResult {
  const padding = input.padding ?? 8;
  const gap = input.gap ?? 16;
  const margin = input.margin ?? 12;
  const vp = input.viewport;
  const popup = input.popup;

  const hole: Rect = {
    top: input.rect.top - padding,
    left: input.rect.left - padding,
    width: input.rect.width + padding * 2,
    height: input.rect.height + padding * 2,
  };

  // Logical placement: a "next to the sidebar" hint means the inner side of
  // the sidebar, which is the OTHER side of the screen in RTL.
  let preferred: Side | null =
    input.preferred && input.preferred !== "auto" ? input.preferred : null;
  if (preferred && input.rtl) {
    if (preferred === "left") preferred = "right";
    else if (preferred === "right") preferred = "left";
  }

  const space = sideSpace(hole, vp);
  const bySpace = (Object.keys(space) as Side[]).sort((a, b) => space[b] - space[a]);
  const order: Side[] = preferred
    ? [preferred, ...bySpace.filter((s) => s !== preferred)]
    : bySpace;

  for (const side of order) {
    if (fits(side, space, popup, gap, margin)) {
      const pos = positionFor(side, hole, vp, popup, gap, margin);
      return { hole, popup: { ...pos, placement: side, maxHeight: null } };
    }
  }

  // No side fits the full tooltip. Take the roomiest side and cap the height
  // (vertical sides) so the footer controls always stay on screen. Horizontal
  // sides can't shrink their width meaningfully, so prefer vertical fallbacks.
  const vertical: Side = space.bottom >= space.top ? "bottom" : "top";
  const available = space[vertical] - gap - margin;
  const MIN_USABLE = 120;
  if (available >= MIN_USABLE) {
    const capped = { w: popup.w, h: Math.min(popup.h, available) };
    const pos = positionFor(vertical, hole, vp, capped, gap, margin);
    return { hole, popup: { ...pos, placement: vertical, maxHeight: capped.h } };
  }

  // Pathological (huge target / tiny viewport): pin the tooltip to the bottom
  // of the viewport, full clamping, capped height. It may cover part of the
  // target - the least-bad option when the target fills the screen.
  const cappedH = Math.min(popup.h, vp.h - margin * 2);
  return {
    hole,
    popup: {
      top: Math.max(margin, vp.h - margin - cappedH),
      left: clamp(hole.left + hole.width / 2 - popup.w / 2, margin, Math.max(margin, vp.w - margin - popup.w)),
      placement: "bottom",
      maxHeight: cappedH,
    },
  };
}
