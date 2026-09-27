/* Ported from the "GOTCHA Campaign Landing.dc.html" script block by tools/build-logic.mjs.
   The class body is the design's own source - keep edits there, not here.
   Re-run the design:sync npm script. */
/* eslint-disable */
'use client';

import React from 'react';
import Template from '@/generated/Template';
import { links, META_PIXEL_ID, LEAD_SOURCE, THANK_YOU_PATH } from '@/lib/site';

class CampaignLogic extends React.Component {
  CFG = {
    demo: 'https://calendar.app.google/5YgBtZFPCDbUpskA7',
    waNumber: '972552633304',
    waDisplay: '055-263-3304',
    email: 'support@gotcha.co.il',
    thankYou: THANK_YOU_PATH,
    leadEndpoint: '/api/waitlist',
    metaPixelId: META_PIXEL_ID,
    privacyUrl: links.trust('privacy-policy'), termsUrl: links.trust('terms-of-service'),
    offerTermsUrl: null, accessibilityUrl: null
  };

  // ── תסריטי ההמחשה: פנייה אופיינית לכל ערוץ, נתוני דמו מקומיים ──
  SCRIPTS = {
    wa: [
      { label: 'הודעה נכנסת', dur: 2500, msgs: [{ who: 'c', t: 'היי, ההזמנה שלי עדיין לא הגיעה. אפשר לבדוק?', time: '09:12' }], ops: ['הפנייה נפתחה ב־WhatsApp'] },
      { label: 'איסוף מידע', dur: 3600, ops: ['זוהתה לקוחה קיימת', 'נמצאה הזמנה #1842 ב־Shopify', 'נבדק סטטוס המשלוח'],
        info: { title: 'כרטיס הזמנה', rows: [{ l: 'הזמנה', v: '#1842', tag: 'Shopify', ltr: true }, { l: 'סטטוס הזמנה', v: 'נשלחה' }, { l: 'סטטוס משלוח', v: 'עיכוב במרכז המיון', hot: true }] } },
      { label: 'תשובה', dur: 3100, typingBefore: true, ops: ['נוסחה תשובה מהמידע שנאסף'], msgs: [{ who: 'b', t: 'בדקתי את ההזמנה. המשלוח מתעכב במרכז המיון.', time: '09:13' }, { who: 'c', t: 'זה כבר עבר את מועד האספקה שהובטח.', time: '09:14' }] },
      { label: 'ביצוע פעולה', dur: 3600, ops: ['חברת המשלוחים מחוברת', 'נפתח בירור #582', 'ממתין לתשובה'], note: 'הפעולות הזמינות תלויות בחברת המשלוחים, בחיבור ובהרשאות.', msgs: [{ who: 'b', t: 'פתחתי בירור מול חברת המשלוחים. אעדכן אותך כאן כשנקבל תשובה.', time: '09:15' }] },
      { label: 'נציג מצטרף', dur: 3900, msgs: [{ who: 'c', t: 'אפשר לדבר עם נציג?', time: '09:16' }],
        copilot: { sum: 'הזמנה #1842 מתעכבת. בירור #582 נפתח מול חברת המשלוחים וממתין לתשובה.', sug: 'היי דנה, אני מצטרף לטיפול. אני רואה שהבירור כבר נפתח ואמשיך לעקוב אחריו.' } },
      { label: 'סיום', dur: 2300, end: true }
    ],
    ig: [
      { label: 'הודעה נכנסת', dur: 2500, msgs: [{ who: 'c', t: 'ראיתי את הסרום בסטורי — מתאים לעור שמן?', time: '20:41' }], ops: ['הפנייה נפתחה ב־Instagram'] },
      { label: 'איסוף מידע', dur: 3600, ops: ['זוהתה תגובה לסטורי', 'אותר המוצר בקטלוג', 'נבדקו מלאי ומחיר'],
        info: { title: 'כרטיס מוצר', rows: [{ l: 'מוצר', v: 'סרום ניאצינמיד 10%' }, { l: 'מחיר', v: '₪129', tag: 'Shopify' }, { l: 'מלאי', v: '7 יחידות' }, { l: 'מתאים ל', v: 'עור שמן ומעורב', hot: true }] } },
      { label: 'תשובה', dur: 3100, typingBefore: true, ops: ['נוסחה תשובה מנתוני הקטלוג'], msgs: [{ who: 'b', t: 'כן, הסרום מיועד לעור שמן ומעורב. ניאצינמיד 10%, ‎129 ₪.', time: '20:42' }, { who: 'c', t: 'אפשר קישור להזמנה?', time: '20:43' }] },
      { label: 'ביצוע פעולה', dur: 3600, ops: ['אותר המוצר המתאים בקטלוג', 'נשלח קישור למוצר'], note: 'הקישורים והפעולות תלויים בחיבור לחנות ובהרשאות.',
        msgs: [{ who: 'b', t: 'זה הסרום שמתאים לך — הקישור למוצר:', time: '20:43', link: { title: 'סרום ניאצינמיד 10%', price: '₪129', url: 'shop.co.il/niacinamide' } }] },
      { label: 'נציג מצטרף', dur: 3900, msgs: [{ who: 'c', t: 'יש גם משהו לעור יבש? אפשר לדבר עם מישהי?', time: '20:45' }],
        copilot: { sum: 'פנייה מסטורי על סרום ניאצינמיד. נשלח קישור למוצר, והלקוחה מתעניינת גם בטיפוח לעור יבש.', sug: 'היי, אני מצטרפת לשיחה. אשמח להמליץ על סרום לעור יבש ולשלוח השוואה בין השניים.' } },
      { label: 'סיום', dur: 2300, end: true }
    ],
    ms: [
      { label: 'הודעה נכנסת', dur: 2500, msgs: [{ who: 'c', t: 'שלום, אפשר להחזיר מוצר שלא נפתח? ועד מתי אתם פתוחים היום?', time: '11:08' }], ops: ['הפנייה נפתחה ב־Messenger'] },
      { label: 'איסוף מידע', dur: 3600, ops: ['אותרה מדיניות ההחזרות', 'נבדקו שעות הפעילות', 'נמצא הסניף הקרוב'],
        info: { title: 'מידע מהמערכות', rows: [{ l: 'החזרות', v: 'עד 14 יום, באריזה מקורית' }, { l: 'פתוח היום', v: '09:00–18:00', ltr: true }, { l: 'סניף קרוב', v: 'תל אביב · אבן גבירול 71' }] } },
      { label: 'תשובה', dur: 3100, typingBefore: true, ops: ['נוסחה תשובה ממדיניות החנות'], msgs: [{ who: 'b', t: 'אפשר להחזיר מוצר שלא נפתח עד 14 יום מקבלתו. היום אנחנו פתוחים עד 18:00.', time: '11:09' }, { who: 'c', t: 'איך מתחילים החזרה?', time: '11:10' }] },
      { label: 'ביצוע פעולה', dur: 3600, ops: ['נפתחה בקשת החזרה #341', 'נשלחה תווית משלוח'], note: 'הפעולות הזמינות תלויות במערכות המחוברות ובהרשאות.', msgs: [{ who: 'b', t: 'פתחתי בקשת החזרה ושלחתי תווית משלוח למייל. אפשר גם להחזיר בסניף.', time: '11:10' }] },
      { label: 'נציג מצטרף', dur: 3900, msgs: [{ who: 'c', t: 'אפשר לדבר עם נציג לגבי החלפה במקום החזרה?', time: '11:12' }],
        copilot: { sum: 'שאלה על החזרה ושעות פעילות. נפתחה בקשת החזרה #341 ונשלחה תווית, והלקוח מתעניין בהחלפה.', sug: 'היי, אני מצטרף לשיחה. אפשר להחליף את המוצר בסניף — אעזור לך לבחור פריט חלופי.' } },
      { label: 'סיום', dur: 2300, end: true }
    ]
  };

