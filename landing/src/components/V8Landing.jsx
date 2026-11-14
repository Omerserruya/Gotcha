/* Ported from the "GOTCHA Website.dc.html" script block by tools/build-home.mjs - do not edit.
   The class body is the design's own source; keep edits there, or in the compiler. */
/* eslint-disable */
'use client';

import React from 'react';
import HomeTemplate from '@/generated/home/Template';
import * as __D from '@/generated/home/data';
import { getLucide } from '@/lib/lucide';
import { enTree } from '@/lib/en-tree';
import { homeHref, portLinks, v8PageHref } from '@/lib/home-links';
import { V8_PAGES } from '@/lib/v8-pages';
import { consentDecided, onConsentDecided } from '@/lib/consent';
import { leadFromForm, sendLead, SEND_FAILED } from '@/lib/home-lead.mjs';
import { loadVendor } from '@/lib/home-vendor';

/*
 * The design ran in a browser only. Rendered on the server too, the two
 * globals its render path touches are shadowed here: on the client they ARE the
 * browser's objects (so `location.href = …` still navigates), and on the
 * server they are inert stand-ins. Lifecycle methods and handlers only ever run
 * in the browser.
 */
const window = typeof globalThis.window !== 'undefined' ? globalThis.window : { innerHeight: 900, innerWidth: 1440 };
const location = typeof globalThis.location !== 'undefined' ? globalThis.location : { pathname: '/', search: '', href: '/' };

