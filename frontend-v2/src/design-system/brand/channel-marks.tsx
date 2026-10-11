import { useId, type ReactNode } from 'react';
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
 * ★★ THE BRANDS' OWN CURRENT MARKS, FROM THE BRANDS (Omer, 2026-10-11)
 * ════════════════════════════════════════════════════════════════════════════
 * "The inbox's channel marks must be the brands' OFFICIAL current icons." The
 * first set was copied from a design folder and was not: a one-colour Gmail
 * M, a flat Instagram, Messenger's retired blue, a one-green Shopify bag, a
 * hand-drawn Outlook and Slack's pre-2026 colours. Each drawing below is now
 * the brand's own file, downloaded from the brand's own site on 2026-10-11,
 * and says which file and where. Kept from each file: its shapes, its
 * gradients and its colours, verbatim. Dropped: its <style> (folded into
 * `fill`), ids (see below), comments and metadata - nothing else.
 *
 * ⚠ INSTAGRAM IS THE ONE APPROXIMATION. Meta's gradient glyph is a raster
 *   gradient clipped to the glyph - there is no vector gradient to copy. The
 *   glyph's outline is Meta's own; the gradient is three SVG layers matched
 *   against Meta's 5000px PNG of it, sample by sample.
 *
 * ⚠ GRADIENT IDS ARE PER INSTANCE. A gradient is referenced by id, and the
 *   inbox renders dozens of marks on one page: two marks with the same id
 *   paint each other's gradient, or nothing once the first unmounts. Every id
 *   is prefixed with `useId()`.
 *
 * ⚠ INLINE ATTRIBUTES ONLY, NO STYLESHEET. The notification icon renders this
 *   component to markup and rasterises it from a `data:` URL, where no CSS
 *   module reaches - so every colour is on the element itself, and each
 *   gradient's <defs> is inside the same <svg> that uses it. That is also why
 *   the brand colours are literals and not tokens: a `var()` inside an SVG
 *   image resolves against nothing.
 *
 * ⚠ THE NEUTRAL GLYPHS PAINT WITH `currentColor`. Web chat, phone calls,
 *   plain email and an unknown channel have no third-party brand; they take
 *   the colour of whatever holds them, so they are right on a light panel
 *   and on the dark wall without a second drawing.
 */

/** Turns a gradient's local name into an id unique to this rendered mark. */
type Ids = (local: string) => string;

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
  readonly body: (id: Ids) => ReactNode;
}

/*
 * WhatsApp - Meta's Brand Resource Center, "WhatsApp brand assets and
 * guidelines" logo pack (WhatsApp-Brand-Resource-Center.zip),
 * `01_Glyph/01_Digital RGB/03_SVG/Digital_Glyph_Green_RGB_2026.svg`.
 * The 2026 glyph in WhatsApp green.
 */
const WHATSAPP: Drawing = {
  glyph: 'whatsapp',
  viewBox: '0 0 720 720',
  paint: { kind: 'brand', fill: '#25D366' },
  body: () => (
    <>
      <path d="M360,0C161.18,0,0,161.18,0,360c0,65.41,17.45,126.75,47.94,179.61L0,720l187.02-44.21c51.34,28.18,110.28,44.21,172.98,44.21,198.82,0,360-161.18,360-360S558.82,0,360,0ZM360,655.52c-60.17,0-116.13-17.98-162.82-48.87l-110.49,28.14,30.99-105.61c-33.53-47.93-53.2-106.26-53.2-169.19,0-163.21,132.31-295.52,295.52-295.52s295.52,132.31,295.52,295.52-132.31,295.52-295.52,295.52Z" />
      <path d="M444.35,407.52l87.1,41.06c4,1.88,6.56,5.94,6.2,10.34-.94,11.46-5.54,34.43-26.13,55.02-58.12,58.12-162.49-7.64-166.74-10.18-25.67-13.79-50.06-32.24-73.19-55.36-23.12-23.12-41.58-47.52-55.37-73.19-2.55-4.24-68.31-108.61-10.18-166.74,20.59-20.59,43.56-25.19,55.02-26.13,4.41-.36,8.46,2.2,10.34,6.2l41.07,87.1c1.94,4.12,1.09,9.02-2.13,12.24l-30.61,30.61c-6.62,6.62-8.56,16.93-4,25.11,11.17,20.03,26.19,39.32,43.59,57.07,17.75,17.4,37.04,32.43,57.07,43.59,8.18,4.56,18.48,2.62,25.11-4l30.61-30.61c3.22-3.22,8.12-4.08,12.24-2.13Z" />
    </>
  ),
};