  get STEPS() { return this.SCRIPTS[(this.PLATS[this.state.plat] || this.PLATS[0]).id]; }
  get REP_ANSWER() { return ((this.STEPS[4] || {}).copilot || {}).sug || ''; }

  // ממשק הערוץ מתחלף יחד עם התסריט
  PLATS = [
    { id: 'wa', name: 'WhatsApp', icon: '/assets/icons/whatsapp.svg', invertIcon: true,
      headBg: '#008069', headFg: '#FFFFFF', avaBg: 'rgba(255,255,255,.22)', chatBg: '#EFEAE2',
      barBg: '#F0F2F5', fieldBg: '#FFFFFF', send: '#00A884', online: 'מחובר', ph: 'הקלידו הודעה',
      inBg: '#D9FDD3', outBg: '#FFFFFF', radiusIn: '0 8px 8px 8px', radiusOut: '8px 0 8px 8px', ink: '#111B21' },
    { id: 'ig', name: 'Instagram', icon: '/assets/icons/instagram.svg', invertIcon: true,
      headBg: '#0A0A0A', headFg: '#FFFFFF', avaBg: 'rgba(255,255,255,.14)', chatBg: '#000000',
      barBg: '#000000', fieldBg: '#1C1C1C', send: '#3B5AFB', online: 'shirel_cosmetics', ph: 'הודעה…',
      inBg: '#3B5AFB', outBg: '#262626', outFg: '#F5F5F5', radiusIn: '20px', radiusOut: '20px', ink: '#FFFFFF' },
    { id: 'ms', name: 'Messenger', icon: '/assets/icons/messenger.svg', invertIcon: true,
      headBg: '#FFFFFF', headFg: '#16150F', avaBg: '#E7EBF0', chatBg: '#FFFFFF',
      barBg: '#FFFFFF', fieldBg: '#F0F2F5', send: '#0084FF', online: 'פעיל כעת', ph: 'הודעה…',
      inBg: '#F0F2F5', outBg: '#0084FF', outFg: '#FFFFFF', radiusIn: '18px', radiusOut: '18px', ink: '#050505' }
  ];