class HomeLogic extends React.Component {
  state = { mg: null, w6: 0, tq: -1, tn: 0, tph: '', uc: 0, faq: 0, biz: 'retail', menu: null, mnav: false, bar: true, offerOpen: false, tstep: 9, sec: '19', typed: null, closed: 14, count: null, ready: true };
  EMBED = false;
  TALK = !!(this.props && this.props.page === 'talk');
  ECOM = !!(this.props && this.props.page === 'ecommerce');
  LEADS = !!(this.props && this.props.page === 'leads');
  WHY = !!(this.props && this.props.page === 'why');
  OFFER = !!(this.props && this.props.page === 'offer');
  PRICE = !!(this.props && this.props.page === 'pricing');
  SOL = this.ECOM || this.LEADS;
  ECD = {
    kicker: 'By business · Ecommerce', h1a: 'Half your day is', h1b: '"where is my order"',
    sub: 'GOTCHA opens the order in your store, reads the real tracking, and answers with the truth. When someone wants to cancel it checks whether the parcel has been packed before promising anything.',
    asideHead: 'Where the impact is',
    aside: '"Where is my order" is half the day for most stores. GOTCHA opens the order, reads the real tracking and answers with the truth, at any hour. Cancellations, exchanges and returns are carried out in your store and your returns platform, not written down for someone to do later.',
    stats: [{ v: 'Order status, live', l: 'from your store and the courier, not a template' }, { v: 'Returns and\nexchanges done', l: 'inside your systems, within the limits you set' }, { v: 'Money asks first', l: 'refunds above your line wait for your approval' }],
    dayKick: 'A normal Tuesday', dayTitle: 'The same three questions, answered before you wake up.', dayNote: 'How a conversation like this plays out, step by step.',
    cases: [
      { icon: 'whatsapp.svg', when: 'WhatsApp · 02:14', tag: 'Shipping', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F', msg: "My package still hasn't arrived and I've been waiting two weeks. This was a gift.", steps: ['Found order #1842: stuck with the carrier since Tuesday', 'Read your refund policy: eligible', 'Refund under ₪200: allowed without asking'], reply: "I'm sorry: #1842 has been stuck since Tuesday. I've refunded the full ₪179 to your card. If you'd still like it, I can hold one from tomorrow's batch.", after: 'Refund processed. She left a five-star review the next day.' },
      { icon: 'instagram.svg', when: 'Instagram · 21:40', tag: 'Exchange', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8', msg: 'Hey, can I swap the sand set for the navy? Ordered Tuesday.', steps: ['Matched her to the order automatically', 'Checked fulfilment: not packed yet', 'Checked navy stock, 11 left'], reply: "Yes, it hasn't left us yet, so I've swapped it to navy in the same size. No charge, and it ships tomorrow.", after: 'Exchange opened in your returns platform. Stock adjusted.' },
      { icon: 'globe.svg', when: 'Web chat · 11:06', tag: 'Wants to buy', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A', msg: 'Do you deliver to Eilat next day? Need it for Friday.', steps: ['Checked your dispatch cut-off, 14:00', 'Checked the courier zone for Eilat', 'Checked stock in her size'], reply: 'Next-day does reach Eilat if you order before 14:00 today. That lands Thursday, a day early. Shall I hold it?', after: 'Ordered eleven minutes later.' }
    ],
    aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
    alone: ['Order status and real tracking', 'Cancellations, after checking fulfilment', 'Returns and exchanges, label included', 'Refunds within your limit', 'Stock checks and product search', 'Sizing and care, from your own product copy'],
    stopTitle: 'Where it stops and asks you', stopNote: 'The decisions that involve money or judgement.',
    stops: [['A refund over your limit', 'Approvals'], ['A cancellation after dispatch', 'Approvals'], ['A customer writing a third time', 'To a person'], ['Anything a policy does not cover', 'To a person']],
    stopFoot: 'Roughly three a day reach you, each one a card with the order, the reason and what it costs to wait. Everything else is already done.',
    quote: '"Ecommerce support is mostly lookups. Lookups are exactly what software should be doing at two in the morning."', qName: 'Matan & Omer', qRole: 'Co-founders · GOTCHA',
    proof: [{ v: 'The routine volume', l: 'handled end to end before it reaches your team' }, { v: 'The judgement calls', l: 'brought to you with the order, the amount and the reason' }],
    ctaTitle: 'See what it would have answered last month.',
    ctaBody: 'Connect your store and GOTCHA replays your own past conversations, your products, your policies, your customers. You judge it on your business before you trust it with one.'
  };
  ECHOW = {
    he: { kick: '', title: 'איך זה עובד?', sub: 'ארבעה צעדים פשוטים, בלי מתכנת ובלי לשנות את הדרך שבה אתם עובדים', steps: [
      ['plug', '#FBEEE8', '#C4552F', 'מחברים את החנות', 'שופיפיי או ווקומרס בלחיצה אחת, ולצידם הוואטסאפ, האינסטגרם והמייל של העסק', true],
      ['book-open', '#EFEBFA', '#4B3E8E', 'GOTCHA לומדת את העסק', 'היא קוראת את המוצרים, ההזמנות, המלאי ומדיניות המשלוחים וההחזרות שלכם. מזה היא עונה, לא מניחוש'],
      ['zap', '#E7F0D4', '#3F6323', 'עונה ומבצעת בתוך הגבולות', 'כשלקוח כותב היא פותחת את ההזמנה האמיתית, בודקת מה מותר לפי ההגדרות שלכם, ומבצעת ישר בחנות: ביטול, החלפה או זיכוי'],
      ['shield-check', '#F6EFD8', '#7E5410', 'והכל בשליטה שלכם כל הזמן', 'אתם קובעים מה מותר לה לעשות לבד. כל מה שמעבר לזה מגיע אליכם לאישור, ואפשר להיכנס לכל שיחה בכל רגע']
    ] },
    en: { kick: '', title: 'How does it work?', sub: 'Four simple steps, no developer, and no change to the way you already work', steps: [
      ['plug', '#FBEEE8', '#C4552F', 'Connect your store', 'Shopify or WooCommerce in one click, together with your WhatsApp, Instagram and email', true],
      ['book-open', '#EFEBFA', '#4B3E8E', 'GOTCHA learns your business', 'It reads your products, orders, stock and your shipping and returns policy. It answers from those, not from guesses'],
      ['zap', '#E7F0D4', '#3F6323', 'It answers and acts within your limits', 'When a customer writes it opens the real order, checks what your settings allow, and acts in the store: a cancellation, an exchange or a refund'],
      ['shield-check', '#F6EFD8', '#7E5410', 'And you stay in control the whole time', 'You decide what it may do on its own. Anything beyond that comes to you for approval, and you can step into any conversation at any moment']
    ] }
  };
  LDHOW = {
    he: { title: 'איך זה עובד?', sub: 'ארבעה צעדים פשוטים, בלי מתכנת ובלי לשנות את הדרך שבה אתם מוכרים', steps: [
      ['plug', '#FBEEE8', '#C4552F', 'מחברים את הערוצים והמערכות', 'וואטסאפ, אינסטגרם, פייסבוק, הטפסים באתר, היומן וה-CRM שלכם, בכמה לחיצות', true],
      ['book-open', '#EFEBFA', '#4B3E8E', 'GOTCHA לומדת את העסק', 'היא קוראת את השירותים, המחירון, אזורי השירות והשאלות שאתם שואלים בשיחת היכרות'],
      ['zap', '#E7F0D4', '#3F6323', 'עונה לכל ליד ומקדמת אותו', 'עונה תוך דקה, מתעניינת בלקוח, שואלת מה חסר, ורק אז מציגה מחיר וקובעת פגישה ביומן'],
      ['shield-check', '#F6EFD8', '#7E5410', 'והכל בשליטה שלכם כל הזמן', 'אתם קובעים מה מותר לה להציע לבד. הנחות, הצעות חריגות וכל מה שמעבר מגיעים אליכם, ואפשר להיכנס לכל שיחה בכל רגע']
    ] },
    en: { title: 'How does it work?', sub: 'Four simple steps, no developer, and no change to the way you sell', steps: [
      ['plug', '#FBEEE8', '#C4552F', 'Connect your channels and systems', 'WhatsApp, Instagram, Facebook, your website forms, your calendar and your CRM, in a few clicks', true],
      ['book-open', '#EFEBFA', '#4B3E8E', 'GOTCHA learns your business', 'It reads your services, price list, service areas and the questions you ask on an intro call'],
      ['zap', '#E7F0D4', '#3F6323', 'It answers every lead and moves it forward', 'It replies within a minute, takes an interest in the customer, asks what is missing, and only then gives a price and books a meeting'],
      ['shield-check', '#F6EFD8', '#7E5410', 'And you stay in control the whole time', 'You decide what it may offer on its own. Discounts, unusual quotes and anything beyond that come to you, and you can step into any conversation at any moment']
    ] }
  };
  ecNew(en) {
    const L = en ? 'en' : 'he', P = (k) => this.pageUrl(k);
    const X = {
      he: { kicker: 'לחנויות שופיפיי ווקומרס', w1: ['GOTCHA'], w2: ['לאיקומרס'], sub: 'עובדי AI שמחוברים לחנות שלכם, עונים ללקוחות בכל ערוץ ומבצעים פעולות ישר בשופיפיי או בווקומרס',
        featTitle: 'כלים שנבנו לחנויות אונליין', featSub: 'כל מה שחנות צריכה כדי למכור יותר ולענות מהר יותר, במקום אחד', featLink: 'לפרטים',
        feats: [['feat-cart', 'shopping-basket', '#FBEEE8', '#C4552F', 'שחזור עגלות נטושות', 'לקוחה השאירה מוצרים בעגלה? GOTCHA כותבת לה בוואטסאפ, עונה על מה שעצר אותה ומחזירה אותה לעגלה מוכנה'],
          ['feat-widget', 'shopping-cart', '#EDF4E7', '#2E7D5B', 'ווידג׳ט לחנות', 'חלון צ׳אט שמכיר את הקטלוג, המלאי והעגלה, ועונה על שאלות מידה, משלוח ומלאי תוך שניות'],
          ['feat-approvals', 'check-check', '#EFEBFA', '#4B3E8E', 'אישורים', 'זיכויים מעל הגבול, ביטולים אחרי משלוח וכל מה שתבחרו מחכים לאישור שלכם, עם כל הפרטים במקום אחד'],
          ['feat-integrations', 'plug', '#F6EFD8', '#7E5410', 'אינטגרציות למערכות צד שלישי', 'GOTCHA מתחברת למערכות שאתם כבר עובדים איתן ופועלת בתוכן בשבילכם', ['חברות שליחויות', 'פלטפורמות החזרות', 'מלאי ו-ERP']]],
        soonBadge: 'בקרוב', soonTitle: 'GOTCHA תברר בעצמה מול חברת המשלוחים',
        soonBody: 'בקרוב עובדי ה-AI של GOTCHA יפתחו פנייה מול חברת המשלוחים ויבררו בעצמם מה קורה עם משלוח בעייתי, ואז יעדכנו את הלקוח בלי שתצטרכו להרים טלפון',
        soon: [['message-circle', 'הלקוחה · וואטסאפ', 'החבילה שלי תקועה כבר שבוע, מה קורה איתה?'], ['send', 'GOTCHA', 'פותחת פנייה מול חברת המשלוחים עם מספר המשלוח וכל הפרטים'], ['truck', 'חברת המשלוחים', 'החבילה במרכז המיון ותצא לחלוקה מחר'], ['check', 'GOTCHA · ללקוחה', 'בדקתי מול חברת המשלוחים. החבילה יוצאת לחלוקה מחר ותגיע עד 14:00']],
        growTitle: 'כשאף שאלה לא נשארת בלי מענה, המכירות עולות', growSub: 'תשובה מהירה בכל ערוץ, עגלות שחוזרות וחנות שעובדת גם בלילה',
        cw: ['סרקו', 'את', 'האתר', 'שלכם'], ctaBody: 'הכניסו את כתובת החנות. GOTCHA תקרא את המוצרים, המשלוחים וההחזרות, ותראה לכם איך היא הייתה עונה ללקוחות שלכם', demo: 'או קבעו דמו' },
      en: { kicker: 'For Shopify and WooCommerce stores', w1: ['GOTCHA'], w2: ['for', 'ecommerce'], sub: 'AI employees connected to your store that answer customers on every channel and take action directly in Shopify or WooCommerce',
        featTitle: 'Built for online stores', featSub: 'Everything a store needs to sell more and answer faster, in one place', featLink: 'Learn more',
        feats: [['feat-cart', 'shopping-basket', '#FBEEE8', '#C4552F', 'Abandoned cart recovery', 'Left items in the cart? GOTCHA writes to her on WhatsApp, answers what stopped her and sends her back to a ready cart'],
          ['feat-widget', 'shopping-cart', '#EDF4E7', '#2E7D5B', 'Store widget', 'A chat window that knows your catalogue, stock and cart, and answers size, shipping and stock questions in seconds'],
          ['feat-approvals', 'check-check', '#EFEBFA', '#4B3E8E', 'Approvals', 'Refunds above your limit, cancellations after dispatch and anything you choose wait for your approval, with every detail in one place'],
          ['feat-integrations', 'plug', '#F6EFD8', '#7E5410', 'Third-party integrations', 'GOTCHA connects to the systems you already use and acts inside them for you', ['Couriers', 'Returns platforms', 'Stock and ERP']]],
        soonBadge: 'Coming soon', soonTitle: 'GOTCHA will check with the courier itself',
        soonBody: 'Soon, GOTCHA AI employees will open a ticket with the courier and find out for themselves what is happening with a problem shipment, then update the customer without you picking up the phone',
        soon: [['message-circle', 'Customer · WhatsApp', 'My parcel has been stuck for a week, what is going on?'], ['send', 'GOTCHA', 'Opens a ticket with the courier, with the tracking number and every detail'], ['truck', 'Courier', 'The parcel is at the sorting centre and goes out for delivery tomorrow'], ['check', 'GOTCHA · to the customer', 'I checked with the courier. Your parcel goes out tomorrow and arrives by 14:00']],
        growTitle: 'When no question goes unanswered, sales go up', growSub: 'Fast answers on every channel, carts that come back and a store that works at night too',
        cw: ['Scan', 'your', 'website'], ctaBody: 'Enter your store address. GOTCHA reads your products, shipping and returns, and shows you how it would have answered your customers', demo: 'Or book a demo' }
    }[L];
    if (this.LEADS) Object.assign(X, {
      he: { kicker: 'לעסקים שמוכרים שירות ועבודה', w1: ['GOTCHA'], w2: ['ללידים'], sub: 'עובדי AI שעונים לכל ליד תוך דקה, שואלים את השאלות הנכונות, קובעים פגישה ביומן ומעדכנים את ה-CRM שלכם',
        featTitle: 'כלים שנבנו למכירת לידים', featSub: 'כל מה שצריך כדי שאף ליד לא יתקרר, במקום אחד', featLink: 'לפרטים',
        feats: [['feat-omnichannel', 'inbox', '#FBEEE8', '#C4552F', 'כל הלידים במקום אחד', 'וואטסאפ, אינסטגרם, פייסבוק, מייל וטפסים באתר נכנסים לאותה תיבה, וכל ליד מקבל מענה תוך דקה'],
          ['feat-callpilot', 'phone-call', '#EDF4E7', '#2E7D5B', 'ליווי שיחות בזמן אמת', 'בשיחת טלפון חיה GOTCHA מכווינה את נציג המכירות, ובסוף השיחה מסכמת אותה ומעדכנת את ה-CRM'],
          ['feat-broadcast', 'megaphone', '#EFEBFA', '#4B3E8E', 'הודעות תפוצה בוואטסאפ', 'חוזרים ללידים שלא סגרו וללקוחות קודמים עם הודעה אישית, בזמן הנכון'],
          ['feat-integrations', 'plug', '#F6EFD8', '#7E5410', 'אינטגרציות ל-CRM וליומן', 'GOTCHA ממלאת את ה-CRM, קובעת ביומן ומעדכנת את הצוות, בלי עבודה ידנית', ['ה-CRM שלכם', 'יומן Google', 'טפסים באתר']]],
        soonBadge: 'מליד לפגישה', soonTitle: 'מהודעה ראשונה ועד פגישה ביומן, בלי להרים טלפון',
        soonBody: 'GOTCHA עונה ללידים בכל שעה, מבררת מה הם צריכים וקובעת פגישה עם הצוות. אתם מגיעים לשיחה עם בריף מוכן',
        soon: [['message-circle', 'ליד חדש · אינסטגרם', 'כמה עולה תוכנית ליווי של שלושה חודשים?'], ['help-circle', 'GOTCHA', 'לפני המחיר היא שואלת על המטרה, הניסיון והזמינות'], ['calendar', 'היומן שלכם', 'שיחת היכרות נקבעה למחר ב-18:00'], ['check', 'GOTCHA · ל-CRM', 'הליד עודכן ב-CRM עם בריף מלא לנציג']],
        growTitle: 'כשכל ליד מקבל מענה תוך דקה, יותר לידים הופכים ללקוחות', growSub: 'מענה מהיר בכל ערוץ, השאלות הנכונות ופגישות שנקבעות לבד',
        cw: ['סרקו', 'את', 'האתר', 'שלכם'], ctaBody: 'הכניסו את כתובת האתר. GOTCHA תקרא את השירותים והמחירון, ותראה לכם איך היא הייתה עונה ללידים שלכם', demo: 'או קבעו דמו' },
      en: { kicker: 'For businesses that sell services and work', w1: ['GOTCHA'], w2: ['for', 'leads'], sub: 'AI employees that answer every lead within a minute, ask the right questions, book the meeting in your calendar and update your CRM',
        featTitle: 'Built for selling to leads', featSub: 'Everything you need so no lead goes cold, in one place', featLink: 'Learn more',
        feats: [['feat-omnichannel', 'inbox', '#FBEEE8', '#C4552F', 'Every lead in one place', 'WhatsApp, Instagram, Facebook, email and website forms land in the same inbox, and every lead gets an answer within a minute'],
          ['feat-callpilot', 'phone-call', '#EDF4E7', '#2E7D5B', 'Live call guidance', 'On a live phone call GOTCHA guides your sales rep, then summarises the call and updates the CRM'],
          ['feat-broadcast', 'megaphone', '#EFEBFA', '#4B3E8E', 'WhatsApp broadcasts', 'Get back to leads who did not close and to past customers with a personal message, at the right time'],
          ['feat-integrations', 'plug', '#F6EFD8', '#7E5410', 'CRM and calendar integrations', 'GOTCHA fills in your CRM, books in your calendar and updates the team, with no manual work', ['Your CRM', 'Google Calendar', 'Website forms']]],
        soonBadge: 'From lead to meeting', soonTitle: 'From the first message to a meeting in the calendar, without a phone call',
        soonBody: 'GOTCHA answers leads at any hour, finds out what they need and books a meeting with your team. You arrive at the call with a brief ready',
        soon: [['message-circle', 'New lead · Instagram', 'How much is a three-month coaching programme?'], ['help-circle', 'GOTCHA', 'Before the price it asks about the goal, experience and availability'], ['calendar', 'Your calendar', 'Intro call booked for tomorrow at 18:00'], ['check', 'GOTCHA · to the CRM', 'Lead updated in the CRM with a full brief for the rep']],
        growTitle: 'When every lead gets an answer within a minute, more leads become customers', growSub: 'Fast answers on every channel, the right questions and meetings that book themselves',
        cw: ['Scan', 'your', 'website'], ctaBody: 'Enter your website address. GOTCHA reads your services and price list, and shows you how it would have answered your leads', demo: 'Or book a demo' }
    }[L]);
    const LG = this.LEADS
      ? { logoA: '/assets/v8/icons/whatsapp.svg', logoAs: '50%', logoB: '/assets/v8/icons/instagram.svg', logoBs: '50%', howLogos: [['whatsapp.svg', '52%'], ['instagram.svg', '52%'], ['messenger.svg', '52%'], ['gmail.svg', '52%']] }
      : { logoA: '/assets/v8/icons/shopify.svg', logoAs: '52%', logoB: '/assets/v8/icons/woo.png', logoBs: '64%', howLogos: [['shopify.svg', '56%'], ['woo.png', '66%'], ['whatsapp.svg', '52%'], ['instagram.svg', '52%']] };
    const SOONBG = ['rgba(250,248,244,.06)', 'rgba(232,148,110,.14)', 'rgba(250,248,244,.06)', 'rgba(171,197,122,.16)'], SOONDOT = ['#F7F5F1', '#E8946E', '#D8D2C6', '#ABC57A'];
    return {
      kicker: X.kicker, kickIcon: this.LEADS ? 'users' : 'shopping-bag', w1: X.w1.map((t, i) => ({ key: i, t })), w2: X.w2.map((t, i) => ({ key: i, t })), sub: X.sub, demo: en ? 'Book a demo' : 'קבעו דמו', ctaDemo: X.demo,
      featTitle: X.featTitle, featSub: X.featSub, featLink: X.featLink,
      feats: X.feats.map((f, i) => ({ key: i, href: P(f[0]), icon: f[1], bg: f[2], ic: f[3], t: f[4], d: f[5], hasChips: !!f[6], chips: (f[6] || []).map((t, j) => ({ key: j, t })) })),
      soonBadge: X.soonBadge, soonTitle: X.soonTitle, soonBody: X.soonBody,
      soon: X.soon.map((n, i) => ({ key: i, icon: n[0], who: n[1], t: n[2], bg: SOONBG[i], dot: SOONDOT[i] })),
      logoA: LG.logoA, logoAs: LG.logoAs, logoB: LG.logoB, logoBs: LG.logoBs, howLogos: LG.howLogos.map((l, i) => ({ key: i, src: '/assets/v8/icons/' + l[0], sz: l[1] })),
      growTitle: X.growTitle, growSub: X.growSub, cw: X.cw.map((t, i) => ({ key: i, t })), ctaBody: X.ctaBody,
      scanSubmit: (e) => { e.preventDefault(); if (!this.siteOk()) { this.setState({ siteErr: true }); const f = document.querySelector('[data-ec-field]'); const inp = f && f.querySelector('input'); if (inp) inp.focus(); if (f && window.gsap && !this.reduce) window.gsap.fromTo(f, { x: 0 }, { keyframes: { x: [-9, 8, -6, 4, -2, 0] }, duration: 0.5, ease: 'power2.out' }); return; } this.setState({ siteErr: false }); this.goOnboarding(this.state.heroSite); }
    };
  }
  ecomUrl() { return homeHref('sol-ecommerce', this.EN_ON ? 'en' : 'he', this.props && this.props.page); }
  ecVals() {
    const T = (x) => this.T(x), C = this.ECD, en = this.EN_ON;
    const sp = (x, dot) => T(x).replace(dot ? /\.$/ : /$^/, '').split(' ').filter(Boolean).map((t, i) => ({ key: i, t }));
    const pos = ['top:4%;left:0;z-index:2', 'top:34%;right:-1%;z-index:2', 'bottom:3%;right:22%;z-index:2'], par = [1.2, 0.7, 1.0];
    return {
      kicker: T(C.kicker), w1: sp(C.h1a), w2: sp(C.h1b), sub: T(C.sub), demo: T('Book a demo'), start: T('Start free'),
      bubbles: C.cases.map((c, i) => ({ key: i, icon: '/assets/v8/icons/' + c.icon, when: T(c.when), msg: T(c.msg), pos: pos[i], par: par[i] })),
      asideHead: T(C.asideHead), aw: sp(C.aside),
      stats: C.stats.map((s, i) => ({ key: i, v: s.v.indexOf('\n') >= 0 ? (en ? 'Returns and exchanges done' : 'החזרות והחלפות מבוצעות') : T(s.v), l: T(s.l) })),
      dayKick: T(C.dayKick), dayTitle: T(C.dayTitle).replace(/\.$/, ''), dayNote: T(C.dayNote),
      cases: C.cases.map((c, i) => ({ key: i, icon: '/assets/v8/icons/' + c.icon, when: T(c.when), tag: T(c.tag), tagFg: c.tagFg, tagBg: c.tagBg, edge: c.edge, msg: T(c.msg), steps: c.steps.map((s, j) => ({ key: j, t: T(s) })), reply: T(c.reply), after: T(c.after) })),
      aloneTitle: T(C.aloneTitle), aloneNote: T(C.aloneNote), alone: C.alone.map((t, i) => ({ key: i, t: T(t), n: T('handled alone') })),
      stopTitle: T(C.stopTitle), stopNote: T(C.stopNote), stops: C.stops.map((s, i) => ({ key: i, t: T(s[0]), n: T(s[1]) })), stopFoot: T(C.stopFoot),
      qw: sp(C.quote), qName: T(C.qName), qRole: T(C.qRole), proof: C.proof.map((p, i) => ({ key: i, v: T(p.v), l: T(p.l) })),
      cw: sp(C.ctaTitle, true), ctaBody: T(C.ctaBody),
      howKick: this.ECHOW[en ? 'en' : 'he'].kick, howTitle: (this.LEADS ? this.LDHOW : this.ECHOW)[en ? 'en' : 'he'].title, howSub: (this.LEADS ? this.LDHOW : this.ECHOW)[en ? 'en' : 'he'].sub,
      ...this.ecNew(en),
      howSteps: (this.LEADS ? this.LDHOW : this.ECHOW)[en ? 'en' : 'he'].steps.map((s, i) => ({ key: i, n: '0' + (i + 1), icon: s[0], bg: s[1], ic: s[2], t: s[3], d: s[4], logos: !!s[5] }))
    };
  }
  async initEcom() {
    const root = document.documentElement;
    const fail = () => { root.classList.remove('fx'); root.classList.add('nofx'); };
    if (this.reduce) { fail(); return; }
    try {
      if (!window.gsap) await loadVendor('gsap');
      if (!window.ScrollTrigger) await loadVendor('ScrollTrigger');
      if (!window.Lenis) await loadVendor('Lenis');
    } catch (e) { fail(); return; }
    for (let i = 0; i < 80 && !(document.querySelectorAll('[data-ec-feat]').length === 4 && document.querySelectorAll('[data-ecw]').length >= 2 && !!document.querySelector('[data-ec-line]')); i++) await new Promise(r => setTimeout(r, 100));
    if (this.dead || !root.classList.contains('fx')) return;
    window.__gHomeReady = true;
    const gsap = window.gsap, ST = window.ScrollTrigger;
    gsap.registerPlugin(ST);
    this.pvo = () => root.getAttribute('data-pv') === 'desktop' ? 52 : 0;
    this.lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    this.lenis.on('scroll', ST.update);
    this.lenisRaf = (t) => this.lenis && this.lenis.raf(t * 1000);
    gsap.ticker.add(this.lenisRaf);
    gsap.ticker.lagSmoothing(0);
    if (this.pvPhone) this.lenis.stop();
    gsap.set('[data-ecw]', { y: 0, yPercent: 115 });
    const hp = gsap.utils.toArray('[data-ec-hero] [data-ec-pop]');
    gsap.timeline({ defaults: { ease: 'power3.out' }, delay: 0.1 })
      .fromTo(hp[0], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7 }, 0)
      .to('[data-ecw]', { y: 0, yPercent: 0, duration: 1.05, stagger: 0.07 }, 0.1)
      .fromTo(hp.slice(1, 3), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.8, stagger: 0.1 }, 0.6)
      .fromTo('[data-ec-stage] [data-ec-float]', { opacity: 0, scale: 0.4, rotationX: 30, z: -200 }, { opacity: 1, scale: 1, rotationX: 0, z: 0, duration: 1, stagger: 0.12, ease: 'back.out(1.6)' }, 0.35);
    gsap.utils.toArray('[data-ec-stage] [data-ec-float]').forEach((el, i) => gsap.to(el, { y: i % 2 ? 14 : -14, duration: 2.6 + i * 0.35, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.4 }));
    this.ecMM = gsap.matchMedia();
    this.ecMM.add({ desk: '(min-width: 861px)', mob: '(max-width: 860px)' }, (ctx) => { this.buildEcom(gsap, ST, ctx.conditions.desk); return () => { document.documentElement.removeAttribute('data-ec-flow'); const g = document.querySelector('[data-ec-dgrid]'); if (g) g.style.scale = ''; }; });
    const remq = () => { if (this.dead) return; gsap.matchMediaRefresh(); ST.refresh(); };
    this.onAnimResize = () => { clearTimeout(this.remqT); this.remqT = setTimeout(remq, 220); };
    window.addEventListener('resize', this.onAnimResize);
    setTimeout(remq, 700);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remq);
  }
  buildEcom(gsap, ST, desk) {
    const q = (s) => document.querySelector(s), qa = (s) => gsap.utils.toArray(s), R = document.documentElement;
    qa('[data-ec-par]').forEach(el => { const k = parseFloat(el.getAttribute('data-ec-par')) || 1; gsap.fromTo(el, { y: 0 }, { y: -110 * k, rotation: (k - 1) * 8, ease: 'none', scrollTrigger: { trigger: '[data-ec-hero]', start: 'top top', end: 'bottom top', scrub: 0.6 } }); });
    const hline = q('[data-ec-how-line]'), hsteps = qa('[data-ec-how-step]');
    if (hsteps.length) {
      const rtl = getComputedStyle(q('[data-ec-how-grid]')).direction === 'rtl';
      if (hline) gsap.set(hline, { transformOrigin: rtl ? '100% 50%' : '0% 50%' });
      const hgrid = q('[data-ec-how-grid]'), htrack = q('[data-ec-how-track]');
      const placeLine = () => {
        const g = hgrid.getBoundingClientRect(), ic = hsteps.map(s => s.firstElementChild.getBoundingClientRect());
        const xs = ic.map(r => r.left + r.width / 2 - g.left), a = Math.min.apply(null, xs), b = Math.max.apply(null, xs);
        [htrack, hline].forEach(el => { if (!el) return; el.style.left = a.toFixed(1) + 'px'; el.style.right = 'auto'; el.style.width = Math.max(0, b - a).toFixed(1) + 'px'; });
      };
      placeLine();
      ST.addEventListener('refreshInit', placeLine);
      const ht = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '[data-ec-how-grid]', start: desk ? 'top 80%' : 'top 90%', end: desk ? 'bottom 55%' : 'bottom 70%', scrub: 0.7 } });
      if (hline && desk) ht.fromTo(hline, { scaleX: 0 }, { scaleX: 1, duration: 1 }, 0);
      hsteps.forEach((s, i) => ht.fromTo(s, { opacity: 0, y: 60, rotationX: 12 }, { opacity: 1, y: 0, rotationX: 0, duration: 0.3, ease: 'power3.out' }, i * 0.24));
    }
    qa('[data-ec-feat]').forEach((el, i) => gsap.fromTo(el, { opacity: 0, y: 80, rotationX: 10 }, { opacity: 1, y: 0, rotationX: 0, ease: 'none', scrollTrigger: { trigger: el, start: 'top 96%', end: 'top 62%', scrub: 0.7, refreshPriority: -1 } }));
    const sn = qa('[data-ec-soon-n]');
    if (sn.length) gsap.fromTo(sn, { opacity: 0, y: 40, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, ease: 'none', stagger: 0.5, scrollTrigger: { trigger: '[data-ec-sgrid]', start: 'top 85%', end: desk ? 'bottom 60%' : 'bottom 75%', scrub: 0.7, refreshPriority: -1 } });
    const gl = q('[data-ec-line]');
    if (gl) { const gt = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: '[data-ec-chart]', start: 'top 85%', end: 'bottom 55%', scrub: 0.8, refreshPriority: -1 } }); gt.fromTo(gl, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1 }, 0).fromTo('[data-ec-area]', { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.5); }
    qa('[data-ec-rise]').forEach(el => gsap.fromTo(el, { opacity: 0, y: 44 }, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true, refreshPriority: -1 } }));
    gsap.set('[data-ecc]', { y: 0, yPercent: 115 });
    gsap.to('[data-ecc]', { y: 0, yPercent: 0, duration: 1, stagger: 0.07, ease: 'power3.out', scrollTrigger: { trigger: '[data-ec-cta]', start: 'top 70%', once: true, refreshPriority: -1 } });
  }
  PHONE = '';
  DEMO = 'https://calendar.app.google/pwKViwkRwQTeibnX9';
  CHAT = {
    kicker: "Let's chat", h1a: 'Talk to someone', h1b: 'who knows the product',
    sub: 'No qualification call, no discovery framework. Twenty minutes with a person who will open GOTCHA on your real channels and tell you honestly whether it is worth your money.',
    stats: [{ v: '20 min', l: 'the whole conversation' }, { v: 'Same day', l: 'we usually reply within two hours' }, { v: 'No deck', l: 'we open the product instead' }],
    waysTitle: 'Pick whichever suits you',
    ways: [
      { icon: 'calendar', bg: '#FBEEE8', ic: '#C4552F', t: 'Book twenty minutes', d: 'Screen shared, your channels open, your real questions. A founder joins for anything over 5,000 conversations a month.', n: 'this week', cta: 'Pick a time', href: 'https://calendar.app.google/pwKViwkRwQTeibnX9' }
    ],
    formTitle: 'Leave your details', formNote: 'Four fields, and we get back to you today or tomorrow with a real answer.',
    submit: 'Leave your details', formFoot: 'We do not add you to a list, and nothing is charged or installed until you say so.',
    answersTitle: 'Before you ask', answersNote: 'The four things people want to know before booking.',
    answers: [
      { t: 'Will a salesperson call me twice a week after this?', n: 'no' },
      { t: 'Can you tell me if I am too small for it?', n: 'we will' },
      { t: 'Can we see it on our own conversations?', n: 'yes, on the call' },
      { t: 'Do you work with businesses outside Israel?', n: 'yes, in English' }
    ],
    answersFoot: 'If the honest answer is that GOTCHA is not right for you yet, we will say so on the call and tell you what to fix first.',
    officeTitle: 'Where we are',
    office: [
      { t: 'Ramat Gan', d: 'Our only office. Come by if you are nearby, coffee and a screen share.' },
      { t: 'Sunday to Thursday, 09:00–18:00', d: 'Support is answered outside those hours too, by the product.' },
      { t: 'Hebrew and English', d: 'Whichever you prefer, on the call and in writing.' }
    ],
    ctaTitle: 'Twenty minutes, and you will know.',
    ctaBody: 'We will open your channels, replay what you were asked last month, and give you a number. If it is not worth it, that is a fine outcome for both of us.'
  };
  homeUrl() { return homeHref('home', this.EN_ON ? 'en' : 'he', this.props && this.props.page); }
  talkUrl() { return homeHref('co-chat', this.EN_ON ? 'en' : 'he', this.props && this.props.page); }
  tkVals() {
    const s = this.state, T = (x) => this.T(x), C = this.CHAT, en = this.EN_ON;
    const split = (x) => T(x).replace(/\.$/, '').split(' ').filter(Boolean).map((t, i) => ({ key: i, t }));
    const e = s.tkErr || {}, bd = (k) => e[k] ? '#C4552F' : '#E8E3D9';
    return {
      kicker: T(C.kicker),
      w1: (en ? 'Want to see GOTCHA' : 'רוצים לראות את GOTCHA').split(' ').map((t, i) => ({ key: i, t })),
      w2: (en ? 'on your conversations?' : 'על השיחות שלכם?').split(' ').map((t, i) => ({ key: i, t })),
      points: (en ? ['20 minutes, on your real channels', 'An honest answer on whether it is worth it', 'A real number, no deck'] : ['20 דקות, על הערוצים האמיתיים שלכם', 'תשובה כנה אם זה שווה לכם', 'מספר אמיתי, בלי מצגת']).map((t, i) => ({ key: i, t })),
      promise: (en ? ['No card', 'No commitment', 'Reply within two hours'] : ['בלי כרטיס אשראי', 'בלי התחייבות', 'חוזרים תוך שעתיים']).map((t, i) => ({ key: i, t })),
      gdpr: en ? 'GDPR compliant' : 'תואמי GDPR',
      stats: C.stats.map((x, i) => ({ key: i, v: T(x.v), l: T(x.l) })),
      formTitle: T(C.formTitle), formNote: T(C.formNote), submitT: T(C.submit), formFoot: T(C.formFoot), demo: T('Or book a demo call'),
      inAlign: en ? 'left' : 'right', phName: T('Your name *'), phPhone: T('Phone *'), phSite: T('Website address *'), phMail: T('Email (optional)'),
      bName: bd('name'), bPhone: bd('phone'), bSite: bd('site'), err: !!s.tkErr,
      errText: en ? 'Please fill in your name, phone and website' : 'צריך למלא שם, טלפון וכתובת אתר',
      sent: !!s.tkSent, notSent: !s.tkSent,
      okTitle: en ? 'Got it, thank you' : 'קיבלנו, תודה',
      okBody: en ? "We'll get back to you today or tomorrow. Want to pick a time right now?" : 'נחזור אליכם היום או מחר. רוצים לקבוע זמן כבר עכשיו?',
      pick: T('Pick a time'), leave: T('Leave your details'),
      clearErr: () => { if (this.state.tkErr) this.setState({ tkErr: null }); },
      submit: (ev) => this.tkSubmit(ev),
      toForm: () => this.tkToForm(),
      waysTitle: T(C.waysTitle), ways: C.ways.map((w, i) => ({ key: i, icon: w.icon, bg: w.bg, ic: w.ic, t: w.call ? (en ? 'Call now' : 'התקשרו עכשיו') : T(w.t), n: T(w.n), cta: w.call ? (en ? 'Call us' : 'חייגו אלינו') : T(w.cta), href: w.call ? (this.PHONE ? 'tel:' + this.PHONE : this.DEMO) : w.href })),
      answersTitle: T(C.answersTitle), answersNote: T(C.answersNote), answersFoot: T(C.answersFoot),
      answers: C.answers.map((a, i) => ({ key: i, t: T(a.t), n: T(a.n) })),
      officeTitle: T(C.officeTitle), office: C.office.map((o, i) => ({ key: i, t: T(o.t), d: T(o.d) })),
      cw: split(C.ctaTitle), ctaBody: T(C.ctaBody)
    };
  }
  tkSubmit(ev) {
    ev.preventDefault();
    const f = ev.currentTarget, v = (n) => String((f.elements[n] || {}).value || '').trim();
    const err = { name: !v('name'), phone: !v('phone'), site: !v('site') };
    const g = window.gsap;
    if (err.name || err.phone || err.site) {
      this.setState({ tkErr: err });
      if (g && !this.reduce) g.fromTo(f, { x: 0 }, { keyframes: { x: [-9, 8, -6, 4, -2, 0] }, duration: 0.5, ease: 'power2.out' });
      return;
    }
    this.setState({ tkSent: true, tkErr: null }, () => requestAnimationFrame(() => {
      if (this.paintIcons) this.paintIcons();
      if (!g || this.reduce) return;
      g.fromTo('[data-tk-ok] > *', { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.09, ease: 'power3.out' });
      g.fromTo('[data-tk-check]', { scale: 0.3 }, { scale: 1, duration: 0.8, ease: 'back.out(2)' });
    }));
  }
  tkToForm() {
    const st = this.tkST, el = document.querySelector('[data-tk-form]');
    let y = 0;
    if (st) y = st.end - 2; else if (el) y = el.getBoundingClientRect().top + window.scrollY - 120;
    if (this.lenis) this.lenis.scrollTo(y, { duration: 1.4 }); else window.scrollTo(0, y);
    setTimeout(() => { const i = document.querySelector('[data-tk-f] input'); if (i) i.focus({ preventScroll: true }); }, 1500);
  }
  WY0 = { fw: [], introD: [], dlabels: [], d0: {}, d1: {}, d2: {}, d3: {}, d4: {}, d5: {}, d6: {}, chans: [], sys: [], perms: [], heavy: [], fitSteps: [], founders: [], bars: [], aw: [], bw: [], workers: [], introW: [], pains: [], p0: { pts: [] }, p1: { pts: [] }, p2: { pts: [] }, qs: [], tabs: [], dots: [], endW: [] };
  whyUrl() { return homeHref('why', this.EN_ON ? 'en' : 'he', this.props && this.props.page); }
  wyVals() {
    const en = this.EN_ON, L = (a, b) => en ? b : a;
    const words = (s, hot, base) => { const a = s.split(' ').filter(Boolean); return a.map((t, i) => ({ key: i, t, c: i >= a.length - (hot || 0) ? '#C4552F' : (base || '#16150F') })); };
    const P = (h2, d) => ({ h: h2, d });
    let sd = 11; const rnd = () => (sd = (sd * 9301 + 49297) % 233280) / 233280;
    return {
      aw: [],
      bw: words(L('למה דווקא GOTCHA?', 'Why GOTCHA?'), 1),
      sub: L('אנחנו מאמינים שה-AI צריך להעצים את העובד, לא להחליף אותו. במקום לשים AI במקום עובדים, אנחנו לוקחים את העובדים, מתאימים להם את הכלים, והם נעשים טובים פי 10', 'We believe AI should empower people, not replace them. Instead of putting AI in place of your team, we take your team, fit the tools to them, and they become 10x better'),
      cta: L('קבעו דמו', 'Book a demo'), arrow: en ? '→' : '←', agent: L('הנציג שלכם', 'Your rep'),
      workers: [
        [L('עונה בוואטסאפ', 'Answers on WhatsApp'), '3%', '4%'], [L('מאתר את ההזמנה', 'Finds the order'), '0%', '42%'], [L('מסכם את השיחה', 'Summarises the call'), '7%', '78%'],
        [L('מעדכן את ה-CRM', 'Updates the CRM'), '70%', '4%'], [L('שולח קישור תשלום', 'Sends a payment link'), '73%', '42%'], [L('קובע פגישה ביומן', 'Books the meeting'), '66%', '78%']
      ].map((k, i) => ({ key: i, t: k[0], x: k[1], y: k[2] })),
      introW: words(L('כשהתקשורת עם הלקוחות מתפרקת, שלושה אנשים משלמים את המחיר', 'When customer communication breaks down, three people pay the price')),
      pains: [L('הלקוח', 'The customer'), L('העובד', 'The employee'), L('העסק', 'The business')].map((who, i) => ({ key: i, who })),
      p0: { who: L('הלקוח', 'The customer'), t: L('מחכה. מסביר שוב. מרגיש כמו מספר', 'Waits. Explains again. Feels like a number'), pts: [
        P('', L('זמני המתנה ארוכים שמייצרים תסכול', 'Long waits that build frustration')),
        P('', L('צריך לחזור על הכול מחדש בכל מעבר בין נציג לנציג או בין ערוץ לערוץ', 'Repeating everything with every handover between reps or channels')),
        P('', L('תחושה של "מספר טיקט" במקום עדיפות', 'Feeling like a "ticket number" instead of a priority'))].map((x, i) => Object.assign({ key: i }, x)) },
      p1: { who: L('העובד', 'The employee'), t: L('עשרה טאבים פתוחים. אפס תמונה מלאה', 'Ten tabs open. Zero full picture'), pts: [
        P(L('עומס ופיצול:', 'Overload:'), L('נפח פניות גבוה ועבודה מול הרבה מערכות במקביל', 'high volume and many systems at once')),
        P(L('עבודה ידנית סיזיפית:', 'Endless manual work:'), L('תיעוד, תמלול וסיכום ידני של כל שיחה', 'logging, transcribing and summarising every conversation by hand')),
        P(L('מידע מפוזר', 'Scattered information'), L('שמחייב מעבר בין אינספור טאבים כדי להבין מי הלקוח', 'that forces endless tab-switching just to know who the customer is'))].map((x, i) => Object.assign({ key: i }, x)) },
      p2: { who: L('העסק', 'The business'), t: L('לידים מתקררים. אין שליטה. העלויות רק עולות', 'Leads go cold. No control. Costs keep rising'), pts: [
        P(L('אובדן הכנסות:', 'Lost revenue:'), L('לידים שמחכים מתקררים והולכים, ולקוחות קיימים נוטשים', 'waiting leads go cold and leave, and existing customers churn')),
        P(L('אפס נראות:', 'Zero visibility:'), L('אין תמונה בזמן אמת על הצוות ועל מצב הלידים', 'no real-time picture of the team or the state of your leads')),
        P(L('כאוס תפעולי:', 'Operational chaos:'), L('נתונים שלא מתעדכנים אוטומטית, וכוח אדם יקר שמנהל עומסים במקום לעבוד', 'data that does not update itself, and expensive people managing load instead of working'))].map((x, i) => Object.assign({ key: i }, x)) },
      wait: L('ממתינה לתשובה', 'Waiting for a reply'),
      qs: [
        ['whatsapp.svg', L('וואטסאפ', 'WhatsApp'), L('איפה ההזמנה שלי?', 'Where is my order?'), '0%', '4%'],
        ['instagram.svg', L('אינסטגרם', 'Instagram'), L('כתבתי כבר בוואטסאפ. איפה ההזמנה שלי?', 'I already wrote on WhatsApp. Where is my order?'), '7%', '27%'],
        ['gmail.svg', L('מייל', 'Email'), L('זו הפעם השלישית שאני שואלת. איפה ההזמנה?', 'This is the third time I am asking. Where is my order?'), '14%', '50%'],
        ['globe.svg', L('צ׳אט באתר', 'Web chat'), L('מישהו פה? אני עדיין מחכה', 'Is anyone there? I am still waiting'), '21%', '73%']
      ].map((b, i) => ({ key: i, logo: '/assets/v8/icons/' + b[0], ch: b[1], t: b[2], r: b[3], y: b[4] })),
      agentB: L('הנציג', 'The rep'),
      tabs: [['Shopify · ' + L('הזמנות', 'Orders'), 2, 6, -6], ['CRM', 40, 0, 4], [L('מייל', 'Email'), 58, 16, -3], [L('וואטסאפ', 'WhatsApp'), 6, 38, 5], [L('גיליון לקוחות', 'Customer sheet'), 30, 32, -7], [L('משלוחים', 'Shipping'), 54, 50, 3], [L('יומן', 'Calendar'), 14, 64, -4], [L('חשבוניות', 'Invoices'), 46, 72, 6]]
        .map((t, i) => ({ key: i, t: t[0], x: t[1] + '%', y: t[2] + '%', r: t[3] + 'deg' })),
      funTop: L('לידים חדשים', 'New leads'), funBottom: L('נסגרו', 'Closed'), funSide: L('התקררו והלכו', 'Went cold'),
      dots: Array.from({ length: 16 }, (_, i) => ({ key: i, st: 'position:absolute;left:' + (31 + rnd() * 36).toFixed(1) + '%;top:' + (7 + rnd() * 5).toFixed(1) + '%;width:14px;height:14px;border-radius:50%;background:' + (i % 4 === 0 ? '#A8C57A' : '#FAF8F4') + ';opacity:0' })),
      fw: words(L('הצוות שלכם כבר טוב. בואו נעשה אותו פי 10', 'Your team is already good. Let us make it 10x'), en ? 2 : 3),
      fSub: L('השאירו פרטים ונחזור אליכם היום או מחר. נראה לכם על העסק שלכם איך הצוות שלכם עובד עם GOTCHA', 'Leave your details and we will get back to you today or tomorrow, and show you how your team works with GOTCHA'),
      introD: words(L('מה עושה אותנו אחרים?', 'What makes us different?'), 1),
      dlabels: [L('כל התקשורת', 'All communication'), L('חיבורים', 'Integrations'), L('שליטה', 'Control'), L('לעסקים צומחים', 'For growing businesses'), L('שינויים מהירים', 'Fast changes'), L('ליווי', 'Hands-on support'), L('תמחור', 'Pricing')].map((t, i) => ({ key: i, t })),
      d0: { k: L('כל התקשורת', 'All communication'), t: L('כל ההודעות. כל השיחות. מקום אחד', 'Every message. Every call. One place'), d: L("אנחנו היחידים שלוקחים את כל התקשורת מקצה לקצה: שיחות טלפון, מיילים, וואטסאפ, אינסטגרם, מסנג'ר וצ'אט באתר. כל הודעה וכל שיחה עוברות דרך GOTCHA", 'We are the only ones who take all of your communication end to end: phone calls, email, WhatsApp, Instagram, Messenger and web chat. Every message and every call runs through GOTCHA') },
      d1: { k: L('חיבורים', 'Integrations'), t: L('מתחבר לכל מה שאתם כבר עובדים איתו', 'Connects to everything you already use'), d: L('לא צריך להחליף מערכות ולא ללמוד הכול מחדש. עובדי ה-AI לא רק קוראים מהמערכות שלכם, הם מעדכנים הזמנות, פותחים החלפות, שולחים קישורי תשלום ומעדכנים את ה-CRM, בתוך המערכות שלכם', 'No new systems to switch to and nothing to relearn. The AI employees do not just read from your systems, they update orders, open exchanges, send payment links and update the CRM, inside your systems') },
      d2: { k: L('שליטה', 'Control'), t: L('אתם רואים הכול. אתם מחליטים הכול', 'You see everything. You decide everything'), d: L('המגע האנושי נשמר בכל רגע. אתם רואים את עובדי ה-AI פועלים בזמן אמת, ומחליטים מה מותר להם לעשות לבד, מה דורש אישור ומה נשאר רק אצלכם', 'The human touch stays at every moment. You watch the AI employees work in real time, and decide what they may do alone, what needs approval and what stays with you') },
      d3: { k: L('לעסקים צומחים', 'For growing businesses'), t: L('בנוי לעסקים קטנים וצומחים', 'Built for small and growing businesses'), d: L('לא מערכת ארגונית שדורשת אינטגרטור, חצי שנה הקמה וצוות IT. מערכת שבנויה בדיוק לגודל שלכם', 'Not an enterprise system that needs an integrator, six months of setup and an IT team. A system built exactly for your size') },
      d4: { k: L('שינויים מהירים', 'Fast changes'), t: L('צריכים שינוי? הוא קורה מהר', 'Need a change? It happens fast'), d: L('עסקים משתנים כל שבוע. אנחנו מעדכנים ומשנים את המערכת מהר ובגמישות, בלי טיקט שמחכה חודש', 'Businesses change every week. We update and adjust the system quickly and flexibly, without a ticket that waits a month') },
      d5: { k: L('ליווי', 'Hands-on support'), t: L('יד ביד, עד שזה עובד', 'Hand in hand, until it works'), d: L("ליווי מלא שלנו לאורך כל הדרך. לא מסמך הוראות ולא צ'אטבוט תמיכה. אנשים אמיתיים שמלווים אתכם עד ההצלחה", 'Full support from us all the way. Not a help document and not a support chatbot. Real people who stay with you until it succeeds') },
      d6: { k: L('תמחור', 'Pricing'), t: L('משלמים לפי הערך שאתם מקבלים', 'You pay for the value you get'), d: L('משתמשים יותר ומפיקים יותר, משלמים יותר. משתמשים פחות, משלמים פחות. וה-ROI החיובי מובטח', 'Use it more and get more from it, pay more. Use it less, pay less. And a positive ROI is guaranteed') },
      chans: [['whatsapp.svg', '6%', '6%'], ['instagram.svg', '40%', '0%'], ['messenger.svg', '78%', '8%'], ['gmail.svg', '0%', '46%'], ['outlook.svg', '84%', '44%'], ['phone.svg', '12%', '80%'], ['globe.svg', '44%', '86%'], ['slack.svg', '76%', '80%']].map((c, i) => ({ key: i, src: '/assets/v8/icons/' + c[0], x: c[1], y: c[2] })),
      chPill: L('כל השיחות, במקום אחד', 'Every conversation, in one place'),
      sys: [['Shopify', '/assets/v8/icons/shopify.svg', 50, 8, true], ['WooCommerce', '/assets/v8/icons/woo.png', 84, 22], ['HubSpot', '', 92, 56], ['Monday', '', 80, 82], ['Stripe', '', 20, 82], ['Google Calendar', '', 8, 56], ['Salesforce', '', 16, 22], ['Calendly', '', 50, 78]]
        .map((s, i) => ({ key: i, t: s[0], src: s[1], noSrc: !s[1], x: s[2] + '%', y: s[3] + '%', ok: !!s[4] })),
      act: L('הזמנה #1842 עודכנה', 'Order #1842 updated'),
      sysMore: L('ועוד Pipedrive, Fireberry, Zoho, Airtable, PayPal', 'and Pipedrive, Fireberry, Zoho, Airtable, PayPal'),
      permT: L('מה מותר לעובדי ה-AI', 'What the AI employees may do'),
      perms: [[L('לאתר הזמנה ולבדוק מלאי', 'Find an order, check stock'), L('לבד', 'On its own'), '#3F6323'], [L('זיכוי מעל הגבול שקבעתם', 'A refund above your limit'), L('דורש אישור', 'Needs approval'), '#B07A1A'], [L('שינוי פרטי לקוח', 'Change customer details'), L('רק אצלכם', 'Only you'), '#16150F']].map((p, i) => ({ key: i, k: p[0], v: p[1], c: p[2] })),
      waitT: L('עובד AI · ממתין לאישור שלכם', 'AI employee · waiting for your approval'), waitD: L('זיכוי מעל הגבול לדנה כהן', 'A refund above the limit for Dana Cohen'), approve: L('אישור', 'Approve'), approved: L('אושר', 'Approved'),
      heavy: [['user-cog', L('אינטגרטור', 'An integrator')], ['calendar-clock', L('חצי שנה הקמה', 'Six months of setup')], ['server', L('צוות IT', 'An IT team')]].map((x, i) => ({ key: i, icon: x[0], t: x[1] })),
      fitT: L('GOTCHA, בגודל שלכם', 'GOTCHA, at your size'),
      fitSteps: [['plug', L('מחברים את הערוצים והמערכות', 'Connect your channels and systems')], ['book-open', L('היא לומדת את העסק', 'It learns your business')], ['zap', L('מתחילה לעבוד', 'It starts working')]].map((f, i) => ({ key: i, icon: f[0], t: f[1] })),
      chgT: L('צוות GOTCHA', 'The GOTCHA team'), chg1: L('אפשר שהיא תשאל על מידה לפני כל החזרה?', 'Can it ask about size before every return?'), chg2: L('בטח, אנחנו על זה', 'Sure, we are on it'), chgWip: L('בעבודה', 'In progress'), chgDone: L('בוצע ועודכן במערכת', 'Done and live in the system'),
      founders: [['/assets/v8/team/founder-1.png', L('מתן', 'Matan')], ['/assets/v8/team/founder-2.jpg', L('עומר', 'Omer')]].map((f, i) => ({ key: i, src: f[0], n: f[1], r: L('מייסד', 'Co-founder') })),
      useL: L('שימוש', 'Usage'), payL: L('מחיר', 'Price'),
      bars: [[22, 18], [34, 28], [46, 38], [58, 48], [74, 60], [90, 74]].map((b, i) => ({ key: i, u: b[0] + '%', p: b[1] + '%' })),
      roi: L('ROI חיובי מובטח', 'Positive ROI guaranteed'),
      endW: words(L('זו לא בעיה של עוד בוט. זו בעיה של תהליך שבור', 'This is not a bot problem. It is a broken process'), en ? 2 : 2, '#FAF8F4')
    };
  }
  async initWhy() {
    const root = document.documentElement;
    const fail = () => { root.classList.remove('fx'); root.classList.add('nofx'); };
    if (this.reduce) { fail(); return; }
    try {
      if (!window.gsap) await loadVendor('gsap');
      if (!window.ScrollTrigger) await loadVendor('ScrollTrigger');
      if (!window.Lenis) await loadVendor('Lenis');
    } catch (e) { fail(); return; }
    for (let i = 0; i < 80 && !(document.querySelectorAll('[data-wz-scn]').length === 3 && document.querySelectorAll('[data-wd-scn]').length === 7 && document.querySelectorAll('[data-wzb]').length >= 2 && document.querySelectorAll('[data-wz-dot]').length >= 12); i++) await new Promise(r => setTimeout(r, 100));
    if (this.dead || !root.classList.contains('fx')) return;
    window.__gHomeReady = true;
    const gsap = window.gsap, ST = window.ScrollTrigger;
    gsap.registerPlugin(ST);
    this.pvo = () => root.getAttribute('data-pv') === 'desktop' ? 52 : 0;
    this.lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    this.lenis.on('scroll', ST.update);
    this.lenisRaf = (t) => this.lenis && this.lenis.raf(t * 1000);
    gsap.ticker.add(this.lenisRaf);
    gsap.ticker.lagSmoothing(0);
    if (this.pvPhone) this.lenis.stop();
    gsap.set('[data-wzb]', { y: 0, yPercent: 115 });
    gsap.to('[data-wzb]', { y: 0, yPercent: 0, duration: 1.05, stagger: 0.08, ease: 'power3.out', delay: 0.15 });
    this.wyMM = gsap.matchMedia();
    this.wyMM.add({ desk: '(min-width: 861px)', mob: '(max-width: 860px)' }, (ctx) => { this.buildWhy(gsap, ST, ctx.conditions.desk); return () => { document.querySelectorAll('[data-wz-b],[data-wz-scn],[data-wd-scn]').forEach(e => { e.style.scale = ''; }); }; });
    const sec = document.querySelector('[data-wy-human]'), veil = document.querySelector('[data-wy-veil]');
    this.updDark = () => {
      if (!sec || !veil) return;
      const r = sec.getBoundingClientRect(), vh = window.innerHeight, c = (v) => Math.min(1, Math.max(0, v));
      const d = c((vh * 0.85 - r.top) / (vh * 0.5)) * (1 - c((vh * 0.8 - r.bottom) / (vh * 0.5)));
      veil.style.opacity = d.toFixed(3);
      root.toggleAttribute('data-dark', d > 0.5);
    };
    this.lenis.on('scroll', this.updDark);
    ST.addEventListener('refresh', this.updDark);
    this.updDark();
    const remq = () => { if (this.dead) return; gsap.matchMediaRefresh(); ST.refresh(); };
    this.onAnimResize = () => { clearTimeout(this.remqT); this.remqT = setTimeout(remq, 220); };
    window.addEventListener('resize', this.onAnimResize);
    setTimeout(remq, 700);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remq);
  }
  buildWhyD(gsap, desk) {
    const q = (s) => document.querySelector(s), qa = (s) => gsap.utils.toArray(s);
    const rtl = getComputedStyle(q('[data-site="main"]')).direction === 'rtl', sg = rtl ? 1 : -1;
    const scns = qa('[data-wd-scn]'), pg = qa('[data-wd-pg]'), units = q('[data-wd-units]');
    const center = (el, box) => { const a = el.getBoundingClientRect(), b = box.getBoundingClientRect(); return { x: a.left + a.width / 2 - b.left, y: a.top + a.height / 2 - b.top }; };
    const lay = () => {
      const box = q('[data-wd-int]'); if (!box) return;
      const sys = qa('[data-wd-sys]'), lines = qa('[data-wd-line]'), w = box.clientWidth, hh = box.clientHeight, cx = w / 2, cy = hh / 2;
      sys.forEach((s, i) => { const tx = parseFloat(s.style.left) / 100 * w, ty = parseFloat(s.style.top) / 100 * hh, dx = tx - cx, dy = ty - cy; const L = lines[i]; if (L) { L.style.width = Math.hypot(dx, dy).toFixed(1) + 'px'; L.style.rotate = (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2) + 'deg'; } });
    };
    if (!desk) {
      lay();
      scns.forEach(el => gsap.fromTo(el, { opacity: 0, y: 46 }, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true } }));
      gsap.set('[data-wd-ton]', { opacity: 1 }); gsap.set('[data-wd-knob]', { x: rtl ? -20 : 20 });
      gsap.to('[data-wdw]', { y: 0, yPercent: 0, duration: 0.9, stagger: 0.07, ease: 'power3.out', scrollTrigger: { trigger: '[data-wd-intro]', start: 'top 80%', once: true } });
      return;
    }
    const pfit = () => scns.forEach(u => { u.style.scale = ''; const v = u.children[1]; const need = Math.max(u.children[0].offsetHeight, v.offsetHeight, v.scrollHeight); const k = Math.min(1, units.clientHeight / Math.max(1, need)); u.style.scale = k < 1 ? Math.max(0.62, k).toFixed(4) : ''; });
    const S = 1.3, A = (i) => 1.0 + i * S, N = scns.length;
    const t = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: this.pinST(q('[data-wd-stage]'), 8.6, { start: () => { pfit(); lay(); return 'top ' + this.pvo() + 'px'; } }) });
    t.fromTo('[data-wdw]', { y: 0, yPercent: 115 }, { y: 0, yPercent: 0, duration: 0.35, stagger: 0.07, ease: 'power3.out', immediateRender: true }, 0.05)
      .to('[data-wd-intro]', { opacity: 0, scale: 0.9, y: -40, duration: 0.3, ease: 'power2.in' }, 0.7)
      .fromTo('[data-wd-bar]', { opacity: 0, y: -12 }, { opacity: 1, y: 0, duration: 0.25 }, 0.85);
    scns.forEach((u, i) => {
      const at = A(i), txt = u.children[0], vis = u.children[1];
      t.fromTo(u, { opacity: 0, y: 0 }, { opacity: 1, duration: 0.1 }, at)
        .fromTo(txt.children, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.08, ease: 'power3.out' }, at)
        .fromTo(vis, { opacity: 0, rotationX: 14, y: 60, transformPerspective: 1400 }, { opacity: 1, rotationX: 0, y: 0, duration: 0.45, ease: 'power3.out' }, at + 0.05)
        .fromTo(pg[i], { scaleX: 0 }, { scaleX: 1, duration: S - 0.1 }, at);
      if (i < N - 1) t.to(u, { opacity: 0, y: -40, duration: 0.22, ease: 'power2.in' }, at + S - 0.24);
    });
    // all communication: icons in, then sucked into the logo
    const ch = q('[data-wd-ch]'), core = q('[data-wd-core]'), chi = qa('[data-wd-chi]');
    t.fromTo(chi, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.15, stagger: 0.04, ease: 'back.out(2)' }, A(0) + 0.15);
    chi.forEach((c, j) => t.to(c, { x: () => center(core, ch).x - (c.offsetLeft + c.offsetWidth / 2), y: () => center(core, ch).y - (c.offsetTop + c.offsetHeight / 2), scale: 0.3, opacity: 0, duration: 0.3, ease: 'power3.in' }, A(0) + 0.55 + j * 0.03));
    t.fromTo(core, { scale: 1 }, { scale: 1.14, duration: 0.12, ease: 'power2.out' }, A(0) + 0.82).to(core, { scale: 1, duration: 0.18, ease: 'power2.inOut' }, A(0) + 0.94)
      .fromTo('[data-wd-pill]', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.2, ease: 'power3.out' }, A(0) + 0.9);
    // integrations: tiles, lines, an action travels to Shopify
    const box = q('[data-wd-int]'), act = q('[data-wd-act]'), sys0 = q('[data-wd-sys]');
    t.fromTo(qa('[data-wd-sys]'), { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.15, stagger: 0.04, ease: 'back.out(2)' }, A(1) + 0.15)
      .fromTo(qa('[data-wd-line]'), { scaleX: 0 }, { scaleX: 1, duration: 0.2, stagger: 0.04 }, A(1) + 0.3)
      .fromTo(act, { opacity: 0, x: 0, y: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.1 }, A(1) + 0.62)
      .to(act, { x: () => center(sys0, box).x - box.clientWidth / 2, y: () => center(sys0, box).y - box.clientHeight / 2 + 46, duration: 0.3, ease: 'power2.inOut' }, A(1) + 0.72)
      .fromTo('[data-wd-okb]', { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, duration: 0.12, ease: 'back.out(2.4)' }, A(1) + 1.0);
    // control: toggles flip, AI waits, approved
    const knobs = qa('[data-wd-knob]'), tons = qa('[data-wd-ton]');
    t.fromTo('[data-wd-perm]', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.25, ease: 'power3.out' }, A(2) + 0.12);
    knobs.forEach((k, j) => { t.fromTo(k, { x: 0 }, { x: rtl ? -20 : 20, duration: 0.12, ease: 'power2.out' }, A(2) + 0.35 + j * 0.12).fromTo(tons[j], { opacity: 0 }, { opacity: 1, duration: 0.12 }, A(2) + 0.35 + j * 0.12); });
    t.fromTo('[data-wd-wait]', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.25, ease: 'power3.out' }, A(2) + 0.72)
      .to('[data-wd-appr]', { scale: 0.92, duration: 0.06 }, A(2) + 0.98).to('[data-wd-appr]', { opacity: 0, scale: 1, duration: 0.1 }, A(2) + 1.04)
      .fromTo('[data-wd-done]', { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.12, ease: 'back.out(2)' }, A(2) + 1.04);
    // growing businesses: heavy setup fades, GOTCHA fits
    t.fromTo(qa('[data-wd-hv]'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.15, stagger: 0.08 }, A(3) + 0.15)
      .to(qa('[data-wd-hv]'), { opacity: 0.25, scale: 0.94, duration: 0.2, stagger: 0.05 }, A(3) + 0.55)
      .fromTo('[data-wd-fit]', { opacity: 0, y: 40, rotationX: 12, transformPerspective: 1200 }, { opacity: 1, y: 0, rotationX: 0, duration: 0.3, ease: 'power3.out' }, A(3) + 0.6)
      .fromTo(qa('[data-wd-fs]'), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.14, stagger: 0.08 }, A(3) + 0.8);
    // fast changes
    const cms = qa('[data-wd-cm]');
    t.fromTo(cms, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.16, stagger: 0.18, ease: 'power3.out' }, A(4) + 0.2)
      .to('[data-wd-s1]', { opacity: 0, duration: 0.1 }, A(4) + 0.9)
      .fromTo('[data-wd-s2]', { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.14, ease: 'back.out(2)' }, A(4) + 0.9);
    // founders enter from the sides with a tilt that straightens
    const fds = qa('[data-wd-fd]');
    fds.forEach((f, j) => t.fromTo(f, { opacity: 0, x: (j ? -1 : 1) * sg * 120, rotation: (j ? -1 : 1) * sg * 7 }, { opacity: 1, x: 0, rotation: 0, duration: 0.4, ease: 'power3.out' }, A(5) + 0.15 + j * 0.1));
    // pricing: usage and price rise together
    t.fromTo(qa('[data-wd-col]'), { scaleY: 0 }, { scaleY: 1, duration: 0.18, stagger: 0.05, ease: 'power3.out' }, A(6) + 0.2)
      .fromTo('[data-wd-roi]', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.2, ease: 'power3.out' }, A(6) + 0.75)
      .to({}, { duration: 0.5 }, A(6) + 1.1);
  }
  buildWhy(gsap, ST, desk) {
    const q = (s) => document.querySelector(s), qa = (s) => gsap.utils.toArray(s), vh = () => window.innerHeight;
    const rtl = getComputedStyle(q('[data-site="main"]')).direction === 'rtl', sg = rtl ? 1 : -1;
    const rise = (el) => gsap.fromTo(el, { opacity: 0, y: 44 }, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true, refreshPriority: -1 } });
    const hero = q('[data-wz-hero]'), bcol = q('[data-wz-b]'), aw = q('[data-wz-aw]'), wks = qa('[data-wz-wk]'), dots = qa('[data-wz-dot]');
    gsap.set('[data-wdw]', { y: 0, yPercent: 115 });
    const title = q('[data-wz-title]');
    if (desk) {
      const fitB = () => { bcol.style.scale = ''; const k = Math.min(1, (hero.clientHeight - 6) / Math.max(1, bcol.scrollHeight)); bcol.style.scale = k < 1 ? Math.max(0.6, k).toFixed(4) : ''; };
      const T0 = () => { const k = parseFloat(bcol.style.scale || 1); const k0 = Math.min(1.7, (hero.clientWidth * 0.86) / Math.max(1, title.offsetWidth * k)); const cy = hero.clientHeight * 0.5, top = (title.offsetTop * k) + bcol.offsetTop; return { s: k0, y: (cy - top - (title.offsetHeight * k * k0) / 2) / k }; };
      let t0 = { s: 1.5, y: 200 };
      gsap.set(title, { scale: () => t0.s, y: () => t0.y });
      gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: this.pinST(hero, 1.3, { start: () => { fitB(); t0 = T0(); return 'top ' + this.pvo() + 'px'; } }) })
        .fromTo(title, { scale: () => t0.s, y: () => t0.y }, { scale: 1, y: 0, duration: 0.6, ease: 'power2.inOut', immediateRender: true }, 0.1)
        .fromTo(['[data-wz-sub]', '[data-wz-cta]'], { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.08, ease: 'power3.out' }, 0.55)
        .to({}, { duration: 0.4 }, 0.95);

      const ps = q('[data-wz-pstage]'), units = q('[data-wz-units]'), scns = qa('[data-wz-scn]'), pg = qa('[data-wz-pg]');
      const pfit = () => scns.forEach(u => { u.style.scale = ''; const need = Math.max(u.children[0].offsetHeight, u.children[1].offsetHeight); const k = Math.min(1, units.clientHeight / Math.max(1, need)); u.style.scale = k < 1 ? Math.max(0.7, k).toFixed(4) : ''; });
      const t = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: this.pinST(ps, 6.4, { start: () => { pfit(); return 'top ' + this.pvo() + 'px'; } }) });
      t.to(qa('[data-wz-lw]'), { opacity: 1, duration: 0.15, stagger: { amount: 0.8 } }, 0.05)
        .to('[data-wz-intro]', { opacity: 0, scale: 1.06, duration: 0.3, ease: 'power2.in' }, 1.1)
        .fromTo('[data-wz-bar]', { opacity: 0, y: -12 }, { opacity: 1, y: 0, duration: 0.25 }, 1.25);
      const S = 1.5, A = (i) => 1.4 + i * S;
      scns.forEach((u, i) => {
        const at = A(i), txt = u.children[0], vis = u.children[1];
        t.fromTo(u, { opacity: 0, y: 0, scale: 1 }, { opacity: 1, duration: 0.12 }, at)
          .fromTo(txt.children, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.3, stagger: 0.08, ease: 'power3.out' }, at)
          .fromTo(u.querySelectorAll('[data-wz-pt]'), { opacity: 0, x: sg * 30 }, { opacity: 1, x: 0, duration: 0.2, stagger: 0.1, ease: 'power3.out' }, at + 0.3)
          .fromTo(vis, { opacity: 0, rotationY: sg * 18, x: -sg * 60, transformPerspective: 1200 }, { opacity: 1, rotationY: 0, x: 0, duration: 0.45, ease: 'power3.out' }, at + 0.05)
          .fromTo(pg[i], { scaleX: 0 }, { scaleX: 1, duration: S - 0.1 }, at);
        if (i < scns.length - 1) t.to(u, { opacity: 0, y: -40, duration: 0.22, ease: 'power2.in' }, at + S - 0.25);
      });
      t.fromTo('[data-wz-clock]', { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.25, ease: 'back.out(1.8)' }, A(0) + 0.15)
        .fromTo('[data-wz-mh]', { rotation: 0 }, { rotation: 900, duration: 1.2 }, A(0) + 0.15)
        .fromTo('[data-wz-hh]', { rotation: 0 }, { rotation: 75, duration: 1.2 }, A(0) + 0.15)
        .fromTo(qa('[data-wz-q]'), { opacity: 0, y: 40, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.22, stagger: 0.24, ease: 'power3.out' }, A(0) + 0.2)
        .fromTo(qa('[data-wz-tab]'), { opacity: 0, y: 160, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.24, stagger: 0.1, ease: 'power3.out' }, A(1) + 0.2)
        .fromTo('[data-wz-ag]', { opacity: 1, scale: 1 }, { opacity: 0.25, scale: 0.92, duration: 0.3 }, A(1) + 0.9);
      const fun = q('[data-wz-fun]');
      dots.forEach((d, j) => {
        const st = A(2) + 0.25 + (j % 8) * 0.07 + Math.floor(j / 8) * 0.32, sd = j % 2 ? 1 : -1;
        t.fromTo(d, { opacity: 0, x: 0, y: -20 }, { opacity: 1, y: 0, duration: 0.08 }, st);
        if (j % 4 === 0) t.to(d, { x: () => fun.clientWidth * 0.5 - d.offsetLeft - 7 + ((j % 3) - 1) * 14, y: () => fun.clientHeight * 0.84 - d.offsetTop, duration: 0.42, ease: 'power2.in' }, st + 0.08);
        else t.to(d, { x: () => sd * fun.clientWidth * (0.3 + (j % 3) * 0.04), y: () => fun.clientHeight * (0.4 + (j % 3) * 0.08) - d.offsetTop, duration: 0.28, ease: 'power2.out' }, st + 0.08)
          .to(d, { y: () => fun.clientHeight * 1.05 - d.offsetTop, opacity: 0, duration: 0.3, ease: 'power2.in' }, st + 0.36);
      });
      t.to({}, { duration: 0.35 }, A(3) - 0.1);
    } else {
      ['[data-wz-sub]', '[data-wz-cta]'].forEach(s => rise(q(s)));
      gsap.to(qa('[data-wz-lw]'), { opacity: 1, ease: 'none', stagger: 0.1, scrollTrigger: { trigger: '[data-wz-intro]', start: 'top 75%', end: 'bottom 45%', scrub: 0.6 } });
      qa('[data-wz-scn]').forEach(el => rise(el));
      gsap.set(dots, { opacity: 1 });
    }
    this.buildWhyD(gsap, desk);
    gsap.set('[data-wfw]', { y: 0, yPercent: 115 });
    gsap.to('[data-wfw]', { y: 0, yPercent: 0, duration: 1, stagger: 0.07, ease: 'power3.out', scrollTrigger: { trigger: '[data-wf]', start: 'top 70%', once: true } });
    gsap.fromTo('[data-wf-sub]', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.9, delay: 0.4, ease: 'power3.out', scrollTrigger: { trigger: '[data-wf]', start: 'top 70%', once: true } });
    gsap.fromTo('[data-wf-card]', { opacity: 0, y: 80, rotationY: (rtl ? -1 : 1) * 16, transformPerspective: 1400 }, { opacity: 1, y: 0, rotationY: 0, duration: 1.1, delay: 0.25, ease: 'power3.out', scrollTrigger: { trigger: '[data-wf]', start: 'top 70%', once: true } });
  }
  PR0 = { cyc: [], cur: [], plans: [], faqs: [], cmpPlans: [], cmpGroups: [], how: [], cuBullets: [] };
  prVals() {
    const en = this.EN_ON, L = (a, b) => en ? b : a, s = this.state;
    const cur = s.prCur || 'usd', yr = !!s.prYr;
    const TIERS = [10, 25, 50, 100, 200], CP = [39, 69, 119, 189, 329], AI = [97, 189, 309, 519, 889];
    const CALL = [[229, 341, 486, 745, 1207], [322, 434, 579, 838, 1300], [442, 554, 699, 958, 1420], [647, 759, 904, 1163, 1625], [1017, 1129, 1274, 1533, 1995]];
    const nis = (v) => { const x = v * 3.1; return x < 1000 ? Math.round(x / 10) * 10 - 1 : Math.round(x / 50) * 50 - 1; };
    const money = (v) => { const m = cur === 'ils' ? nis(v) : v; const t = yr ? m * 12 : m; return (cur === 'ils' ? '₪' : '$') + t.toLocaleString('en-US'); };
    const ix = { pcp: s.pcp || 0, pai: s.pai || 0, ccp: s.ccp || 0, cai: s.cai || 0 };
    const slider = (k, unit, label, dark) => ({ key: k, value: String(TIERS[ix[k]]), unit, label, index: ix[k], accent: dark ? '#E8946E' : '#C4552F', muted: dark ? '#B8B3AA' : '#5B564D',
      set: (e) => this.setState({ [k]: parseInt(e.target.value, 10) }),
      ticks: TIERS.map((t, i) => ({ key: i, t: String(t), c: i === ix[k] ? (dark ? '#FAF8F4' : '#16150F') : (dark ? '#6E6A62' : '#B4AFA5') })) });
    const chat = L('שיחות צ׳אט ביום עסקים', 'chat conversations a business day');
    const vat = L('לא כולל מע״מ 18%', 'excluding 18% VAT');
    const per = yr ? L('לשנה', '/ year') : L('לחודש', '/ month');
    const gift = L('חודש ראשון מתנה', 'First month free');
    const offer = this.pageUrl('offer');
    const light = { bg: '#FFFFFF', bd: '#E4DFD4', fg: '#16150F', muted: '#5B564D', rule: '#EFEAE1', dot: '#C4552F', btnBg: '#16150F', btnFg: '#FAF8F4', btnBd: '#16150F', giftBg: '#FBEEE8', giftFg: '#8E3418', shadow: '0 1px 2px rgba(22,21,15,.05),0 30px 60px -36px rgba(22,21,15,.35)' };
    const dark = { bg: '#16150F', bd: '#16150F', fg: '#FAF8F4', muted: '#B8B3AA', rule: '#2A2925', dot: '#E8946E', btnBg: '#C4552F', btnFg: '#FFFFFF', btnBd: '#C4552F', giftBg: '#FAF8F4', giftFg: '#8E3418', shadow: '0 60px 120px -50px rgba(22,21,15,.6)' };
    const feats = (a) => a.map((f, i) => ({ key: i, t: L(f[0], f[1]) }));
    const plans = [
      Object.assign({}, light, { key: 'cp', name: 'Co-Pilot', hasBadge: false, badge: '',
        who: L('AI לצד הצוות שלכם: מכין כל תשובה, והנציגים מנהלים את השירות והמכירה', 'AI beside your team: it prepares every reply, and your agents run the service and the sales'),
        price: money(CP[ix.pcp]), per, sub: L(TIERS[ix.pcp] + ' משתמשי Co-Pilot', TIERS[ix.pcp] + ' Co-Pilot users') + ' · ' + vat,
        sliders: [slider('pcp', chat, L('משתמשי Co-Pilot', 'Co-Pilot users'), false)], featHead: L('כולל', 'Includes'),
        feats: feats([['תיבה אחת לכל הערוצים והודעות תפוצה', 'Multichannel unified inbox and broadcasts'], ['אוטומציות, ניתוב חכם ומרכז שליטה', 'Automations, AI routing and the command centre'], ['Copilot שמנסח כל תשובה לנציגים', 'Copilot drafting every reply for your agents'], ['סיכומי שיחה ישירות ל־CRM', 'Conversation summaries into your CRM'], ['מאגר ידע ותמונה מלאה של כל לקוח', 'Knowledge base and the full customer picture']]),
        cta: L('התחילו בחינם', 'Start free'), hasGift: true, gift, href: offer }),
      Object.assign({}, dark, { key: 'ai', name: 'AI Team', hasBadge: true, badge: L('רוב העסקים', 'Most businesses'),
        who: L('עובדי AI שמטפלים בשירות, בעבודת Copilot ובמשימות של הצוות, מקצה לקצה', 'AI employees that handle service, copilot work and tasks for your team, end to end'),
        price: money(AI[ix.pai]), per, sub: L(TIERS[ix.pai] + ' עובדי AI', TIERS[ix.pai] + ' AI employees') + ' · ' + vat,
        sliders: [slider('pai', chat, L('עובדי AI', 'AI employees'), true)], featHead: L('כל מה שב־Co-Pilot, ועוד', 'Everything in Co-Pilot, plus'),
        feats: feats([['עובדי AI שעונים ופועלים בעצמם', 'AI employees answering and acting on their own'], ['עצמאות לכל פעולה: להציע, לשאול או לבצע', 'Autonomy set per action: suggest, ask, or do it'], ['עבודת בק אופיס שנעשית בשבילכם', 'Back office work done for you, not just replies'], ['פעולות בתוך Shopify, ה־CRM והכלים שלכם', 'Actions inside Shopify, your CRM and your tools'], ['אנליטיקה שמראה את הסיבה, לא רק את הכמות', 'Analytics that name the cause, not just the volume']]),
        cta: L('התחילו בחינם', 'Start free'), hasGift: true, gift, href: offer }),
      Object.assign({}, light, { key: 'call', name: 'Call Pilot', hasBadge: false, badge: '',
        who: L('שניהם יחד, כולל טלפון: בוחרים נפח צ׳אט ונפח שיחות קוליות', 'Both together, with the phone included: pick your chat volume and your voice volume'),
        price: money(CALL[ix.ccp][ix.cai]), per, sub: L(TIERS[ix.ccp] + ' משתמשים · ' + TIERS[ix.cai] + ' עובדי AI', TIERS[ix.ccp] + ' users · ' + TIERS[ix.cai] + ' AI employees') + ' · ' + vat,
        sliders: [slider('ccp', chat, L('משתמשי Co-Pilot', 'Co-Pilot users'), false), slider('cai', L('שיחות טלפון ביום עסקים', 'voice calls a business day'), L('עובדי AI בטלפון', 'AI employees on the phone'), false)],
        featHead: L('כל מה שב־AI Team, ועוד', 'Everything in AI Team, plus'),
        feats: feats([['Call Pilot בשיחות טלפון בזמן אמת', 'Call Pilot live on phone calls'], ['תמלול, היסטוריית הלקוח ופעולות תוך כדי שיחה', 'Transcript, caller history and actions while you talk'], ['המשפט הבא להגיד, מוכן תוך כדי השיחה', 'The next line to say, prepared as the call runs'], ['מחיר אחד לצ׳אט ולטלפון יחד', 'One price for chat and voice together']]),
        cta: L('דברו איתנו', 'Talk to us'), hasGift: false, gift: '', href: this.talkUrl() })
    ];
    const bases = [CP[ix.pcp], AI[ix.pai], CALL[ix.ccp][ix.cai]], ISO = (x) => '\u2066' + x + '\u2069';
    plans.forEach((p, i) => { const sym = cur === 'ils' ? '₪' : '$', m = cur === 'ils' ? nis(bases[i]) : bases[i], full = m * 12, disc = Math.round(full * 0.85 / 10) * 10 - 1, f = (n) => sym + n.toLocaleString('en-US');
      p.hasSave = false; p.was = f(full); p.off = L('15% הנחה', '15% off');
      p.save = L('חוסכים ' + ISO(f(full - disc)) + ' בשנה', 'You save ' + f(full - disc) + ' a year');
      p.monthEq = L('יוצא ' + ISO(f(Math.round(disc / 12))) + ' לחודש במקום ' + ISO(f(m)), 'Works out to ' + f(Math.round(disc / 12)) + ' a month instead of ' + f(m));
      p.saveBg = i === 1 ? '#2A2520' : '#E7F0D4'; p.saveFg = i === 1 ? '#F3C9B4' : '#3F6323'; p.offBg = '#C4552F'; });
    const seg = (on) => on ? '#16150F' : 'transparent', segF = (on) => on ? '#FAF8F4' : '#5B564D';
    const FQ = [
      ['מה זה קרדיט?', 'What is a credit?', 'קרדיט הוא היחידה שבה GOTCHA מודדת עבודת AI. קריאת הודעה, ניסוח תשובה, שליפת ידע, עדכון ה־CRM וסיכום שיחה מורידים מהיתרה. זו היחידה היחידה שבה מחייבים אתכם', 'A credit is how GOTCHA measures AI work. Reading a message, drafting a reply, retrieving knowledge, updating your CRM and summarising a conversation all draw on your balance. Credits are the only unit you are billed in'],
      ['מה קורה כשהקרדיטים נגמרים?', 'What happens when credits run out?', 'פעולות ה־AI נעצרות עד שמוסיפים קרדיטים. התיבה המשותפת, היסטוריית השיחות והנציגים ממשיכים לעבוד, ושום מידע לא נמחק. אפשר לקנות קרדיטים או להפעיל טעינה אוטומטית', 'AI actions stop until credits are added. Your shared inbox, conversation history and human agents keep working, and no data is removed. You can buy credits or enable automatic top up'],
      ['אפשר לקנות קרדיטים בלי להחליף חבילה?', 'Can I buy extra credits without changing plan?', 'כן. חבילות קרדיטים נוספות מתווספות ליתרה ונשארות בה עד שמשתמשים בהן. הקרדיטים של החבילה תמיד מנוצלים קודם', 'Yes. Prepaid credit packages are added to your balance and stay there until consumed. Included plan credits are always used first'],
      ['מה קורה כשמשדרגים או מורידים חבילה?', 'What happens when I upgrade or downgrade?', 'שדרוג נכנס לתוקף מיד, ומשלמים רק את ההפרש היחסי עד סוף התקופה. הורדת חבילה נכנסת לתוקף רק בתאריך החידוש, ועד אז הכול נשאר כמו שהוא', 'An upgrade starts immediately and you pay the prorated difference for the rest of the period. A downgrade only starts at renewal, and nothing changes before then'],
      ['מה קורה אם מבטלים?', 'What happens if I cancel?', 'הביטול נכנס לתוקף בסוף תקופת החיוב הנוכחית. הגישה נשארת מלאה עד תאריך החידוש, ואפשר לחזור בכם לפניו. המידע שלכם לא נמחק', 'Cancellation takes effect at the end of the current billing period. You keep full access until your renewal date and can resume before it. Your data is not deleted'],
      ['באיזה מטבע המחירים?', 'Which currency are the prices in?', 'המחירים נקבעים בדולר. המחיר בשקלים מחושב בהמרה ומעוגל, ומוצג להערכה. המטבע שבו תחויבו מופיע לפני האישור', 'Prices are set in US dollars. Shekel amounts are a conversion, rounded, and shown as an estimate. The currency you are charged in is shown before you confirm'],
      ['איך מחושבת הערכת השיחות?', 'How are conversation estimates calculated?', 'לכל חבילה יש הנחה מסחרית לגבי כמה קרדיטים שיחה ממוצעת צורכת וכמה ימי עסקים יש בחודש. ההערכה מחלקת את מכסת הקרדיטים בהנחה הזו. היא מתארת את הגדרת החבילה, לא מדידה של שימוש של מישהו', 'Each plan is configured with a commercial assumption about how many credits an average conversation uses and how many business days a month contains. The estimate divides the allowance by that assumption. It describes the plan, not anyone\'s measured usage'],
      ['השימוש שלי יתאים להערכה?', 'Will my usage match the estimate?', 'לא בדיוק. הצריכה בפועל משתנה לפי אורך השיחה, הערוץ, פעולות ה־AI, היכולות שהופעלו ומשך השיחות הקוליות. ההערכה נועדה לבחור גודל, לא לחזות חשבון', 'Not exactly. Actual consumption varies by conversation length, channel, AI actions, enabled features and voice duration. The estimate is there to size a plan, not to predict a bill'],
      ['איך עובדת טעינה אוטומטית?', 'How does automatic top up work?', 'אתם בוחרים מתי היא מופעלת, כמה היא קונה ותקרת הוצאה חודשית. כשמגיעים לתקרה לא מחויב שום דבר נוסף, ואתם מקבלים התראה כדי להחליט מה הלאה', 'You choose when it triggers, how much it buys and a monthly spending limit. Once the limit is reached nothing further is charged, and you are notified so you can decide'],
      ['יש תקופת ניסיון או פיילוט?', 'Do you offer a trial or a pilot?', 'ניסיונות ופיילוטים נקבעים מול הצוות שלנו, כדי שתקציב הקרדיטים והמשך יתאימו למה שאתם רוצים לבדוק. כרגע החודש הראשון מתנה ל־50 העסקים הראשונים', 'Trials and pilots are arranged with our team, so the credit budget and duration match what you want to evaluate. Right now the first month is free for the first 50 businesses'],
      ['אפשר לקבל חבילה מותאמת?', 'Can we get a custom plan?', 'כן. בחבילה מותאמת קובעים את היכולות, המגבלות, הקרדיטים ונפחי הצ׳אט והטלפון, בתנאים שסוגרים איתכם', 'Yes. Custom plans set their own capabilities, limits, credit allocation and chat and voice volumes, with terms agreed with you']
    ];
    const fq = s.prFaq == null ? 0 : s.prFaq;
    return {
      kicker: L('תמחור', 'Pricing'), giftPill: L('חודש ראשון מתנה, ל־50 העסקים הראשונים', 'First month free, for the first 50 businesses'),
      h1: L('משלמים לפי הערך שאתם מקבלים', 'You pay for the value you get'),
      sub: L('כל חבילה כוללת תיבה אחת לכל הערוצים, חיבור לחנות ולמערכות וה־AI שמבין את העסק שלכם. הזיזו את הסרגל לגודל של העסק', 'Every plan includes one inbox for every channel, the connection to your store and systems, and the AI that understands your business. Slide each plan to the size of your business'),
      cycLabel: L('תקופת חיוב', 'Billing'), curLabel: L('מטבע', 'Currency'),
      cyc: [[false, L('חודשי', 'Monthly')], [true, L('שנתי', 'Yearly')]].map(([v, t], i) => ({ key: i, t, bg: seg(yr === v), fg: segF(yr === v), pick: () => this.setState({ prYr: v }) })),
      cur: [['ils', L('₪ שקל', '₪ ILS')], ['usd', L('$ דולר', '$ USD')]].map(([v, t], i) => ({ key: i, t, bg: seg(cur === v), fg: segF(cur === v), pick: () => this.setState({ prCur: v }) })),
      note: (yr ? L('חיוב פעם בשנה, חשבונית אחת', 'Billed once a year, one invoice') : L('חיוב חודשי, מבטלים מתי שרוצים', 'Billed monthly, cancel whenever')) + ' · ' + L('המחירים לא כוללים מע״מ 18%', 'Prices exclude 18% VAT') + (cur === 'ils' ? L(' · המחיר בשקלים מוערך', ' · Shekel prices are an estimate') : ''),
      plans,
      cmpTitle: L('שורה אחרי שורה, מה כל חבילה כוללת', 'Line by line, what each plan includes'), cmpKicker: L('השוואה מלאה', 'Compare in full'),
      cmpNote: L('החבילה והמחיר נשארים מולכם בזמן הגלילה, כדי שתמיד תדעו איזו עמודה אתם קוראים', 'The plan and its price stay with you as you scroll, so you always know which column you are reading'),
      cmpCorner: yr ? L('מחיר שנתי', 'Yearly price') : L('מחיר חודשי', 'Monthly price'),
      cmpFoot: L('בכל החבילות כל הצוות כלול, בלי חיוב לפי משתמש', 'Every plan includes your whole team, with no per seat charge'),
      cmpPlans: plans.map((p, i) => ({ key: p.key, name: p.name, hasSave: p.hasSave, was: p.was, off: p.off, saveShort: p.hasSave ? L('חוסכים ' + p.save.replace(/^חוסכים |^You save /, '').replace(/ בשנה$| a year$/, ''), 'Save ' + p.save.replace(/^You save /, '').replace(/ a year$/, '')) : '', hasBadge: p.hasBadge, badge: p.badge, price: p.price, per: p.per, bg: i === 1 ? '#FBF6F0' : 'transparent', cta: p.cta, href: p.href, hasGift: p.hasGift, gift: p.gift, btnBg: i === 1 ? '#16150F' : '#FFFFFF', btnFg: i === 1 ? '#FAF8F4' : '#16150F', btnBd: i === 1 ? '#16150F' : '#D8D2C6' })),
      cmpGroups: (() => {
        const CMP = [
          [['תקשורת', 'Communication'], [
            [['תיבה אחת לכל הערוצים', 'Multichannel unified inbox'], 1, 1, 1],
            [['הודעות תפוצה לקהל מפולח', 'Broadcasts to a segmented audience'], 1, 1, 1],
            [['אוטומציות שמנתבות, עונות ופועלות בלי נציג', 'Automations that route, reply and act without an agent'], 1, 1, 1],
            [['תגובות לפוסטים שעוברות לצ׳אט פרטי', 'Social engagement: comments on posts into private chats'], 1, 1, 1],
            [['סיכומי שיחה שנכתבים ל־CRM', 'Conversation summaries written into your CRM'], 1, 1, 1],
            [['ניתוב AI למחלקה הנכונה', 'AI routing to the right department'], 1, 1, 1]]],
          [['הקשר וידע', 'Context and knowledge'], [
            [['מרכז השליטה', 'The command centre'], 1, 1, 1],
            [['מאגר ידע', 'Knowledge base'], 1, 1, 1],
            [['תמונת לקוח מלאה', 'The full customer picture'], 1, 1, 1],
            [['ניתוח סנטימנט', 'Sentiment analysis'], 1, 1, 1],
            [['אינטגרציות', 'Integrations'], 1, 1, 1]]],
          [['ניהול הצוות', 'Running the team'], [
            [['דשבורד מנהלים', 'Manager dashboard'], 1, 1, 1],
            [['מעקב אחרי נציגים', 'Agent monitoring'], 1, 1, 1],
            [['מעקב שימוש', 'Usage tracking'], 1, 1, 1],
            [['כל הצוות, בלי חיוב לפי משתמש', 'Your whole team, no per seat charge'], 1, 1, 1]]],
          [['עובדי AI וקול', 'AI employees and voice'], [
            [['Copilot לצד הצוות בכל שיחה', 'Copilot beside your team in every conversation'], 1, 1, 1],
            [['עובדי AI שעונים ופועלים מקצה לקצה', 'AI employees answering and acting end to end'], 0, 1, 1],
            [['עצמאות לכל פעולה: להציע, לשאול או לבצע', 'Autonomy per action: suggest, ask me, or do it'], 0, 1, 1],
            [['Call Pilot בשיחות טלפון בזמן אמת', 'Call Pilot on live phone calls'], 0, 0, 1],
            [['דקות שיחה מתוך יתרת הקרדיטים', 'Voice minutes drawn from your credit balance'], 0, 0, 1]]],
          [['קרדיטים וחיוב', 'Credits and billing'], [
            [['קרדיטים מתנה בכל חודש', 'Gift credits every month'], (TIERS[ix.pcp] * 25 * 3).toLocaleString('en-US'), (TIERS[ix.pai] * 200).toLocaleString('en-US'), (TIERS[ix.ccp] * 200 + TIERS[ix.cai] * 250).toLocaleString('en-US')],
            [['הערכת שיחות בחודש', 'Estimated conversations a month'], L('בערך ', 'About ') + '⁦' + (TIERS[ix.pcp] * 25).toLocaleString('en-US') + '⁩', L('בערך ', 'About ') + '⁦' + (TIERS[ix.pai] * 25).toLocaleString('en-US') + '⁩', L('בערך ', 'About ') + '⁦' + ((TIERS[ix.ccp] + TIERS[ix.cai]) * 25).toLocaleString('en-US') + '⁩'],
            [['חבילות קרדיטים מראש', 'Prepaid credit packages'], 1, 1, 1],
            [['טעינה אוטומטית עם תקרת הוצאה', 'Automatic top up with a spending limit'], 1, 1, 1],
            [[yr ? 'מחיר לשנה, לא כולל מע״מ' : 'מחיר לחודש, לא כולל מע״מ', yr ? 'Price a year, excluding VAT' : 'Price a month, excluding VAT'], plans[0].price, plans[1].price, plans[2].price]]]
        ];
        const cell = (x, i) => { const bg = i === 1 ? '#FBF6F0' : 'transparent', plan = plans[i].name;
          if (typeof x === 'number') return { key: i, plan, bg, yes: !!x, no: !x, v: '', c: '#16150F', w: '500' };
          return { key: i, plan, bg, yes: false, no: false, v: x, c: '#16150F', w: '600' }; };
        return CMP.map((g, gi) => ({ key: gi, t: L(g[0][0], g[0][1]), rows: g[1].map((rw, ri) => ({ key: ri, t: L(rw[0][0], rw[0][1]), cells: [cell(rw[1], 0), cell(rw[2], 1), cell(rw[3], 2)] })) }));
      })(),
      howKicker: L('איך נקבע המחיר', 'How the price is set'),
      roiCapA: L('מה שאתם מרוויחים', 'What you gain'), fTitle: L('בואו נראה מה ה־ROI אצלכם', 'Let us work out your ROI'), fLead: L('השאירו פרטים ונחזור אליכם היום או מחר, עם הערכה אמיתית לעסק שלכם', 'Leave your details and we will get back to you today or tomorrow with a real estimate for your business'), fSubmit: L('השאירו פרטים', 'Leave your details'), fFoot: L('עונים לכם מתן או עומר, לא תור. בלי כרטיס אשראי', 'Answered by Matan or Omer, not a queue. No card needed'), roiCapB: L('מה שאנחנו רוצים', 'What we want'),
      howTitle: L('ה־ROI שלכם הוא האינטרס שלנו', 'Your ROI is our interest'),
      howBody: L('אנחנו מרוויחים רק כשאתם מרוויחים. המחיר עולה רק כשהמערכת עושה בשבילכם יותר עבודה, ויורד באותו חודש כשהיא עושה פחות. ככה שנינו רוצים את אותו הדבר: שהיא תעבוד בשבילכם', 'We only grow when you do. The price rises only when the system does more work for you, and drops the same month when it does less. So we both want the same thing: for it to work for you'),
      how: [
        [['מה מפעילים', 'What you switch on'], ['יכולות', 'Capabilities'], ['מתחילים מהתיבה המשותפת ומוסיפים קול, מענה אוטונומי, פעולות בק אופיס או מעורבות ברשתות כשרוצים. כל יכולת שמפעילים מתומחרת, וכל יכולת שמכבים מפסיקה להיות מחויבת', 'Start with the shared inbox and add voice, autonomous replies, back office actions or social engagement when you want them. Each one you turn on is priced, each one you turn off stops being charged'], false],
        [['כמה מטפלים', 'How much you handle'], ['נפח', 'Volume'], ['שיחות, שיחות טלפון ופעולות AI נמדדות. חודש שקט עולה פחות מחודש של השקה, בלי לנהל משא ומתן מחדש', 'Conversations, calls and AI actions are metered. A quiet month costs less than a launch month, without renegotiating anything'], false],
        [['זה זז לשני הכיוונים', 'It moves both ways'], ['למעלה ולמטה', 'Up and down'], ['צמיחה מעלה את החשבון ביחס לעבודה שנעשתה בשבילכם. עונה שקטה או פחות יכולות מורידות אותו באותו חודש', 'Growth raises the bill in proportion to the work done for you. A slower season, or fewer capabilities, lowers it the same month'], true],
        [['אתם קובעים את התקרה', 'You set the ceiling'], ['התקרה שלכם', 'Your limit'], ['תקרת הוצאה חודשית שאתם בוחרים. השימוש גלוי בזמן אמת, ושום דבר לא מחויב מעבר לתקרה', 'A monthly spending limit you choose. Usage is visible as it happens and nothing is charged beyond it'], false]
      ].map((c, i) => ({ key: i, t: L(c[0][0], c[0][1]), v: L(c[1][0], c[1][1]), d: L(c[2][0], c[2][1]), bg: c[3] ? '#16150F' : '#FFFFFF', bd: c[3] ? '#16150F' : '#E4DFD4', fg: c[3] ? '#FAF8F4' : '#16150F', muted: c[3] ? '#B8B3AA' : '#5B564D' })),
      cuKicker: L('חבילה מותאמת', 'Custom plan'),
      cuTitle: L('בנויה סביב איך שהעסק שלכם באמת עובד', 'Built around how your business actually runs'),
      cuBody: L('אם הנפחים, הערוצים, המגבלות או תנאי ההתקשרות לא מתאימים לחבילות האלה, נגדיר חבילה שמתאימה. חבילה מותאמת קובעת יכולות, מגבלות, קרדיטים ונפחי צ׳אט וקול, בתנאים שסוגרים איתכם', 'If your volumes, channels, limits or contract terms do not fit these plans, we will configure one that does. A custom plan sets its own capabilities, limits, credit allocation and chat and voice volumes, on terms agreed with you'),
      cuCta: L('דברו עם המכירות', 'Contact sales'), cuHref: this.talkUrl(),
      cuBullets: [['בחירת יכולות ומגבלות לכל ארגון', 'Feature selection and numeric limits set per organisation'], ['הקצאת קרדיטים ונפחי צ׳אט וקול שסוגרים מראש', 'Credit allocation and chat and voice volumes agreed up front'], ['תנאים חודשיים או שנתיים לתקופה מוגדרת', 'Monthly or annual terms with a defined contract period'], ['מחיר לעסק שלכם, לא לפי מחירון', 'Priced for your business rather than a published tier']].map((b, i) => ({ key: i, t: L(b[0], b[1]) })),
      faqTitle: L('שאלות על התמחור', 'Questions about pricing'),
      faqs: FQ.map((f, i) => ({ key: i, q: L(f[0], f[1]), a: L(f[2], f[3]), open: fq === i, sign: fq === i ? '−' : '+', toggle: () => this.setState({ prFaq: fq === i ? -1 : i }) })),
      endTitle: L('החודש הראשון עלינו', 'Your first month is on us'),
      endBody: L('בוחרים Co-Pilot או AI Team, מתחברים איתנו, ומתחילים לשלם רק אחרי חודש. בלי התחייבות ובלי כרטיס אשראי', 'Choose Co-Pilot or AI Team, connect it with us, and start paying only after a month. No commitment and no card'),
      endCta: L('התחילו בחינם', 'Start free'), gift, demo: L('קבעו דמו', 'Book a demo'), offer
    };
  }
  async initPrice() {
    window.__gHomeReady = true;
    if (this.reduce) return;
    try { if (!window.gsap) await loadVendor('gsap'); } catch (e) { return; }
    for (let i = 0; i < 40 && !document.querySelector('[data-pr-card]'); i++) await new Promise(r => setTimeout(r, 100));
    if (this.dead || !window.gsap) return;
    const g = window.gsap;
    g.fromTo('[data-pr-hero] [data-pr-rise]', { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: 0.9, stagger: 0.09, ease: 'power3.out', delay: 0.1 });
    g.fromTo('[data-pr-card]', { opacity: 0, y: 70 }, { opacity: 1, y: 0, duration: 1, stagger: 0.1, ease: 'power3.out', delay: 0.35 });
  }
  OP0 = { hw: [], items: [], cards: [], shotW: [], steps: [], fine: [], cw: [] };
  opVals() {
    const T = (x) => this.T(x), np = (s) => T(s).replace(/[.]\s*$/, '');
    const words = (s, c) => np(s).split(' ').filter(Boolean).map((t) => ({ t, c }));
    const k = (a) => a.map((x, i) => Object.assign({ key: i }, x));
    return {
      badge: T('Launch offer'), scarcity: T('For the first 50 businesses only'),
      hw: k(words('Your first month of GOTCHA', '#16150F').concat(words('on us!', '#C4552F'))),
      sub: T('We are opening the system to the first 50 businesses, and we would rather earn you than charge you. Your first month is free, with no commitment, on the plan you choose, with us setting it up beside you.'),
      cta: T('Claim a place'), demo: T('Or book a demo call'), ctaNote: T('Two minutes to leave your details.'),
      priceLabel: T('First month'), price: T('Free'), priceNote: T('No commitment and no card, on the plan you choose. After that, regular pricing from $39 a month.'),
      items: k(['1,000 credits for the free month', 'Co-Pilot or AI Team, your choice', 'Connection, onboarding and personal guidance', 'Billing starts only once you are connected'].map(t => ({ t: T(t) }))),
      formTitle: T('Claim your place'), formLead: T('Leave your details and we get back to you today or tomorrow.'), submit: T('Leave your details'),
      formFoot: T('Answered by Matan or Omer, not a queue. No card, and nothing charged until you are connected.'),
      bandTitle: np('A full month of the whole system, on us, with no commitment.'),
      cards: k([
        { icon: 'layers', bg: '#EFD9CD', ic: '#8E3418', t: 'Choose Co-Pilot or AI Team', d: 'The offer covers either of the first two plans. Take Co-Pilot if your team answers, or AI Team if you want AI employees handling it end to end. Switch between them during the free month.' },
        { icon: 'coins', bg: '#F7F0E2', ic: '#8A6A16', t: '1,000 credits every month', d: 'Enough for a real month of conversations, not a demo.' },
        { icon: 'plug', bg: '#EDF4E7', ic: '#2E7D5B', t: 'We connect it with you', d: 'Your channels, your store or site and your systems. You are not handed a login and left to work it out.' },
        { icon: 'user-round-check', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Onboarding and personal guidance', d: 'We build the first knowledge base with you, set the autonomy limits, and stay reachable while you settle in.' },
        { icon: 'users-round', bg: '#FBEEE8', ic: '#C4552F', t: 'Only 50 businesses', d: 'So that each one gets our attention. When the fiftieth business joins, the offer closes.' }
      ].map(c => Object.assign({}, c, { t: np(c.t), d: T(c.d) }))),
      shotW: k(words('Every conversation, every channel, every customer, in one calm, organised place.')),
      shotMeta: T('GOTCHA · your morning view'), shotAlt: T('The GOTCHA home screen on a Monday morning'),
      howKicker: T('How it works'), howTitle: np('From this page to answering, usually the same day.'),
      steps: k([['Leave your details', 'Your store, your channels and how you would rather we reach you.'], ['A short call with one of us', 'Twenty minutes, with a founder, to see whether we can genuinely help you.'], ['We connect and onboard you', 'Channels, Shopify and your systems, plus the first knowledge base built together.'], ['Your free month starts', 'The free month begins only once you are connected and answering.']].map(s => ({ t: T(s[0]), d: T(s[1]) }))),
      fineTitle: T('The terms, in full'),
      fine: k(['The first month is free, with no commitment.', '1,000 credits included in the free month.', 'Connection, onboarding and personal guidance included.', 'For the first 50 businesses.', 'The offer ends on 31 December 2026 or when 50 businesses have joined, whichever comes first.', 'After the first month the price follows the plan and usage you choose. Regular pricing starts at $39 a month. Cancel any time.', 'The free month starts after connection.', 'Prices are in USD and exclude 18% VAT.'].map(t => ({ t: T(t) }))),
      cw: k(words('One of fifty. Then it closes.', '#FAF8F4')),
      ctaBody: T('Leave your details and one of us will call you today or tomorrow. If GOTCHA is not right for your store, we will say so on that call.'),
      toForm: () => { const st = this.ofST, el = document.querySelector('[data-of-form]'); let y = 0; if (st) y = st.end - 2; else if (el) y = el.getBoundingClientRect().top + window.scrollY - 110; if (this.lenis) this.lenis.scrollTo(y, { duration: 1.4 }); else window.scrollTo(0, y); setTimeout(() => { const i = document.querySelector('[data-of-form] input'); if (i) i.focus({ preventScroll: true }); }, 1500); }
    };
  }
  async initOffer() {
    const root = document.documentElement;
    const fail = () => { root.classList.remove('fx'); root.classList.add('nofx'); };
    if (this.reduce) { fail(); return; }
    try {
      if (!window.gsap) await loadVendor('gsap');
      if (!window.ScrollTrigger) await loadVendor('ScrollTrigger');
      if (!window.Lenis) await loadVendor('Lenis');
    } catch (e) { fail(); return; }
    for (let i = 0; i < 80 && !(document.querySelectorAll('[data-of-pan]').length === 5 && document.querySelectorAll('[data-ofw]').length > 3 && document.querySelector('[data-of-big]')); i++) await new Promise(r => setTimeout(r, 100));
    if (this.dead || !root.classList.contains('fx')) return;
    window.__gHomeReady = true;
    const gsap = window.gsap, ST = window.ScrollTrigger;
    gsap.registerPlugin(ST);
    this.pvo = () => root.getAttribute('data-pv') === 'desktop' ? 52 : 0;
    this.lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    this.lenis.on('scroll', ST.update);
    this.lenisRaf = (t) => this.lenis && this.lenis.raf(t * 1000);
    gsap.ticker.add(this.lenisRaf);
    gsap.ticker.lagSmoothing(0);
    if (this.pvPhone) this.lenis.stop();
    gsap.set(['[data-ofw]', '[data-ofc]'], { y: 0, yPercent: 115 });
    gsap.to('[data-ofw]', { y: 0, yPercent: 0, duration: 1.05, stagger: 0.08, ease: 'power3.out', delay: 0.15 });
    gsap.fromTo('[data-of-hero] [data-of-rise]', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.9, stagger: 0.12, ease: 'power3.out', delay: 0.55 });
    this.ofMM = gsap.matchMedia();
    this.ofMM.add({ desk: '(min-width: 861px)', mob: '(max-width: 860px)' }, (ctx) => { this.buildOffer(gsap, ctx.conditions.desk); return () => { this.ofST = null; const g = document.querySelector('[data-of-grid]'); if (g) g.style.scale = ''; }; });
    const remq = () => { if (this.dead) return; gsap.matchMediaRefresh(); ST.refresh(); };
    this.onAnimResize = () => { clearTimeout(this.remqT); this.remqT = setTimeout(remq, 220); };
    window.addEventListener('resize', this.onAnimResize);
    setTimeout(remq, 700);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remq);
  }
  buildOffer(gsap, desk) {
    const q = (s) => document.querySelector(s), qa = (s) => gsap.utils.toArray(s), vh = () => window.innerHeight;
    const rtl = getComputedStyle(q('[data-site="main"]')).direction === 'rtl', sg = rtl ? 1 : -1;
    const rise = (el) => gsap.fromTo(el, { opacity: 0, y: 44 }, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true, refreshPriority: -1 } });
    const stage = q('[data-of-stage]'), grid = q('[data-of-grid]'), big = q('[data-of-big]'), slot = q('[data-of-slot]');
    if (desk) {
      const fit = () => { grid.style.scale = ''; const cs = getComputedStyle(stage); const av = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom); const k = Math.min(1, av / Math.max(1, grid.offsetHeight)); grid.style.scale = k < 1 ? Math.max(0.6, k).toFixed(4) : ''; };
      const price = q('[data-of-price]');
      const K = () => { fit(); const keep = price.style.transform; price.style.transform = 'none'; const bw = big.offsetWidth, bh = big.offsetHeight, a = slot.getBoundingClientRect(), b = stage.getBoundingClientRect(); price.style.transform = keep; return { x0: (stage.clientWidth - bw) / 2, y0: (stage.clientHeight - bh) / 2 + 10, x1: a.left - b.left, y1: a.top - b.top, k1: a.height / bh }; };
      let m = K();
      const t = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: this.pinST(stage, 2.6, { start: () => { m = K(); return 'top ' + this.pvo() + 'px'; } }) });
      this.ofST = t.scrollTrigger;
      t.fromTo(big, { x: () => m.x0, y: () => m.y0, scale: 1, opacity: 1 }, { x: () => m.x1, y: () => m.y1, scale: () => m.k1, duration: 0.7, ease: 'power3.inOut', immediateRender: true }, 0.15)
        .fromTo('[data-of-price]', { opacity: 0, rotationY: sg * -16, y: 60, transformPerspective: 1500 }, { opacity: 1, rotationY: 0, y: 0, duration: 0.5, ease: 'power3.out' }, 0.35)
        .to(big, { opacity: 0, duration: 0.05 }, 0.85)
        .fromTo(slot, { opacity: 0 }, { opacity: 1, duration: 0.05 }, 0.85)
        .fromTo(qa('[data-of-chk]'), { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, duration: 0.14, stagger: 0.16, ease: 'back.out(2.4)' }, 0.95)
        .fromTo('[data-of-form]', { opacity: 0, x: sg * -120, rotationY: sg * 18, transformPerspective: 1500 }, { opacity: 1, x: 0, rotationY: 0, duration: 0.55, ease: 'power3.out' }, 1.6)
        .to({}, { duration: 0.4 }, 2.2);
      const tw = q('[data-of-trackwrap]'), track = q('[data-of-track]'), pans = qa('[data-of-pan]');
      const D = () => Math.max(0, track.scrollWidth - tw.clientWidth);
      gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: tw, pin: true, scrub: 0.8, invalidateOnRefresh: true, start: () => 'top ' + this.pvo() + 'px', end: () => '+=' + Math.round(D() + vh() * 0.4) } })
        .fromTo(track, { x: 0 }, { x: () => sg * D(), duration: 1 }, 0)
        .fromTo(pans, { rotationY: -sg * 10, scale: 0.94 }, { rotationY: 0, scale: 1, duration: 0.3, stagger: 0.17 }, 0);
      const steps = qa('[data-of-step]');
      gsap.fromTo('[data-of-rail]', { scaleY: 0 }, { scaleY: 1, ease: 'none', scrollTrigger: { trigger: '[data-of-steps]', start: 'top 70%', end: 'bottom 55%', scrub: 0.6 } });
      steps.forEach(s => gsap.fromTo(s, { opacity: 0.22 }, { opacity: 1, ease: 'none', scrollTrigger: { trigger: s, start: 'top 72%', end: 'top 52%', scrub: 0.6 } }));
    } else {
      this.ofST = null;
      rise(q('[data-of-price]')); rise(q('[data-of-form]'));
      qa('[data-of-pan]').forEach(rise);
    }
    qa('[data-of-cards] [data-of-rise], [data-of-how] [data-of-rise], [data-of-final] [data-of-rise]').forEach(rise);
    gsap.to(qa('[data-of-lw]'), { opacity: 1, ease: 'none', stagger: 0.1, scrollTrigger: { trigger: '[data-of-shot]', start: 'top 80%', end: 'top 25%', scrub: 0.6 } });
    gsap.fromTo('[data-of-mock]', { rotationX: 26, scale: 0.84, y: 120 }, { rotationX: 0, scale: 1, y: 0, ease: 'none', scrollTrigger: { trigger: '[data-of-mock]', start: 'top bottom', end: 'center 55%', scrub: 0.7 } });
    gsap.fromTo(qa('[data-of-fn]'), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6, stagger: 0.06, ease: 'power3.out', scrollTrigger: { trigger: '[data-of-fine]', start: 'top 80%', once: true } });
    gsap.to('[data-ofc]', { y: 0, yPercent: 0, duration: 1, stagger: 0.08, ease: 'power3.out', scrollTrigger: { trigger: '[data-of-final]', start: 'top 65%', once: true } });
  }
  async initTalk() {
    const root = document.documentElement;
    const fail = () => { root.classList.remove('fx'); root.classList.add('nofx'); };
    if (this.reduce) { fail(); return; }
    try {
      if (!window.gsap) await loadVendor('gsap');
      if (!window.ScrollTrigger) await loadVendor('ScrollTrigger');
      if (!window.Lenis) await loadVendor('Lenis');
    } catch (e) { fail(); return; }
    for (let i = 0; i < 80 && !(document.querySelectorAll('[data-tkw]').length > 2 && document.querySelectorAll('[data-tk-way]').length >= 1); i++) await new Promise(r => setTimeout(r, 100));
    if (this.dead || !root.classList.contains('fx')) return;
    window.__gHomeReady = true;
    const gsap = window.gsap, ST = window.ScrollTrigger;
    gsap.registerPlugin(ST);
    this.pvo = () => root.getAttribute('data-pv') === 'desktop' ? 52 : 0;
    this.lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    this.lenis.on('scroll', ST.update);
    this.lenisRaf = (t) => this.lenis && this.lenis.raf(t * 1000);
    gsap.ticker.add(this.lenisRaf);
    gsap.ticker.lagSmoothing(0);
    if (this.pvPhone) this.lenis.stop();
    gsap.set('[data-tkw]', { y: 0, yPercent: 115 });
    const wide = window.innerWidth > 860;
    gsap.timeline({ defaults: { ease: 'power3.out' }, delay: 0.1 })
      .fromTo('[data-tk-kick]', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7 }, 0)
      .to('[data-tkw]', { y: 0, yPercent: 0, duration: 1.05, stagger: 0.07 }, 0.1)
      .fromTo('[data-tk-formwrap]', { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.35)
      .fromTo('[data-tk-form]', wide ? { rotationY: -24, x: -110, scale: 0.9 } : { rotationX: 14, y: 70, scale: 0.96 }, { rotationY: 0, rotationX: 0, x: 0, y: 0, scale: 1, duration: 1.2 }, 0.35)
      .fromTo('[data-tk-sub] > *', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.1 }, 0.7)
      .set('[data-tk-sub]', { opacity: 1 }, 0.7)
      .fromTo('[data-tk-stats] > *', { opacity: 0, y: 20, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, stagger: 0.1 }, 1.0)
      .set('[data-tk-stats]', { opacity: 1 }, 1.0)
      .fromTo('[data-tk-f] input', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.06 }, 0.75);
    this.tkMM = gsap.matchMedia();
    this.tkMM.add({ desk: '(min-width: 861px)', mob: '(max-width: 860px)' }, (ctx) => { this.buildTalk(gsap, ST, ctx.conditions.desk); return () => { this.tkST = null; document.documentElement.removeAttribute('data-tk-flow'); const g = document.querySelector('[data-tk-grid]'); if (g) g.style.scale = ''; }; });
    const remq = () => { if (this.dead) return; gsap.matchMediaRefresh(); ST.refresh(); };
    this.onAnimResize = () => { clearTimeout(this.remqT); this.remqT = setTimeout(remq, 220); };
    window.addEventListener('resize', this.onAnimResize);
    setTimeout(remq, 700);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remq);
  }
  buildTalk(gsap, ST, desk) {
    const q = (s) => document.querySelector(s), qa = (s) => gsap.utils.toArray(s);
    const hero = q('[data-tk-hero]'), grid = q('[data-tk-grid]');
    this.tkST = null;
    if (desk && hero && grid) { grid.style.scale = ''; const c0 = getComputedStyle(hero); const av0 = hero.clientHeight - parseFloat(c0.paddingTop) - parseFloat(c0.paddingBottom); const k = av0 / Math.max(1, grid.offsetHeight); if (k < 1 && k >= 0.8) grid.style.scale = k.toFixed(4); }
    if (!desk) {
      const fl = q('[data-tk-float]'), fm = q('[data-tk-form]');
      if (fl && fm) { gsap.set(fl, { autoAlpha: 0, y: 30 }); ST.create({ trigger: fm, start: 'bottom 10%', endTrigger: document.body, end: 'bottom bottom', onToggle: (self) => { gsap.to(fl, { autoAlpha: self.isActive && !this.state.tkSent ? 1 : 0, y: self.isActive ? 0 : 30, duration: 0.45, ease: 'power3.out', overwrite: true }); fl.setAttribute('aria-hidden', self.isActive ? 'false' : 'true'); } }); }
    }
    qa('[data-tk-rise]').forEach(el => gsap.fromTo(el, { opacity: 0, y: 44 }, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true, refreshPriority: -1 } }));
    qa('[data-tk-way]').forEach(r => gsap.fromTo(r, { opacity: 0, y: 80, rotationX: 14 }, { opacity: 1, y: 0, rotationX: 0, ease: 'none', scrollTrigger: { trigger: r, start: 'top 96%', end: 'top 58%', scrub: 0.7, refreshPriority: -1 } }));
    const ans = qa('[data-tk-ans]');
    if (ans.length) gsap.fromTo(ans, { opacity: 0.16, x: desk ? 30 : 0 }, { opacity: 1, x: 0, ease: 'none', stagger: 0.5, scrollTrigger: { trigger: '[data-tk-dark]', start: 'top 55%', end: 'bottom 75%', scrub: 0.6, refreshPriority: -1 } });
    qa('[data-tk-off]').forEach((r, i) => gsap.fromTo(r, { opacity: 0, y: 60 + i * 30 }, { opacity: 1, y: 0, ease: 'none', scrollTrigger: { trigger: r, start: 'top 100%', end: 'top 62%', scrub: 0.7, refreshPriority: -1 } }));
    gsap.set('[data-tkc]', { y: 0, yPercent: 115 });
    gsap.to('[data-tkc]', { y: 0, yPercent: 0, duration: 1, stagger: 0.08, ease: 'power3.out', scrollTrigger: { trigger: '[data-tk-final]', start: 'top 70%', once: true, refreshPriority: -1 } });
  }
  OVR = { 'All your communication': 'כל התקשורת שלכם', 'From the journal': 'מהבלוג', 'Your customers write in the evening, on the sofa, with the phone in one hand. That is exactly when nobody is reading.': 'הלקוחות שלכם כותבים בערב, על הספה, עם הטלפון ביד. בדיוק כשאף אחד לא קורא.' };
  CH = [['WhatsApp', 'whatsapp.svg'], ['Instagram', 'instagram.svg'], ['Facebook', 'facebook.svg'], ['Slack', 'slack.svg'], ['Outlook', 'outlook.svg'], ['Gmail', 'gmail.svg'], ['Web chat', 'globe.svg'], ['Phone', 'phone.svg']];
  NIGHT = [62, 48, 70, 40, 56, 66, 44, 58, 52, 68, 46, 60, 50, 64].map((w, i) => ({ w: w + '%', key: i }));
  DOTS = (() => {
    let s = 7; const r = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const C = ['#C4552F', '#E8946E', '#16150F', '#8E3418', '#A8C57A'];
    return Array.from({ length: 200 }, (_, i) => { const sz = 6 + Math.round(r() * 10); return { key: i, st: 'position:absolute;left:' + (3 + r() * 94).toFixed(2) + '%;top:' + (4 + r() * 92).toFixed(2) + '%;width:' + sz + 'px;height:' + Math.round(sz * 0.78) + 'px;border-radius:' + sz + 'px ' + sz + 'px ' + sz + 'px 2px;background:' + C[i % 5] + ';opacity:0' }; });
  })();

  EN_ON = !!(this.props && this.props.lang === 'en');
  T(s) {
    if (s == null) return '';
    if (this.EN_ON) { if (!/[\u0590-\u05FF]/.test(s)) return s; return this.toEn(s); }
    const H = __D.GOTCHA_HE || {}; return this.OVR[s] || (H[s] != null ? H[s] : s);
  }
  toEn(s) {
    if (!this.REV) { this.REV = {}; const H = __D.GOTCHA_HE || {}; Object.keys(H).forEach(k => { const v = String(H[k]).trim(); if (!(v in this.REV)) this.REV[v] = k; }); Object.keys(this.OVR || {}).forEach(k => { this.REV[String(this.OVR[k]).trim()] = k; }); Object.assign(this.REV, __D.GOTCHA_EN || {}); }
    const t = String(s).trim(); if (this.REV[t] != null) return String(s).replace(t, this.REV[t]);
    return s;
  }
  pageUrl(p) { return homeHref(p, this.EN_ON ? 'en' : 'he', this.props && this.props.page); }
  siteOk() { return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(String(this.state.heroSite || '').trim()); }
  goOnboarding(site) { const v = String(site || '').trim(); try { if (v) sessionStorage.setItem('gotcha-onboarding-site', v); } catch (e) {} window.dispatchEvent(new CustomEvent('gotcha:onboarding', { detail: { site: v, lang: this.EN_ON ? 'en' : 'he' } })); }
  setLang(l) { try { localStorage.setItem('gotcha-home-lang', l); localStorage.setItem('gotcha-lang', l); sessionStorage.setItem('gotcha-lang-top', '1'); } catch (e) {} if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; location.href = v8PageHref(this.props && this.props.page, l); }
  enPass = () => {
    if (!this.EN_ON) return;
    const root = document.querySelector('[data-site="main"]'); if (!root) return;
    if (root.getAttribute('dir') !== 'ltr') { root.setAttribute('dir', 'ltr'); root.setAttribute('lang', 'en'); }
    const heb = /[\u0590-\u05FF]/, w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const v = n.nodeValue; const pe = n.parentElement; if (pe && (pe.hasAttribute('data-chw') || pe.hasAttribute('data-lw') || pe.hasAttribute('data-hw'))) continue; if (v && heb.test(v)) { const r = this.toEn(v); if (r !== v) n.nodeValue = r; } }
    root.querySelectorAll('[dir="rtl"]').forEach(el => el.setAttribute('dir', 'ltr'));
    const w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n2; while ((n2 = w2.nextNode())) { if (n2.nodeValue && n2.nodeValue.indexOf('←') >= 0) n2.nodeValue = n2.nodeValue.split('←').join('→'); }
    const bar = document.querySelector('[data-bar]'); if (bar && bar.getAttribute('dir') !== 'ltr') { bar.setAttribute('dir', 'ltr'); const tw = document.createTreeWalker(bar, NodeFilter.SHOW_TEXT); let b3; while ((b3 = tw.nextNode())) { const v = b3.nodeValue; if (v && heb.test(v)) { const r = this.toEn(v); if (r !== v) b3.nodeValue = r; } if (b3.nodeValue.indexOf('←') >= 0) b3.nodeValue = b3.nodeValue.split('←').join('→'); } }
    root.querySelectorAll('[placeholder],[aria-label],[alt],[title]').forEach(el => ['placeholder', 'aria-label', 'alt', 'title'].forEach(a => { const v = el.getAttribute(a); if (v && heb.test(v)) { const r = this.toEn(v); if (r !== v) el.setAttribute(a, r); } }));
  };
  queueEn() { if (!this.EN_ON || this.enRaf) return; this.enRaf = requestAnimationFrame(() => { this.enRaf = 0; this.enPass(); }); }
  pvMode() { return null; }
  syncPv() { const m = this.pvMode(), d = document.documentElement; this.pvPhone = m === 'phone'; if (m) d.setAttribute('data-pv', m); else d.removeAttribute('data-pv'); d.toggleAttribute('data-nobar', !this.state.bar); }
  calcScale() { return +Math.min(1, Math.max(0.3, (window.innerHeight - 52 - 40) / 898)).toFixed(4); }
  fitPv = () => this.setState({ pvScale: this.calcScale() });
  load(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }

  paintIcons() {
    const L = getLucide(); if (!L || !L.icons) return;
    document.querySelectorAll('i[data-lucide]').forEach(el => {
      const n = el.getAttribute('data-lucide'); if (!n || el.getAttribute('data-painted') === n) return;
      const k = n.replace(/(^|-)(\w)/g, (a, b, c) => c.toUpperCase()); const ic = L.icons[k]; if (!ic) return;
      const svg = L.createElement(ic); svg.setAttribute('stroke-width', '2.1'); el.innerHTML = ''; el.appendChild(svg); el.setAttribute('data-painted', n);
    });
  }

  async componentDidMount() {
    this.syncPv(); this.fitPv();
    if (this.EMBED) document.documentElement.setAttribute('data-embed', '');
    window.addEventListener('resize', this.fitPv);
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.offerDismissed = localStorage.getItem('gotcha-offer-dismissed') === '1';
    for (let i = 0; i < 60 && !(__D.GOTCHA_HE && __D.GOTCHA_HOME); i++) await new Promise(r => setTimeout(r, 100));
    if (!this.state.ready) this.setState({ ready: true });
    this.lastBiz = this.state.biz;
    setTimeout(() => this.faqSync(true), 300);
    window.addEventListener('scroll', this.offerAuto, { passive: true });
    if (this.EN_ON) { this.enPass(); setTimeout(this.enPass, 300); setTimeout(this.enPass, 1200); }
    setTimeout(() => { if (this.TALK || this.SOL || this.WHY || this.OFFER || this.PRICE) return; if (this.baP == null) this.baSet(this.baRest()); const st = document.querySelector('[data-ba]'); if (st && window.ResizeObserver) { this.baRO = new ResizeObserver(() => this.baSet(this.baP ?? this.baRest())); this.baRO.observe(st); } }, 400);
    setTimeout(() => { this.paintIcons(); const fr = document.querySelector('[data-pv-iframe]'); if (fr && !fr.getAttribute('src')) fr.setAttribute('src', location.pathname.split('/').pop() + '?embed=1' + (this.TALK ? '&page=talk' : this.ECOM ? '&page=ecommerce' : this.LEADS ? '&page=leads' : this.WHY ? '&page=why' : this.OFFER ? '&page=offer' : '')); }, 50);
    if (this.TALK) this.initTalk(); else if (this.SOL) this.initEcom(); else if (this.WHY) this.initWhy(); else if (this.OFFER) this.initOffer(); else if (this.PRICE) this.initPrice(); else this.initAnim();
  }
  componentDidUpdate() {
    this.paintIcons();
    if (this.state.mnav && !this.mnavWas && window.gsap) { this.mnavWas = true; requestAnimationFrame(() => { window.gsap.fromTo('[data-mg-row]', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.05, ease: 'power3.out' }); }); }
    if (!this.state.mnav) this.mnavWas = false;
    if (this.state.offerOpen && !this.offerWasOpen) { this.offerWasOpen = true; requestAnimationFrame(() => this.offerIn()); }
    if (!this.state.offerOpen) this.offerWasOpen = false;
    this.queueEn();
    this.faqSync(false);
    if (this.baP != null) this.baSet(this.baP);
    const fr = document.querySelector('[data-pv-iframe]'); if (fr && !fr.getAttribute('src')) fr.setAttribute('src', location.pathname.split('/').pop() + '?embed=1' + (this.TALK ? '&page=talk' : this.ECOM ? '&page=ecommerce' : this.LEADS ? '&page=leads' : this.WHY ? '&page=why' : this.OFFER ? '&page=offer' : ''));
    if (this.state.biz !== this.lastBiz) { const p = this.lastBiz; this.lastBiz = this.state.biz; this.animBiz(p, this.state.biz); this.rebuildSc(); }
    const was = this.pvPhone; this.syncPv();
    if (was !== this.pvPhone) { if (this.lenis) this.pvPhone ? this.lenis.stop() : this.lenis.start(); if (window.ScrollTrigger) setTimeout(() => window.ScrollTrigger.refresh(), 60); }
    if (this.barWas !== this.state.bar) { this.barWas = this.state.bar; if (window.ScrollTrigger) setTimeout(() => window.ScrollTrigger.refresh(), 60); }
  }
  componentWillUnmount() {
    this.dead = true;
    clearInterval(this.tTimer); clearTimeout(this.tWait); window.removeEventListener('scroll', this.offerAuto); if (this.baRO) this.baRO.disconnect();
    window.removeEventListener('resize', this.fitPv);
    window.removeEventListener('resize', this.onAnimResize);
    if (this.scCtx) this.scCtx.revert();
    if (this.mm) this.mm.revert(); if (this.ofMM) this.ofMM.revert(); if (this.wyMM) this.wyMM.revert(); if (this.tkMM) this.tkMM.revert(); if (this.ecMM) this.ecMM.revert();
    if (this.lenisRaf && window.gsap) window.gsap.ticker.remove(this.lenisRaf);
    if (this.lenis) { this.lenis.destroy(); this.lenis = null; }
  }

  async initAnim() {
    const root = document.documentElement;
    const fail = () => { root.classList.remove('fx'); root.classList.add('nofx'); };
    if (this.reduce) { fail(); return; }
    try {
      if (!window.gsap) await loadVendor('gsap');
      if (!window.ScrollTrigger) await loadVendor('ScrollTrigger');
      if (!window.Lenis) await loadVendor('Lenis');
    } catch (e) { fail(); return; }
    const q = (s) => document.querySelector(s);
    for (let i = 0; i < 80 && !(document.querySelectorAll('[data-scn]').length >= (((__D.GOTCHA_HOME || {}).BIZ || {})[this.state.biz] || { moments: [1] }).moments.length && document.querySelectorAll('[data-sw]').length === 5 && document.querySelectorAll('[data-hw]').length > 3); i++) await new Promise(r => setTimeout(r, 100));
    if (this.dead || !root.classList.contains('fx')) return;
    window.__gHomeReady = true;
    const gsap = window.gsap, ST = window.ScrollTrigger;
    gsap.registerPlugin(ST);
    this.lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    this.lenis.on('scroll', ST.update);
    this.lenisRaf = (t) => this.lenis && this.lenis.raf(t * 1000);
    gsap.ticker.add(this.lenisRaf);
    gsap.ticker.lagSmoothing(0);
    if (this.pvPhone) this.lenis.stop();

    gsap.set('[data-hw]', { y: 0, yPercent: 115 });
    gsap.timeline({ defaults: { ease: 'power3.out' }, delay: 0.15 })
      .to('[data-hw]', { y: 0, yPercent: 0, duration: 1.05, stagger: 0.08 }, 0)
      .fromTo('[data-win-img]', { scale: 1.12 }, { scale: 1, duration: 1.8, ease: 'power2.out' }, 0)
      .fromTo('[data-h-field]', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.9 }, 0.55)
      .fromTo('[data-h-sub]', { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.8, stagger: 0.1 }, 0.75);

    this.pvo = () => root.getAttribute('data-pv') === 'desktop' ? 52 : 0;
    this.mm = gsap.matchMedia();
    this.mm.add({ desk: '(min-width: 861px)', mob: '(max-width: 860px)' }, (ctx) => {
      this.desk = ctx.conditions.desk;
      this.build(gsap, ST, this.desk);
      this.buildSc();
      return () => { if (this.scCtx) { this.scCtx.revert(); this.scCtx = null; } if (this.resetFits) this.resetFits(); this.resetFits = null; this.demoST = null; this.setState({ tstep: 9, sec: '19', typed: null, closed: 14, count: null }); };
    });

    const biz = q('[data-biz]'), stm = q('[data-stm]');
    this.updDark = () => {
      if (!biz || !stm) return;
      const y = 90 + this.pvo(), a = biz.getBoundingClientRect(), b = stm.getBoundingClientRect();
      root.toggleAttribute('data-dark', a.top < y && b.bottom > y);
    };
    this.lenis.on('scroll', this.updDark);
    ST.addEventListener('refresh', this.updDark);
    this.updDark();
    const remq = () => { if (this.dead) return; gsap.matchMediaRefresh(); ST.refresh(); };
    this.onAnimResize = () => { clearTimeout(this.remqT); this.remqT = setTimeout(remq, 220); };
    window.addEventListener('resize', this.onAnimResize);
    setTimeout(remq, 700);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remq);
  }

  rel(el, anc) { let x = 0, y = 0; while (el && el !== anc) { x += el.offsetLeft; y += el.offsetTop; el = el.offsetParent; } return { x, y }; }
  pinST(trigger, len, extra) { return Object.assign({ trigger, pin: true, scrub: 0.7, invalidateOnRefresh: true, start: () => 'top ' + this.pvo() + 'px', end: () => '+=' + Math.round(window.innerHeight * len) }, extra || {}); }

  build(gsap, ST, desk) {
    const q = (s) => document.querySelector(s), qa = (s) => gsap.utils.toArray(s), rel = this.rel;

    const hero = q('[data-hero]'), win = q('[data-win]'), stick = q('[data-hero-stick]');
    const hcol = q('[data-h-col]');
    const heroFit = () => { hcol.style.transform = ''; const H0 = stick.clientHeight; if (H0 < 200) return; let bottom = 0; [...hcol.children].forEach(c => { bottom = Math.max(bottom, c.offsetTop + c.offsetHeight); }); const k = Math.max(0.6, Math.min(1, (H0 - 16) / Math.max(1, bottom))); hcol.style.transform = k < 1 ? 'scale(' + k.toFixed(4) + ')' : ''; };
    heroFit();
    gsap.set(win, { clearProps: 'transform,borderRadius' });
    gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: hero, start: 'top top', end: () => '+=' + Math.round(window.innerHeight * 0.6), scrub: 0.6, invalidateOnRefresh: true, onRefresh: heroFit } })
      .fromTo(hcol, { opacity: 1 }, { opacity: 0, duration: 0.55 }, 0)
      .fromTo(win, { opacity: 1 }, { opacity: 0, duration: 1 }, 0);


    qa('[data-rise]').forEach(el => gsap.fromTo(el, { opacity: 0, y: 44 }, { opacity: 1, y: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true, refreshPriority: -1 } }));

    gsap.fromTo('[data-mq-track]', { xPercent: 0 }, { xPercent: this.EN_ON ? -50 : 50, ease: 'none', duration: 34, repeat: -1 });
    const chw = qa('[data-chw]');
    if (desk) {
      gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: this.pinST(q('[data-ch]'), 1.4) })
        .fromTo('[data-ch-h]', { scale: 1.12, y: 40 }, { scale: 1, y: 0, duration: 1.2, ease: 'power2.out' }, 0)
        .fromTo(chw, { opacity: 0.14 }, { opacity: 1, duration: 0.3, stagger: 0.16 }, 0)
        .fromTo('[data-mq]', { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, 0.9)
        .to({}, { duration: 0.4 }, 1.5);
    } else {
      gsap.fromTo('[data-ch-h]', { y: 40 }, { y: 0, ease: 'none', scrollTrigger: { trigger: '[data-ch]', start: 'top 85%', end: 'top 30%', scrub: 0.6 } });
      gsap.fromTo(chw, { opacity: 0.14 }, { opacity: 1, ease: 'none', stagger: 0.2, scrollTrigger: { trigger: '[data-ch]', start: 'top 75%', end: 'top 20%', scrub: 0.6 } });
      gsap.fromTo('[data-mq]', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.9, ease: 'power3.out', scrollTrigger: { trigger: '[data-mq]', start: 'top 90%', once: true } });
    }

    const sw = qa('[data-sw]'), sl = qa('[data-sl]'), slots = qa('[data-sw-row] [data-slot]'), rowL = qa('[data-row-l]'), chart = q('[data-chart]'), stage = q('[data-sw-stage]');
    if (desk) {
      gsap.set(sw, { xPercent: -50, yPercent: -50 }); gsap.set(sl, { xPercent: -50 });
      const tg = (i) => { const r = rel(slots[i], stage); return { x: r.x + slots[i].offsetWidth / 2 - sw[i].offsetLeft, y: r.y + slots[i].offsetHeight / 2 - sw[i].offsetTop, s: parseFloat(getComputedStyle(slots[i]).fontSize) / parseFloat(getComputedStyle(sw[i]).fontSize) }; };
      const stl = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: this.pinST(q('[data-sw-sec]'), 3) });
      sw.forEach((w, i) => {
        stl.fromTo(w, { opacity: 0, x: 0, y: 110, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power3.out' }, i);
        stl.fromTo(sl[i], { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power3.out' }, i + 0.1);
        if (i < 4) { stl.to(w, { opacity: 0, y: -110, scale: 0.96, duration: 0.35, ease: 'power2.in' }, i + 0.7); stl.to(sl[i], { opacity: 0, duration: 0.25 }, i + 0.7); }
      });
      stl.to(sl[4], { opacity: 0, duration: 0.25 }, 4.75);
      sw.forEach((w, i) => stl.to(w, { x: () => tg(i).x, y: () => tg(i).y, scale: () => tg(i).s, opacity: 1, duration: 0.9, ease: 'power3.inOut' }, 4.85 + i * 0.06));
      const rtl = getComputedStyle(chart).direction === 'rtl', side = rtl ? '100%' : '0%';
      const lnClip = q('[data-ln-clip]'), lnIn = q('[data-ln-in]'), lp = { p: 0.001 };
      const setLn = () => { gsap.set(lnClip, { scaleX: lp.p, transformOrigin: side + ' 50%' }); gsap.set(lnIn, { scaleX: 1 / lp.p, transformOrigin: side + ' 50%' }); };
      gsap.set(q('[data-ax-x]'), { transformOrigin: side + ' 50%' });
      stl.fromTo(chart, { opacity: 0 }, { opacity: 1, duration: 0.01, immediateRender: true }, 6.45);
      stl.fromTo('[data-ax-y]', { scaleY: 0 }, { scaleY: 1, duration: 0.45, ease: 'power2.out', immediateRender: true }, 6.5);
      stl.fromTo('[data-ax-x]', { scaleX: 0 }, { scaleX: 1, duration: 0.45, ease: 'power2.out', immediateRender: true }, 6.5);
      stl.fromTo(lp, { p: 0.001 }, { p: 1, duration: 0.95, ease: 'power2.inOut', immediateRender: true, onUpdate: setLn }, 6.95);
      setLn();
      stl.fromTo(rowL, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.08 }, 5.6);
      stl.to({}, { duration: 0.7 }, 7.9);
    } else {
      qa('[data-sw-row] > div').forEach((cell, j) => { gsap.fromTo(cell, { opacity: 0, x: 70 }, { opacity: 1, x: 0, ease: 'none', scrollTrigger: { trigger: cell, start: 'top 92%', end: 'top 62%', scrub: 0.6 } }); });
      gsap.set(rowL, { opacity: 1 });
    }

    const bgrid = q('[data-biz-grid]');
    gsap.fromTo(qa('[data-trust-row]'), { opacity: 0, y: 70, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, ease: 'none', stagger: 0.5, scrollTrigger: { trigger: '[data-trust]', start: 'top 75%', end: 'center 55%', scrub: 0.7 } });
    gsap.fromTo(qa('[data-faq-row]'), { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.07, ease: 'power3.out', scrollTrigger: { trigger: '[data-faq]', start: 'top 70%', once: true } });
    gsap.fromTo('[data-glow-drift]', { yPercent: -9, xPercent: -5, scale: 1 }, { yPercent: 9, xPercent: 6, scale: 1.08, ease: 'none', scrollTrigger: { trigger: '[data-dark-wrap]', start: 'top bottom', end: 'bottom top', scrub: 0.8 } });
    this.baSet(this.baP ?? this.baRest());
    if (this.baP == null || this.baP === this.baRest()) { const R0 = this.baRest(), pr = { p: R0 }; this.baSet(R0); this.baHint = gsap.fromTo(pr, { p: R0 + (this.EN_ON ? -0.08 : 0.08) }, { p: R0, immediateRender: false, duration: 1.6, ease: 'power3.inOut', onUpdate: () => this.baSet(pr.p), scrollTrigger: { trigger: '[data-ba]', start: 'top 70%', once: true } }); }
    qa('[data-bz-btn]').forEach((b, bi) => [...b.querySelectorAll('[data-bz-ring]')].forEach((r, ri) => gsap.fromTo(r, { scale: 1, opacity: 0.8 }, { scale: 1.24, opacity: 0, duration: 4, ease: 'power1.out', repeat: -1, delay: ri * 2 + bi * 1 })));
    this.resetFits = () => { bgrid.style.transform = ''; hcol.style.transform = ''; const u = q('[data-sc-units]'); if (u) u.style.transform = ''; document.querySelectorAll('[data-scn]').forEach(e => { e.style.scale = ''; }); document.querySelectorAll('[data-sct], [data-scs]').forEach(e => { e.style.scale = ''; }); };
    if (!desk) bgrid.style.transform = '';

    const cnt = q('[data-count]');
    if (cnt) { const o = { v: 0 }; cnt.textContent = '0'; gsap.to(o, { v: +cnt.getAttribute('data-count'), duration: 1.6, ease: 'power2.out', scrollTrigger: { trigger: cnt, start: 'top 88%', once: true }, onUpdate: () => { cnt.textContent = Math.round(o.v).toLocaleString('en-US'); } }); }
    const stm = q('[data-stm]');
    const A = qa('[data-stm-v="retail"] [data-lw]'), B = qa('[data-stm-v="leads"] [data-lw]');
    gsap.set(A.concat(B), { opacity: 0.16 });
    gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: desk ? this.pinST(stm, 1.6) : { trigger: stm, start: 'top 70%', end: 'bottom 60%', scrub: 0.5 } })
      .to(A, { opacity: 1, duration: 0.25, stagger: { amount: 1 } }, 0).to(B, { opacity: 1, duration: 0.25, stagger: { amount: 1 } }, 0)
      .fromTo(qa('[data-stm-sub]'), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.3 }, 1.05).to({}, { duration: 0.4 });
  }

  rebuildSc() {
    if (!window.__gHomeReady || !window.gsap) return;
    setTimeout(() => { if (this.dead) return; if (this.scCtx) { this.scCtx.revert(); this.scCtx = null; } this.buildSc(); window.ScrollTrigger.refresh(); }, 30);
  }

  buildSc() {
    const gsap = window.gsap, desk = this.desk, q = (s) => document.querySelector(s), qa = (s) => gsap.utils.toArray(s), rel = this.rel;
    this.scCtx = gsap.context(() => {
      const _tl = gsap.timeline;
      gsap.config({ nullTargetWarn: false });
      qa('[data-wave]').forEach((b, i) => gsap.fromTo(b, { scaleY: 0.35 }, { scaleY: 1, duration: 0.55, repeat: -1, yoyo: true, ease: 'sine.inOut', delay: i * 0.08 }));
      const F = this.fx || {}, N = qa('[data-scn]').length, D = 2, TT = N * D + 0.4;
      const units = q('[data-sc-units]');
      const scFit = () => { units.style.transform = ''; const av = units.clientHeight; if (!desk) { qa('[data-scn]').forEach(sc => { sc.style.scale = ''; const a2 = sc.querySelector('[data-sct]'), b2 = sc.querySelector('[data-scs]'); const ch = (a2 ? a2.offsetHeight : 0) + (b2 ? b2.offsetHeight : 0) + 16; const k = Math.min(1, av / Math.max(1, ch)); sc.style.scale = k < 1 ? Math.max(0.55, k).toFixed(4) : ''; }); return; } qa('[data-sct], [data-scs]').forEach(el => { el.style.scale = ''; const k = Math.max(0.78, Math.min(1, av / Math.max(1, el.offsetHeight))); el.style.scale = k < 1 ? k.toFixed(4) : ''; }); };
      this.scMode = true;
      const t = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: this.pinST(q('[data-sc-scene]'), N * (desk ? 1.25 : 0.95), { start: () => { scFit(); return 'top ' + this.pvo() + 'px'; }, onUpdate: (self) => this.scUpdate(self.progress * TT) }) });
      t.fromTo('[data-rail-fill]', { scaleY: 0 }, { scaleY: 1, duration: (N - 1) * D }, 0);
      qa('[data-node-on]').forEach((n, i) => t.fromTo(n, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.2 }, i * D + 0.05));
      const sel = (a, i) => '[data-' + a + '="' + i + '"]';
      for (let i = 0; i < N; i++) {
        const b = i * D;
        if (i === 0) {
          gsap.set([q(sel('sct', 0)), q(sel('scs', 0))], { opacity: 1, y: 0 });
          gsap.fromTo(q(sel('scn', 0)), { opacity: 0, y: 70 }, { opacity: 1, y: 0, ease: 'none', scrollTrigger: { trigger: q('[data-sc-scene]'), start: 'top 90%', end: () => 'top ' + (this.pvo() + 1) + 'px', scrub: 0.6 } });
        } else {
          t.fromTo(sel('sct', i), { opacity: 0, y: 50 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power3.out' }, b + 0.05);
          t.fromTo(sel('scs', i), { opacity: 0, y: 70, rotationX: 12, scale: 0.94 }, { opacity: 1, y: 0, rotationX: 0, scale: 1, duration: 0.55, ease: 'power3.out' }, b + 0.1);
        }
        if (i < N - 1) {
          t.to(sel('sct', i), { opacity: 0, y: -40, duration: 0.28, ease: 'power2.in' }, b + 1.62);
          t.to(sel('scs', i), { opacity: 0, y: -50, scale: 0.97, duration: 0.3, ease: 'power2.in' }, b + 1.6);
        }
        const ms = qa(sel('mstep', i)); if (ms.length) t.fromTo(ms, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.25, stagger: 0.32, ease: 'power3.out' }, b + 0.35);
        const ib = qa(sel('ibx-row', i));
        const ibFly = !!(this.mFly || {})[i];
        if (ib.length && !ibFly) {
          t.fromTo(qa(sel('ibx-frame', i)), { opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'power3.out', immediateRender: true }, b + 0.2);
          t.fromTo(ib, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.25, stagger: 0.1, ease: 'power3.out', immediateRender: true }, b + 0.45);
          const bt = q(sel('ibx-btn', i)); if (bt) t.fromTo(bt, { scale: 1 }, { scale: 1.15, duration: 0.12, ease: 'power2.out' }, b + 1.15).to(bt, { scale: 1, duration: 0.2, ease: 'power2.in' }, b + 1.27);
        }
        if (ib.length && ibFly) {
          ib.forEach((r, j) => { const a = j * 1.7 + 0.4; t.fromTo(r, { opacity: 0, x: Math.cos(a) * 240, y: Math.sin(a) * 160 - 30, rotation: (j % 2 ? 1 : -1) * (7 + j * 2), scale: 0.86 }, { opacity: 1, duration: 0.2, immediateRender: true }, b + 0.3 + j * 0.06); t.to(r, { x: 0, y: 0, rotation: 0, scale: 1, duration: 0.55, ease: 'power3.inOut' }, b + 0.55 + j * 0.05); });
          t.fromTo(qa(sel('ibx-frame', i)), { opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'power3.out' }, b + 0.95);
        }
        if (i === F.connect) {
          const la = q('[data-cx-logo="a"]'), rest = qa('[data-cx-logo]').filter(x => x !== la), card = q(sel('mcard', i));
          t.fromTo([la].concat(rest), { opacity: 0, scale: 0.3, y: 40 }, { opacity: 1, scale: 1, y: 0, duration: 0.4, stagger: 0.09, ease: 'back.out(1.8)', immediateRender: true }, b + 0.15);
          rest.forEach((x, j) => t.to(x, { opacity: 0, x: (j % 2 ? 1 : -1) * 90, y: 40, scale: 0.7, duration: 0.3, ease: 'power2.in' }, b + 0.8 + j * 0.03));
          t.to(la, { scale: 0.22, y: () => -(card ? card.offsetHeight * 0.38 : 120), opacity: 0, duration: 0.45, ease: 'power3.in' }, b + 0.82);
          if (card) t.fromTo(card, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 0.45, ease: 'power3.out', immediateRender: true }, b + 1.0);
        }
        const scn = q(sel('scan', i)); if (scn) t.fromTo(scn, { yPercent: 0, opacity: 1 }, { yPercent: 100, duration: 1.15, ease: 'none', immediateRender: true }, b + 0.25).to(scn, { opacity: 0, duration: 0.2 }, b + 1.4);
        const ab = qa(sel('abar', i)); if (ab.length) t.fromTo(ab, { scaleY: 0 }, { scaleY: 1, duration: 0.35, stagger: 0.07, ease: 'power3.out' }, b + 0.4);
        const pr = qa(sel('prow', i)); if (pr.length) t.fromTo(pr, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.22, stagger: 0.09, ease: 'power3.out' }, b + (i === F.type ? 0.95 : i === F.amount ? 1.1 : i === F.connect ? 1.2 : 0.45));
        const qu = q(sel('mq-quote', i)); if (qu) t.fromTo(qu, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out' }, b + 0.35);
        const ky = q(sel('keys', i)); if (ky) t.fromTo(ky, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.25, ease: 'power3.out' }, b + 1.2);
        const hlx = q(sel('hl', i)); if (hlx && i !== F.type) t.fromTo(hlx, { opacity: 0 }, { opacity: 1, duration: 0.15 }, b + 1.0);
      }
      const at = (i) => i * D;
      if (F.clock != null) t.fromTo('[data-clock]', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power3.out' }, at(F.clock) + 0.15);
      if (F.amount != null) {
        const stg = q(sel('scs', F.amount)), big = q('[data-amt-big]'), slot = q('[data-amt-slot]');
        const ta = () => { const r = rel(slot, stg); return { x: r.x + slot.offsetWidth / 2 - big.offsetLeft, y: r.y + slot.offsetHeight / 2 - big.offsetTop, s: parseFloat(getComputedStyle(slot).fontSize) / parseFloat(getComputedStyle(big).fontSize) }; };
        gsap.set(big, { xPercent: -50, yPercent: -50 });
        t.fromTo(big, { opacity: 0, x: 0, y: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'power3.out' }, at(F.amount) + 0.2)
          .to(big, { x: () => ta().x, y: () => ta().y, scale: () => ta().s, duration: 0.6, ease: 'power3.inOut' }, at(F.amount) + 0.65);
      }
      if (F.type != null) {
        const b = at(F.type);
        t.fromTo(sel('hl', F.type), { opacity: 0 }, { opacity: 1, duration: 0.12 }, b + 1.3);
        const hr = q(sel('prow', F.type));
        if (hr) t.fromTo(hr, { scale: 1 }, { scale: 1.03, duration: 0.07 }, b + 1.42).to(hr, { scale: 1, duration: 0.12 }, b + 1.49);
      }
      if (F.dots != null) {
        const b = at(F.dots), stg = q(sel('scs', F.dots)), tgt = q('[data-dot-tgt="yes"]'), dots = qa('[data-dot]'), card = q(sel('mcard', F.dots));
        const tc = () => { const r = rel(tgt, stg); return { x: r.x + tgt.offsetWidth / 2, y: r.y + tgt.offsetHeight / 2 }; };
        if (card) t.fromTo(card, { opacity: 0 }, { opacity: 0, duration: 0.01 }, b);
        t.fromTo(dots, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.2, stagger: { amount: 0.4, from: 'random' }, ease: 'back.out(2)' }, b + 0.12);
        if (tgt) dots.forEach((d, i) => t.to(d, { x: () => tc().x - d.offsetLeft - d.offsetWidth / 2 + ((i % 9) - 4) * 9, y: () => tc().y - d.offsetTop - d.offsetHeight / 2 + ((i % 5) - 2) * 4, duration: 0.5, ease: 'power3.in' }, b + 0.62 + (i % 20) * 0.006));
        if (card) t.fromTo(card, { opacity: 0, y: 26, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power3.out', immediateRender: false }, b + 1.0);
        t.to(dots, { opacity: 0, duration: 0.1 }, b + 1.12);
      }
      if (F.night != null) {
        const b = at(F.night), card = q(sel('mcard', F.night));
        t.fromTo('[data-night]', { y: 0, yPercent: -101, opacity: 1 }, { y: 0, yPercent: 0, opacity: 1, duration: 0.28, ease: 'power3.inOut' }, b - 0.12);
        if (card) t.fromTo(card, { opacity: 0 }, { opacity: 0, duration: 0.01 }, b);
        t.fromTo(sel('p-ink', F.night), { opacity: 0 }, { opacity: 0, duration: 0.01 }, b);
        t.fromTo('[data-night-block]', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power3.out' }, b + 0.3);
        t.fromTo(qa('[data-chk]'), { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.08, stagger: 0.045, ease: 'back.out(2)' }, b + 0.45);
        t.to('[data-night-block]', { opacity: 0, y: -20, duration: 0.2 }, b + 1.15);
        t.to('[data-night]', { y: 0, yPercent: 101, duration: 0.3, ease: 'power3.inOut' }, b + 1.15);
        t.to('[data-p-white]', { opacity: 0, duration: 0.15 }, b + 1.2).to(sel('p-ink', F.night), { opacity: 1, duration: 0.2 }, b + 1.3);
        if (card) t.fromTo(card, { opacity: 0, y: 36, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: 'power3.out', immediateRender: false }, b + 1.3);
        const pr = qa(sel('prow', F.night)); if (pr.length) t.fromTo(pr, { opacity: 0 }, { opacity: 1, duration: 0.15, stagger: 0.06 }, b + 1.4);
      }
      if (F.count != null) {
        const b = at(F.count);
        t.fromTo('[data-g-fill]', { scaleX: 0 }, { scaleX: F.fill, duration: 0.9, ease: 'power2.out' }, b + 0.3);
        t.fromTo('[data-stat-note]', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.3 }, b + 0.95);
      }
      t.to({}, { duration: 0.4 }, N * D);
      this.scUpdate(0);
    });
  }

  scUpdate(t) {
    const F = this.fx || {}, c = (v) => Math.min(1, Math.max(0, v)), D = 2, s = this.state;
    const sec = F.clock != null ? String(Math.round(c((t - F.clock * D - 0.3) / 0.9) * F.secT)).padStart(2, '0') : s.sec;
    const typed = F.type != null ? Math.ceil(c((t - F.type * D - 0.25) / 0.6) * (F.typeLen || 1)) : null;
    const closed = F.night != null ? Math.round(c((t - F.night * D - 0.45) / 0.63) * 14) : 14;
    const count = F.count != null ? Math.round(c((t - F.count * D - 0.3) / 0.9) * F.countT) : null;
    if (s.sec !== sec || s.typed !== typed || s.closed !== closed || s.count !== count) this.setState({ sec, typed, closed, count });
  }

  magMove = (e) => {
    const g = window.gsap, z = e.currentTarget; if (!g || !z) return;
    const r = z.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const btn = z.querySelector('[data-bz-btn]'), inn = z.querySelector('[data-bz-in]'), halo = z.querySelector('[data-bz-halo]');
    g.to(halo, { opacity: 1, scale: 1.1, duration: 0.5, ease: 'power3.out', overwrite: 'auto' });
    if (this.reduce) return;
    g.to(btn, { x: dx * 0.16, y: dy * 0.16, scale: 1.04, duration: 0.5, ease: 'power3.out', overwrite: 'auto' });
    g.to(inn, { x: dx * 0.1, y: dy * 0.1, duration: 0.5, ease: 'power3.out', overwrite: 'auto' });
    g.to(halo, { x: dx * 0.3, y: dy * 0.3, duration: 0.6, ease: 'power3.out', overwrite: 'auto' });
  };
  magLeave = (e) => {
    const g = window.gsap, z = e.currentTarget; if (!g || !z) return;
    const btn = z.querySelector('[data-bz-btn]'), inn = z.querySelector('[data-bz-in]'), halo = z.querySelector('[data-bz-halo]');
    g.to([btn, inn], { x: 0, y: 0, scale: 1, duration: 0.9, ease: 'elastic.out(1, 0.45)', overwrite: 'auto' });
    g.to(halo, { opacity: 0, x: 0, y: 0, scale: 1, duration: 0.6, ease: 'power2.out', overwrite: 'auto' });
  };

  baSet(p) {
    this.baP = Math.min(1, Math.max(0, p));
    const st = document.querySelector('[data-ba]'); if (!st) return;
    const w = st.clientWidth, x = Math.round(this.baP * w);
    const af = st.querySelector('[data-ba-after]'), ln = st.querySelector('[data-ba-line]');
    const ltr = getComputedStyle(st).direction === 'ltr';
    if (af) af.style.clipPath = ltr ? 'inset(0 0 0 ' + x + 'px)' : 'inset(0 ' + (w - x) + 'px 0 0)';
    if (ln) ln.style.transform = 'translateX(' + x + 'px)';
  }
  baRest() { return this.EN_ON ? 0.4 : 0.6; }
  baFromEvent(e) { const st = document.querySelector('[data-ba]'); if (!st) return; const r = st.getBoundingClientRect(); this.baSet((e.clientX - r.left) / r.width); }
  baDown = (e) => { this.baDrag = true; if (this.baHint) this.baHint.kill(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} this.baFromEvent(e); };
  baMove = (e) => { if (this.baDrag) this.baFromEvent(e); };
  baUp = () => { this.baDrag = false; };
  baKey = (e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); this.baSet((this.baP ?? this.baRest()) - 0.05); } if (e.key === 'ArrowRight') { e.preventDefault(); this.baSet((this.baP ?? this.baRest()) + 0.05); } };
  ask(i) {
    clearInterval(this.tTimer); clearTimeout(this.tWait);
    const W = __D.GOTCHA_HOME.WEEK[this.state.w6], full = W.qs[i][1];
    if (this.reduce) { this.setState({ tq: i, tn: full.length, tph: 'done' }); return; }
    this.setState({ tq: i, tn: 0, tph: 'dots' });
    this.tWait = setTimeout(() => {
      this.setState({ tph: 'typing' });
      this.tTimer = setInterval(() => { const n = this.state.tn + 2; if (n >= full.length) { clearInterval(this.tTimer); this.setState({ tn: full.length, tph: 'done' }); } else this.setState({ tn: n }); }, 22);
    }, 900);
  }

  faqSync(first) {
    const g = window.gsap, open = this.state.faq;
    document.querySelectorAll('[data-faq-a]').forEach(el => {
      const k = +el.getAttribute('data-faq-a'), on = k === open, ic = document.querySelector('[data-faq-i="' + k + '"]'), inn = el.firstElementChild;
      const was = el.getAttribute('data-open') === '1'; if (!first && was === on) return;
      el.setAttribute('data-open', on ? '1' : '0');
      if (!g || this.reduce || first) { el.style.height = on ? 'auto' : '0px'; if (ic) ic.style.transform = on ? 'rotate(45deg)' : ''; return; }
      if (on) { g.fromTo(el, { height: el.offsetHeight }, { height: 'auto', duration: 0.6, ease: 'power3.out', overwrite: true }); g.fromTo(inn, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, delay: 0.1, ease: 'power3.out' }); }
      else g.to(el, { height: 0, duration: 0.5, ease: 'power3.inOut', overwrite: true });
      if (ic) g.to(ic, { rotation: on ? 45 : 0, duration: 0.45, ease: 'power3.out' });
    });
  }

  offerClose() {
    if (this.offerClosing) return; this.offerClosing = true;
    this.offerDismissed = true; try { localStorage.setItem('gotcha-offer-dismissed', '1'); } catch (e) {}
    const g = window.gsap, dr = document.querySelector('[data-drawer]'), ov = document.querySelector('[data-offer-ov]');
    const done = () => { this.offerClosing = false; this.setState({ offerOpen: false }); };
    if (!g || this.reduce || !dr) { done(); return; }
    const mob = matchMedia('(max-width: 860px)').matches;
    g.to(dr, mob ? { yPercent: 105, duration: 0.45, ease: 'power3.in', overwrite: true } : { xPercent: 106, opacity: 0.4, duration: 0.5, ease: 'power3.in', overwrite: true });
    g.to(ov, { opacity: 0, duration: 0.45, ease: 'power2.in', overwrite: true, onComplete: done });
  }
  offerIn() {
    const g = window.gsap, dr = document.querySelector('[data-drawer]'), ov = document.querySelector('[data-offer-ov]');
    if (!dr) return;
    if (!g || this.reduce) { if (ov) ov.style.opacity = '1'; return; }
    g.fromTo(ov, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power2.out', overwrite: true });
    const mob = matchMedia('(max-width: 860px)').matches;
    if (mob) g.fromTo(dr, { yPercent: 105, xPercent: 0, opacity: 1 }, { yPercent: 0, duration: 0.7, ease: 'power4.out', overwrite: true });
    else g.fromTo(dr, { xPercent: 106, opacity: 0.4 }, { xPercent: 0, opacity: 1, duration: 0.8, ease: 'power4.out', overwrite: true });
    const kids = dr.querySelectorAll('li, h2, h3, a, button');
    if (kids.length) g.fromTo(kids, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.04, delay: 0.25, ease: 'power3.out' });
  }
  offerAuto = () => {
    if (this.autoOpened || this.state.offerOpen || !consentDecided()) return;
    let gone = false; try { gone = localStorage.getItem('gotcha-offer-dismissed') === '1'; } catch (e) {}
    if (gone || this.offerDismissed) { this.autoOpened = true; return; }
    if (window.scrollY > window.innerHeight * 0.45) { this.autoOpened = true; this.setState({ offerOpen: true }); }
  };

  animBiz(prev, next) {
    const g = window.gsap, red = this.reduce || !g || !window.__gHomeReady;
    const sel = (k, v) => '[data-' + k + '="' + v + '"]';
    const kinds = ['glow', 'stm-v'];
    if (red) { kinds.forEach(k => { const a = document.querySelector(sel(k, prev)), b = document.querySelector(sel(k, next)); if (a) { a.style.opacity = '0'; a.style.visibility = 'hidden'; } if (b) { b.style.opacity = '1'; b.style.visibility = 'visible'; } }); return; }
    g.to(sel('glow', prev), { autoAlpha: 0, duration: 0.9, overwrite: true }); g.to(sel('glow', next), { autoAlpha: 1, duration: 0.9, overwrite: true });
    g.to(sel('stm-v', prev), { autoAlpha: 0, duration: 0.4, overwrite: true }); g.to(sel('stm-v', next), { autoAlpha: 1, duration: 0.6, delay: 0.2, overwrite: true });
  }

  renderVals() {
    const s = this.state, T = (x) => this.T(x);
    const mode = this.pvMode(), ph = mode === 'phone';
    const setPv = (m) => { localStorage.setItem('gotcha-preview-mode', m); window.scrollTo(0, 0); this.setState({ pvMode: m }, this.fitPv); };
    const on = ['#FAF8F4', '#16150F'], off = ['transparent', '#A29D95'];
    const pv = { show: false, isPhone: ph, scale: this.calcScale(), src: location.pathname.split('/').pop() + '?embed=1' + (this.TALK ? '&page=talk' : this.ECOM ? '&page=ecommerce' : this.LEADS ? '&page=leads' : this.WHY ? '&page=why' : this.OFFER ? '&page=offer' : ''), label: ph ? 'iPhone 18 Pro · 402 × 874' : 'מחשב · רוחב מלא', setDesktop: () => setPv('desktop'), setPhone: () => setPv('phone'), dBg: (ph ? off : on)[0], dFg: (ph ? off : on)[1], pBg: (ph ? on : off)[0], pFg: (ph ? on : off)[1] };
    const H = __D.GOTCHA_HOME;
    if (!H) return { pv, bar: { show: false }, nav: { items: [] }, offer: {}, hero: { words: [], bullets: [] }, ch: { halves: [], words: [] }, stats: [], biz: { cards: [], demos: [], stm: [] }, lang: {}, isHome: !this.TALK && !this.SOL && !this.WHY && !this.OFFER && !this.PRICE, isPrice: this.PRICE, pr: this.PRICE ? this.prVals() : this.PR0, isWhy: this.WHY, isOffer: this.OFFER, op: this.OFFER ? this.opVals() : this.OP0, wy: this.WHY ? this.wyVals() : this.WY0, isTalk: this.TALK, isEcom: this.SOL, ec: { w1: [], w2: [], bubbles: [], aw: [], stats: [], cases: [], alone: [], stops: [], qw: [], proof: [], cw: [], howSteps: [], feats: [], soon: [], howLogos: [] }, tk: { w1: [], w2: [], points: [], promise: [], ways: [] }, links: { home: '#top', talk: '#top', offer: '#top', onboarding: '#top', demo: 'https://calendar.app.google/pwKViwkRwQTeibnX9' }, wk: { tabs: [], rows: [], qs: [] }, sc: { moments: [] }, fx: {}, dots: [], night: [], ucTabs: [], uc: { does: [], stats: [] }, faqs: [], cta: {} };

    const NAV = [['Product', 'product'], ['Solutions', 'solutions'], ['Our Company', 'company'], ['Why us'], ['Pricing'], ['First month free!', null, true]];
    const mapMenu = (m) => ({ cols: m.cols.map((c, i) => ({ key: i, t: T(c.t), d: T(c.d), icon: c.icon, bg: c.bg, ic: c.ic, items: c.items.map((it, j) => ({ key: j, t: T(it.t), n: T(it.n), icon: it.icon, href: this.pageUrl(it.page) })) })), railKicker: T(m.railKicker), railTitle: T(m.railTitle), railBody: T(m.railBody), railLink: T(m.railLink), railShot: m.railShot });
    const nav = {
      items: NAV.map(([t, key, hot], i) => ({ key: i, t: T(t), hasMenu: !!key, open: s.menu === key && !!key, rot: s.menu === key && key ? '180deg' : '0deg', bg: s.menu === key && key ? 'rgba(22,21,15,.07)' : 'transparent', fg: hot ? '#C4552F' : 'inherit', weight: hot ? '700' : '500',
        enter: () => { clearTimeout(this.navT); if (key) { if (this.state.menu !== key) this.setState({ menu: key }); } else if (this.state.menu) { this.navT = setTimeout(() => this.setState({ menu: null }), 280); } }, click: () => { if (!key && t === 'Why us') { this.setState({ menu: null }); if (!this.WHY) location.href = this.whyUrl(); return; } const go = { 'Pricing': 'pricing', 'First month free!': 'offer' }[t]; if (!key && go) { location.href = this.pageUrl(go); return; } this.setState({ menu: key && s.menu !== key ? key : null }); } })),
      menu: s.menu && H.MENUS[s.menu] ? mapMenu(H.MENUS[s.menu]) : null, hasMenu: !!(s.menu && H.MENUS[s.menu]),
      close: () => { clearTimeout(this.navT); this.navT = setTimeout(() => { if (this.state.menu) this.setState({ menu: null }); }, 320); },
      keep: () => clearTimeout(this.navT),
      login: T('Login'), cta: T('Book a demo'), burgerIcon: s.mnav ? 'x' : 'menu', burger: () => this.setState({ mnav: !s.mnav, menu: null }), mOpen: s.mnav,
      login: T('Log in'),
      mGroups: [['Product', 'product'], ['Solutions', 'solutions'], ['Our Company', 'company']].map(([t, k]) => { const open = s.mg === k; return { key: k, t: T(t), open, rot: open ? '45deg' : '0deg', sign: '+', fg: '#16150F', tap: () => this.setState({ mg: open ? null : k }), items: [].concat(...H.MENUS[k].cols.map(c => c.items)).map((it, j) => ({ key: j, t: T(it.t), n: T(it.n), icon: it.icon, href: this.pageUrl(it.page) })) }; }).concat([['Why us', 'why'], ['Pricing', 'pricing'], ['First month free!', 'offer']].map(([t, k]) => ({ key: k, t: T(t), open: false, rot: this.EN_ON ? '0deg' : '180deg', sign: '→', fg: k === 'offer' ? '#C4552F' : '#16150F', items: [], tap: () => { if (k === 'why') { this.setState({ mnav: false }); if (!this.WHY) { location.href = this.whyUrl(); return; } if (this.lenis) this.lenis.scrollTo(0); else window.scrollTo(0, 0); return; const el = document.getElementById('scenarios'); setTimeout(() => { if (el && this.lenis) this.lenis.scrollTo(el); else if (el) window.scrollTo(0, el.getBoundingClientRect().top + scrollY); }, 50); return; } location.href = this.pageUrl(k); } })))
    };
    const dismiss = () => { this.offerDismissed = true; localStorage.setItem('gotcha-offer-dismissed', '1'); };
    const offer = { badge: T('Launch offer'), barText: T('First month free, no commitment! For the first 50 businesses.'), seeMore: T('See more'), tabLabel: T('First month free'), title: T('Your first month free!'), price: T('Free'), priceNote: T('for the first month, no commitment'),
      items: ['1,000 credits for the month', 'Connection, onboarding and personal guidance from us', 'For the first 50 businesses', 'The free month starts once you are connected'].map((x, i) => ({ key: i, t: T(x) })),
      closeLabel: T('Close'), terms: T('Offer ends 31 December 2026 or when 50 businesses have joined, whichever comes first. After the first month you continue on the plan and usage you choose, with no commitment. Regular pricing starts at $39 a month, excluding 18% VAT.'),
      open: s.offerOpen, tabShown: !s.offerOpen, close: () => this.offerClose(), toggle: () => { if (s.offerOpen) { this.offerClose(); return; } this.setState({ offerOpen: true }); } };
    const h1 = this.EN_ON ? 'Every customer interaction, end to end' : T('Every customer interaction, end to end').replace(/,\s*/, ' - ');
    const hero = { h1, words: h1.split(' ').map((t, i) => ({ key: i, t })), placeholder: 'הכניסו את כתובת האתר', aria: T('your website address'), button: 'קראו את האתר שלי',
      sub: T('From WhatsApp messages to phone calls, GOTCHA manages every customer interaction in one place,\u00a0 with AI employees tailored to your business, working alongside your team.'),
      bullets: ['No card to start your trial', 'Cancel whenever you want', 'Simple Setup & Dedicated Support'].map((x, i) => ({ key: i, t: T(x) })), submit: (e) => { e.preventDefault(); if (!this.siteOk()) { this.setState({ siteErr: true }); const f = document.querySelector('[data-h-field]'); const inp = f && f.querySelector('input'); if (inp) inp.focus(); if (f && window.gsap && !this.reduce) window.gsap.fromTo(f, { x: 0 }, { keyframes: { x: [-9, 8, -6, 4, -2, 0] }, duration: 0.5, ease: 'power2.out' }); return; } this.setState({ siteErr: false }); this.goOnboarding(this.state.heroSite); }, site: s.heroSite || '', onSite: (e) => this.setState({ heroSite: e.target.value, siteErr: false }), err: !!s.siteErr, errText: this.EN_ON ? 'Enter your website address to continue' : 'צריך להכניס כתובת אתר כדי להמשיך', ring: s.siteErr ? '0 30px 70px -24px rgba(22,21,15,.45),0 0 0 2px #C4552F' : '0 30px 70px -24px rgba(22,21,15,.45),0 0 0 1px rgba(22,21,15,.06)' };
    const st9 = s.tstep;
    const LTRACE = [['קורא מה היא שאלה', 'מחיר · התאמה למתחילות'], ['מזהה את הפונה', 'ליד חדש · אינסטגרם'], ['בודק את מחירון התוכניות', '3 חודשים · ₪1,890'], ['בודק אפשרויות תשלום', 'עד 3 תשלומים'], ['בודק את היומן', 'מחר 10:00 / 18:00'], ['בודק מה מותר לו', 'בלי הנחות בלי אישור'], ['שואל את מה שחסר', 'מטרה · ניסיון קודם'], ['מכין בריף למאמנת', 'ליד חם · שיחת היכרות'], ['כותב לה', 'בשפה שלה']];
    const mkTrace = (rows) => rows.map((x, i) => ({ key: i, t: T(x[0]), r: st9 > i ? T(x[1]) : '', c: st9 > i ? (i === 5 ? '#8A6A16' : '#4F7A2E') : '#DCD8D0', o: st9 > i ? 1 : 0.35 }));
    const tagz = (rows) => rows.map((x, i) => ({ key: i, t: T(x[0]), bg: x[1], fg: x[2] }));
    const BZd = H.BIZ;
    const demos = [
      { key: 'retail', icon: '/assets/v8/icons/whatsapp.svg', title: T('WhatsApp · 02:14'), meta: T('nobody on your team was awake'), msg: T("My package still hasn't arrived and I've been waiting two weeks. This was a gift."),
        tags: tagz([['Shipping issue', '#FBEEE8', '#8E3418'], ['Frustrated', '#FBEEE8', '#8E3418'], ['Gift · date passed', '#F0EDE7', '#6B6660']]),
        reply: 'אני מצטער, הזמנה #1842 תקועה אצל חברת המשלוחים מיום שלישי, וזה לא מספיק טוב. מה תעדיפי: זיכוי לכרטיס, קרדיט לחנות, או שנשלח לך אחת חדשה כבר מחר?',
        sent: 'נשלח 02:14 · 31 שניות אחרי שכתבה · מחכה לבחירה שלה', trace: mkTrace(H.TRACE.map((x, j) => j === 6 ? ['מכין שלוש אפשרויות', 'זיכוי · קרדיט · משלוח חדש'] : x)), cta: T(BZd.retail.cta), ctaNote: T(BZd.retail.ctaNote) },
      { key: 'leads', icon: '/assets/v8/icons/instagram.svg', title: T(BZd.leads.demoTitle), meta: T(BZd.leads.demoMeta), msg: BZd.leads.demo[0].t,
        tags: tagz([['תוכנית ליווי', '#EAE4FB', '#4B3E8E'], ['ליד חדש', '#EAE4FB', '#4B3E8E'], ['מחוץ לשעות העבודה', '#F0EDE7', '#6B6660']]),
        reply: BZd.leads.demo[2].t, sent: 'נשלח 21:40 · 14 שניות אחרי שכתבה · שני מועדים שמורים ביומן', trace: mkTrace(LTRACE), cta: T(BZd.leads.cta), ctaNote: T(BZd.leads.ctaNote) }
    ];
    const chItems = this.CH.map(([t, f], i) => ({ key: i, t: T(t), icon: '/assets/v8/icons/' + f }));
    const chLabel = 'עובדים בכל מקום שהלקוחות שלכם נמצאים';
    const chL = T(chLabel);
    const ch = { label: chL, words: chL.split(' ').map((t, i) => ({ key: i, t })), statsLabel: T('first response time'), halves: [{ key: 'a', hidden: 'false', items: chItems }, { key: 'b', hidden: 'true', items: chItems.map(c => Object.assign({}, c, { key: 'b' + c.key })) }] };
    const stats = [['מהירה יותר', 'התגובה הראשונה ללקוח'], ['קצר יותר', 'זמן הפתרון הממוצע'], ['גבוה יותר', 'שיעור הפתרון בפנייה הראשונה'], ['יותר', 'שיחות לכל איש צוות'], ['פחות', 'פניות שמתפספסות']].map((x, i) => ({ key: i, w: x[0], l: x[1], color: i === 4 ? '#C4552F' : '#16150F', top: i < 3, bottom: i >= 3 }));

    const BZ = H.BIZ;
    const CARDS = [{ key: 'retail', t: 'Retail or ecommerce', tag: 'You sell products', d: 'Orders, deliveries, returns, sizes, stock. Most of what people write to you already has an answer inside your store.' }, { key: 'leads', t: 'Leads and enquiries', tag: 'You sell work', d: 'Quotes, availability, appointments, follow-ups. The money is in answering first and asking the right three questions.' }];
    const bubble = (side) => side === 'out' ? 'align-self:flex-end;max-width:90%;background:#16150F;color:#F7F5F1;border-radius:18px 18px 6px 18px;padding:13px 16px;font-size:15.5px;line-height:1.5' : side === 'trace' ? "font:400 12.5px 'IBM Plex Mono',Heebo,monospace;color:#5B564D" : 'align-self:flex-start;max-width:86%;background:#F5F2EC;border-radius:18px 18px 18px 6px;padding:13px 16px;font-size:15.5px;line-height:1.5';
    const biz = { demos, started: st9 >= 8, typing: st9 === 8, done: st9 >= 9, writing: T('writing'), traceTitle: T('What it did before answering'), replayLabel: T('replay ↻'),
      foot: T('Your rules determine what GOTCHA can handle automatically, what requires approval, and when a team member should step in.'),
      replay: () => { if (this.demoST && this.lenis) this.lenis.scrollTo(this.demoST.start, { duration: 1.2 }); },
      h2so: 'אז', h2a: T('What is your'), h2b: T('business model'), h2: 'אז ' + T('What is your') + ' ' + T('business model') + '?', pick: T('Pick yours'),
      cards: CARDS.map(c => { const onn = s.biz === c.key; return { key: c.key, t: T(c.t), tag: T(c.tag), d: T(c.d), hint: T(onn ? 'Showing below' : 'Show me this instead'), on: onn, bg: onn ? '#FAF8F4' : '#16150F', fg: onn ? '#16150F' : '#FAF8F4', bd: onn ? '#FAF8F4' : 'rgba(250,248,244,.38)', tagFg: onn ? '#5B564D' : '#B8B3AA', shadow: onn ? '0 30px 60px -22px rgba(0,0,0,.7)' : 'none', hintFg: onn ? '#A8C57A' : '#E8946E', mt: c.key === 'leads' ? 'clamp(80px, 16vh, 170px)' : '0px', pick: () => this.setState({ biz: c.key, w6: c.key === 'leads' ? Math.max(0, (H.WEEK || []).findIndex(x => x.t === 'מכירות לידים')) : 0 }), move: this.magMove, leave: this.magLeave }; }),
      stm: ['retail', 'leads'].map(k => ({ key: k, accent: k === 'retail' ? '#A8C57A' : '#C9BCF7', kicker: T(BZ[k].kicker), words: T(BZ[k].h).replace(/[.]\s*$/, '').split(' ').map((w, i) => ({ key: i, t: w })), sub: T(BZ[k].sub) })) };

    const b = BZ[s.biz], leads = s.biz === 'leads', accent = leads ? '#C9BCF7' : '#A8C57A';
    const PILL = { stalled: ['#FBEEE8', '#C4552F'], allowed: ['#EDF4E7', '#2E7D5B'], 'ask first': ['#F7F0E2', '#8A6A16'], never: ['#EFEAE1', '#7A6A4F'], booked: ['#EDF4E7', '#2E7D5B'], synced: ['#EDF1F7', '#3E5C99'], open: ['#EAE4FB', '#4B3E8E'], done: ['#EDF4E7', '#2E7D5B'] , ai: ['#EAE4FB', '#4B3E8E'], 'אצלכם': ['#FBEEE8', '#8E3418'], you: ['#FBEEE8', '#8E3418'] , 'נלמד': ['#EDF4E7', '#2E7D5B'], 'מחובר': ['#EDF4E7', '#2E7D5B'] };
    const fx = { secT: leads ? 9 : 19 };
    const MBc = { in: 'max-width:88%;background:#262521;color:#F7F5F1;border-radius:13px 13px 13px 4px;padding:8px 13px;font-size:14px;line-height:1.45', out: 'max-width:88%;background:#F7F5F1;color:#16150F;border-radius:13px 13px 4px 13px;padding:8px 13px;font-size:14px;line-height:1.45', trace: "font:400 11.5px 'IBM Plex Mono',Heebo,monospace;color:#8E8A83;padding:0 4px;line-height:1.4" };
    const MB = { in: 'max-width:88%;background:#262521;color:#F7F5F1;border-radius:14px 14px 14px 4px;padding:12px 15px;font-size:15px;line-height:1.5', out: 'max-width:88%;background:#F7F5F1;color:#16150F;border-radius:14px 14px 4px 14px;padding:12px 15px;font-size:15px;line-height:1.5', trace: "font:400 12px 'IBM Plex Mono',Heebo,monospace;color:#8E8A83;padding:2px 4px;line-height:1.5" };
    this.mFly = {};
    const moments = b.moments.map((m, i) => {
      const kind = m.inbox ? 'inbox' : m.msgs ? 'chat' : m.panel ? 'panel' : 'stat', dark = m.panel === 'dark';
      const title = T(m.title || ''), cursor = /\|$/.test(title), tt = title.replace(/\|$/, '');
      const fxClock = kind === 'chat' && i === b.moments.findIndex(x => x.msgs && !x.inbox), fxAmount = m.label === 'Above your limit', fxDots = m.label === 'Where the money is', fxNight = m.label === 'Your morning', fxCount = kind === 'stat';
      const am = fxAmount ? tt.match(/₪[\d,]+/) : null;
      if (fxClock) fx.clock = i; if (am) fx.amount = i; if (cursor) { fx.type = i; fx.typeLen = tt.length; } if (fxDots) fx.dots = i; if (fxNight) fx.night = i; if (m.connectLogos) fx.connect = i; if (m.inbox && m.inbox.fly) { this.mFly = this.mFly || {}; this.mFly[i] = true; }
      let suffix = '', num = 0;
      if (fxCount) { const bg = T(m.big); const mm = bg.match(/^(\d+)(.*)$/); num = mm ? +mm[1] : 0; suffix = mm ? mm[2] : bg; fx.count = i; fx.countT = num; fx.fill = /%/.test(suffix) ? num / 100 : 1; }
      const shownTitle = cursor ? tt.slice(0, s.typed == null ? tt.length : s.typed) : tt;
      const keys = (m.keys || []).map((k, j) => Object.assign({ key: j, hot: j === 0 ? 'yes' : 'no', letter: k.key, t: T(k.t) }, j === 0 ? (dark ? { bg: '#F7F5F1', fg: '#16150F', bd: '#F7F5F1', keyBd: '#C8C2B6' } : { bg: '#16150F', fg: '#F7F5F1', bd: '#16150F', keyBd: '#4A4740' }) : (dark ? { bg: '#262521', fg: '#F7F5F1', bd: '#2E2C28', keyBd: '#4A4740' } : { bg: '#FFFFFF', fg: '#16150F', bd: '#E8E3D9', keyBd: '#DCD8D0' })));
      return {
        key: s.biz + i, i, n: String(i + 1).padStart(2, '0'), label: T(m.label), t: T(m.t).replace(/[.。]\s*$/, ''), note: T(m.note), screen: T(m.screen || m.label), time: T(m.time), icon: m.icon || 'sparkles', accent,
        isChat: kind === 'chat', isPanel: kind === 'panel', isStat: kind === 'stat', isInbox: kind === 'inbox',
        inbox: m.inbox ? { title: m.inbox.title, count: m.inbox.count, views: [['ממתין בתור', '2'], ['מוקצה לי', '4'], ['פעיל', '6'], ['מנוהל ע״י GOTCHA', '4'], ['טופל', '']].map((v, j) => { const on = v[0] === m.inbox.view; return { key: j, t: v[0], c: v[1], bg: on ? '#2A2925' : 'transparent', fg: on ? '#FAF8F4' : '#B8B3AA', w: on ? 600 : 400, cc: on ? '#E8C27A' : '#8E8A83' }; }),
          rows: m.inbox.rows.map((r, j) => ({ key: j, icon: '/assets/v8/icons/' + r.icon, ini: r.ini, n: r.n, s: r.s, time: r.time, badge: r.badge || '', btn: r.btn || '', bg: r.on ? '#F1ECE4' : '#FFFFFF', bd: r.on ? '#E2D8C8' : '#EDE9E1', tags: (r.tags || []).map((g, q) => ({ key: q, t: g[0], dot: g[1] === 'sla', bg: g[1] === 'sla' ? '#FBE3DA' : g[1] === 'ai' ? '#EAE4FB' : '#EFEAE1', fg: g[1] === 'sla' ? '#8E3418' : g[1] === 'ai' ? '#4B3E8E' : '#6B6660' })) })) } : { views: [], rows: [] }, ibFly: !!(m.inbox && m.inbox.fly),
        segBg: dark ? '#262521' : '#F0EDE7', segL0: T('Do it'), segL1: T('Ask me'), segL2: T('Never'),
        fxClock, fxAmount: !!am, fxDots, fxNight, scan: !!m.scan, fxConnect: !!m.connectLogos, chLogo: kind === 'chat' ? (/whatsapp|וואטסאפ/i.test(m.screen || '') ? '/assets/v8/icons/whatsapp.svg' : /instagram|אינסטגרם/i.test(m.screen || '') ? '/assets/v8/icons/instagram.svg' : '') : '', noChLogo: !(kind === 'chat' && /whatsapp|וואטסאפ|instagram|אינסטגרם/i.test(m.screen || '')), showKicker: !fxNight, chart: (m.chart || []).map((v, j, arr) => ({ key: j, h: v + '%', c: j === arr.length - 1 ? '#3F6323' : '#ABC57A', d: m.chartDays[j] })), hasChart: !!m.chart, clock: fxClock ? (T(m.screen).split('·').pop() || '').trim() : '',
        msgs: (m.msgs || []).map((g, j) => ({ key: j, t: T(g.t), meta: T(g.meta || ''), st: ((m.msgs.length > 3 ? MBc : MB)[g.side]) || MB.in, align: g.side === 'out' ? 'flex-end' : 'flex-start' })),
        panelBg: dark ? '#16150F' : '#FFFFFF', panelFg: dark ? '#F7F5F1' : '#16150F', panelBd: dark ? '#16150F' : '#E8E3D9', panelMuted: dark ? '#8E8A83' : '#8E887C', panelLine: dark ? '#2A2823' : '#EFEAE1', quoteBg: dark ? '#262521' : '#F5F2EC',
        hasTitle: !!tt, cursor, titlePre: am ? tt.slice(0, am.index) : shownTitle, titleAmt: am ? am[0] : '', titlePost: am ? tt.slice(am.index + am[0].length) : '',
        quote: T(m.quote || ''), wave: !!m.wave, waveLabel: T(m.waveLabel || ''), waveBars: [10, 16, 22, 14, 26, 18, 12, 24, 16, 20, 10, 22, 14, 18].map((h, j) => ({ key: j, h: h + 'px' })),
        prows: (m.prows || []).map((r, j) => { const p = PILL[(r.pill || '').toLowerCase()] || ['#EFEAE1', '#55524C']; return { key: j, k: T(r.k), v: T(r.v || ''), pill: T(r.pill || ''), pillBg: p[0], pillFg: p[1], tgt: fxDots && (r.pill || '').toLowerCase() === 'open' ? 'yes' : 'no', hl: (cursor && j === 0) || !!r.hl, logo: r.logo ? '/assets/v8/icons/' + r.logo : '', seg: r.seg != null, ...[0, 1, 2].reduce((o, n) => { const on = r.seg === n; o['b' + n] = on ? (dark ? '#F7F5F1' : '#16150F') : 'transparent'; o['c' + n] = on ? (dark ? '#16150F' : '#FAF8F4') : (dark ? '#8E8A83' : '#6B6660'); return o; }, {}) }; }),
        hasKeys: !!(m.keys && m.keys.length), keysNote: T(m.keysNote || ''), keys,
        bigNote: T(m.bigNote || ''), suffix, fill: fx.fill || 1, nightLabel: T('Closed overnight by GOTCHA')
      };
    });
    this.fx = fx;
    const fxv = { sec: s.sec, closed: s.closed, count: s.count == null ? (fx.countT || 0) : s.count };
    return {
      pv, nav, offer, hero, ch, stats, biz,
      ucTabs: H.UC.map((u, i) => ({ key: i, t: T(u.t), on: i === s.uc, pick: () => this.setState({ uc: i }), bg: i === s.uc ? '#16150F' : 'transparent', fg: i === s.uc ? '#FAF8F4' : '#5B564D', shadow: i === s.uc ? '0 6px 18px rgba(22,21,15,.18)' : 'none' })),
      uc: ((u) => ({ t: T(u.t), edge: u.edge, body: T(u.body), msg: T(u.msg), tag: T(u.tag), answer: T(u.answer), foot: T(u.foot), does: u.does.map((d, i) => ({ key: i, t: T(d.t), d: T(d.d) })), stats: u.stats.map((x, i) => ({ key: i, v: T(x.v), l: T(x.l) })) }))(H.UC[s.uc] || H.UC[0]),
      faqs: H.FAQ.map((f, i) => ({ key: i, q: T(f[0]), a: T(f[1]), open: s.faq === i, sign: s.faq === i ? '−' : '+', h: s.faq === i ? '420px' : '0px', o: s.faq === i ? 1 : 0, toggle: () => this.setState({ faq: s.faq === i ? -1 : i }) })),
      cta: { submit: (e) => e.preventDefault() },
      isHome: !this.TALK && !this.SOL && !this.WHY && !this.OFFER && !this.PRICE, isPrice: this.PRICE, pr: this.PRICE ? this.prVals() : this.PR0, isWhy: this.WHY, isOffer: this.OFFER, op: this.OFFER ? this.opVals() : this.OP0, wy: this.WHY ? this.wyVals() : this.WY0, isTalk: this.TALK, isEcom: this.SOL, ec: this.SOL ? this.ecVals() : { w1: [], w2: [], bubbles: [], aw: [], stats: [], cases: [], alone: [], stops: [], qw: [], proof: [], cw: [] }, tk: (this.TALK || this.WHY || this.OFFER || this.PRICE) ? this.tkVals() : { w1: [], w2: [], points: [], promise: [], ways: [] },
      links: { home: (this.TALK || this.SOL || this.WHY || this.OFFER || this.PRICE) ? this.homeUrl() : '#top', talk: this.TALK ? '#top' : this.talkUrl(), offer: this.pageUrl('offer'), onboarding: '#top', demo: 'https://calendar.app.google/pwKViwkRwQTeibnX9' },
      lang: { isEn: this.EN_ON, isHe: !this.EN_ON, toEn: () => this.setLang('en'), toHe: () => this.setLang('he'), enBg: this.EN_ON ? '#262521' : 'transparent', enFg: this.EN_ON ? '#F7F5F1' : '#8E8A83', heBg: this.EN_ON ? 'transparent' : '#262521', heFg: this.EN_ON ? '#8E8A83' : '#F7F5F1' },
      wk: (() => { const WK = H.WEEK || [], cur = WK[s.w6] || { rows: [], qs: [], t: '' }, qa = s.tq >= 0 ? cur.qs[s.tq] : null; return {
        h: T('Pick the one that sounds like your week.'), t: cur.t,
        tabs: WK.map((x, i) => { const on = i === s.w6; return { key: i, t: x.t, on, bg: on ? '#16150F' : 'transparent', fg: on ? '#FAF8F4' : '#16150F', bd: on ? '#16150F' : '#CFC6B6', pick: () => { clearInterval(this.tTimer); clearTimeout(this.tWait); this.setState({ w6: i, tq: -1, tn: 0, tph: '' }); } }; }),
        rows: cur.rows.map((r, i) => ({ key: s.w6 + '-' + i, icon: '/assets/v8/icons/' + r[0] + '.svg', n: r[1], q: r[2], wait: r[3], a: r[4], done: 'טופל · תוך דקה' })),
        statB: this.EN_ON ? cur.rows.length + ' requests waiting' : cur.rows.length + ' פניות מחכות', statA: T('כולן טופלו'),
        qs: cur.qs.map((x, i) => ({ key: s.w6 + '-' + i, q: x[0], ask: () => this.ask(i), bg: i === s.tq ? '#FFFFFF' : 'rgba(255,255,255,.5)', bd: i === s.tq ? '#C4552F' : '#DDD5C7' })),
        empty: !qa, hasQ: !!qa, q: qa ? qa[0] : '', dots: s.tph === 'dots', hasA: !!qa && (s.tph === 'typing' || s.tph === 'done'), a: qa ? qa[1].slice(0, s.tn) : '', done: s.tph === 'done',
        down: this.baDown, move: this.baMove, up: this.baUp, key: this.baKey }; })(),
      bar: { show: s.bar, hide: () => this.setState({ bar: false }) },
      sc: { railLabel: T(b.railLabel), scroll: T('scroll'), moments }, fx: fxv, dots: this.DOTS, night: this.NIGHT
    };
  }

  // dc-runtime: vals = { ...userProps, ...logic.renderVals() }, plus the
  // addresses this site gives the design's placeholder links.
  render() {
    let vals;
    try {
      vals = { ...this.props, ...(this.renderVals() || {}), portLinks: portLinks(this.EN_ON ? 'en' : 'he'), ctaPort: this.ctaPort() };
    } catch (e) {
      console.error('renderVals():', e);
      return React.createElement('pre', { style: { padding: 24, color: '#8E3418' } }, String((e && e.stack) || e));
    }
    const tree = HomeTemplate({ v: vals });
    // enPass(), applied to the tree instead of the DOM, so English is in the
    // server-rendered page and not swapped in after it paints.
    return this.EN_ON ? enTree(tree, (s) => this.toEn(s)) : tree;
  }
}


