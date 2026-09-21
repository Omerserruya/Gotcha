/**
 * Wraps the design's DCLogic class as a React component, changing as little of
 * the authored source as possible: DCLogic already mirrors React's class API
 * (state, setState, componentDidMount/WillUnmount), so the body ports across
 * untouched and only the class header, a handful of asserted patches and
 * render() differ.
 *
 * EVERY PATCH BELOW IS ASSERTED. If the design renames a field or rewrites the
 * submit handler, this build stops rather than quietly shipping a page whose
 * form posts nowhere.
 *
 * Usage:  node tools/build-logic.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design');
const OUT = path.join(ROOT, 'src/components/CampaignLanding.jsx');

const raw = fs.readFileSync(path.join(DESIGN, 'GOTCHA Campaign Landing.dc.html'), 'utf8');
const start = raw.indexOf('>', raw.indexOf('<script type="text/x-dc"')) + 1;
let src = raw.slice(start, raw.lastIndexOf('</script>'));

/** Replace exactly once, or fail loudly with what was being looked for. */
function patch(find, replace, why) {
  const n = src.split(find).length - 1;
  if (n !== 1) {
    throw new Error(
      `expected exactly one occurrence, found ${n}, while ${why}:\n  ${find.split('\n')[0]}`,
    );
  }
  src = src.replace(find, replace);
}

/* DCLogic -> React.Component. Same lifecycle names, same setState contract. */
patch(
  'class Component extends DCLogic {',
  'class CampaignLogic extends React.Component {',
  'porting the class header',
);

/* ─────────── the three values the design left unset ───────────
 *
 * The design file ships them as `null` with a comment saying they are set
 * before publication - which is correct for a design file and would be a dead
 * page here. They are wired to real values through build-time constants rather
 * than by editing the design, so the design file stays the design file.
 */

/**
 * Where the form posts.
 *
 * SAME-ORIGIN, deliberately. `/api/waitlist` is proxied to the auth service by
 * this host's own nginx vhost, so the browser makes a same-origin POST and no
 * CORS preflight is involved. Pointing it at https://gotcha.co.il/api/waitlist
 * instead would work only if that host grew an Access-Control-Allow-Origin for
 * go.gotcha.co.il, which is a second thing to get right for no benefit.
 */
patch(
  "    leadEndpoint: null,          // יעד שמירת הטופס — יוגדר לפני הפרסום",
  "    leadEndpoint: '/api/waitlist',",
  'wiring the lead endpoint',
);

/**
 * The Meta pixel stays unset unless a real id is supplied.
 *
 * There is no pixel id to put here - it belongs to whoever runs the ad account.
 * Left null, the design's own `track()` logs each event to the console and
 * fires nothing, which is the honest behaviour: a made-up id would silently
 * send every campaign event into a pixel that does not exist.
 */
patch(
  "    metaPixelId: null,           // מזהה פיקסל Meta חדש — יוזן לפני הפרסום",
  "    metaPixelId: META_PIXEL_ID,",
  'wiring the Meta pixel id',
);

/**
 * The legal documents that exist, and only those.
 *
 * privacy and terms are real, published pages on the Trust Center. The offer
 * terms and the accessibility statement are NOT written yet, and the design
 * already has the right behaviour for that: `legalLink()` renders a marked,
 * non-clickable label rather than a link that goes nowhere. Filling these in
 * with a plausible-looking URL would be the one genuinely bad option.
 */
patch(
  "    privacyUrl: null,            // מסמכי האתר יסופקו על ידינו\n    termsUrl: null,",
  "    privacyUrl: links.trust('privacy-policy'),\n    termsUrl: links.trust('terms-of-service'),",
  'wiring the legal links',
);

/**
 * The lead fires Meta's STANDARD `Lead` event, not a custom one.
 *
 * The design sends every event through `fbq('trackCustom', name)`, which is
 * right for `demo_click_hero` and `widget_open` - they are ours, and Meta has
 * no opinion about them. It is wrong for the one event the ad is actually
 * optimised against.
 *
 * A custom event shows up in Events Manager immediately but is NOT selectable
 * as an optimisation goal until someone creates a Custom Conversion on it by
 * hand. `Lead` is one of Meta's standard events: it is recognised on arrival
 * and can be picked as the campaign objective with no further setup. Shipping
 * the custom spelling would mean running a lead campaign whose chosen
 * conversion event never arrives.
 *
 * Only the lead is remapped. Everything else stays custom, which is what it is.
 */
