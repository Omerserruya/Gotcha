/**
 * Wraps a design's DCLogic class as a React component, changing as little of
 * the authored source as possible: DCLogic already mirrors React's class API
 * (state, setState, componentDidMount/WillUnmount), so the body ports across
 * untouched and only the class header, a handful of asserted patches and
 * render() differ.
 *
 * EVERY PATCH IS ASSERTED, and that has already paid for itself twice. When the
 * campaign design was rewritten, three patches this file used to apply stopped
 * matching - because the design had fixed those bugs itself, better than the
 * patches did. The build stopped and said so, instead of shipping a page whose
 * form posted nowhere.
 *
 * Usage:  node tools/build-logic.mjs [campaign|thanks]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'design');

const DESIGNS = {
  campaign: {
    src: 'GOTCHA Campaign Landing.dc.html',
    className: 'CampaignLogic',
    template: 'Template',
    out: 'src/components/CampaignLanding.jsx',
  },
  thanks: {
    src: 'GOTCHA Thank You.dc.html',
    className: 'ThanksLogic',
    template: 'ThanksTemplate',
    out: 'src/components/ThankYou.jsx',
  },
};

const which = process.argv[2] || 'campaign';
const CFG = DESIGNS[which];
if (!CFG) throw new Error(`unknown design "${which}". Known: ${Object.keys(DESIGNS).join(', ')}`);

const OUT = path.join(ROOT, CFG.out);
const raw = fs.readFileSync(path.join(DESIGN, CFG.src), 'utf8');
const start = raw.indexOf('>', raw.indexOf('<script type="text/x-dc"')) + 1;
let src = raw.slice(start, raw.lastIndexOf('</script>'));

/** Replace exactly once, or fail loudly with what was being looked for. */
function patch(find, replace, why) {
  const n = src.split(find).length - 1;
  if (n !== 1) {
    throw new Error(
      `[${which}] expected exactly one occurrence, found ${n}, while ${why}:\n  ${find.split('\n')[0]}`,
    );
  }
  src = src.replace(find, replace);
}

patch(
  'class Component extends DCLogic {',
  `class ${CFG.className} extends React.Component {`,
  'porting the class header',
);

/* ─────────── the values the design leaves for us ─────────── */

if (which === 'campaign') {
  /**
   * Where the form posts. SAME-ORIGIN: /api/waitlist is proxied to the auth
   * service by this host's own vhost, so no CORS is involved.
   */
  patch(
    "    leadEndpoint: null,     // יעד שמירת הליד — יחובר לפני הפרסום",
    "    leadEndpoint: '/api/waitlist',",
    'wiring the lead endpoint',
  );

  /** GOTCHA's pixel. Still gated on consent - see MetaPixel. */
  patch(
    "    metaPixelId: null,      // מזהה פיקסל Meta — יוזן לפני הפרסום",
    '    metaPixelId: META_PIXEL_ID,',
    'wiring the Meta pixel id',
  );

  /**
   * Where a successful submit lands.
   *
   * The design points this at the design FILE - correct on the design canvas,
   * meaningless once built. It becomes the route that page is served at, which
   * is also what makes a clean conversion URL possible: one address that is
   * only ever reached by someone who actually submitted.
   */
  patch(
    "    thankYou: 'GOTCHA Thank You.dc.html',",
    '    thankYou: THANK_YOU_PATH,',
    'pointing the thank-you redirect at a real route',
  );

  /**
   * The two legal documents that exist. `offerTermsUrl` and `accessibilityUrl`
   * stay null on purpose: those documents have not been written, and the design
   * already renders a marked non-link for a missing one, which is better than a
   * link that goes nowhere.
   */
  patch(
    '    privacyUrl: null, termsUrl: null, offerTermsUrl: null, accessibilityUrl: null',
    "    privacyUrl: links.trust('privacy-policy'), termsUrl: links.trust('terms-of-service'),\n" +
      '    offerTermsUrl: null, accessibilityUrl: null',
    'wiring the legal links',
  );

  /**
   * The form's own field names, mapped onto the endpoint's.
   *
   *   name  -> firstName
   *   site  -> companyDomain   (stored as `company`, which is what the leads
   *                             table and the Telegram alert show)
   *   source -> a campaign tag, and NOT 'early-access-form', which puts the
   *             endpoint into a stricter mode that rejects any lead without an
   *             email address. This form asks for email optionally.
   */
  patch(
    '      body: JSON.stringify(Object.assign({}, v, { site: this.normSite(v.site) }))',
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
   * The endpoint answers 409 when the phone or email is already on the list.
   * Treated as an error, it would tell someone who has already reached us to
   * "try again", which can never work. They get the thank-you page, which is
   * the truth from where they are standing.
   *
   * `lead` is deliberately NOT tracked on that branch: the conversion already
   * fired the first time, and counting it twice overstates the campaign to the
   * ad platform being optimised against it.
   */
  patch(
    `      if (!r.ok) throw new Error('save failed');
      this.track('lead', true);
      location.href = this.CFG.thankYou;`,
    `      if (r.status === 409) {
        // Already on the list: same destination, no second conversion.
        location.href = this.CFG.thankYou;
        return;
      }
      if (!r.ok) throw new Error('save failed');
      this.track('lead', true);
      location.href = this.CFG.thankYou;`,
    'treating a duplicate lead as reached rather than failed',
  );
} else {
  /** The thank-you page carries the same two documents in its footer. */
  patch(
    `    privacyUrl: null,
    termsUrl: null`,
    `    privacyUrl: links.trust('privacy-policy'),
    termsUrl: links.trust('terms-of-service')`,
    'wiring the legal links on the thank-you page',
  );
}

/* The design references its assets relatively; they are served from one tree. */
const assetHits = (src.match(/'assets\//g) || []).length;
src = src.replace(/'assets\//g, "'/assets/");

const RENDER = `
  // dc-runtime: vals = { ...userProps, ...logic.renderVals() }
  render() {
    let vals;
    try {
      vals = { ...this.props, ...(this.renderVals() || {}) };
    } catch (e) {
      // A blank page is a paid click landing on nothing. Show the failure
      // rather than disappearing.
      console.error('renderVals():', e);
      return React.createElement('pre', { style: { padding: 24, color: '#8E3418' } },
        String((e && e.stack) || e));
    }
    return React.createElement(${CFG.template}, { v: vals });
  }
`;

const last = src.lastIndexOf('}');
if (last < 0) throw new Error('no closing brace');
src = src.slice(0, last) + RENDER + src.slice(last);

const header = `/* Ported from the "${CFG.src}" script block by tools/build-logic.mjs.
   The class body is the design's own source - keep edits there, not here.
   Re-run the design:sync npm script. */
/* eslint-disable */
'use client';

import React from 'react';
import ${CFG.template} from '@/generated/${CFG.template}';
import { links${which === 'campaign' ? ', META_PIXEL_ID, LEAD_SOURCE, THANK_YOU_PATH' : ''} } from '@/lib/site';

`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + src.trimStart() + `\n\nexport default ${CFG.className};\n`);

console.log(`${path.basename(OUT)}`.padEnd(24), (header + src).split('\n').length, 'lines');
console.log('rooted asset paths'.padEnd(24), assetHits);
