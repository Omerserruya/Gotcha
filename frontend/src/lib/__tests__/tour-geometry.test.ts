import { describe, it, expect } from "vitest";
import { computeTourGeometry, rectsIntersect, type Rect, type Side } from "../tour-geometry";

const VP = { w: 1280, h: 800 };
const POPUP = { w: 300, h: 200 };

function popupRect(geo: ReturnType<typeof computeTourGeometry>, size = POPUP): Rect {
  return {
    top: geo.popup.top,
    left: geo.popup.left,
    width: size.w,
    height: geo.popup.maxHeight ?? size.h,
  };
}

function insideViewport(r: Rect, vp = VP, margin = 12): boolean {
  return (
    r.top >= margin &&
    r.left >= margin &&
    r.top + r.height <= vp.h - margin &&
    r.left + r.width <= vp.w - margin
  );
}

describe("computeTourGeometry", () => {
  // Step 2: sidebar nav item. In LTR the sidebar is on the left, the tooltip
  // must sit beside it (right side) without covering it.
  it("places the tooltip beside a sidebar menu item without covering it (LTR)", () => {
    const navItem: Rect = { top: 180, left: 8, width: 240, height: 44 };
    const geo = computeTourGeometry({ rect: navItem, viewport: VP, popup: POPUP, preferred: "right", rtl: false });
    expect(geo.popup.placement).toBe("right");
    expect(rectsIntersect(popupRect(geo), geo.hole)).toBe(false);
    expect(insideViewport(popupRect(geo))).toBe(true);
  });

  it("flips a 'right' hint to the other side in RTL (sidebar sits on the right)", () => {
    // RTL: the same nav item renders near the RIGHT edge of the screen.
    const navItem: Rect = { top: 180, left: VP.w - 248, width: 240, height: 44 };
    const geo = computeTourGeometry({ rect: navItem, viewport: VP, popup: POPUP, preferred: "right", rtl: true });
    expect(geo.popup.placement).toBe("left");
    expect(rectsIntersect(popupRect(geo), geo.hole)).toBe(false);
    expect(insideViewport(popupRect(geo))).toBe(true);
  });

  // Step 6: the Co-Pilot panel fills the right half - a "left" hint fits in
  // LTR, but in RTL the panel is on the left and the tooltip must flip.
  it("never covers a large side panel (AI assistant), either direction", () => {
    const panelLtr: Rect = { top: 60, left: VP.w - 420, width: 400, height: 700 };
    const geoLtr = computeTourGeometry({ rect: panelLtr, viewport: VP, popup: POPUP, preferred: "left", rtl: false });
    expect(rectsIntersect(popupRect(geoLtr), geoLtr.hole)).toBe(false);

    const panelRtl: Rect = { top: 60, left: 20, width: 400, height: 700 };
    const geoRtl = computeTourGeometry({ rect: panelRtl, viewport: VP, popup: POPUP, preferred: "left", rtl: true });
    expect(rectsIntersect(popupRect(geoRtl), geoRtl.hole)).toBe(false);
    expect(insideViewport(popupRect(geoRtl))).toBe(true);
  });

  // Steps 16/17: target near the bottom of the page with a "bottom" hint -
  // the old code clamped the tooltip back over the target and cut the Next
  // button. Now the hint falls back to a side that actually fits.
  it("falls back to a fitting side when the hinted side would cut off the controls", () => {
    const nearBottom: Rect = { top: VP.h - 120, left: 500, width: 200, height: 48 };
    const geo = computeTourGeometry({ rect: nearBottom, viewport: VP, popup: POPUP, preferred: "bottom", rtl: false });
    expect(geo.popup.placement).not.toBe("bottom");
    expect(rectsIntersect(popupRect(geo), geo.hole)).toBe(false);
    expect(insideViewport(popupRect(geo))).toBe(true);
  });

  it("keeps the whole tooltip on screen at narrow viewports", () => {
    const vp = { w: 700, h: 560 };
    const target: Rect = { top: 480, left: 250, width: 200, height: 48 };
    const geo = computeTourGeometry({ rect: target, viewport: vp, popup: POPUP, preferred: "bottom", rtl: false });
    const r = popupRect(geo);
    expect(r.top + r.height).toBeLessThanOrEqual(vp.h - 12);
    expect(r.left + r.width).toBeLessThanOrEqual(vp.w - 12);
    expect(r.top).toBeGreaterThanOrEqual(12);
    expect(r.left).toBeGreaterThanOrEqual(12);
  });

  it("caps the height (scrollable body) instead of overflowing when nothing fits", () => {
    // A target that fills most of a small viewport: no side can host 200px.
    const vp = { w: 640, h: 480 };
    const target: Rect = { top: 40, left: 40, width: 560, height: 320 };
    const geo = computeTourGeometry({ rect: target, viewport: vp, popup: POPUP, preferred: "auto", rtl: false });
    const r = popupRect(geo);
    expect(geo.popup.maxHeight).not.toBeNull();
    expect(r.top + r.height).toBeLessThanOrEqual(vp.h - 12 + 0.5);
  });

  it("prefers the hinted side when it fits", () => {
    const target: Rect = { top: 320, left: 500, width: 200, height: 40 };
    for (const side of ["top", "bottom", "left", "right"] as Side[]) {
      const geo = computeTourGeometry({ rect: target, viewport: VP, popup: POPUP, preferred: side, rtl: false });
      expect(geo.popup.placement).toBe(side);
    }
  });

  it("auto placement picks a non-overlapping on-screen position for random rects", () => {
    // Deterministic pseudo-random sweep - a cheap fuzz over the invariants.
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 200; i++) {
      const rect: Rect = {
        top: rnd() * (VP.h - 60),
        left: rnd() * (VP.w - 60),
        width: 20 + rnd() * 500,
        height: 20 + rnd() * 300,
      };
      const geo = computeTourGeometry({ rect, viewport: VP, popup: POPUP, preferred: "auto", rtl: rnd() > 0.5 });
      const r = popupRect(geo);
      if (geo.popup.maxHeight === null) {
        expect(rectsIntersect(r, geo.hole)).toBe(false);
      }
      expect(r.top + r.height).toBeLessThanOrEqual(VP.h - 12 + 0.5);
      expect(r.left + r.width).toBeLessThanOrEqual(VP.w - 12 + 0.5);
    }
  });
});