/** A v8 page - the home, contact, why, offer, pricing, ecommerce or leads - in the design's chrome. */
export default class V8Landing extends HomeLogic {
  componentDidMount() {
    // The exported HTML already carries these (tools/sync-html-lang.mjs); this
    // covers `next dev`, which serves the layout without the rewrite.
    const d = document.documentElement;
    d.setAttribute('lang', this.EN_ON ? 'en' : 'he');
    if (this.EN_ON) d.setAttribute('data-lang', 'en'); else d.removeAttribute('data-lang');
    // The drawer's auto-open waits for the cookie card; once it is answered,
    // run the design's own check again so a reader already scrolled past the
    // fold gets the drawer then, not on some later scroll.
    this.offConsent = onConsentDecided(() => this.offerAuto());
    return super.componentDidMount();
  }

  componentWillUnmount() {
    if (this.offConsent) this.offConsent();
    super.componentWillUnmount();
  }

  /**
   * The hero's website field (Omer's decision): its own check and shake are the
   * design's; a valid address now carries on to the bottom form instead of
   * firing an event nothing listens to. The form gets the website, the reader
   * gets the name field, and the lead is sent with source landing-home-hero for
   * as long as that website is the one in the field. The scroll and focus are
   * the design's own tkToForm(): 120px above the form, 1.4s, focus without
   * scrolling once it lands.
   */
  goOnboarding(site) {
    super.goOnboarding(site);
    const v = String(site || '').trim();
    const form = document.querySelector('#cta form');
    const target = form || document.querySelector('#cta [data-tk-ok]');
    if (!target) return;
    if (form) {
      const siteInput = form.elements.site;
      if (siteInput) siteInput.value = v;
      this.heroSite = v;
    }
    const y = target.getBoundingClientRect().top + window.scrollY - 120;
    if (this.lenis) this.lenis.scrollTo(y, { duration: 1.4 }); else window.scrollTo(0, y);
    setTimeout(() => { const i = form && form.elements.name; if (i) i.focus({ preventScroll: true }); }, 1500);
  }