/*
 * Instagram - Meta's Brand Resource Center, "Instagram brand assets and
 * guidelines" logo pack (IG_brand_asset_pack_2023.zip). The outline is
 * `01 Static Glyph/03 Black Glyph/Instagram_Glyph_Black.svg` (its
 * translate(-2.5) moved into the viewBox). The gradient matches
 * `01 Gradient Glyph/Instagram_Glyph_Gradient.png`, whose SVG twin embeds
 * the gradient as a PNG: a pink-red body, yellow rising from the bottom
 * left, a magenta top and violet in the top-left corner.
 */
const INSTAGRAM_OUTLINE =
  'M295.42,6c-53.2,2.51-89.53,11-121.29,23.48-32.87,12.81-60.73,30-88.45,57.82S40.89,143,28.17,175.92c-12.31,31.83-20.65,68.19-23,121.42S2.3,367.68,2.56,503.46,3.42,656.26,6,709.6c2.54,53.19,11,89.51,23.48,121.28,12.83,32.87,30,60.72,57.83,88.45S143,964.09,176,976.83c31.8,12.29,68.17,20.67,121.39,23s70.35,2.87,206.09,2.61,152.83-.86,206.16-3.39S799.1,988,830.88,975.58c32.87-12.86,60.74-30,88.45-57.84S964.1,862,976.81,829.06c12.32-31.8,20.69-68.17,23-121.35,2.33-53.37,2.88-70.41,2.62-206.17s-.87-152.78-3.4-206.1-11-89.53-23.47-121.32c-12.85-32.87-30-60.7-57.82-88.45S862,40.87,829.07,28.19c-31.82-12.31-68.17-20.7-121.39-23S637.33,2.3,501.54,2.56,348.75,3.4,295.42,6m5.84,903.88c-48.75-2.12-75.22-10.22-92.86-17-23.36-9-40-19.88-57.58-37.29s-28.38-34.11-37.5-57.42c-6.85-17.64-15.1-44.08-17.38-92.83-2.48-52.69-3-68.51-3.29-202s.22-149.29,2.53-202c2.08-48.71,10.23-75.21,17-92.84,9-23.39,19.84-40,37.29-57.57s34.1-28.39,57.43-37.51c17.62-6.88,44.06-15.06,92.79-17.38,52.73-2.5,68.53-3,202-3.29s149.31.21,202.06,2.53c48.71,2.12,75.22,10.19,92.83,17,23.37,9,40,19.81,57.57,37.29s28.4,34.07,37.52,57.45c6.89,17.57,15.07,44,17.37,92.76,2.51,52.73,3.08,68.54,3.32,202s-.23,149.31-2.54,202c-2.13,48.75-10.21,75.23-17,92.89-9,23.35-19.85,40-37.31,57.56s-34.09,28.38-57.43,37.5c-17.6,6.87-44.07,15.07-92.76,17.39-52.73,2.48-68.53,3-202.05,3.29s-149.27-.25-202-2.53m407.6-674.61a60,60,0,1,0,59.88-60.1,60,60,0,0,0-59.88,60.1M245.77,503c.28,141.8,115.44,256.49,257.21,256.22S759.52,643.8,759.25,502,643.79,245.48,502,245.76,245.5,361.22,245.77,503m90.06-.18a166.67,166.67,0,1,1,167,166.34,166.65,166.65,0,0,1-167-166.34';

