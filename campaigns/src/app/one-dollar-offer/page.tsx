import type { Metadata } from 'next';
import CampaignLanding from '@/components/CampaignLanding';
import MetaPixel from '@/components/MetaPixel';
import CookieNotice from '@/components/CookieNotice';

/*
 * Loaded HERE rather than in the root layout, and the order is the point.
 *
 * Next emits a route's layout stylesheets before its page stylesheets, so this
 * sheet's `body { font-family: Heebo }` lands after tokens.css's Archivo and
 * wins. The other pages on this host never load it and keep the shell's type.
 *
 * It is generated from the design file's <helmet> block - see tools/dc2jsx.mjs.
 */
import '../campaign.css';

export const metadata: Metadata = {
  /*
   * The title is read in the browser tab, in a WhatsApp link preview and in the
   * Facebook feed before anyone has seen a word of the page, so it carries the
   * OFFER rather than a description of the product. "עובדי AI שעונים, בודקים
   * ומבצעים" explained what GOTCHA is to someone who had already decided to
   * care; three months at a dollar gives them the reason to.
   */
  title: 'GOTCHA · 3 חודשים בדולר אחד',
  description:
    'עובד AI שעונה ללקוחות בוואטסאפ, אינסטגרם ובמייל - 3 חודשים בדולר אחד ל-50 העסקים הראשונים. 1,000 קרדיטים בחודש, בלי התחייבות.',
  // `robots` is inherited from the root layout: noindex, like every page here.
};

/*
 * The campaign page itself is the design, compiled.
 *
 * Nothing about the layout, the copy or the behaviour is decided in this file.
 * `CampaignLanding` is generated from the design's own DCLogic class and
 * `Template` from its markup, so a design change is re-run rather than
 * re-typed. Edits belong in design/GOTCHA Campaign Landing.dc.html.
 *
 * Direction is handled inside the design, which puts `dir="rtl" lang="he"` on
 * its own content column, footer and dialog. Two blocks - the FAQ section and
 * the mobile sticky bar - sit outside those and inherit the document's
 * direction, exactly as they do on the design canvas. Adding `dir` to them here
 * would be a correction to the design rather than a port of it.
 */
export default function DemoCampaign() {
  return (
    <>
      {/*
        Renders nothing and requests nothing until the visitor has allowed
        advertising measurement - the same shared `gotcha_consent` cookie the
        marketing site writes, so someone who already said yes there is not
        asked again. The design's own `track()` is guarded on `window.fbq`,
        which simply does not exist until this mounts the script, so events
        before consent are dropped rather than buffered.
      */}
      <MetaPixel />
      <CampaignLanding />
      {/*
        Last, so it sits above the page in paint order as well as in z-index,
        and renders nothing at all for anyone who has already answered - which
        includes every visitor who came through gotcha.co.il, since the consent
        cookie is shared across the domain. Campaign traffic arrives cold and
        is asked here; without that the pixel above could never load and the
        campaign could not report its own conversions.
      */}
      <CookieNotice />
    </>
  );
}
