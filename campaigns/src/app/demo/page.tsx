import type { Metadata } from 'next';
import CampaignLanding from '@/components/CampaignLanding';

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
  title: 'GOTCHA - עובדי AI שעונים, בודקים ומבצעים',
  description:
    'עובד AI שעונה ללקוחות שלכם בוואטסאפ, אינסטגרם ובמייל - בודק, מבצע, ומעביר לצוות רק את מה שדורש אדם.',
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
  return <CampaignLanding />;
}