patch(
  `    if (window.fbq && this.CFG.metaPixelId) window.fbq('trackCustom', name);`,
  `    if (window.fbq && this.CFG.metaPixelId) {
      // 'lead' is Meta's standard Lead event; the rest are ours.
      if (name === 'lead') window.fbq('track', 'Lead');
      else window.fbq('trackCustom', name);
    }`,
  'sending the lead as Meta\'s standard Lead event',
);

/* ─────────── the payload, and the duplicate lead ───────────
 *
 * The design posts its own four fields; the endpoint has been taking leads from
 * the marketing site for months and has its own names. Mapped here rather than
 * renaming either side: the design should keep describing its form in its own
 * words, and the endpoint is shared with /early-access.
 *
 *   name  -> firstName
 *   site  -> companyDomain   (stored as `company`, which is what the admin
 *                             leads table shows - the endpoint does
 *                             `company || companyDomain`)
 *   source -> a campaign-specific tag, and NOT 'early-access-form', which the
 *             endpoint treats as a stricter form that rejects a lead with no
 *             email address. This form asks for email optionally, so submitting
 *             under that source would 400 every lead that skipped it.
 */
patch(
  `      body: JSON.stringify(Object.assign({}, v, { site: this.normSite(v.site) }))`,
  `      body: JSON.stringify({
        firstName: v.name,
        phone: v.phone,
        email: (v.email || '').trim() || undefined,
        companyDomain: this.normSite(v.site),
        source: LEAD_SOURCE
      })`,
  'mapping the form payload onto the lead endpoint',
);

/**
 * A duplicate is not a failure.
 *
 * The endpoint answers 409 when the phone or email is already on the list. The
 * design's handler treats every non-2xx the same and shows "sending failed, try
 * again" - advice that cannot ever work, to someone who has already reached us.
 * They get the thank-you state instead, which is the truth from where they are
 * standing.
 *
 * `lead` is deliberately NOT tracked on that branch. The conversion already
 * fired the first time, and counting it twice would overstate the campaign to
 * the ad platform that is being optimised against it.
 */
patch(
  `      if (!r.ok) throw new Error('save failed');
      this.track('lead', false);
      this.setState({ sent: true, sending: false });`,
  `      if (r.status === 409) {
        // Already on the list: same outcome for them, no second conversion.
        this.setState({ sent: true, sending: false });
        return;
      }
      if (!r.ok) throw new Error('save failed');
      this.track('lead', false);
      this.setState({ sent: true, sending: false });`,
  'treating a duplicate lead as reached rather than failed',
);

/* The design references its assets relatively; they are served from one tree. */
const assetHits = (src.match(/'assets\//g) || []).length;
src = src.replace(/'assets\//g, "'/assets/");

/* ─────────── render ─────────── */

const RENDER = `
  // dc-runtime: vals = { ...userProps, ...logic.renderVals() }
  render() {
    let vals;
    try {
      vals = { ...this.props, ...(this.renderVals() || {}) };
    } catch (e) {
      // The design's renderVals() reads a dozen state fields. If one of them is
      // missing the page must not disappear - a blank campaign page is a paid
      // click landing on nothing.
      console.error('renderVals():', e);
      return React.createElement('pre', { style: { padding: 24, color: '#8E3418' } },
        String((e && e.stack) || e));
    }
    return React.createElement(Template, { v: vals });
  }
`;

const last = src.lastIndexOf('}');
if (last < 0) throw new Error('no closing brace');
src = src.slice(0, last) + RENDER + src.slice(last);

const header = `/* Ported from the "GOTCHA Campaign Landing.dc.html" script block by
   tools/build-logic.mjs. The class body is the design's own source - keep edits
   there, not here. Re-run the design:sync npm script. */
/* eslint-disable */
'use client';

import React from 'react';
import Template from '@/generated/Template';
import { links, META_PIXEL_ID } from '@/lib/site';

/**
 * How this campaign's leads are tagged in the admin leads table.
 *
 * Anything but 'early-access-form', which the endpoint treats as the full
 * wizard and holds to a stricter rule (email AND phone both required). This
 * form makes email optional.
 */
const LEAD_SOURCE = 'campaign-one-dollar-offer';

`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + src.trimStart() + '\n\nexport default CampaignLogic;\n');

console.log('CampaignLanding.jsx:', (header + src).split('\n').length, 'lines');
console.log('rooted asset paths :', assetHits);