  /**
   * The contact form the talk, why, offer and pricing pages draw (tk.*). The
   * design checks it and then shows its sent card; here the lead is sent in
   * between, with the page's own source (src/lib/v8-pages.ts). An incomplete
   * form is the design's own path, untouched. A failure keeps the form and its
   * values and shows the design's alert line with the send-failed sentence.
   */
  async tkSubmit(ev) {
    ev.preventDefault();
    if (this.tkBusy) return;
    const f = ev.currentTarget, v = (n) => String((f.elements[n] || {}).value || '');
    const page = (this.props && this.props.page) || 'home';
    const lead = leadFromForm({ name: v('name'), phone: v('phone'), site: v('site'), mail: v('mail') }, V8_PAGES[page] && V8_PAGES[page].source);
    // Incomplete, or a page with no source: the design's own handling.
    if (!lead || !lead.source) return super.tkSubmit({ preventDefault() {}, currentTarget: f });
    this.tkBusy = true;
    if (this.state.tkFail) this.setState({ tkFail: false });
    const result = await sendLead(lead);
    this.tkBusy = false;
    if (result !== 'sent') { this.setState({ tkFail: true, tkErr: null }); return; }
    super.tkSubmit({ preventDefault() {}, currentTarget: f });
  }

  tkVals() {
    const v = super.tkVals();
    if (this.state.tkFail) {
      v.err = true;
      v.errText = SEND_FAILED[this.EN_ON ? 'en' : 'he'];
    }
    const clear = v.clearErr;
    v.clearErr = () => { if (this.state.tkFail) this.setState({ tkFail: false }); clear(); };
    return v;
  }