  state = {
    plat: 0, step: 0, playing: false, started: false, repDraft: '', repSent: false,
    open: null, wa: 'closed', waDraft: '', waTeased: false, kbd: false,
    fa: { err: {}, busy: false }, fb: { err: {}, busy: false }
  };

  vals = { fa: { name: '', phone: '', site: '', email: '' }, fb: { name: '', phone: '', site: '', email: '' } };

  get cfg() {
    const c = this.CFG;
    return {
      demo: c.demo, wa: 'https://wa.me/' + c.waNumber, waDisplay: c.waDisplay,
      tel: 'tel:+' + c.waNumber, email: c.email, mailto: 'mailto:' + c.email
    };
  }

  fired = {};
  track(name, once) {
    if (once && this.fired[name]) return;
    this.fired[name] = true;
    const utm = {};
    try { new URLSearchParams(location.search).forEach((v, k) => { if (/^utm_|^gclid$|^fbclid$/.test(k)) utm[k] = v; }); } catch (e) {}
    const payload = { event: name, utm: utm };
    (window.dataLayer = window.dataLayer || []).push(payload);
    if (window.fbq && this.CFG.metaPixelId) window.fbq(name === 'lead' ? 'track' : 'trackCustom', name === 'lead' ? 'Lead' : name);
    if (!this.CFG.metaPixelId) console.info('[measurement pending pixel id]', payload);
  }

