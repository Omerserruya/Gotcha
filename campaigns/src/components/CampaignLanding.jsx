/* Ported from the "GOTCHA Campaign Landing.dc.html" script block by
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

class CampaignLogic extends React.Component {
  // ── כל הקישורים וההגדרות במקום אחד ─────────────────────────────
  CFG = {
    demo: 'https://calendar.app.google/5YgBtZFPCDbUpskA7',
    waNumber: '972552633304',
    waDisplay: '055-263-3304',
    email: 'support@gotcha.co.il',
    leadEndpoint: '/api/waitlist',
    metaPixelId: META_PIXEL_ID,
    privacyUrl: links.trust('privacy-policy'),
    termsUrl: links.trust('terms-of-service'),
    offerTermsUrl: null,
    accessibilityUrl: null,
    offerActive: true,           // כיבוי המבצע כשהמכסה מתמלאת
    offerEnds: '2026-10-31'
  };

  state = { errors: {}, values: { name: '', phone: '', site: '', email: '' }, sent: false, sending: false,
            open: null, anim: 'paused', wa: 'closed', waDraft: '', waTeased: false, barHidden: false, gift: false };

  get cfg() {
    const c = this.CFG;
    return { demo: c.demo, wa: 'https://wa.me/' + c.waNumber, waDisplay: c.waDisplay,
             tel: 'tel:+' + c.waNumber, email: c.email, mailto: 'mailto:' + c.email,
             privacy: c.privacyUrl || '#form', terms: c.termsUrl || '#form', offerTerms: c.offerTermsUrl || '#form',
             accessibility: c.accessibilityUrl || '#form', cookies: c.cookiesUrl || '#form' };
  }

  // ── מדידה: אירוע אחד לכל פעולה, בלי כפילויות ובלי פרטים אישיים ──
  fired = {};
  track(name, once) {
    if (once && this.fired[name]) return;
    this.fired[name] = true;
    const utm = {};
    try {
      new URLSearchParams(location.search).forEach((v, k) => { if (/^utm_|^gclid$|^fbclid$/.test(k)) utm[k] = v; });
    } catch (e) {}
    const payload = { event: name, utm: utm };
    (window.dataLayer = window.dataLayer || []).push(payload);
    if (window.fbq && this.CFG.metaPixelId) {
      // 'lead' is Meta's standard Lead event; the rest are ours.
      if (name === 'lead') window.fbq('track', 'Lead');
      else window.fbq('trackCustom', name);
    }
    if (!this.CFG.metaPixelId) console.info('[measurement pending pixel id]', payload);
  }

  componentDidMount() {
    this.track('page_view', true);
    this.runMarquee();
    // הרוחב משתנה כשהאייקונים והפונטים נטענים — מודדים שוב ומסנכרנים
    this.mqRO = new ResizeObserver(() => this.runMarquee());
    const tr = document.querySelector('[data-track]');
    if (tr) { this.mqRO.observe(tr.querySelector('[data-grp]')); this.mqRO.observe(tr.parentElement); }
    addEventListener('load', () => this.runMarquee());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.runMarquee());
    [400, 1200, 3000].forEach((ms) => setTimeout(() => this.runMarquee(), ms));
    this.io = new IntersectionObserver((es) => {
      es.forEach(e => {
        if (e.target.getAttribute('data-watch') === 'anim') {
          if (e.isIntersecting && e.intersectionRatio > 0.5) { if (!this.userPaused) this.setState({ anim: 'playing' }); }
          else if (this.state.anim === 'playing') this.setState({ anim: 'paused' });
        }
      });
    }, { threshold: [0, 0.5, 0.75] });
    const watch = () => {
      const t = document.querySelector('[data-watch="anim"]');
      if (t) this.io.observe(t);
      else setTimeout(watch, 300);
    };
    watch();

    // הווידג׳ט נסוג רק כשהוא באמת מכסה כפתור פעולה, תנאי הטבה או שדה בטופס
    this.checkGuards = () => {
      const w = document.querySelector('[data-widget]');
      const fab = w && w.querySelector('button[aria-label]');
      if (!fab) return;
      const b = fab.getBoundingClientRect();
      const pad = 14;
      const box = { left: b.left - pad, right: b.right + pad, top: b.top - pad, bottom: b.bottom + pad };
      let covers = false;
      document.querySelectorAll('[data-guard]').forEach(el => {
        if (covers) return;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        if (!(box.right < r.left || box.left > r.right || box.bottom < r.top || box.top > r.bottom)) covers = true;
      });
      const hide = covers && this.state.wa !== 'open';
      if (hide !== !!this.state.waHidden) this.setState({ waHidden: hide });
    };
    // ── הרקע נע עם הגלילה: מנוע אחד שמחשב התקדמות ומזיז את השכבות ──
    this.reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.bg = {};
    const grab = () => {
      const b = document.querySelector('[data-bg]');
      if (!b) return setTimeout(grab, 300);
      this.bg = {
        tint: b.querySelector('[data-bg-tint]'),
        a: b.querySelector('[data-bg-glow="a"]'),
        bb: b.querySelector('[data-bg-glow="b"]'),
        c: b.querySelector('[data-bg-glow="c"]'),
        arcs: b.querySelector('[data-bg-arcs]'),
        dots: b.querySelector('[data-bg-dots]'),
        lines: b.querySelector('[data-bg-lines]')
      };
    };
    grab();
    this.paintBg = () => {
      const g = this.bg;
      if (!g.a) return;
      const d = document.documentElement;
      const max = Math.max(1, d.scrollHeight - d.clientHeight);
      const p = Math.max(0, Math.min(1, (d.scrollTop || document.body.scrollTop) / max));
      const ease = p * p * (3 - 2 * p);
      const t = this.reduce ? 0 : performance.now() / 1000;
      const br = (hz, amp) => Math.sin(t * hz) * amp;
      // סימן אחד עצום, והדף הוא הריבוע שנע עליו — רצוף לגמרי עם הגלילה:
      // נקודות המוקד של האזורים הן תחנות, והמסך נע ביניהן לפי מיקום הגלילה בפועל
      const secs = Array.from(document.querySelectorAll('[data-focus]'));
      const mid = innerHeight * 0.42;
      const stops = secs.map(s => {
        const r = s.getBoundingClientRect();
        const v = (s.getAttribute('data-focus') || '').split(',').map(Number);
        // ראש הדף הוא תחנה בקצה העליון של המסמך, כך שכל פיקסל גלילה כבר מזיז
        const anchor = s.tagName === 'HEADER' ? r.top - (mid - 0) : r.top + r.height * 0.5 - mid;
        return { y: anchor, x: v[0] || 0, fy: v[1] || 0, s: v[2] || 1 };
      }).sort((p, q) => p.y - q.y);
      let cur = { x: 34, y: 30, s: 1 }, active = 0;
      if (stops.length) {
        if (stops[0].y >= 0) { cur = { x: stops[0].x, y: stops[0].fy, s: stops[0].s }; active = 0; }
        else if (stops[stops.length - 1].y <= 0) { const l = stops[stops.length - 1]; cur = { x: l.x, y: l.fy, s: l.s }; active = stops.length - 1; }
        else {
          for (let i = 0; i < stops.length - 1; i++) {
            const A = stops[i], B = stops[i + 1];
            if (A.y <= 0 && B.y >= 0) {
              const t = (0 - A.y) / Math.max(1, B.y - A.y);
              const e = t * t * (3 - 2 * t);
              cur = { x: A.x + (B.x - A.x) * e, y: A.fy + (B.fy - A.fy) * e, s: A.s + (B.s - A.s) * e };
              active = t < .5 ? i : i + 1;
              break;
            }
          }
        }
      }
      this.bgCur = cur;
      g.a.style.transform = 'translate3d(' + cur.x.toFixed(2) + 'vmax,' + cur.y.toFixed(2) + 'vmax,0) scale(' + cur.s.toFixed(3) + ')';
      // מסילת המספרים מסמנת את האזור הפעיל
      if (g.arcs && active !== this.bgActive) {
        this.bgActive = active;
        Array.prototype.forEach.call(g.arcs.children, (el, i) => {
          const on = i === active;
          el.style.color = on ? '#16150F' : '#B3ADA1';
          const tick = el.firstElementChild;
          if (tick) { tick.style.width = on ? '40px' : (i % 2 ? '26px' : '16px'); tick.style.background = on ? '#C4552F' : '#D8D3C9'; }
        });
      }
      g.arcs.style.transform = 'translate3d(0,0,0)';
      g.dots.style.backgroundPosition = '0 ' + (-120 * ease) + 'px';
      g.dots.style.opacity = String(.3 - .12 * ease);
      g.tint.style.opacity = String(Math.max(0, ease * 1.05 - .05));
    };
    // הלופ קורא למתודה, כך שעדכוני קוד חיים נתפסים בלי לטעון מחדש את הדף
    this.guardLoop = () => { try { this.frame(); } catch (e) { if (!this.warned) { this.warned = true; console.warn(e); } } this.guardRaf = requestAnimationFrame(this.guardLoop); };
    this.onResizeH = () => { this.placed = false; };
    window.addEventListener('resize', this.onResizeH);
    this.guardRaf = requestAnimationFrame(this.guardLoop);
    this.onScroll = () => {
      const d = document.documentElement;
      const r = (d.scrollTop || document.body.scrollTop) / Math.max(1, d.scrollHeight - d.clientHeight);
      if (r > 0.25 && !this.state.waTeased && this.state.wa === 'closed' && !this.waDismissed) this.setState({ waTeased: true });
    };
    window.addEventListener('scroll', this.onScroll, { passive: true });
  }

  componentWillUnmount() {
    if (this.io) this.io.disconnect();
    if (this.guardRaf) cancelAnimationFrame(this.guardRaf);
    window.removeEventListener('scroll', this.onScroll);
  }

  root() { return document; }

  // ── הנפשה ─────────────────────────────────────────────────────
  animEls() {
    const host = document.querySelector('[data-watch="anim"]');
    return host ? host.getAnimations({ subtree: true }) : [];
  }
  toggleAnim = () => {};
  replay = () => {
    this.animEls().forEach(a => { try { a.currentTime = 0; a.play(); } catch (e) {} });
    this.setState({ anim: 'playing' });
  };
  // עמודת השלבים גדלה לגובה השכבה הגבוהה ביותר, כך ששום שלב לא גולש מהבמה
  fitSteps() {
    const col = document.querySelector('[data-steps]');
    if (!col) return;
    const w = col.clientWidth;
    if (this.stepsW === w) return;
    let max = 0;
    Array.prototype.forEach.call(col.children, (layer) => {
      const inner = layer.firstElementChild;
      if (inner) max = Math.max(max, inner.scrollHeight);
    });
    if (max > 0) { col.style.minHeight = (max + 8) + 'px'; this.stepsW = w; }
  }

  frame() {
    this.fitSteps();
    // Deliberately not called: see build-logic.mjs. The widget stays put.
    this.paintBg && this.paintBg();
    this.loopDemo();
    this.placeHeadline();
  }

  // לופ אינסופי: כשהתסריט (38 שניות) מסתיים, הכול חוזר להתחלה
  DEMO_LEN = 38;                                  // אורך פס ההתקדמות
  loopDemo() {
    const host = document.querySelector('[data-watch="anim"]');
    if (!host) return;
    const tk = host.querySelector('[data-demo-tk]');
    const a = tk && tk.getAnimations()[0];
    if (!a) return;
    // אנימציה שהסתיימה נעצרת על זמן הסיום — זה הרגע להתחיל מחדש (עם שנייה של מנוחה)
    if (a.playState === 'finished' || Number(a.currentTime) >= this.DEMO_LEN * 1000 - 5) {
      if (!this.loopAt) this.loopAt = performance.now() + 1200;
      if (performance.now() >= this.loopAt) { this.loopAt = 0; this.replay(); }
    }
  }

  // ── למי זה מתאים · הבחירה מכוונת את שורת ההסבר ואת הכפתור ─────
  FIT = [
    { line: 'אדם אחד מול כל הפניות? עובד ה־AI עונה, בודק ומבצע — ואתם מצטרפים רק כשצריך', cta: 'הראו לי איך זה עובד לעסק של אחד' },
    { line: 'צוות קטן שמתחלק בין וואטסאפ, אינסטגרם ומייל? הכול מתרכז לתיבה אחת, עם קופיילוט לכל אחד', cta: 'קבעו דמו של 15 דק׳ לצוות שלכם' },
    { line: 'מאות פניות ביום? עובדי ה־AI סוגרים את החוזרות, והנציגים מקבלים רק את מה שדורש אדם — עם כל ההקשר', cta: 'קבעו דמו של 15 דק׳ לצוות המכירות' }
  ];
  pickFit = (i) => () => { this.track('fit_pick_' + i, false); this.setState({ fit: i }); };

  // ── הכותרת הראשית יושבת על החלק הבהיר של הסימן ───────────────
  placeHeadline() {
    if (true) return;   // הכותרת יושבת בסקשן משלה, אין צורך במיקום דינמי
    const h1 = document.querySelector('h1');
    const mark = document.querySelector('[data-bg-glow="a"] img');
    if (!h1 || !mark || !mark.complete || !mark.naturalWidth || this.placed) return;
    if (scrollY > 4 || !this.bgCur) return;        // רק במצב ההתחלתי, ואחרי שהסימן כבר במקומו
    const col = h1.parentElement;
    const cw = col.clientWidth, hw = Math.min(595, cw), hh = h1.offsetHeight || 260;
    if (!this.alpha) {
      const c = document.createElement('canvas'); c.width = 128; c.height = 128;
      const x = c.getContext('2d'); x.drawImage(mark, 0, 0, 128, 128);
      this.alpha = x.getImageData(0, 0, 128, 128).data;
    }
    const mr = mark.getBoundingClientRect();
    const ink = (px, py) => {
      const u = Math.floor(((px - mr.left) / mr.width) * 128), v = Math.floor(((py - mr.top) / mr.height) * 128);
      if (u < 0 || v < 0 || u > 127 || v > 127) return 0;
      return this.alpha[(v * 128 + u) * 4 + 3] / 255;
    };
    const cr = col.getBoundingClientRect();
    const baseTop = cr.top;
    let best = { score: Infinity, dx: 0, dy: 0 };
    for (let dy = 0; dy <= 260; dy += 20) for (let dx = 0; dx <= Math.max(0, cw - hw); dx += 40) {
      let s = 0, n = 0;
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
        s += ink(cr.right - dx - hw + (hw * i) / 4, baseTop + dy + (hh * j) / 4); n++;
      }
      const score = s / n + dy * 0.0006 + dx * 0.0004;   // עדיפות קלה למקום המקורי
      if (score < best.score) best = { score, dx, dy };
    }
    // הסימן מכסה את כל עמודת הפתיחה בנקודת ההתחלה, כך שאין "חלק בהיר" גדול
    // מספיק לכותרת — במקום להזיז אותה, הכותרת יושבת על לוח נייר בהיר משלה
    this.placed = true;
  }

  // ── רצועת הערוצים: הזזה מדודה בדיוק ברוחב קבוצה אחת + מרווח אחד,
  //    כך שהתפר בין הסוף להתחלה נופל בדיוק על אותו מרחק כמו כל השאר ─
  runMarquee() {
    const track = document.querySelector('[data-track]');
    const grp = track && track.querySelector('[data-grp]');
    if (!track || !grp) return;
    const w = grp.getBoundingClientRect().width;
    if (w < 10) { requestAnimationFrame(() => this.runMarquee()); return; }
    const gap = parseFloat(getComputedStyle(track).columnGap) || 44;
    const shift = w + gap;
    if (this.mqShift === shift && this.mqAnim && this.mqAnim.playState === 'running') return;
    this.mqShift = shift;
    const at = this.mqAnim ? Number(this.mqAnim.currentTime) || 0 : 0;
    if (this.mqAnim) this.mqAnim.cancel();
    this.mqAnim = track.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-' + shift + 'px)' }],
      { duration: (shift / 55) * 1000, iterations: Infinity, easing: 'linear' }
    );
    if (at) this.mqAnim.currentTime = at % ((shift / 55) * 1000);
  }

  // ── שאלות נפוצות ──────────────────────────────────────────────
  ask = (i) => () => this.setState({ open: this.state.open === i ? null : i });

  // ── ווידג׳ט WhatsApp ──────────────────────────────────────────
  waOpen = () => { this.track('widget_open', false); this.setState({ wa: 'open', waTeased: false }); };
  waClose = () => { this.waDismissed = true; this.setState({ wa: 'closed', waTeased: false }); };
  waType = (e) => { this.setState({ waDraft: e.target.value }); };

  // מסמכי האתר עוד לא סופקו: מציגים טקסט מסומן ולא קישור שמתחזה לעבוד
  legalLink(label, url) {
    // הפוטר יושב ישירות על הסימן הענק — הטוקן הכהה הוא היחיד שעומד ב-AA שם
    if (url) return React.createElement('a', { href: url, target: '_blank', rel: 'noopener', style: { color: '#B8B3AA', fontWeight: 500 } }, label);
    // אין כתובת: טקסט נגיש שאינו קישור. מצב ההשלמה נשמר ב-title וב-CFG בלבד.
    return React.createElement('span', {
      title: 'המסמך יחובר לפני הפרסום',
      style: { color: '#B8B3AA', borderBottom: '1px dotted #55524C', cursor: 'default' }
    }, label);
  }
  waSend = () => {
    const msg = (this.state.waDraft || '').trim() || 'היי, הגעתי מדף הקמפיין של GOTCHA ויש לי שאלה.';
    this.track('whatsapp_click', false);
    window.open('https://wa.me/' + this.CFG.waNumber + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
  };

  // ── טופס ──────────────────────────────────────────────────────
  set = (f) => (e) => {
    const v = e.target.value;
    this.vals = Object.assign({}, this.vals || this.state.values); this.vals[f] = v;
    this.track('form_start', true);
    // A controlled input needs a render to show what was typed, so this goes
    // through setState on every keystroke, error or not.
    const errs = Object.assign({}, this.state.errors);
    delete errs[f];
    this.setState({ errors: errs, values: this.vals });
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

  submit = (ev) => {
    ev.preventDefault();
    // The form that was submitted, captured before any setState, so an error is
    // reported inside it rather than in whichever form happens to be first.
    const submittedForm = ev && ev.currentTarget && ev.currentTarget.querySelector ? ev.currentTarget : null;
    const v = Object.assign({}, this.state.values, this.vals || {});
    const errs = this.validate(v);
    if (Object.keys(errs).length) {
      this.setState({ errors: errs, values: v });
      const scope = submittedForm || this.root();
      const el = scope && scope.querySelector('[data-field="' + Object.keys(errs)[0] + '"] input');
      if (el) el.focus();
      return;
    }
    this.track('demo_form_submit_attempt', false);
    if (!this.CFG.leadEndpoint) {
      // אין יעד מחובר: לא מציגים הצלחה ולא יורים אירוע ליד
      this.setState({ values: v, errors: { form: 'החיבור לשליחת הטופס ממתין להגדרה. עד אז אפשר לתאם הדגמה ביומן או לכתוב לנו בוואטסאפ.' } });
      console.warn('[lead endpoint not configured] CFG.leadEndpoint');
      return;
    }
    this.setState({ sending: true, values: v, errors: {} });
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
        // Already on the list: same outcome for them, no second conversion.
        this.setState({ sent: true, sending: false });
        return;
      }
      if (!r.ok) throw new Error('save failed');
      this.track('lead', false);
      this.setState({ sent: true, sending: false });
    }).catch(() => this.setState({ sending: false, errors: { form: 'השליחה נכשלה. נסו שוב, או תאמו הדגמה ביומן.' } }));
  };

  renderVals() {
    const s = this.state, e = s.errors, v = Object.assign({}, s.values, this.vals || {});
    const err = (f) => e[f] || '';
    return {
      cfg: this.cfg,
      offerOn: this.CFG.offerActive,
      ev: {
        demoTop: () => this.track('demo_click_header', false),
        demoHero: () => this.track('demo_click_hero', false),
        demoAnim: () => this.track('demo_click_section', false),
        demoForm: () => this.track('demo_click_form', false),
        demoBar: () => this.track('demo_click_sticky', false),
        demoGift: () => this.track('demo_click_gift', false),
        demoFooter: () => this.track('demo_click_footer', false),
        waFooter: () => this.track('whatsapp_click_footer', false),
        telFooter: () => this.track('phone_click_footer', false),
        mailFooter: () => this.track('mail_click_footer', false),
        // שלב א׳: הקופסה נשארת והמכסה עף. שלב ב׳: התוכן יוצא ממנה
        giftOpen: () => {
          if (this.state.gift) return;
          this.track('gift_open', false);
          this.setState({ gift: true });
        },
        giftJump: () => {
          this.track('gift_open_hero', false);
          this.setState({ gift: true });
          const el = document.getElementById('form');
          if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 20, behavior: 'smooth' });
        },
        giftClose: () => this.setState({ gift: false }),
        stop: (e) => e.stopPropagation(),
        waBar: () => { this.track('whatsapp_click', false); }
      },
      gift: { show: s.gift ? 'open' : 'closed', boxDisplay: s.gift ? 'none' : 'flex', cardDisplay: s.gift ? 'flex' : 'none' },
      anim: { state: s.anim, label: '', toggle: this.toggleAnim, replay: this.replay },
      fit: {
        is0: (s.fit ?? 0) === 0, is1: s.fit === 1, is2: s.fit === 2,
        pick0: this.pickFit(0), pick1: this.pickFit(1), pick2: this.pickFit(2),
        line: this.FIT[s.fit ?? 0].line, cta: this.FIT[s.fit ?? 0].cta
      },
      faq: { q0: this.ask(0), q1: this.ask(1), q2: this.ask(2), q3: this.ask(3),
             is0: s.open === 0, is1: s.open === 1, is2: s.open === 2, is3: s.open === 3 },
      bar: { hidden: s.wa === 'open' ? 'hidden' : 'shown' },
      wa: {
        teased: s.waTeased, open: s.wa === 'open', openIt: this.waOpen, close: this.waClose,
        toggle: s.wa === 'open' ? this.waClose : this.waOpen,
        fabLabel: s.wa === 'open' ? 'סגירת חלון הפנייה' : 'פתיחת חלון פנייה בוואטסאפ',
        fabText: s.wa === 'open' ? 'סגירה' : '',
        iconChat: s.wa === 'open' ? 'none' : 'flex',
        iconClose: s.wa === 'open' ? 'flex' : 'none',
        type: this.waType, send: this.waSend, draft: s.waDraft || '',
        hide: s.waHidden && s.wa !== 'open' ? '1' : '0'
      },
      legal: {
        privacy: this.legalLink('מדיניות הפרטיות', this.CFG.privacyUrl),
        footer: [
          this.legalLink('תנאי שימוש', this.CFG.termsUrl),
          this.legalLink('מדיניות פרטיות', this.CFG.privacyUrl),
          this.legalLink('תנאי ההטבה', this.CFG.offerTermsUrl),
          this.legalLink('הצהרת נגישות', this.CFG.accessibilityUrl),
          this.legalLink('העדפות עוגיות', this.CFG.cookiesUrl)
        ].map((el, i) => React.cloneElement(el, { key: i }))
      },
      form: {
        name: v.name, phone: v.phone, site: v.site, email: v.email,
        onName: this.set('name'), onPhone: this.set('phone'), onSite: this.set('site'), onEmail: this.set('email'),
        submit: this.submit, sent: s.sent, editing: !s.sent,
        cta: s.sending ? 'שולח…' : 'חזרו אליי להדגמה',
        eName: err('name'), ePhone: err('phone'), eSite: err('site'), eEmail: err('email'), eForm: err('form'),
        hasName: !!err('name'), hasPhone: !!err('phone'), hasSite: !!err('site'), hasEmail: !!err('email'), hasForm: !!err('form')
      }
    };
  }

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
}


export default CampaignLogic;
