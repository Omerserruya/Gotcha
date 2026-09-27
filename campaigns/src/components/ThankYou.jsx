/* Ported from the "GOTCHA Thank You.dc.html" script block by tools/build-logic.mjs.
   The class body is the design's own source - keep edits there, not here.
   Re-run the design:sync npm script. */
/* eslint-disable */
'use client';

import React from 'react';
import ThanksTemplate from '@/generated/ThanksTemplate';
import { links } from '@/lib/site';

class ThanksLogic extends React.Component {
  CFG = {
    demo: 'https://calendar.app.google/5YgBtZFPCDbUpskA7',
    waNumber: '972552633304',
    privacyUrl: links.trust('privacy-policy'),
    termsUrl: links.trust('terms-of-service')
  };

  track(name) {
    const payload = { event: name };
    (window.dataLayer = window.dataLayer || []).push(payload);
    console.info('[measurement]', payload);
  }

  legalLink(label, url) {
    if (url) return React.createElement('a', { href: url, target: '_blank', rel: 'noopener', style: { color: '#B8B3AA', fontWeight: 500 } }, label);
    return React.createElement('span', { title: 'המסמך יחובר לפני הפרסום', style: { color: '#B8B3AA', borderBottom: '1px dotted #55524C', cursor: 'default' } }, label);
  }

  renderVals() {
    const ask = 'היי, השארתי פרטים באתר ויש לי שאלה לפני ההדגמה.';
    return {
      cfg: {
        demo: this.CFG.demo,
        waAsk: 'https://wa.me/' + this.CFG.waNumber + '?text=' + encodeURIComponent(ask)
      },
      ev: {
        demo: () => this.track('calendar_click_thankyou'),
        wa: () => this.track('whatsapp_click_thankyou')
      },
      legal: {
        links: [
          this.legalLink('מדיניות פרטיות', this.CFG.privacyUrl),
          this.legalLink('תנאי שימוש', this.CFG.termsUrl)
        ].map((el, i) => React.cloneElement(el, { key: i }))
      }
    };
  }

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
    return React.createElement(ThanksTemplate, { v: vals });
  }
}


export default ThanksLogic;