  componentDidMount() {
    this.onStick = () => { const el = document.querySelector('[data-sticky-head]'); if (el) el.toggleAttribute('data-stuck', window.scrollY > 8); };
    window.addEventListener('scroll', this.onStick, { passive: true }); this.onStick();
    this.track('page_view', true);
    this.runMarquee();
    const tr = document.querySelector('[data-track]');
    if (tr && window.ResizeObserver) {
      this.mqRO = new ResizeObserver(() => this.runMarquee());
      this.mqRO.observe(tr.querySelector('[data-grp]'));
      this.mqRO.observe(tr.parentElement);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.runMarquee());
    [400, 1500, 3000].forEach(ms => setTimeout(() => this.runMarquee(), ms));

    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ההמחשה מתחילה כשהיא נכנסת למסך, נעצרת כשהיא יוצאת וממשיכה בחזרה
    const watch = () => {
      const el = document.querySelector('[data-demo]');
      if (!el) return setTimeout(watch, 300);
      if (!this.state.started && !this.reduce) { this.stepAt = Date.now(); this.setState({ started: true, playing: true }); }
    };
    watch();
    if (!this.reduce) { this.stepAt = Date.now(); this.ensureClock(); this.setState({ playing: true, started: true }); }
    this.rmq = matchMedia('(prefers-reduced-motion: reduce)');
    if (this.rmq.addEventListener) this.rmq.addEventListener('change', (e) => { this.reduce = e.matches; });

    // הפס הדביק נסוג כשמקלדת פתוחה או כשחלון הווידג׳ט פתוח
    this.onFocusIn = (e) => {
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) this.setState({ kbd: true });
    };
    this.onFocusOut = (e) => {
      const t = e.target;
      if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) setTimeout(() => {
        const a = document.activeElement;
        if (!a || !/^(INPUT|TEXTAREA)$/.test(a.tagName)) this.setState({ kbd: false });
      }, 80);
    };
    document.addEventListener('focusin', this.onFocusIn);
    document.addEventListener('focusout', this.onFocusOut);

    this.onScroll = () => {
      const d = document.documentElement;
      const max = Math.max(1, d.scrollHeight - d.clientHeight);
      const p = (d.scrollTop || document.body.scrollTop) / max;
      const g = document.querySelector('[data-bg-glow]');
      if (g) g.style.transform = 'translate3d(0,' + (-5 + 10 * p).toFixed(2) + 'vmax,0)';
      if (p > 0.25 && !this.teaseShown && this.state.wa === 'closed' && !this.state.kbd) {
        this.teaseShown = true;
        this.setState({ waTeased: true });
        this.teaseTimer = setTimeout(() => { if (this.state.wa !== 'open') this.setState({ waTeased: false }); }, 7000);
      }
    };
    window.addEventListener('scroll', this.onScroll, { passive: true });
  }

  componentWillUnmount() {
    window.removeEventListener('scroll', this.onStick);
    if (this.mqRO) this.mqRO.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    clearInterval(window.__gotchaDemoClock);
    window.__gotchaDemoClock = null;
    clearTimeout(this.typeT);
    clearTimeout(this.teaseTimer);
    window.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('focusin', this.onFocusIn);
    document.removeEventListener('focusout', this.onFocusOut);
    if (this.mqAnim) this.mqAnim.cancel();
  }

  // ── שעון ההמחשה ───────────────────────────────────────────────
  inView = true;   // עד שה-observer מדווח אחרת, ההמחשה יכולה לרוץ

  // ── שעון ההמחשה ───────────────────────────────────────────────
  // הזמן נמדד בשעון קיר (Date.now) ולא בהפרשי פריימים, כי בתצוגות
  // מוטמעות/מוסתרות rAF לא נקרא בכלל וה-setInterval מווסת לכ-700ms.
  // השעון נבנה מחדש בכל רינדור אם חסר, כך שהוא שורד גם remount/hot-reload.
  // שעון יחיד לכל הדף: כל יצירה מחליפה את הקודם, כך שגם remount או
  // טעינת קוד חיה לא משאירים שני שעונים שמרנדרים את העץ במקביל
  ensureClock() {
    if (this.timer && window.__gotchaDemoClock === this.timer) return;
    clearInterval(window.__gotchaDemoClock);
    window.__gotchaDemoClock = this.timer = setInterval(this.tick, 90);
  }

  // הנראות נמדדת בכל פעימה מול המסך, ולא נשמרת מדיווח חד-פעמי
  visible() {
    if (document.hidden) return true;
    const el = document.querySelector('[data-demo]');
    if (!el) return true;
    const r = el.getBoundingClientRect();
    const h = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!h || !r.height) return true;
    return r.bottom > -r.height * 0.5 && r.top < h + r.height * 0.5;
  }

  tick = () => {
    const s = this.state;
    if (this.ticking || !s.playing || !this.visible()) return;
    this.ticking = true;
    try { this.step(s); } finally { this.ticking = false; }
  };

  step(s) {
    const d = (this.STEPS[s.step] || {}).dur || 4000;
    const el = Date.now() - (this.stepAt || Date.now());
    if (s.step === 4) {
      if (el > d * 0.38 && !s.repDraft) this.useAnswer();
      else if (el > d * 0.72 && !s.repSent) this.sendRep();
    }
    if (el >= d) {
      // לופ: בסוף הרצף חוזרים להתחלה, כמו GIF
      if (s.step >= this.STEPS.length - 1) {
        this.stepAt = Date.now();
        this.setState({ step: 0, typing: false, repDraft: '', repSent: false });
      } else this.goStep(s.step + 1);
    }
  }

  goStep = (i) => {
    const n = Math.max(0, Math.min(this.STEPS.length - 1, i));
    this.stepAt = Date.now();
    this.inView = true;
    this.ensureClock();
    clearTimeout(this.typeT);
    const typing = !!(this.STEPS[n] && this.STEPS[n].typingBefore);
    if (typing) this.typeT = setTimeout(() => this.setState({ typing: false }), 700);
    this.setState({ step: n, started: true, typing: typing, repDraft: n > 4 ? this.REP_ANSWER : '', repSent: n > 4 });
  };
  toggleDemo = () => {
    this.inView = true;
    this.userPlay = true;
    this.ensureClock();
    if (!this.state.playing && this.state.step >= this.STEPS.length - 1) return this.replay();
    this.stepAt = Date.now();
    this.setState({ playing: !this.state.playing, started: true });
  };
  replay = () => {
    this.stepAt = Date.now();
    this.inView = true;
    this.userPlay = true;
    this.ensureClock();
    this.setState({ step: 0, playing: true, started: true, typing: false, repDraft: '', repSent: false });
  };
  useAnswer = () => this.setState({ repDraft: this.REP_ANSWER });
  sendRep = () => {
    if (!this.state.repDraft) return;
    this.setState({ repSent: true });
  };

  demoVals() {
    const s = this.state, cur = s.step;
    const msgs = [];
    this.STEPS.forEach((st, i) => {
      if (i > cur || !st.msgs) return;
      st.msgs.forEach(m => msgs.push(m));
    });
    if (s.repSent) {
      const last = (this.STEPS[4] || {}).msgs;
      const t = last && last[0] ? last[0].time : '';
      msgs.push({ who: 'b', t: this.REP_ANSWER, time: t, rep: true });
    }
    // מציגים רק את ההודעות שנכנסות בשלמותן בחלון בגובה הקבוע
    const narrow = (typeof innerWidth === 'number' ? innerWidth : 1200) < 620;
    const shown = msgs.slice(narrow ? -2 : -4);
    const st = this.STEPS[cur] || {};
    const ops = st.ops || [];   // רק הפעולה של השלב הנוכחי
    const info = st.info || (cur === 2 ? (this.STEPS[1] || {}).info : null);
    const cop = st.copilot;
    const rep = cur >= 4;
    const P = this.PLATS[s.plat] || this.PLATS[0];
    const dotStyle = (on) => 'width:' + (on ? '26px' : '9px') + ';height:9px;border-radius:5px;border:0;padding:0;cursor:pointer;background:' + (on ? '#C4552F' : '#D8D3C9');
    return {
      msgs: shown.map((m, i) => ({
        t: m.t, time: m.time, key: i,
        row: 'display:flex;justify-content:' + (m.who === 'c' ? 'flex-start' : 'flex-end') + ';animation:bubbleIn .26s cubic-bezier(.22,.68,.16,1) both',
        bubble: 'max-width:88%;padding:8px 11px 6px;border-radius:' + (m.who === 'c' ? P.radiusIn : P.radiusOut)
          + ';background:' + (m.who === 'c' ? P.inBg : P.outBg)
          + ';color:' + (m.who === 'c' ? P.ink : (P.outFg || P.ink))
          + (P.id === 'wa' ? ';box-shadow:0 1px .5px rgba(11,20,26,.13)' : ''),
        meta: 'font-size:11px;text-align:left;margin-top:3px;direction:ltr;opacity:.7;color:' + (m.who === 'c' ? '#667781' : (P.outFg || '#667781')),
        linkStyle: m.link
          ? 'display:flex;align-items:center;gap:9px;margin-top:7px;padding:8px 10px;border-radius:12px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22)'
          : 'display:none',
        linkTitle: m.link ? m.link.title : '',
        linkPrice: m.link ? m.link.price : '',
        linkUrl: m.link ? m.link.url : ''
      })),
      plats: this.PLATS.map((p, i) => ({
        key: p.id, name: p.name, icon: p.icon, on: i === s.plat,
        pick: () => {
          if (i === s.plat) return;
          this.stepAt = Date.now();
          this.ensureClock();
          this.setState({ plat: i, step: 0, playing: true, typing: false, repDraft: '', repSent: false });
        },
        iconStyle: 'width:18px;height:18px;flex:none;background:center/contain no-repeat url(' + p.icon + ')'
          + (i === s.plat && p.invertIcon ? ';filter:brightness(0) invert(1)' : ''),
        style: 'display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 14px;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .18s ease,border-color .18s ease;'
          + (i === s.plat ? 'border:1.5px solid #16150F;background:#16150F;color:#FAF8F4' : 'border:1.5px solid #D8D3C9;background:#FFFFFF;color:#16150F')
      })),
      platIcon: P.icon, platName: P.name,
      headBg: P.headBg, headFg: P.headFg, avaBg: P.avaBg, chatBg: P.chatBg,
      headLine: P.id === 'ms' ? '#DDE0E4' : 'rgba(255,255,255,.18)',
      barBg: P.barBg, fieldBg: P.fieldBg, sendColor: P.send, placeholder: P.ph,
      fieldInk: P.id === 'ig' ? '#8E8E8E' : '#8696A0',
      headIcon: 'width:19px;height:19px;flex:none;opacity:.9;background:center/contain no-repeat url(' + P.icon + ')'
        + (P.invertIcon ? ';filter:brightness(0) invert(1)' : ''),
      typeBox: 'align-self:flex-end;padding:10px 13px;background:' + P.outBg + ';border-radius:' + P.radiusOut
        + (P.id === 'wa' ? ';box-shadow:0 1px .5px rgba(11,20,26,.13)' : ''),
      typing: !!s.typing && s.playing,
      ops: ops.map((t, i) => ({
        t: t, key: i, mark: '✓',
        dot: 'width:20px;height:20px;border-radius:50%;background:#E7F0D4;color:#3F6323;font-size:11px;display:flex;align-items:center;justify-content:center;flex:none',
        delay: 'animation:cardIn .28s cubic-bezier(.22,.68,.16,1) both;animation-delay:' + (i * 0.12).toFixed(2) + 's'
      })),
      opsTitle: rep ? 'הפעולה שמתבצעת · נציג' : 'הפעולה שמתבצעת · עובד AI',
      status: rep ? 'בטיפול נציג' : 'בטיפול עובד AI',
      statusStyle: 'margin-inline-start:auto;font-size:12px;font-weight:600;border-radius:8px;padding:5px 10px;white-space:nowrap;' + (rep ? 'color:#3D3470;background:#F3F0FB' : 'color:#8E3418;background:#FBEEE8'),
      waSub: rep ? 'אורי מהחנות מצטרף לשיחה' : P.online,
      showOps: ops.length > 0 && !cop,   // בשלב הנציג הכרטיס הסגול מדווח בעצמו
      showInfo: !!info,
      infoTitle: info ? info.title : '',
      infoRows: info ? info.rows.map((r, i) => ({
        key: i, l: r.l, v: r.v, tag: r.tag || '',
        vStyle: 'font-size:14.5px;font-weight:' + (r.hot ? '600' : '500') + (r.hot ? ';color:#8E3418' : '')
          + (r.ltr ? ';direction:ltr;unicode-bidi:isolate' : '')
      })) : [],
      showNote: !!st.note, note: st.note || '',
      showCopilot: !!cop,
      copSum: cop ? cop.sum : '',
      copSug: cop ? cop.sug : '',
      showEnd: !!st.end,
      draftText: s.repDraft || 'שדה ההקלדה של הנציג',
      draftColor: s.repDraft ? '#16150F' : '#8E8A83',
      sendBg: s.repDraft && !s.repSent ? '#16150F' : '#B4AFA5',
      playLabel: s.playing ? 'עצירה' : 'הפעלה',
      playAria: s.playing ? 'עצירת ההמחשה' : 'הפעלת ההמחשה',
      stepLabel: 'שלב ' + (cur + 1) + ' מתוך ' + this.STEPS.length + ' · ' + this.STEPS[cur].label,
      toggle: this.toggleDemo, replay: this.replay,
      prev: () => this.goStep(cur - 1), next: () => this.goStep(cur + 1),
      useAnswer: this.useAnswer, sendRep: this.sendRep,
      dots: this.STEPS.map((st, i) => ({
        key: i, on: i === cur, aria: 'שלב ' + (i + 1) + ': ' + st.label,
        go: () => this.goStep(i), style: dotStyle(i === cur)
      }))
    };
  }

  // ── רצועת הערוצים ─────────────────────────────────────────────
  runMarquee() {
    const track = document.querySelector('[data-track]');
    const grp = track && track.querySelector('[data-grp]');
    if (!track || !grp) return;
    const w = grp.getBoundingClientRect().width;
    if (w < 10) { requestAnimationFrame(() => this.runMarquee()); return; }
    const gap = parseFloat(getComputedStyle(track).columnGap) || 40;
    const shift = w + gap;
    if (this.mqShift === shift && this.mqAnim && this.mqAnim.playState === 'running') return;
    this.mqShift = shift;
    if (this.mqAnim) this.mqAnim.cancel();
    this.mqAnim = track.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-' + shift + 'px)' }],
      { duration: (shift / 55) * 1000, iterations: Infinity, easing: 'linear' }
    );
  }

  ask = (i) => () => this.setState({ open: this.state.open === i ? null : i });

  // ── ווידג׳ט WhatsApp ──────────────────────────────────────────
  waOpen = () => { this.track('widget_open', false); clearTimeout(this.teaseTimer); this.setState({ wa: 'open', waTeased: false }); };
  waClose = () => this.setState({ wa: 'closed', waTeased: false });
  waDismiss = () => { clearTimeout(this.teaseTimer); this.setState({ waTeased: false }); };
  waType = (e) => this.setState({ waDraft: e.target.value });
  waSend = () => {
    const msg = (this.state.waDraft || '').trim() || 'היי, הגעתי מדף הקמפיין של GOTCHA ויש לי שאלה.';
    this.track('whatsapp_click', false);
    window.open('https://wa.me/' + this.CFG.waNumber + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
  };

  legalLink(label, url) {
    if (url) return React.createElement('a', { href: url, target: '_blank', rel: 'noopener', style: { color: '#B8B3AA', fontWeight: 500 } }, label);
    return React.createElement('span', { title: 'המסמך יחובר לפני הפרסום', style: { color: '#B8B3AA', borderBottom: '1px dotted #55524C', cursor: 'default' } }, label);
  }

  // ── טפסים · שני טפסים עם מזהים וערכים נפרדים ──────────────────
  setField = (key, f) => (e) => {
    this.vals[key][f] = e.target.value;
    this.track('form_start', true);
    const fs = this.state[key];
    if (fs.err[f]) {
      const err = Object.assign({}, fs.err); delete err[f];
      this.setState({ [key]: { err: err, busy: fs.busy } });
    }
  };

  normSite(v) {
    const s = (v || '').trim();
    if (!s) return '';
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
  }

  validate(v) {
    const e = {};
    if (!(v.name || '').trim()) e.name = 'נשמח לדעת מה השם שלכם.';
    const digits = (v.phone || '').replace(/[^\d]/g, '');
    if (!digits) e.phone = 'נדרש מספר טלפון שנוכל לחזור אליו.';
    else if (digits.length < 9 || digits.length > 15) e.phone = 'המספר לא נראה תקין. אפשר מספר מקומי או בינלאומי.';
    const site = this.normSite(v.site);
    if (!site) e.site = 'נדרשת כתובת אתר העסק.';
    else if (!/^https?:\/\/[^\s.]+\.[^\s]{2,}$/i.test(site)) e.site = 'הכתובת לא נראית תקינה. לדוגמה: shop.co.il';
    if ((v.email || '').trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email.trim())) e.email = 'כתובת המייל לא נראית תקינה.';
    return e;
  }

  submitForm = (key) => (ev) => {
    ev.preventDefault();
    if (this.state[key].busy) return;
    const v = Object.assign({}, this.vals[key]);
    const err = this.validate(v);
    if (Object.keys(err).length) {
      this.setState({ [key]: { err: err, busy: false } });
      const el = document.getElementById((key === 'fa' ? 'a-' : 'b-') + Object.keys(err)[0]);
      if (el) el.focus();
      return;
    }
    this.track('demo_form_submit_attempt', false);
    if (!this.CFG.leadEndpoint) {
      // אין יעד מחובר: לא מציגים הצלחה, לא יורים אירוע ליד ולא עוברים לדף התודה
      this.setState({ [key]: { err: { form: 'החיבור לשליחת הטופס ממתין להגדרה. עד אז אפשר לתאם הדגמה ביומן או לכתוב לנו בוואטסאפ.' }, busy: false } });
      console.warn('[lead endpoint not configured] CFG.leadEndpoint');
      return;
    }
    this.setState({ [key]: { err: {}, busy: true } });
    fetch(this.CFG.leadEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: v.name,
        phone: v.phone,
        email: (v.email || '').trim() || undefined,
        companyDomain: this.normSite(v.site),
        source: LEAD_SOURCE
      })
    }).then(r => {
      if (r.status === 409) {
        // Already on the list: same destination, no second conversion.
        location.href = this.CFG.thankYou;
        return;
      }
      if (!r.ok) throw new Error('save failed');
      this.track('lead', true);
      location.href = this.CFG.thankYou;
    }).catch(() => this.setState({ [key]: { err: { form: 'השליחה נכשלה. נסו שוב, או תאמו הדגמה ביומן.' }, busy: false } }));
  };

  formVals(key) {
    const fs = this.state[key], e = fs.err;
    return {
      onName: this.setField(key, 'name'), onPhone: this.setField(key, 'phone'),
      onSite: this.setField(key, 'site'), onEmail: this.setField(key, 'email'),
      submit: this.submitForm(key), busy: fs.busy,
      cta: fs.busy ? 'שולח…' : 'חזרו אליי להדגמה',
      eName: e.name || '', ePhone: e.phone || '', eSite: e.site || '', eEmail: e.email || '', eForm: e.form || '',
      hasName: !!e.name, hasPhone: !!e.phone, hasSite: !!e.site, hasEmail: !!e.email, hasForm: !!e.form
    };
  }

  renderVals() {
    const s = this.state;
    return {
      cfg: this.cfg,
      demo: this.demoVals(),
      fa: this.formVals('fa'),
      fb: this.formVals('fb'),
      ev: {
        demoHeader: () => this.track('demo_click_header', false),
        demoHero: () => this.track('demo_click_hero', false),
        demoForm: () => this.track('demo_click_form', false),
        demoBar: () => this.track('demo_click_sticky', false),
        demoFooter: () => this.track('demo_click_footer', false),
        waFooter: () => this.track('whatsapp_click_footer', false),
        telFooter: () => this.track('phone_click_footer', false),
        mailFooter: () => this.track('mail_click_footer', false),
        toForm: () => this.track('scroll_to_form', false)
      },
      faq: {
        q0: this.ask(0), q1: this.ask(1), q2: this.ask(2), q3: this.ask(3),
        is0: s.open === 0, is1: s.open === 1, is2: s.open === 2, is3: s.open === 3,
        s0: s.open === 0 ? '−' : '+', s1: s.open === 1 ? '−' : '+', s2: s.open === 2 ? '−' : '+', s3: s.open === 3 ? '−' : '+'
      },
      bar: { state: s.wa === 'open' || s.kbd ? 'hidden' : 'shown' },
      wa: {
        open: s.wa === 'open', teased: s.waTeased && s.wa !== 'open',
        openIt: this.waOpen, close: this.waClose, dismiss: this.waDismiss,
        toggle: s.wa === 'open' ? this.waClose : this.waOpen,
        fabLabel: s.wa === 'open' ? 'סגירת חלון הפנייה' : 'פתיחת חלון פנייה בוואטסאפ',
        iconChat: s.wa === 'open' ? 'none' : 'flex',
        iconClose: s.wa === 'open' ? 'flex' : 'none',
        type: this.waType, send: this.waSend, draft: s.waDraft || ''
      },
      legal: {
        privacy: this.legalLink('מדיניות הפרטיות', this.CFG.privacyUrl),
        footer: [
          this.legalLink('תנאי שימוש', this.CFG.termsUrl),
          this.legalLink('מדיניות פרטיות', this.CFG.privacyUrl),
          this.legalLink('תנאי ההטבה', this.CFG.offerTermsUrl),
          this.legalLink('הצהרת נגישות', this.CFG.accessibilityUrl)
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
    return React.createElement(Template, { v: vals });
  }
}


export default CampaignLogic;