const INSTAGRAM: Drawing = {
  glyph: 'instagram',
  viewBox: '2.5 2.5 1000 1000',
  paint: { kind: 'brand' },
  body: (id) => (
    <>
      <defs>
        <radialGradient id={id('base')} cx="0.3" cy="1.05" r="1.15">
          <stop offset="0" stopColor="#F9D648" />
          <stop offset="0.17" stopColor="#F8D447" />
          <stop offset="0.26" stopColor="#F2A03A" />
          <stop offset="0.35" stopColor="#EE7432" />
          <stop offset="0.43" stopColor="#EC5A45" />
          <stop offset="0.5" stopColor="#EB4656" />
          <stop offset="0.6" stopColor="#EA3768" />
          <stop offset="1" stopColor="#EA3378" />
        </radialGradient>
        <linearGradient id={id('top')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#CF2BC6" />
          <stop offset="0.2" stopColor="#E032B4" stopOpacity="0.75" />
          <stop offset="0.42" stopColor="#EA33A0" stopOpacity="0" />
        </linearGradient>
        <radialGradient
          id={id('corner')}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(0.05 0) scale(0.8 0.4)"
        >
          <stop offset="0" stopColor="#6020F5" />
          <stop offset="0.3" stopColor="#6520F5" />
          <stop offset="0.6" stopColor="#6520F5" stopOpacity="0.55" />
          <stop offset="0.85" stopColor="#6520F5" stopOpacity="0.15" />
          <stop offset="1" stopColor="#6520F5" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path fill={`url(#${id('base')})`} d={INSTAGRAM_OUTLINE} />
      <path fill={`url(#${id('top')})`} d={INSTAGRAM_OUTLINE} />
      <path fill={`url(#${id('corner')})`} d={INSTAGRAM_OUTLINE} />
    </>
  ),
};

/*
 * Messenger - Meta's Brand Resource Center, "Messenger icon" (updated
 * February 2025) icon pack (Messenger-Icon-Pack.zip),
 * `Messenger Icon/Primary Icon/Messenger_Icon_Primary_Blue.svg`.
 *
 * ⚠ FLAT FACEBOOK BLUE, NOT THE GRADIENT. Meta retired the blue-to-purple
 *   bubble in February 2025: "The primary version of the icon is in Facebook
 *   Blue." The gradient is now an old version.
 */
const MESSENGER: Drawing = {
  glyph: 'messenger',
  viewBox: '0 0 502 502',
  paint: { kind: 'brand' },
  body: () => (
    <>
      <path
        fill="#0866ff"
        d="M501,243.5c0,139.34-109.17,242.5-250,242.5-25.29,0-49.56-3.34-72.37-9.61-4.43-1.23-9.14-.88-13.35.97l-49.62,21.91c-12.98,5.73-27.63-3.5-28.06-17.68l-1.36-44.48c-.17-5.48-2.63-10.6-6.72-14.25C30.87,379.36,1,316.39,1,243.5,1,104.16,110.17,1,251,1s250,103.16,250,242.5Z"
      />
      <path
        fill="#fff"
        d="M318.88,313.31l87.04-134.52c8.75-13.52-7.46-29.26-20.72-20.11l-90.86,62.67c-3.06,2.11-7.1,2.17-10.22.15l-80.65-52.18c-6.83-4.42-15.94-2.46-20.35,4.36l-87.05,134.52c-8.75,13.52,7.46,29.26,20.72,20.11l90.88-62.68c3.06-2.11,7.1-2.17,10.22-.15l80.63,52.17c6.83,4.42,15.94,2.46,20.36-4.36Z"
      />
    </>
  ),
};

/*
 * Gmail - Google's own current product logo,
 * `https://www.gstatic.com/images/branding/productlogos/gmail_2026/v2/web/192px.svg`,
 * the file Google's Gmail page (workspace.google.com/products/gmail) draws.
 * Google's 2026 M: its four colours run as gradients - red into yellow
 * across the top, green into blue down the right.
 */
const GMAIL: Drawing = {
  glyph: 'gmail',
  viewBox: '0 0 192 192',
  paint: { kind: 'brand' },
  body: (id) => (
    <>
      <path
        fill={`url(#${id('a')})`}
        d="M146 44h38v110c0 6.627-5.373 12-12 12h-20a6 6 0 0 1-6-6z"
      />
      <path fill="#fc413d" d="M46 44H8v110c0 6.627 5.373 12 12 12h20a6 6 0 0 0 6-6z" />
      <path
        fill={`url(#${id('b')})`}
        d="M39.226 30.456c-8.033-6.752-20.018-5.714-26.77 2.319-6.752 8.032-5.714 20.017 2.319 26.77l76.078 63.949a8 8 0 0 0 10.295 0l76.078-63.95c8.032-6.752 9.07-18.737 2.318-26.77-6.752-8.032-18.737-9.07-26.769-2.318L96 78.18z"
      />
      <defs>
        {' '}
        <linearGradient
          id={id('a')}
          x1="165"
          x2="165"
          y1="44"
          y2="166"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#60d673" />
          <stop offset=".17" stopColor="#42c868" />
          <stop offset=".39" stopColor="#0ebc5f" />
          <stop offset=".62" stopColor="#00a9bb" />
          <stop offset=".86" stopColor="#3c90ff" />
          <stop offset="1" stopColor="#3186ff" />
        </linearGradient>
        <linearGradient
          id={id('b')}
          x1="8"
          x2="184"
          y1="46.13"
          y2="46.13"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".08" stopColor="#ff63a0" />
          <stop offset=".3" stopColor="#fc413d" />
          <stop offset=".5" stopColor="#fc413d" />
          <stop offset=".65" stopColor="#fc413d" />
          <stop offset=".72" stopColor="#fc5c30" />
          <stop offset=".86" stopColor="#feb10c" />
          <stop offset=".91" stopColor="#fec700" />
          <stop offset=".96" stopColor="#ffdb0f" />
        </linearGradient>
      </defs>
    </>
  ),
};

/*
 * Outlook - Microsoft's own FY26 app icon,
 * `https://www.microsoft.com/content/dam/microsoft/bade/images/icons/en-us/m365-app-icons-fy26/Outlook-Icon-FY26.svg`,
 * the file Microsoft's Outlook product page draws: the 2025 fluid icon.
 *
 * The file's 48px artboard leaves 4px of air round the icon, where every
 * other mark here runs to its edge; the viewBox is the 40px square round the
 * drawing, so Outlook reads at the size the others do. No painted part is cut.
 *
 * ⚠ IT HAS A NEAR-BLACK PART: the envelope's back is `#0D1F69` to `#002177`,
 *   which vanishes on the wall's dark `--copilot-well`. The wall sets every
 *   mark on the light plate (`--channel-mark-plate`) for that reason.
 */
const OUTLOOK: Drawing = {
  glyph: 'outlook',
  viewBox: '3 4 40 40',
  paint: { kind: 'brand' },
  body: (id) => (
    <>
      <path
        d="M30.9322 9.34307L7.97588 23.8943L6.00165 20.7797V18.0959C6.00165 17.1188 6.49634 16.2081 7.31603 15.6762L20.6606 7.01716C22.6937 5.69792 25.3125 5.69771 27.3458 7.01665L30.9322 9.34307Z"
        fill={`url(#${id('p0')})`}
      />
      <path
        d="M27.1402 6.88928C27.2092 6.93033 27.2777 6.97284 27.3455 7.01682L37.76 13.7724L11.9375 30.1404L7.97498 23.8891L26.9262 11.8533C28.7213 10.7133 28.7999 8.14871 27.1402 6.88928Z"
        fill={`url(#${id('p1')})`}
      />
      <path
        d="M27.1402 6.88928C27.2092 6.93033 27.2777 6.97284 27.3455 7.01682L37.76 13.7724L11.9375 30.1404L7.97498 23.8891L26.9262 11.8533C28.7213 10.7133 28.7999 8.14871 27.1402 6.88928Z"
        fill={`url(#${id('p2')})`}
        fillOpacity="0.2"
      />
      <path
        d="M22.2402 33.2659L11.9377 30.1406L33.842 16.2557C35.6868 15.0864 35.682 12.3932 33.8331 11.2304L33.7344 11.1684L34.0185 11.3451L40.685 15.6695C41.5049 16.2014 41.9998 17.1122 41.9998 18.0895V20.687L22.2402 33.2659Z"
        fill={`url(#${id('p3')})`}
      />
      <path
        d="M22.2402 33.2659L11.9377 30.1406L33.842 16.2557C35.6868 15.0864 35.682 12.3932 33.8331 11.2304L33.7344 11.1684L34.0185 11.3451L40.685 15.6695C41.5049 16.2014 41.9998 17.1122 41.9998 18.0895V20.687L22.2402 33.2659Z"
        fill={`url(#${id('p4')})`}
        fillOpacity="0.2"
      />
      <path
        d="M27.3458 7.01665C25.3125 5.69771 22.6937 5.69792 20.6605 7.01716L7.31603 15.6762C6.49634 16.2081 6.00165 17.1188 6.00165 18.0959V18.2272C6.03382 19.208 6.55002 20.1121 7.38373 20.6378L23.9764 31.0985L40.6108 20.6537C41.4747 20.1112 41.999 19.1628 41.999 18.1427V20.6873L41.9994 18.0896C41.9994 17.1123 41.5045 16.2015 40.6846 15.6696L27.3458 7.01665Z"
        fill={`url(#${id('p5')})`}
      />
      <path
        d="M21.0513 42.0035H35.748C39.1998 42.0035 41.998 39.2053 41.998 35.7535L41.998 18.1426C41.998 19.1627 41.4736 20.1111 40.6098 20.6536L18.7495 34.3798C17.5703 35.1202 16.8546 36.4149 16.8547 37.8073C16.8549 40.1248 18.7337 42.0035 21.0513 42.0035Z"
        fill={`url(#${id('p6')})`}
      />
      <path
        d="M21.0513 42.0035H35.748C39.1998 42.0035 41.998 39.2053 41.998 35.7535L41.998 18.1426C41.998 19.1627 41.4736 20.1111 40.6098 20.6536L18.7495 34.3798C17.5703 35.1202 16.8546 36.4149 16.8547 37.8073C16.8549 40.1248 18.7337 42.0035 21.0513 42.0035Z"
        fill={`url(#${id('p7')})`}
        fillOpacity="0.4"
      />
      <path
        d="M21.0513 42.0035H35.748C39.1998 42.0035 41.998 39.2053 41.998 35.7535L41.998 18.1426C41.998 19.1627 41.4736 20.1111 40.6098 20.6536L18.7495 34.3798C17.5703 35.1202 16.8546 36.4149 16.8547 37.8073C16.8549 40.1248 18.7337 42.0035 21.0513 42.0035Z"
        fill={`url(#${id('p8')})`}
        fillOpacity="0.5"
      />
      <path
        d="M27.0268 42.0023H12.2492C8.79745 42.0023 5.99923 39.2041 5.99923 35.7523V18.1297C5.99923 19.1478 6.52165 20.0948 7.38292 20.6377L29.2215 34.4058C30.4171 35.1595 31.1423 36.4741 31.1421 37.8874C31.1419 40.1601 29.2995 42.0023 27.0268 42.0023Z"
        fill={`url(#${id('p9')})`}
      />
      <path
        d="M27.0268 42.0023H12.2492C8.79745 42.0023 5.99923 39.2041 5.99923 35.7523V18.1297C5.99923 19.1478 6.52165 20.0948 7.38292 20.6377L29.2215 34.4058C30.4171 35.1595 31.1423 36.4741 31.1421 37.8874C31.1419 40.1601 29.2995 42.0023 27.0268 42.0023Z"
        fill={`url(#${id('p10')})`}
      />
      <rect x="4" y="23" width="16" height="16" rx="3.25" fill={`url(#${id('p11')})`} />
      <rect
        x="4"
        y="23"
        width="16"
        height="16"
        rx="3.25"
        fill={`url(#${id('p12')})`}
        fillOpacity="0.5"
      />
      <path
        d="M11.959 35.5999C10.636 35.5999 9.54994 35.186 8.70069 34.3583C7.85144 33.5306 7.42682 32.4505 7.42682 31.1179C7.42682 29.7107 7.85785 28.5726 8.7199 27.7035C9.58195 26.8345 10.7107 26.3999 12.1062 26.3999C13.4249 26.3999 14.4982 26.8158 15.3261 27.6477C16.1583 28.4795 16.5744 29.5762 16.5744 30.9378C16.5744 32.3367 16.1433 33.4644 15.2813 34.3211C14.4235 35.1736 13.3161 35.5999 11.959 35.5999ZM11.9974 33.8431C12.7186 33.8431 13.299 33.5968 13.7386 33.1044C14.1781 32.6119 14.3979 31.9269 14.3979 31.0496C14.3979 30.1349 14.1845 29.4231 13.7578 28.9141C13.331 28.405 12.7613 28.1505 12.0486 28.1505C11.3146 28.1505 10.7235 28.4133 10.2754 28.9389C9.82733 29.4604 9.60328 30.1515 9.60328 31.0123C9.60328 31.8856 9.82733 32.5767 10.2754 33.0857C10.7235 33.5906 11.2975 33.8431 11.9974 33.8431Z"
        fill="white"
      />
      <path
        d="M11.9554 35.7233C10.6375 35.7233 9.55551 35.2982 8.7095 34.448C7.8635 33.5977 7.44049 32.4881 7.44049 31.1192C7.44049 29.6737 7.86987 28.5046 8.72864 27.6119C9.5874 26.7191 10.7119 26.2727 12.102 26.2727C13.4157 26.2727 14.4849 26.7 15.3097 27.5545C16.1387 28.409 16.5532 29.5356 16.5532 30.9343C16.5532 32.3712 16.1238 33.5297 15.265 34.4097C14.4105 35.2855 13.3073 35.7233 11.9554 35.7233ZM11.9936 33.9187C12.7121 33.9187 13.2903 33.6657 13.7282 33.1598C14.1661 32.6539 14.385 31.9503 14.385 31.049C14.385 30.1095 14.1724 29.3783 13.7473 28.8554C13.3222 28.3325 12.7546 28.071 12.0447 28.071C11.3134 28.071 10.7246 28.341 10.2782 28.8809C9.83185 29.4165 9.60865 30.1265 9.60865 31.0108C9.60865 31.9078 9.83185 32.6178 10.2782 33.1407C10.7246 33.6593 11.2964 33.9187 11.9936 33.9187Z"
        fill="white"
      />
      <defs>
        {' '}
        <linearGradient
          id={id('p0')}
          x1="9.98908"
          y1="22.3649"
          x2="30.9322"
          y2="9.37495"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#20A7FA" />
          <stop offset="0.4" stopColor="#3BD5FF" />
          <stop offset="1" stopColor="#C4B0FF" />
        </linearGradient>
        <linearGradient
          id={id('p1')}
          x1="17.1972"
          y1="26.7945"
          x2="28.8562"
          y2="8.12575"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#165AD9" />
          <stop offset="0.5008" stopColor="#1880E5" />
          <stop offset="1" stopColor="#8587FF" />
        </linearGradient>
        <linearGradient
          id={id('p2')}
          x1="25.7005"
          y1="27.0484"
          x2="12.7563"
          y2="16.5013"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.236946" stopColor="#448AFF" stopOpacity="0" />
          <stop offset="0.792113" stopColor="#0032B1" />
        </linearGradient>
        <linearGradient
          id={id('p3')}
          x1="24.0534"
          y1="31.1099"
          x2="44.51"
          y2="18.0177"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1A43A6" />
          <stop offset="0.492267" stopColor="#2052CB" />
          <stop offset="1" stopColor="#5F20CB" />
        </linearGradient>
        <linearGradient
          id={id('p4')}
          x1="29.8281"
          y1="30.3273"
          x2="17.3975"
          y2="19.5708"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0045B9" stopOpacity="0" />
          <stop offset="0.669859" stopColor="#0D1F69" />
        </linearGradient>
        <radialGradient
          id={id('p5')}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(24.0018 6.81788) rotate(-90) scale(27.0027 29.2262)"
        >
          <stop offset="0.568182" stopColor="#275FF0" stopOpacity="0" />
          <stop offset="0.992424" stopColor="#002177" />
        </radialGradient>
        <linearGradient
          id={id('p6')}
          x1="41.998"
          y1="29.9431"
          x2="23.8517"
          y2="29.9431"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4DC4FF" />
          <stop offset="0.196145" stopColor="#0FAFFF" />
        </linearGradient>
        <radialGradient
          id={id('p7')}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(28.0928 37.9117) rotate(-45) scale(11.572)"
        >
          <stop offset="0.259477" stopColor="#0060D1" />
          <stop offset="0.908166" stopColor="#0383F1" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={id('p8')}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(10.6314 46.472) rotate(-52.6577) scale(39.2814 35.5204)"
        >
          <stop offset="0.732317" stopColor="#F4A7F7" stopOpacity="0" />
          <stop offset="1" stopColor="#F4A7F7" />
        </radialGradient>
        <radialGradient
          id={id('p9')}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(18.5708 27.5319) rotate(123.339) scale(20.7258 53.7859)"
        >
          <stop stopColor="#49DEFF" />
          <stop offset="0.724349" stopColor="#29C3FF" />
        </radialGradient>
        <linearGradient
          id={id('p10')}
          x1="3.45756"
          y1="37.8723"
          x2="20.9291"
          y2="37.8597"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.205882" stopColor="#6CE0FF" />
          <stop offset="0.535" stopColor="#50D5FF" stopOpacity="0" />
        </linearGradient>
        <radialGradient
          id={id('p11')}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(3.94291 23.6154) rotate(46.9242) scale(21.0618)"
        >
          <stop offset="0.038877" stopColor="#0091FF" />
          <stop offset="0.919119" stopColor="#183DAD" />
        </radialGradient>
        <radialGradient
          id={id('p12')}
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(12 32.7439) rotate(90) scale(11.2 12.9188)"
        >
          <stop offset="0.557796" stopColor="#0FA5F7" stopOpacity="0" />
          <stop offset="1" stopColor="#74C6FF" />
        </radialGradient>
      </defs>
    </>
  ),
};

/*
 * Slack - slack.com/media-kit → Logos → "Slack Media Kit Logos"
 * (salesforce.widencollective.com/c/yn6bxnam), `SLA-Slack-icon-RGB.svg`.
 * The current four colours; Slack's terms say "Don't use old versions".
 */
const SLACK: Drawing = {
  glyph: 'slack',
  viewBox: '0 0 400 400',
  paint: { kind: 'brand' },
  body: () => (
    <>
      <path
        fill="#e3066a"
        d="M84.039,252.769c0,23.127-18.893,42.02-42.02,42.02S0,275.896,0,252.769s18.893-42.02,42.02-42.02h42.02v42.02Z"
      />
      <path
        fill="#e3066a"
        d="M105.212,252.769c0-23.127,18.893-42.02,42.02-42.02s42.02,18.893,42.02,42.02v105.212c0,23.127-18.893,42.02-42.02,42.02s-42.02-18.893-42.02-42.02c0,0,0-105.212,0-105.212Z"
      />
      <path
        fill="#00b3ff"
        d="M147.231,84.039c-23.127,0-42.02-18.893-42.02-42.02S124.104,0,147.231,0s42.02,18.893,42.02,42.02v42.02h-42.02Z"
      />
      <path
        fill="#00b3ff"
        d="M147.231,105.212c23.127,0,42.02,18.893,42.02,42.02s-18.893,42.02-42.02,42.02H42.02c-23.127,0-42.02-18.893-42.02-42.02s18.893-42.02,42.02-42.02c0,0,105.212,0,105.212,0Z"
      />
      <path
        fill="#41b658"
        d="M315.961,147.231c0-23.127,18.893-42.02,42.02-42.02s42.02,18.893,42.02,42.02-18.893,42.02-42.02,42.02h-42.02v-42.02Z"
      />
      <path
        fill="#41b658"
        d="M294.788,147.231c0,23.127-18.893,42.02-42.02,42.02s-42.02-18.893-42.02-42.02V42.02c0-23.127,18.893-42.02,42.02-42.02s42.02,18.893,42.02,42.02v105.212Z"
      />
      <path
        fill="#fcc003"
        d="M252.769,315.961c23.127,0,42.02,18.893,42.02,42.02s-18.893,42.02-42.02,42.02-42.02-18.893-42.02-42.02v-42.02h42.02Z"
      />
      <path
        fill="#fcc003"
        d="M252.769,294.788c-23.127,0-42.02-18.893-42.02-42.02s18.893-42.02,42.02-42.02h105.212c23.127,0,42.02,18.893,42.02,42.02s-18.893,42.02-42.02,42.02h-105.212Z"
      />
    </>
  ),
};

/*
 * Shopify - shopify.com/brand-assets → "Download The Shopping Bag"
 * (shopify-shopping-bag.zip), `02 - Glyph/svg/shopify_glyph.svg`: the
 * two-green bag with its white S. Shopify's chat is Shopify's.
 *
 * The bag is taller than wide (109.5 × 124.5); the viewBox widens it to a
 * square, centred, so it sits in the same box as every other mark.
 */
const SHOPIFY: Drawing = {
  glyph: 'shopify',
  viewBox: '-7.5 0 124.5 124.5',
  paint: { kind: 'brand' },
  body: () => (
    <>
      <path
        fill="#95BF47"
        d="M95.9,23.9c-0.1-0.6-0.6-1-1.1-1c-0.5,0-9.3-0.2-9.3-0.2s-7.4-7.2-8.1-7.9c-0.7-0.7-2.2-0.5-2.7-0.3 c0,0-1.4,0.4-3.7,1.1c-0.4-1.3-1-2.8-1.8-4.4c-2.6-5-6.5-7.7-11.1-7.7c0,0,0,0,0,0c-0.3,0-0.6,0-1,0.1c-0.1-0.2-0.3-0.3-0.4-0.5 c-2-2.2-4.6-3.2-7.7-3.1c-6,0.2-12,4.5-16.8,12.2c-3.4,5.4-6,12.2-6.8,17.5c-6.9,2.1-11.7,3.6-11.8,3.7c-3.5,1.1-3.6,1.2-4,4.5 c-0.3,2.5-9.5,73-9.5,73l76.4,13.2l33.1-8.2C109.5,115.8,96,24.5,95.9,23.9z M67.2,16.8c-1.8,0.5-3.8,1.2-5.9,1.8 c0-3-0.4-7.3-1.8-10.9C64,8.6,66.2,13.7,67.2,16.8z M57.2,19.9c-4,1.2-8.4,2.6-12.8,3.9c1.2-4.7,3.6-9.4,6.4-12.5 c1.1-1.1,2.6-2.4,4.3-3.2C56.9,11.6,57.3,16.5,57.2,19.9z M49.1,4c1.4,0,2.6,0.3,3.6,0.9C51.1,5.8,49.5,7,48,8.6 c-3.8,4.1-6.7,10.5-7.9,16.6c-3.6,1.1-7.2,2.2-10.5,3.2C31.7,18.8,39.8,4.3,49.1,4z"
      />
      <path
        fill="#5E8E3E"
        d="M94.8,22.9c-0.5,0-9.3-0.2-9.3-0.2s-7.4-7.2-8.1-7.9c-0.3-0.3-0.6-0.4-1-0.5l0,109.7l33.1-8.2 c0,0-13.5-91.3-13.6-92C95.8,23.3,95.3,22.9,94.8,22.9z"
      />
      <path
        fill="#FFFFFF"
        d="M58,39.9l-3.8,14.4c0,0-4.3-2-9.4-1.6c-7.5,0.5-7.5,5.2-7.5,6.4c0.4,6.4,17.3,7.8,18.3,22.9 c0.7,11.9-6.3,20-16.4,20.6c-12.2,0.8-18.9-6.4-18.9-6.4l2.6-11c0,0,6.7,5.1,12.1,4.7c3.5-0.2,4.8-3.1,4.7-5.1 c-0.5-8.4-14.3-7.9-15.2-21.7c-0.7-11.6,6.9-23.4,23.7-24.4C54.7,38.2,58,39.9,58,39.9z"
      />
    </>
  ),
};

/* `assets/icons/globe.svg` - web chat has no third-party brand. */
const WEB: Drawing = {
  glyph: 'globe',
  viewBox: '0 0 24 24',
  paint: { kind: 'neutral' },
  body: () => (
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
  body: () => (
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
  body: () => (
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
  body: () => (
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
  // Called for every mark, used by those with gradients: hooks run unconditionally.
  const prefix = `cm${useId().replace(/[^\w-]/g, '')}`;
  const id: Ids = (local) => `${prefix}-${local}`;
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
      {drawing.body(id)}
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