  /** The bottom form's bindings: the contact-page form's states and copy, from tkVals(). */
  ctaPort() {
    const tk = this.tkVals(), s = this.state;
    return {
      submit: (ev) => this.ctaSubmit(ev),
      notSent: !s.ctaSent, sent: !!s.ctaSent,
      err: !!s.ctaErr,
      errText: s.ctaErr === 'send' ? SEND_FAILED[this.EN_ON ? 'en' : 'he'] : tk.errText,
      okTitle: tk.okTitle, okBody: tk.okBody, pick: tk.pick,
    };
  }

  /**
   * Same shape as the design's tkSubmit(): read the fields, refuse an
   * incomplete form with the design's shake, otherwise send. A failure keeps
   * the form and its values on screen with the error line; nothing is dropped
   * silently.
   */
  async ctaSubmit(ev) {
    ev.preventDefault();
    if (this.ctaBusy) return;
    const f = ev.currentTarget, v = (n) => String((f.elements[n] || {}).value || '');
    const fromHero = !!this.heroSite && v('site').trim() === this.heroSite;
    const lead = leadFromForm({ name: v('name'), phone: v('phone'), site: v('site'), mail: v('mail') }, fromHero ? 'landing-home-hero' : 'landing-home-cta');
    if (!lead) {
      this.setState({ ctaErr: 'fields' });
      const g = window.gsap;
      if (g && !this.reduce) g.fromTo(f, { x: 0 }, { keyframes: { x: [-9, 8, -6, 4, -2, 0] }, duration: 0.5, ease: 'power2.out' });
      return;
    }
    this.ctaBusy = true;
    if (this.state.ctaErr) this.setState({ ctaErr: null });
    const result = await sendLead(lead);
    this.ctaBusy = false;
    this.setState(result === 'sent' ? { ctaSent: true, ctaErr: null } : { ctaErr: 'send' });
  }
}
