/* Ported from the "GOTCHA Landing.dc.html" script block by tools/build-logic.mjs.
   The class body is the design's own source - keep edits there, not here. */
/* eslint-disable */
'use client';

import React from 'react';
import Template from '@/generated/Template';
import Chrome from '@/generated/Chrome';
import { HE_DICT } from '@/generated/he';
import { getLucide } from '@/lib/lucide';
import UrlSync from '@/components/UrlSync';

class LandingLogic extends React.Component {
  state = { mnav: false, menu: null, step: 0, uc: 0, faq: 0, shot: 0, page: (this.props && this.props.initialPage) || 'home', vol: 2, yearly: false, pfaq: 0, biz: 'retail', trade: 0, post: null, lang: (this.props && this.props.initialLang) || 'en', trace: 0, dirCat: 'All integrations', dirQ: '', pcp: 0, pai: 0, ccp: 0, cai: 0, offerOpen: false, barOffer: true, barAnn: true, widget: { q: null, typing: false, acted: false } };

  // The timeline spine is a grey track that fills orange as it passes the reading line,
  // so the colour arrives with the scroll rather than all at once on reveal.
  setupSpines() {
    const root = this.host || document;
    const pick = () => {
      const a = Array.from(root.querySelectorAll('[data-spine-fill]'));
      return a.length ? a : Array.from(document.querySelectorAll('[data-spine-fill]'));
    };
    this.paintSpines = () => {
      const line = window.innerHeight * 0.62;   // the reading line: a little below centre
      pick().forEach(s => {
        const r = s.getBoundingClientRect();
        if (!r.height) return;
        const p = Math.max(0, Math.min(1, (line - r.top) / r.height));
        const pct = (p * 100).toFixed(1);
        s.style.transition = 'none';
        s.style.background = p <= 0 ? '#E8E3D9'
          : 'linear-gradient(#C4552F ' + pct + '%, #E8E3D9 ' + pct + '%)';
        const dot = s.parentElement && s.parentElement.querySelector('[data-spine-dot]');
        if (dot) {
          const on = r.top + r.height * 0.5 - 38 <= line;
          dot.style.background = on ? '#C4552F' : '#DCD8D0';
          dot.style.transform = on ? 'scale(1.25)' : 'none';
        }
      });
    };
    let queued = false;
    this.spineScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.paintSpines(); });
    };
    window.addEventListener('scroll', this.spineScroll, { passive: true });
    document.addEventListener('scroll', this.spineScroll, { passive: true, capture: true });
    window.addEventListener('resize', this.spineScroll);
    this.spineTimer = setInterval(() => this.paintSpines(), 250);   // hosts where scroll never reaches us
    this.paintSpines();
  }

  // The stack pyramid: the wires draw and the tiles land row by row as the section
  // crosses the reading line, so GOTCHA reads as arriving on top of the stack.
  setupPyramid() {
    const root = this.host || document;
    const find = (sel) => {
      const a = Array.from(root.querySelectorAll(sel));
      return a.length ? a : Array.from(document.querySelectorAll(sel));
    };
    const cl = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
    const out3 = (t) => 1 - Math.pow(1 - t, 3);
    const paint = () => {
      const tiles = find('[data-pyr]');
      if (!tiles.length) return;
      const box = tiles[0].parentElement;
      const r = box.getBoundingClientRect();
      if (!r.height) return;
      const p = cl((window.innerHeight * 0.92 - r.top) / (r.height * 0.95));
      find('[data-pyr-line]').forEach(el => {
        const i = +el.dataset.i;
        el.setAttribute('stroke-dashoffset', String(1 - out3(cl((p - 0.06 - i * 0.20) / 0.20))));
      });
      tiles.forEach(el => {
        const i = +el.dataset.i;
        const k = out3(cl((p - 0.14 - i * 0.030) / 0.20));
        el.style.opacity = String(k);
        el.style.transform = 'translateY(' + ((1 - k) * 14).toFixed(1) + 'px) scale(' + (0.9 + k * 0.1).toFixed(3) + ')';
      });
      const apexEl = find('[data-pyr-apex]')[0];
      if (apexEl) apexEl.style.transform = 'scale(' + (1 + 0.05 * out3(cl((p - 0.02) / 0.22))).toFixed(3) + ')';
    };
    let queued = false;
    this.pyrScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; paint(); });
    };
    window.addEventListener('scroll', this.pyrScroll, { passive: true });
    document.addEventListener('scroll', this.pyrScroll, { passive: true, capture: true });
    window.addEventListener('resize', this.pyrScroll);
    this.pyrTimer = setInterval(paint, 250);
    paint();
  }

  // The product section is a scroll stage: messages arrive scattered, then converge into
  // the single window. Driven imperatively so scrolling never re-renders the page, with a
  // timed fallback for hosts where scroll events never reach the document.
  setupStage() {
    const root = this.host || document;
    const sec = root.querySelector('#screens') || document.getElementById('screens');
    const stage = sec && sec.querySelector('[data-stage]');
    if (!stage) return;
    const cards = Array.from(sec.querySelectorAll('[data-fly]'));
    const app = sec.querySelector('[data-app]');
    const head = sec.querySelector('[data-head]');
    const headA = sec.querySelector('[data-head-a]');
    const headB = sec.querySelector('[data-head-b]');
    const tabs = sec.querySelector('[data-tabs]');
    if (!app || !headA || !headB || !tabs) return;
    const cl = v => v < 0 ? 0 : v > 1 ? 1 : v;
    const out3 = t => 1 - Math.pow(1 - t, 3);
    const inOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const apply = (p) => {
      const w = stage.offsetWidth || 1240, h = stage.offsetHeight || 680;
      const HEAD = 124, CW = 152, CH = 52;            // header bottom, card half width, half height
      const sx = Math.max(.18, Math.min(1, (w / 2 - CW) / 620));
      const syUp = Math.max(.14, Math.min(1, (h / 2 - HEAD - CH) / 340));
      const syDn = Math.max(.14, Math.min(1, (h / 2 - CH - 44) / 340));
      const boxK = Math.max(.62, Math.min(1, sx * 1.4));
      const tight = w < 1180 || h < 760;
      const KEEP = [0, 1, 4, 7];                       // WhatsApp, Instagram, web chat, the call
      // measured, so a headline that wraps to two lines still owns its space
      const stTop = stage.getBoundingClientRect().top;
      const bot = (el) => el.getBoundingClientRect().bottom - stTop;
      const headBot = Math.max(bot(head), bot(headA), bot(headB));
      cards.forEach((el, i) => {
        if (tight && KEEP.indexOf(i) < 0) { el.style.opacity = '0'; el.style.transform = 'scale(.6)'; return; }
        const dy = parseFloat(el.dataset.y || 0);
        const R = parseFloat(el.dataset.r || 0);
        let X = parseFloat(el.dataset.x || 0) * sx, Y = dy * (dy < 0 ? syUp : syDn);
        if (tight) {
          const q = KEEP.indexOf(i);
          X = (q === 0 || q === 3 ? -1 : 1) * Math.max(120, w / 2 - CW * boxK - 8);
          Y = (q < 2 ? headBot + 44 + CH * boxK : h - 62 - CH * boxK) - h / 2;
        } else if (Math.abs(X) < 380) {
          Y = Math.max(Y, headBot + 34 + CH - h / 2);   // never over the headline
        }
        const k = out3(cl((p - i * .016) / .10));
        const c = inOut(cl((p - .40 - (cards.length - 1 - i) * .012) / .26));
        el.style.opacity = String(k * (1 - c));
        el.style.transform = 'translate3d(' + (X * (1 - c)).toFixed(1) + 'px,' + (Y * (1 - c) + (1 - k) * 24).toFixed(1) + 'px,0) scale(' + (boxK * (.9 + .1 * k) * (1 - .8 * c)).toFixed(3) + ') rotate(' + (R * (1 - c)).toFixed(2) + 'deg)';
      });
      const g = out3(cl((p - .66) / .26));
      const top0 = headBot + 10, bot0 = h - 56;            // close under the headline, clear of the tab row
      const room = bot0 - top0;
      const win = app.firstElementChild;
      if (win) win.style.height = Math.max(300, Math.min(900, room)) + 'px';   // fill the room, do not shrink into it
      const appH = app.offsetHeight || 600;
      const fit = Math.max(.34, Math.min(1, room / appH));
      const want = (top0 + bot0) / 2;                      // centre of the room under the headline
      const boxMid = 200 + appH / 2;                       // the element's own centre, which the transform is about
      app.style.opacity = String(cl((p - .66) / .12));
      app.style.transform = 'translate3d(0,' + ((1 - g) * 26 + (want - boxMid)).toFixed(1) + 'px,0) scale(' + (fit * (.4 + .6 * g)).toFixed(3) + ')';
      app.style.pointerEvents = p > .88 ? 'auto' : 'none';
      headA.style.opacity = String(1 - cl((p - .40) / .10));
      headB.style.opacity = String(cl((p - .48) / .09));
      tabs.style.opacity = String(cl((p - .86) / .10));
      tabs.style.pointerEvents = p > .9 ? 'auto' : 'none';
    };
    const draw = () => {
      if (!stage.offsetHeight || !stage.offsetWidth) return;   // no layout yet: never compute a scale from it
      const span = sec.offsetHeight - stage.offsetHeight;
      apply(cl(-sec.getBoundingClientRect().top / (span || 1)));
    };

    // fallback: some hosts render the page at full height and never fire a scroll, so the
    // same story plays on a timer with CSS transitions the moment the stage is on screen
    const ease = (on) => {
      const c = on ? 'opacity .85s ease, transform 1.15s cubic-bezier(.2,.75,.2,1)' : '';
      cards.forEach(e => { e.style.transition = c; });
      app.style.transition = on ? 'opacity 1s ease, transform 1.25s cubic-bezier(.2,.75,.2,1)' : '';
      [headA, headB, tabs].forEach(e => { e.style.transition = on ? 'opacity .8s ease' : ''; });
    };
    this.stageTimers = [];
    const play = () => {
      if (this.stagePlayed || this.stageScrolled) return;
      this.stagePlayed = true;
      ease(true);
      apply(.26);
      this.stageTimers.push(setTimeout(() => apply(.66), 1700), setTimeout(() => apply(1), 3200));
    };

    let last = null;
    this.stageScroll = () => {
      if (!this.stageScrolled) {
        this.stageScrolled = true;
        this.stageTimers.forEach(clearTimeout);
        ease(false);
      }
      last = null;
      draw();
    };
    window.addEventListener('resize', this.stageScroll);
    window.addEventListener('scroll', this.stageScroll, { passive: true });
    document.addEventListener('scroll', this.stageScroll, { passive: true, capture: true });
    window.addEventListener('load', draw);
    if (window.ResizeObserver) { this.stageRO = new ResizeObserver(() => draw()); this.stageRO.observe(stage); }
    if (window.IntersectionObserver) {
      this.stageIO = new IntersectionObserver((es) => {
        if (es.some(e => e.isIntersecting)) this.stageTimers.push(setTimeout(play, 700));
      }, { threshold: .3 });
      this.stageIO.observe(stage);
    }
    const loop = () => {
      this.stageRaf = requestAnimationFrame(loop);
      const t = sec.getBoundingClientRect().top;
      if (t === last) return;
      last = t;
      if (t > window.innerHeight * 1.6 || t < -sec.offsetHeight) return;
      if (this.stagePlayed && !this.stageScrolled) return;   // the timed fallback owns it
      draw();
    };
    setTimeout(draw, 0);
    setTimeout(draw, 400);
    draw();
    loop();
  }

  componentDidMount() {
    try { const l = localStorage.getItem('gotcha-lang'); if (l === 'he' || l === 'en') this.setState({ lang: l }); } catch (e) {}
    this.translateTimer = setInterval(() => this.translate(), 400);
    setTimeout(() => this.setupStage(), 60);
    this.setupSpines();
    // the offer panel introduces itself once, after the visitor has started reading
    this.offerScroll = () => {
      if (this.offerDismissed || this.offerShown) return;
      const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
      if (y < 700) return;
      this.offerShown = true;
      this.setState({ offerOpen: true });
    };
    window.addEventListener('scroll', this.offerScroll, { passive: true });
    document.addEventListener('scroll', this.offerScroll, { passive: true, capture: true });
    this.setupPyramid();
    let root = this.host || document;
    if (!root.querySelectorAll('[data-reveal]').length) root = document;
    const hide = (el) => {
      el.style.opacity = '0';
      el.style.transform = el.dataset.side === 'left' ? 'translateX(-36px)' : el.dataset.side === 'right' ? 'translateX(36px)' : 'translateY(18px)';
      ownSteps(el).forEach(s => { s.style.opacity = '0'; s.style.transform = 'translateY(10px)'; s.style.transition = 'opacity .55s ease, transform .55s cubic-bezier(.2,.75,.2,1)'; });
    };
    // steps belong to the nearest reveal wrapper, so a parent revealing doesn't fire a nested row early
    const ownSteps = (el) => Array.from(el.querySelectorAll('[data-step]')).filter(s => s.parentElement && s.parentElement.closest('[data-reveal]') === el);
    const reveal = (el) => {
      el.style.opacity = '1';
      el.style.transform = 'none';
      if (this.paintSpines) this.paintSpines();
      ownSteps(el).forEach((s, i) => { setTimeout(() => { s.style.opacity = '1'; s.style.transform = 'none'; }, Math.min(200 + i * 140, 2000)); });
      if (this.stagger) this.stagger(el);
    };
    this.reveal = reveal;
    const targets = Array.from(root.querySelectorAll('[data-reveal]'));
    targets.forEach(el => { hide(el); el.dataset.revwatch = '1'; });
    // blocks that appear later (a choice opens new sections) join the same scroll reveal
    this.watchReveals = () => {
      (this.host || document).querySelectorAll('[data-reveal]').forEach(el => {
        if (el.dataset.revwatch) return;
        el.dataset.revwatch = '1';
        hide(el);
        if (this.io) this.io.observe(el);
        setTimeout(() => { if (el.style.opacity === '0') reveal(el); }, 2600);
      });
    };
    this.io = new IntersectionObserver((es) => {
      es.forEach(e => { if (e.isIntersecting) { reveal(e.target); this.io.unobserve(e.target); } });
    }, { threshold: 0.06, rootMargin: '200px 0px 0px 0px' });
    targets.forEach(el => this.io.observe(el));
    this.failsafe = setTimeout(() => targets.forEach(reveal), 1800);

    const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // card rows deal themselves in behind their section, left to right
    this.stagger = (host) => {
      if (calm) return;
      Array.from(host.querySelectorAll('div')).filter(c => {
        if (c.dataset.staggered) return false;
        if (getComputedStyle(c).display !== 'grid') return false;
        if (c.children.length < 3 || c.children.length > 9) return false;
        if (c.getBoundingClientRect().height < 90) return false;
        return !Array.from(c.children).some(k => k.style.opacity || k.style.transform);
      }).slice(0, 2).forEach(c => {
        c.dataset.staggered = '1';
        Array.from(c.children).forEach((k, i) => {
          k.style.transition = 'opacity .6s ease, transform .6s cubic-bezier(.2,.75,.2,1)';
          k.style.opacity = '0';
          k.style.transform = 'translateY(16px)';
          setTimeout(() => { k.style.opacity = '1'; k.style.transform = 'none'; }, 90 + i * 85);
        });
      });
    };
    // hero block arrives a line at a time
    const heroHost = root.querySelector('[data-hero-in]');
    if (heroHost && !calm) {
      Array.from(heroHost.children).forEach((k, i) => {
        k.style.opacity = '0';
        k.style.transform = 'translateY(14px)';
        k.style.animation = 'gpop .85s cubic-bezier(.2,.75,.2,1) forwards';
        k.style.animationDelay = (120 + i * 130) + 'ms';
      });
      setTimeout(() => Array.from(heroHost.children).forEach(k => { k.style.opacity = '1'; k.style.transform = 'none'; }), 1400);
    }



    this.countIo = new IntersectionObserver((es) => {
      es.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target, target = parseFloat(el.getAttribute('data-count')), sfx = el.getAttribute('data-suffix') || '';
        if (isNaN(target)) { this.countIo.unobserve(el); return; }
        el.dataset.counted = '1';
        const t0 = performance.now(), dur = 1150;
        const tick = (now) => {
          const k = Math.min(1, (now - t0) / dur), e2 = 1 - Math.pow(1 - k, 3);
          el.textContent = Math.round(target * e2).toLocaleString() + sfx;
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        this.countIo.unobserve(el);
      });
    }, { threshold: 0.35 });
    root.querySelectorAll('[data-count]').forEach(el => this.countIo.observe(el));
    // anything the observer can never reach (already scrolled past on load, or offscreen
    // in an embedded frame) gets its final figure filled in rather than sitting at zero
    this.settleCounts = (force) => {
      root.querySelectorAll('[data-count]').forEach(el => {
        if (el.dataset.counted) return;
        const t = parseFloat(el.getAttribute('data-count'));
        if (isNaN(t)) return;
        if (!force && el.getBoundingClientRect().top > window.innerHeight * 0.9) return; // still below: let it animate on arrival
        el.dataset.counted = '1';
        el.textContent = t.toLocaleString() + (el.getAttribute('data-suffix') || '');
      });
    };
    // the sweep runs for the life of the page: figures that appear later (a page
    // switch remounts them from the template) get observed, then filled if the
    // observer can never reach them inside this frame's viewport
    this.countPass = () => {
      root.querySelectorAll('[data-count]').forEach(el => {
        if (el.dataset.counted) return;
        if (!el.dataset.seen) { el.dataset.seen = String(Date.now()); this.countIo.observe(el); return; }
        if (Date.now() - Number(el.dataset.seen) > 2200) this.settleCounts(true);
      });
    };
    setTimeout(this.countPass, 900);
    this.countSweep = setInterval(this.countPass, 1100);

    // paced replay: reading beat, steady trace, then a long hold on the answer before it loops
    this.stepDelay = (s) => (s === 0 ? 1700 : s === 8 ? 2600 : s === 9 ? 13000 : 1550);
    this.tick = () => {
      this.timer = setTimeout(() => {
        this.setState(s => ({ step: (s.step + 1) % 10 }), this.tick);
      }, this.stepDelay(this.state.step));
    };
    this.tick();
    this.paintIcons();
    this.iconTimer = setInterval(() => this.paintIcons(), 900);

    this.fitNav = () => {
      const w = window.innerWidth;
      // six nav items no longer fit at every width; compress rather than let the last one get sliced
      const compact = w < 1320, tight = w < 1160;
      document.querySelectorAll('[data-nav-item]').forEach(el => { el.style.padding = tight ? '8px 7px' : (compact ? '8px 10px' : '8px 13px'); el.style.gap = tight ? '4px' : '6px'; });
      document.querySelectorAll('[data-nav-label]').forEach(el => { el.style.fontSize = tight ? '13px' : '14px'; });
      document.querySelectorAll('[data-nav-caret]').forEach(el => { el.style.display = tight ? 'none' : 'inline-block'; });
      // the CTAs hide only when they genuinely stop fitting, measured after the compression above
      const secs = [...document.querySelectorAll('[data-nav-secondary]')];
      if (secs.length) {
        const group = secs[0].parentElement, row = group && group.parentElement;
        if (row) {
          secs.forEach(el => { el.style.display = ''; });
          const kids = [...row.children];
          const used = kids.reduce((n, el) => n + (el === group ? 0 : el.getBoundingClientRect().width), 0);
          const need = kids.filter(el => el !== group).length * 10 + 24 + secs.reduce((n2, el) => n2 + el.scrollWidth, 0);
          if (used + need > row.clientWidth) secs.forEach(el => { el.style.display = 'none'; });
        }
      }
    };
    this.fitNav();
    window.addEventListener('resize', this.fitNav);
    this.logoSweeps = [600, 1800, 4000].map(ms => setTimeout(() => this.sweepLogos(), ms));
  }

  // a brand mark the CDN no longer serves leaves a monogram, never a blank gap
  sweepLogos() {
    document.querySelectorAll('img[src*="simpleicons"]').forEach(img => {
      const done = () => {
        const host = img.parentNode;
        if (!host || host.dataset.fellback || img.naturalWidth) return;
        host.dataset.fellback = '1';
        img.style.display = 'none';
        const s = document.createElement('span');
        s.textContent = (img.getAttribute('alt') || '?').trim().charAt(0).toUpperCase();
        s.style.cssText = 'font:600 13px Archivo,sans-serif;line-height:1;color:#55524C';
        host.appendChild(s);
      };
      if (img.complete) done(); else img.addEventListener('error', done, { once: true });
    });
  }

  // lucide.createIcons() REPLACES the <i> element, which React still believes it owns.
  // Toggling any conditional branch that held one then throws removeChild. Paint the svg
  // inside the <i> instead: React keeps its node, the svg is just unmanaged content.
  // The store widget the visitor can actually drive: pick a question, watch it think,
  // get the answer plus the two products it would recommend.
  tryWidget() {
    const w = this.state.widget || { q: null, typing: false, acted: false };
    const QS = [
      { t: 'Will the king fit a 220×240 duvet?',
        a: 'King is made for 220×240, so it fits with a little to spare. Sand and white are both in stock in king.',
        recs: [{ t: 'Linen set · sand', p: '₪179 · king', swatch: 'linear-gradient(140deg,#EDE6DA,#D9CEBC)' },
               { t: 'Linen set · white', p: '₪179 · king', swatch: 'linear-gradient(140deg,#F6F4F0,#E4E1DA)' }],
        acted: 'King · sand added to your cart' },
      { t: 'Is sand back in stock, and when would it arrive?',
        a: 'Sand came back in this morning, 11 left in king. Ordered today it is with you Thursday, and delivery is free over ₪300.',
        recs: [{ t: 'Linen set · sand', p: '₪179 · in stock', swatch: 'linear-gradient(140deg,#EDE6DA,#D9CEBC)' },
               { t: 'Pillowcases · sand', p: '₪69 · pair', swatch: 'linear-gradient(140deg,#E7DFD1,#CFC3AF)' }],
        acted: 'Both added · ₪248, delivery free' },
      { t: 'I ordered last week. Where is it?',
        a: 'Order 41822 left the warehouse yesterday and is out for delivery today between 14:00 and 18:00. Want the tracking link?',
        recs: null, acted: 'Tracking link sent to your email' }
    ];
    const cur = w.q == null ? null : QS[w.q];
    return {
      title: 'A visitor asks. It answers, and it sells.',
      note: 'This is the widget, not a picture of it. Pick a question the way a customer would and watch what it does.',
      store: 'AVIV & CO.', nav: 'Bedding · Bath · Sale',
      url: 'avivandco.co.il/products/linen-duvet-set',
      navItems: ['Bedding', 'Bath', 'Sale'],
      heroA: 'The linen edit', heroB: 'New season · four colours',
      alsoLabel: 'Goes well with',
      also: [
        { t: 'Pillowcases', p: '₪69 · pair', swatch: 'linear-gradient(140deg,#E7DFD1,#CFC3AF)' },
        { t: 'Fitted sheet', p: '₪99', swatch: 'linear-gradient(140deg,#F1EEE8,#DCD6CA)' },
        { t: 'Waffle towel', p: '₪49', swatch: 'linear-gradient(140deg,#E3E5DE,#C7CCC1)' }
      ],
      product: 'Linen duvet set', price: '₪179 · four colours', blurb: 'Stone washed French linen. Single, double, queen, king.',
      sizes: [
        { t: 'Single', bd: '#E8E3D9', bg: '#FFFFFF', fg: '#16150F' },
        { t: 'Double', bd: '#E8E3D9', bg: '#FFFFFF', fg: '#16150F' },
        { t: 'Queen', bd: '#E8E3D9', bg: '#FFFFFF', fg: '#16150F' },
        { t: 'King', bd: '#16150F', bg: '#16150F', fg: '#FAF8F4' }
      ],
      buy: 'Add to cart', stock: '11 left in king',
      trust: ['Free delivery over ₪300', '30 day returns', 'Ships in 1 working day'],
      widgetName: 'Ask us anything', widgetSub: 'Answers in seconds, around the clock',
      greeting: 'Hi! Ask me anything about this set, your order or delivery.',
      tryLabel: 'Tap a question', composer: 'Write a message…', addLabel: 'Add to cart',
      asked: cur ? cur.t : '',
      typing: !!w.typing,
      answer: cur && !w.typing ? cur.a : '',
      recs: cur && !w.typing ? cur.recs : null,
      acted: cur && !w.typing && w.acted ? cur.acted : '',
      qs: QS.map((q, i) => ({
        t: q.t,
        pick: () => {
          clearTimeout(this.wTimer1); clearTimeout(this.wTimer2);
    (this.traceTimers || []).forEach(clearTimeout);
          this.setState({ widget: { q: i, typing: true, acted: false } });
          this.wTimer1 = setTimeout(() => this.setState({ widget: { q: i, typing: false, acted: false } }), 1100);
          this.wTimer2 = setTimeout(() => this.setState({ widget: { q: i, typing: false, acted: true } }), 2600);
        },
        bg: w.q === i ? '#FFFDFA' : '#FFFFFF',
        bd: w.q === i ? '#C4552F' : '#EFEAE1',
        fg: w.q === i ? '#8E3418' : '#3A3833'
      }))
    };
  }

  // Copilot working, beside the thread: the steps land one after another, the last one
  // stops and waits for the agent. Runs on its own once the band is on screen.
  copilotTrace() {
    const n = this.state.trace == null ? 0 : this.state.trace;   // 0..5, 5 = approved
    const STEPS = [
      { t: 'Reading the thread', d: 'Three messages, one order, an angry tone', ms: '0.4s', icon: 'brain' },
      { t: 'Pulling her record', d: 'Dana Cohen · 4 orders · #1842, queen, 12 March', ms: '0.9s', icon: 'database' },
      { t: 'Checking the carrier', d: 'Stuck in the depot since Tuesday, no movement', ms: '1.4s', icon: 'truck' },
      { t: 'Checking stock', d: 'King in sand: 11 left, next batch ships tomorrow', ms: '1.8s', icon: 'package-search' },
      { t: 'Refunding ₪179', d: 'Above your ₪150 limit, so it stops here', ms: '2.2s', icon: 'hand' }
    ];
    const start = (delay) => {
      if (this.traceRunning) return;
      this.traceRunning = true;
      this.traceTimers = STEPS.map((s, i) => setTimeout(() => this.setState({ trace: i + 1 }), delay + i * 700));
    };
    if (!this.traceRunning) setTimeout(() => start(600), 0);
    return {
      kicker: 'Copilot, working', title: 'It thinks out loud, then waits for you.',
      note: 'Every step it takes is on the panel beside the thread: what it read, what it looked up, and the one thing it will not do without you.',
      ini: 'DC', who: 'Dana Cohen', whoMeta: 'WhatsApp · order #1842', threadTag: 'Open',
      msgs: [
        { t: 'Third time I am writing. Where is my order? It was a gift and the date has passed.', side: 'in' }
      ].map(m => ({ t: m.t, align: 'flex-start', bg: '#F5F2EC', fg: '#16150F', bd: '#EDE9E1', radius: '14px 14px 14px 4px' })),
      ctxLabel: 'The whole customer, on the same screen',
      facts: [
        { k: 'Customer since', v: 'Nov 2024' },
        { k: 'Orders', v: '4 · ₪716' },
        { k: 'This order', v: '#1842 · queen' },
        { k: 'Returns', v: 'none' }
      ],
      histLabel: 'Everywhere she has written',
      history: [
        { t: 'Asked whether the linen came in king', when: '12 Mar', logo: 'https://cdn.simpleicons.org/instagram/E4405F', ch: 'Instagram' },
        { t: 'Order confirmation for #1842', when: 'Tue', logo: 'https://cdn.simpleicons.org/gmail/EA4335', ch: 'Email' },
        { t: 'Chased the delivery twice', when: 'Thu, Fri', logo: 'https://cdn.simpleicons.org/whatsapp/25D366', ch: 'WhatsApp' },
        { t: 'Called, waited, hung up', when: 'Fri 17:20', icon: 'phone-missed', noLogo: true, ch: 'Phone' }
      ],
      panelT: 'Copilot', panelSub: 'Working on this thread',
      steps: STEPS.map((s, i) => {
        const on = n > i, live = n === i;
        return Object.assign({}, s, {
          op: on || live ? '1' : '0.22',
          fg: on || live ? '#F7F5F1' : '#8E8A83',
          dotBg: on ? (i === 4 ? '#E0A458' : '#2C4433') : (live ? '#2A2823' : '#221F1B'),
          dotFg: on ? (i === 4 ? '#16150F' : '#A8C57A') : '#6E6A63',
          icon: on && i < 4 ? 'check' : s.icon,
          anim: live ? 'gpulse 1.1s ease-in-out infinite' : 'none',
          ms: on ? s.ms : (live ? '…' : '')
        });
      }),
      needApproval: n === 5,          // all five steps landed, nothing approved yet
      replyShown: n >= 5,             // the draft appears in the thread with the last step
      done: n >= 6,
      draftLabel: 'Copilot drafted this for you',
      draft: 'I am so sorry, Dana. #1842 has been stuck with the carrier since Tuesday, so I have refunded the full ₪179 and I can hold a king in sand from tomorrow\'s batch for you.',
      sendLabel: 'Send', editLabel: 'Edit first',
      approveT: 'Needs your approval', approveD: 'A ₪179 refund is above the limit you set, so it is waiting. Approving does the refund and sends the reply.',
      approveLabel: 'Approve', declineLabel: 'Not this time',
      doneT: 'Refunded ₪179 · reply sent · CRM updated',
      replayLabel: 'Watch it again',
      approve: () => this.setState({ trace: 6 }),
      replay: () => {
        (this.traceTimers || []).forEach(clearTimeout);
        this.traceRunning = false;
        this.setState({ trace: 0 });
        setTimeout(() => {
          this.traceRunning = true;
          this.traceTimers = STEPS.map((s, i) => setTimeout(() => this.setState({ trace: i + 1 }), 350 + i * 700));
        }, 60);
      }
    };
  }

  // The integrations directory: search plus categories on the left, cards on the right.
  integrationDir() {
    const L = (slug, hex) => 'https://cdn.simpleicons.org/' + slug + '/' + hex;
    const APPS = [
      { t: 'WhatsApp', c: 'Channels', logo: L('whatsapp', '25D366'), bg: '#EDF4E7',
        d: 'Your own number on the official Business Platform. Every message, template and broadcast in one queue.', tags: ['Messaging', 'Omnichannel inbox'] },
      { t: 'Instagram', c: 'Channels', logo: L('instagram', 'E4405F'), bg: '#FBEEE8',
        d: 'DMs, story replies, mentions and comments under your posts, answered in public or moved into a private chat.', tags: ['Messaging', 'Social'] },
      { t: 'Messenger', c: 'Channels', logo: L('messenger', '0084FF'), bg: '#EDF1F7',
        d: 'Page messages and post comments arrive beside everything else, with the same customer record attached.', tags: ['Messaging', 'Social'] },
      { t: 'Email', c: 'Channels', logo: L('gmail', 'EA4335'), bg: '#FBEEE8',
        d: 'Forward your support address and threads become conversations, summarised and searchable like any other channel.', tags: ['Messaging'] },
      { t: 'Web chat', c: 'Channels', icon: 'globe', ic: '#55524C', bg: '#F0EDE7',
        d: 'The widget on your store answers product questions, checks stock and adds to the cart while they are still reading.', tags: ['Messaging', 'Ecommerce'] },
      { t: 'Phone', c: 'Channels', icon: 'phone', ic: '#55524C', bg: '#F0EDE7',
        d: 'Call Pilot listens on the line and gives your agent the order, the history and the next line to say.', tags: ['Voice', 'Beta'] },
      { t: 'Shopify', c: 'Ecommerce', logo: L('shopify', '7AB55C'), bg: '#EDF4E7',
        d: 'Orders, tracking, stock and refunds. It reads the order and can open the exchange or send the label itself.', tags: ['Ecommerce', 'Actions'] },
      { t: 'WooCommerce', c: 'Ecommerce', logo: L('woocommerce', '96588A'), bg: '#F3EEF5',
        d: 'The same order lookups and actions on a WordPress store, with your products and policies in the knowledge base.', tags: ['Ecommerce', 'Actions'] },
      { t: 'ReturnGO', c: 'Ecommerce', icon: 'undo-2', ic: '#4B3E8E', bg: '#EFEBFA',
        d: 'Returns and exchanges opened from the conversation, inside the rules you already set up there.', tags: ['Ecommerce', 'Actions'] },
      { t: 'HubSpot', c: 'CRM', logo: L('hubspot', 'FF7A59'), bg: '#FBEEE8',
        d: 'Every conversation summarised onto the contact, with the deal stage updated and the follow-up task created.', tags: ['CRM', 'Automation'] },
      { t: 'Salesforce', c: 'CRM', icon: 'cloud', ic: '#3E5C99', bg: '#EDF1F7',
        d: 'Leads, cases and notes written back automatically, so nobody copies a chat into a record by hand.', tags: ['CRM', 'Automation'] },
      { t: 'Zoho CRM', c: 'CRM', logo: L('zoho', 'E42527'), bg: '#FBEEE8',
        d: 'Contacts enriched from the conversation, and the reply history visible on the record your team already uses.', tags: ['CRM'] },
      { t: 'monday.com', c: 'Operations', icon: 'kanban', ic: '#C4552F', bg: '#FBEEE8',
        d: 'Turn a request into an item on the right board, assigned, with the conversation linked to it.', tags: ['Operations', 'Automation'] },
      { t: 'Airtable', c: 'Operations', logo: L('airtable', '18BFFF'), bg: '#EDF1F7',
        d: 'Read a base to answer a question, or write a row when something needs to be tracked outside the inbox.', tags: ['Operations', 'Data'] },
      { t: 'Google Calendar', c: 'Operations', logo: L('googlecalendar', '4285F4'), bg: '#EDF1F7',
        d: 'Real availability in the conversation, and the appointment booked, moved or cancelled without a phone call.', tags: ['Scheduling', 'Actions'] },
      { t: 'Google Drive', c: 'Knowledge', logo: L('googledrive', '4285F4'), bg: '#EDF1F7',
        d: 'Connect a folder and the knowledge base stays in sync with the documents your team actually maintains.', tags: ['Knowledge'] },
      { t: 'Slack', c: 'Operations', icon: 'hash', ic: '#7A6A4F', bg: '#F3EEF5',
        d: 'Approvals and escalations land in the channel your team already watches, answerable from there.', tags: ['Operations', 'Approvals'] },
      { t: 'Zapier', c: 'Developers', logo: L('zapier', 'FF4F00'), bg: '#FBEEE8',
        d: 'Anything we have not built yet: trigger a zap from a conversation, or start a conversation from one.', tags: ['Automation'] },
      { t: 'Your ERP', c: 'Developers', icon: 'server', ic: '#55524C', bg: '#F0EDE7',
        d: 'Priority, SAP or the system your accountant chose in 2011. If it has an API, it can be read and written.', tags: ['Custom integration'] },
      { t: 'Open API', c: 'Developers', icon: 'code', ic: '#55524C', bg: '#F0EDE7',
        d: 'Our API and webhooks, so your developer can wire GOTCHA into whatever you run internally.', tags: ['Custom integration', 'Developers'] }
    ];
    const CATS = [
      { t: 'All integrations', icon: 'layout-grid' }, { t: 'Channels', icon: 'radio' },
      { t: 'Ecommerce', icon: 'shopping-cart' }, { t: 'CRM', icon: 'contact' },
      { t: 'Operations', icon: 'kanban' }, { t: 'Knowledge', icon: 'library' },
      { t: 'Developers', icon: 'code' }
    ];
    const cat = this.state.dirCat || 'All integrations';
    const q = (this.state.dirQ || '').trim().toLowerCase();
    const shown = APPS.filter(a => (cat === 'All integrations' || a.c === cat)
      && (!q || a.t.toLowerCase().includes(q) || a.d.toLowerCase().includes(q) || a.c.toLowerCase().includes(q)));
    return {
      note: 'Every one of these gives it real things it can do, not just data it can read. Anything missing, we connect through the API, usually in a week.',
      searchLabel: 'search for an app…', catLabel: 'Categories',
      q: this.state.dirQ || '',
      setQ: (e) => this.setState({ dirQ: e.target.value }),
      cats: CATS.map(c => ({
        t: c.t, icon: c.icon,
        n: c.t === 'All integrations' ? String(APPS.length) : String(APPS.filter(a => a.c === c.t).length),
        pick: () => this.setState({ dirCat: c.t }),
        bg: cat === c.t ? '#F5F2EC' : 'transparent',
        fg: cat === c.t ? '#16150F' : '#5B564D',
        ic: cat === c.t ? '#C4552F' : '#A29B8E',
        weight: cat === c.t ? '600' : '400'
      })),
      headTitle: cat, count: shown.length + (shown.length === 1 ? ' integration' : ' integrations'),
      apps: shown.map(a => Object.assign({}, a, { noLogo: !a.logo })),
      empty: shown.length ? null : true,
      emptyT: 'Nothing here by that name.',
      emptyD: 'Tell us what you run and we will connect it. Anything with an API takes about a week.',
      askT: 'Not on the list?', askD: 'Tell us what you run. If it has an API, we connect it, usually in a week.', askCta: 'Ask us →'
    };
  }

  paintIcons() {
    const L = getLucide();
    if (!L || !L.icons) return;
    const pascal = (s) => s.replace(/(^|-)([a-z0-9])/g, (m, a, b) => b.toUpperCase());
    document.querySelectorAll('[data-lucide]').forEach(el => {
      const name = el.getAttribute('data-lucide');
      if (!name || el.dataset.painted === name) return;
      const node = L.icons[pascal(name)];
      if (!node) return;
      // an IconNode is ["svg", rootAttrs, [[tag, attrs], …]] — the glyph is in node[2]
      const parts = Array.isArray(node[2]) ? node[2] : node;
      const body = parts.map(part => {
        const tag = part && part[0], attrs = (part && part[1]) || {};
        if (typeof tag !== 'string') return '';
        return '<' + tag + ' ' + Object.keys(attrs).map(k => k + '="' + attrs[k] + '"').join(' ') + '/>';
      }).join('');
      if (!body) return;
      el.dataset.painted = name;
      if (!el.style.display) el.style.display = 'inline-flex';
      el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (el.getAttribute('width') || 16) +
        '" height="' + (el.getAttribute('height') || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
        (el.getAttribute('stroke-width') || 2) + '" stroke-linecap="round" stroke-linejoin="round" style="display:block">' + body + '</svg>';
    });
  }

  componentDidUpdate() { this.paintIcons(); if (this.fitNav) this.fitNav(); this.sweepLogos(); if (this.watchReveals) this.watchReveals(); this.translate(); }

  // Hebrew is applied as a dictionary over the rendered text, so the English template stays
  // the single source of layout. Every English string with an entry in HE is replaced in place.
  translate() {
    const root = (this.host || document).querySelector('[dir]');
    if (!root) return;
    const he = this.state.lang === 'he';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(n => {
      const p = n.parentElement; if (!p || p.closest('script,style,[data-no-translate]')) return;
      const raw = n.nodeValue, t = raw.trim(); if (!t) return;
      if (he) {
        const h = HE_DICT[t] || HE_DICT[t.replace(/\s+/g, ' ')];
        if (h && h !== t) { if (!n.__en) n.__en = raw; n.nodeValue = raw.replace(t, h); }
      } else if (n.__en != null) { n.nodeValue = n.__en; n.__en = null; }
    });
    ['placeholder', 'alt', 'title'].forEach(attr => root.querySelectorAll('[' + attr + ']').forEach(el => {
      const v = el.getAttribute(attr); if (!v) return;
      if (he) { const h = HE_DICT[v.trim()]; if (h) { if (!el.dataset['en' + attr]) el.dataset['en' + attr] = v; el.setAttribute(attr, h); } }
      else if (el.dataset['en' + attr]) { el.setAttribute(attr, el.dataset['en' + attr]); delete el.dataset['en' + attr]; }
    }));
  }

  componentWillUnmount() {
    clearTimeout(this.timer); clearInterval(this.countSweep); clearTimeout(this.countForce);
    if (this.stageScroll) {
      window.removeEventListener('resize', this.stageScroll);
      window.removeEventListener('scroll', this.stageScroll);
      document.removeEventListener('scroll', this.stageScroll, true);
    }
    (this.stageTimers || []).forEach(clearTimeout);
    clearInterval(this.spineTimer);
    clearInterval(this.pyrTimer);
    if (this.offerScroll) {
      window.removeEventListener('scroll', this.offerScroll);
      document.removeEventListener('scroll', this.offerScroll, true);
    }
    clearTimeout(this.wTimer1); clearTimeout(this.wTimer2);
    (this.traceTimers || []).forEach(clearTimeout);
    if (this.pyrScroll) {
      window.removeEventListener('scroll', this.pyrScroll);
      document.removeEventListener('scroll', this.pyrScroll, true);
      window.removeEventListener('resize', this.pyrScroll);
    }
    if (this.spineScroll) {
      window.removeEventListener('scroll', this.spineScroll);
      document.removeEventListener('scroll', this.spineScroll, true);
      window.removeEventListener('resize', this.spineScroll);
    } clearInterval(this.translateTimer);
    if (this.stageRO) this.stageRO.disconnect();
    if (this.stageIO) this.stageIO.disconnect();
    if (this.stageRaf) cancelAnimationFrame(this.stageRaf);
    clearInterval(this.iconTimer); (this.logoSweeps || []).forEach(clearTimeout); clearTimeout(this.failsafe);
    if (this.fitNav) window.removeEventListener('resize', this.fitNav);
    if (this.io) this.io.disconnect(); if (this.countIo) this.countIo.disconnect();

  }

  // lucide.createIcons() destroys the <i> React owns, so a state-driven glyph would freeze
  // on whatever the first render produced. Build these as real React elements instead.
  glyph(name, size, color) {
    const L = getLucide();
    const pascal = String(name || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    const data = L && L.icons && (L.icons[pascal] || L.icons[name]);
    const base = {
      xmlns: 'http://www.w3.org/2000/svg', width: size, height: size, viewBox: '0 0 24 24',
      fill: 'none', stroke: color || 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { display: 'block' }
    };
    if (!data) return React.createElement('svg', base, React.createElement('circle', { cx: 12, cy: 12, r: 7, key: 'f' }));
    // lucide stores each icon as ['svg', attrs, children]; children are ['tag', attrs] pairs
    const nodes = data[2] || [];
    const camel = (k) => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    const kids = nodes.map((n, i) => {
      const tag = n[0];
      const src = n[1] || {};
      const attrs = { key: 'g' + i };
      Object.keys(src).forEach(k => { if (k !== 'key') attrs[camel(k)] = src[k]; });
      return React.createElement(tag, attrs);
    });
    return React.createElement('svg', base, kids);
  }

  renderVals() {
    const st = this.state, step = st.step;
    const L = (slug, hex) => 'https://cdn.simpleicons.org/' + slug + '/' + hex;
    // a brand mark that fails to load leaves a monogram, never an empty swatch
    const logoFail = (e) => {
      const img = e.currentTarget, host = img.parentNode;
      if (!host || host.dataset.fellBack) return;
      host.dataset.fellBack = '1';
      img.style.display = 'none';
      const s = document.createElement('span');
      s.textContent = (img.getAttribute('alt') || '?').trim().charAt(0).toUpperCase();
      s.style.cssText = 'font:600 14px Archivo,sans-serif;line-height:1';
      host.appendChild(s);
    };

    const MENUS = {
      product: {
        cols: [
          { t: 'The conversation', d: 'All your communication', icon: 'inbox', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [
              { t: 'Omnichannel', n: '6 channels', icon: 'inbox', page: 'feat-omnichannel' },
              { t: 'Customers', n: 'one record', icon: 'contact', page: 'feat-customers' },
              { t: 'Social engagement', n: 'comments   & DMד\n', icon: 'at-sign', page: 'feat-social' },
              { t: 'Store widget', n: 'sells', icon: 'shopping-cart', page: 'feat-widget' },
              { t: 'WhatsApp broadcast', n: 'campaigns that reply', icon: 'megaphone', page: 'feat-broadcast' }
            ] },
          { t: 'Beside your team', d: 'It does the reading, you decide', icon: 'square-pen', bg: '#EAE4FB', ic: '#4B3E8E',
            items: [
              { t: 'Your new employee', n: 'AI, on the team', icon: 'user-round-check', page: 'feat-employee' },
              { t: 'Copilot', n: 'in every thread', icon: 'square-pen', page: 'feat-copilot' },
              { t: 'Call pilot', n: 'beta', icon: 'phone-call', page: 'feat-callpilot' },
              { t: 'Approvals', n: 'your limits', icon: 'check-check', page: 'feat-approvals' }
            ] },
          { t: 'Teach it, measure it', d: 'Where the answers and the numbers live', icon: 'sliders-horizontal', bg: '#FBEEE8', ic: '#C4552F',
            items: [
              { t: 'Knowledge base', n: 'your sources', icon: 'library', page: 'feat-knowledge' },
              { t: 'AI Studio', n: 'no prompts', icon: 'sliders-horizontal', page: 'feat-studio' },
              { t: 'Analytics', n: 'named causes', icon: 'bar-chart-3', page: 'feat-analytics' }
            ] },
          { t: 'Connect it up', d: 'Where the messages and the data come from', icon: 'plug', bg: '#EDF1F7', ic: '#3E5C99',
            items: [
              { t: 'Channels', n: '8 channels', icon: 'radio', page: 'feat-channels' },
              { t: 'Integrations', n: '40+ systems', icon: 'plug', page: 'feat-integrations' }
            ] }
        ],
        railKicker: 'The product', railTitle: 'Every channel. One inbox.',
        railBody: 'WhatsApp, Instagram, Messenger, email and web chat, threaded by customer, with everything known about her beside the conversation.',
        railLink: 'See the product', railShot: '/assets/shots/inbox.png'
      },
      solutions: {
        cols: [
          { t: 'By business type', d: 'What a normal week looks like for you', icon: 'store', bg: '#FBEEE8', ic: '#C4552F',
            items: [
              { t: 'Ecommerce', n: 'orders & returns', icon: 'shopping-bag', page: 'sol-ecommerce' },
              { t: 'Lead handling', n: 'enquiries & quotes', icon: 'user-plus', page: 'sol-leads' }
            ] },
          { t: 'By industry', d: 'The questions your trade gets asked', icon: 'layout-grid', bg: '#EAE4FB', ic: '#4B3E8E',
            items: [
              { t: 'Cosmetics & skincare', n: 'shade & ingredients', icon: 'sparkles', page: 'sol-cosmetics' },
              { t: 'Fashion & clothing', n: 'size & returns', icon: 'shirt', page: 'sol-fashion' },
              { t: 'Home & furniture', n: 'delivery & assembly', icon: 'sofa', page: 'sol-home' },
              { t: 'Clinics & aesthetics', n: 'bookings & prep', icon: 'stethoscope', page: 'sol-clinics' },
              { t: 'Restaurants & local', n: 'tables & allergens', icon: 'utensils', page: 'sol-food' },
              { t: 'Electronics & gadgets', n: 'specs & warranty', icon: 'cpu', page: 'sol-electronics' },
              { t: 'Jewellery & gifting', n: 'sizing & engraving', icon: 'gem', page: 'sol-jewellery' }
            ] },
          { t: 'By role', d: 'Who this changes the day for', icon: 'briefcase', bg: '#F0EDE7', ic: '#55524C',
            items: [
              { t: 'Running it alone', n: 'owner-operator', icon: 'crown', page: 'sol-owner' },
              { t: 'On the front line', n: 'agents & reception', icon: 'headphones', page: 'sol-agent' }
            ] }
        ],
        railKicker: 'Your AI employees', railTitle: 'Hire one for support, one for sales.',
        railBody: 'Each employee owns its area, works every hour, and does only what you allow: suggest, ask me first, or do it.',
        railLink: 'Meet your new employee', railShot: '/assets/shots/employees.png'
      },
      integrations: {
        cols: [
          { t: 'Commerce', d: 'Orders, refunds, stock, customers', icon: 'shopping-bag', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [{ t: 'Shopify', n: '7 actions', icon: 'shopping-bag' }, { t: 'WooCommerce', n: '6', icon: 'shopping-cart' }, { t: 'Returns platforms', n: '4', icon: 'package' }] },
          { t: 'CRM & business systems', d: 'Reads and writes, both ways', icon: 'database', bg: '#EDF1F7', ic: '#3E5C99',
            items: [{ t: 'Zoho', n: '5', icon: 'database' }, { t: 'Monday', n: '4', icon: 'kanban' }, { t: 'HubSpot', n: '5', icon: 'contact' }, { t: 'ERP', n: 'custom', icon: 'server' }] },
          { t: 'Day to day', d: 'Calendars, files, phone numbers', icon: 'calendar', bg: '#FBEEE8', ic: '#C4552F',
            items: [{ t: 'Google Calendar', n: '3', icon: 'calendar' }, { t: 'Google Drive', n: 'knowledge', icon: 'folder' }, { t: 'Calendly', n: '2', icon: 'calendar-clock' }, { t: 'Anything with an API', n: '', icon: 'plug' }] }
        ],
        railKicker: 'How connecting works', railTitle: 'A system becomes a capability',
        railBody: 'Connect Shopify and GOTCHA can look up orders, check stock and refund. You then decide which of those it may do without asking.',
        railLink: 'Browse all integrations', railShot: '/assets/shots/systems.png'
      },
      company: {
        cols: [
          { t: 'Who we are', d: 'The company behind the product', icon: 'building-2', bg: '#EFEAE1', ic: '#7A6A4F',
            items: [
              { t: 'About us', n: 'our story', icon: 'building-2', page: 'co-about' },
              { t: 'Careers', n: 'not hiring, still reading', icon: 'briefcase', page: 'co-careers' }
            ] },
          { t: 'What we write', d: 'What we learn from real inboxes', icon: 'newspaper', bg: '#EAE4FB', ic: '#4B3E8E',
            items: [
              { t: 'Blog', n: 'journal', icon: 'newspaper', page: 'co-blog' },
              { t: 'Help center', n: 'guides & setup', icon: 'book-open', page: 'co-help' }
            ] },
          { t: 'Trust and talking', d: 'How we hold your data, and how to reach us', icon: 'shield-check', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [
              { t: 'Security', n: 'how we hold your data', icon: 'shield-check', page: 'co-security' },
              { t: "Let's Chat!", n: 'talk to a person', icon: 'message-circle', page: 'co-chat' }
            ] }
        ],
        railKicker: 'From the journal', railTitle: 'The shift nobody works',
        railBody: 'Your customers write in the evening, on the sofa, with the phone in one hand. That is exactly when nobody is reading.',
        railLink: 'Read the journal', railShot: '/assets/shots/inbox.png'
      },
      resources: {
        cols: [
          { t: 'Learn', d: 'Get going, and get better at it', icon: 'book-open', bg: '#FBEEE8', ic: '#C4552F',
            items: [{ t: 'Help center', n: '', icon: 'book-open' }, { t: 'Getting started guide', n: '', icon: 'flag' }, { t: 'Playbooks by industry', n: '', icon: 'map' }, { t: 'Blog', n: '', icon: 'newspaper' }] },
          { t: 'Trust', d: 'What we do with your customers\' data', icon: 'shield-check', bg: '#EDF4E7', ic: '#2E7D5B',
            items: [{ t: 'Security', n: '', icon: 'shield-check', page: 'co-security' }, { t: 'Encryption and access', n: '', icon: 'lock' }, { t: 'Privacy and GDPR', n: '', icon: 'file-text' }, { t: 'What the AI never trains on', n: '', icon: 'brain' }] },
          { t: 'Talk to us', d: 'A person, not a form', icon: 'message-circle', bg: '#EDF1F7', ic: '#3E5C99',
            items: [{ t: "Let's Chat!", n: '', icon: 'message-circle', page: 'co-chat' }, { t: 'Help center', n: '', icon: 'book-open', page: 'co-help' }, { t: 'About us', n: '', icon: 'building-2', page: 'co-about' }, { t: 'Careers', n: '', icon: 'briefcase', page: 'co-careers' }] }
        ],
        railKicker: 'From the journal', railTitle: 'Answering is easy. Acting is the job.',
        railBody: 'Writing the reply is the last ten percent. The work is finding the order, reading the policy and carrying it out.',
        railLink: 'Read the journal', railShot: '/assets/shots/approvals.png'
      }
    };

    const NAV = [['Product', 'product'], ['Solutions', 'solutions'], ['Our Company', 'company'], ['Why us', null, 'why'], ['Pricing', null, 'pricing'], ['$1 offer!', null, 'offer']];
    const PP = 12;
    const VOL = [
      { t: '10', n: 10, plan: 'Co-Pilot', m: 39, unit: '$0.16', note: 'Co-Pilot at its base volume: 750 credits a month, about 250 conversations, roughly $0.16 each.' },
      { t: '25', n: 25, plan: 'Co-Pilot', m: 0, note: 'Still Co-Pilot, on a larger credit allowance. The price moves with the allowance you pick.' },
      { t: '50', n: 50, plan: 'AI Team', m: 97, note: 'AI Team. This is where AI employees handling conversations end to end start to pay for themselves.' },
      { t: '100', n: 100, plan: 'AI Team', m: 0, note: 'AI Team on a larger allowance. Worth a conversation about where to set the automatic top-up.' },
      { t: '200', n: 200, plan: 'Call-Pilot', m: 229, note: 'Call-Pilot: everything in AI Team, with voice on top of the chat volume.' },
      { t: '200+', n: 201, plan: 'Custom', m: 0, note: 'Above this we configure a plan: your capabilities, your limits, your credit allocation and voice volume.' }
    ];
    const v = VOL[this.state.vol] || VOL[2];
    const money = (n) => '₪' + n.toLocaleString();
    const yearPrice = (m) => money(Math.round(m * PP));

    const navItems = NAV.map(([t, key, page]) => {
      const prefix = { product: 'feat-', solutions: 'sol-', company: 'co-' }[key];
      const on = (st.menu === key && !!key) || (page && st.page === page) || (prefix && String(st.page).indexOf(prefix) === 0);
      return {
        t, hasMenu: !!key,
        rot: st.menu === key && key ? 'rotate(180deg)' : 'rotate(0deg)',
        bg: page === 'offer' ? '#C4552F' : (on ? '#FBEEE8' : 'transparent'),
        fg: page === 'offer' ? '#FFFFFF' : (on ? '#8E3418' : '#16150F'),
        enter: () => { if (key) this.setState({ menu: key }); else this.setState({ menu: null }); },
        click: () => {
          if (page) { this.setState({ menu: null, page }); window.scrollTo(0, 0); return; }
          this.setState(s => ({ menu: s.menu === key ? null : key }));
        }
      };
    });

    // the phone menu: the same NAV spine, with every mega-menu link flattened under its section
    const mnav = NAV.map(([t, key, page]) => {
      const m = key && MENUS[key];
      return {
        t,
        go: () => {
          if (page) { this.setState({ mnav: false, menu: null, page }); window.scrollTo(0, 0); }
        },
        items: m
          ? m.cols.reduce((acc, c) => acc.concat(c.items.map(it => ({
              t: it.t, n: it.n, icon: it.icon,
              go: () => {
                if (it.page) { this.setState({ mnav: false, menu: null, page: it.page, post: null }); window.scrollTo(0, 0); }
              }
            }))), [])
          : []
      };
    });

    const TRACE = [
      ['Reading what she asked', 'shipping · frustrated'],
      ['Recognising her', 'Dana Cohen · 6 orders'],
      ['Finding the order', '#1842'],
      ['Checking the carrier', 'stuck since Tuesday'],
      ['Reading your refund policy', 'eligible'],
      ['Checking what it may do', 'under ₪200 · allowed'],
      ['Refunding ₪179', 'done'],
      ['Checking stock for a replacement', '11 left'],
      ['Writing to her', 'in her language']
    ];
    const trace = TRACE.map((t, i) => ({ t: t[0], r: step > i ? t[1] : '', c: step > i ? (i === 5 ? '#8A6A16' : '#4F7A2E') : '#DCD8D0', o: step > i ? 1 : 0.35 }));

    const SHOTS = ['Home', 'Inbox', 'Approvals'];
    const CAPTIONS = [
      'Home: what happened, what needs you, and a command line that both answers questions and does things.',
      'Inbox: the conversation, the customer, the order and Copilot\'s options in one view. No tab switching, no second window.',
      'Approvals. One decision at a time, with what it costs to wait and whether it can be undone. Keyboard only, if you like.'
    ];

    const UC = [
      { t: 'Online store', edge: '#C4552F', line: 'Half your day is "where is my order" and the other half is a size question.',
        body: 'GOTCHA opens the order in your store, reads the tracking, and answers with the truth. When someone wants to cancel, it checks whether it has been packed before promising anything.',
        does: [{ t: 'Order status', d: 'Real tracking, not "let me check"' }, { t: 'Cancel or return', d: 'Checks fulfilment first, then acts' }, { t: 'Refunds', d: 'Up to the limit you set' }, { t: 'Size & fit', d: 'From your own product copy' }],
        stats: [{ v: '88%', l: 'answered alone' }, { v: '19s', l: 'first reply' }, { v: '₪12,400', l: 'carts recovered monthly' }],
        msg: 'Hey, can I swap the sand set for the navy? Ordered Tuesday.', tag: 'Exchange · order found automatically',
        answer: "Yes, it hasn't left us yet, so I've swapped it to navy in the same size. No charge, and it ships tomorrow.",
        foot: 'Exchange opened in your returns platform. Stock adjusted. Nobody on your team touched it.' },
      { t: 'Wholesale & trade', edge: '#8A6A16', line: 'Every trade enquiry is the same six questions, and each one waits a day for an answer.',
        body: 'It quotes your trade prices, states lead times per product, and opens a trade account when someone qualifies. When two of your own documents disagree about the minimum order, it says it will check rather than guessing.',
        does: [{ t: 'Trade pricing', d: 'Your real price list, per tier' }, { t: 'Lead times', d: 'Per product, kept current' }, { t: 'Open an account', d: 'Collects what you need, once' }, { t: 'Reorders', d: 'Reads their usual order back' }],
        stats: [{ v: '22%', l: 'more trade enquiries closed' }, { v: '4h', l: 'was: two days' }, { v: '12', l: 'reorders it chased' }],
        msg: 'What is the minimum for a first wholesale order, and do you do 30 days?', tag: 'Wholesale · high value',
        answer: 'Minimum first order is ₪550, and yes, 30 day terms once the trade account is open. I can start that now if you send your business number.',
        foot: 'Trade account drafted. Eitan sees it in the morning with everything already filled in.' },
      { t: 'Services & bookings', edge: '#4F7A2E', line: 'People ask for a slot at eleven at night and book with someone else by morning.',
        body: 'It offers real slots from your calendar, books them, reschedules, and reminds people the day before. Cancellations free the slot and offer it to whoever asked next.',
        does: [{ t: 'Real availability', d: 'Straight from your calendar' }, { t: 'Book & reschedule', d: 'Without a form' }, { t: 'Reminders', d: 'Day before, on WhatsApp' }, { t: 'No-show follow-up', d: 'Asks once, politely' }],
        stats: [{ v: '31%', l: 'fewer empty slots' }, { v: '0', l: 'double bookings' }, { v: '2m', l: 'to book, average' }],
        msg: 'Do you have anything Thursday afternoon? Preferably late.', tag: 'Booking · intent to buy',
        answer: 'Thursday at 16:30 or 17:45 are both free. Shall I hold 17:45 for you?',
        foot: 'Booked, added to the calendar, reminder scheduled. It also noted she prefers late slots.' },
      { t: 'Clinics', edge: '#E0B341', line: 'Reception cannot answer the phone and the WhatsApp at the same time.',
        body: 'It answers both, handles the routine, hours, prices, what to bring, rescheduling, and passes anything clinical straight to a person, immediately and without pretending otherwise.',
        does: [{ t: 'Reschedule', d: 'The single biggest volume' }, { t: 'Prices & cover', d: 'From your own list' }, { t: 'Preparation', d: 'What to bring, fasting, forms' }, { t: 'Hands over fast', d: 'Anything clinical goes to staff' }],
        stats: [{ v: '74%', l: 'handled without reception' }, { v: '100%', l: 'clinical questions escalated' }, { v: '0', l: 'medical advice given' }],
        msg: "I need to move my Sunday appointment, and does it need to be on an empty stomach?", tag: 'Reschedule + preparation',
        answer: 'Moved to Tuesday 09:00. And yes, nothing to eat or drink for eight hours beforehand, water is fine.',
        foot: 'Calendar updated. The preparation answer came from your own instructions, nothing invented.' },
      { t: 'Restaurants & local', edge: '#4F7A2E', line: 'The busiest hour is exactly when nobody can look at the phone.',
        body: 'It takes reservations, answers about parking, allergens and the menu, and tells people the truth about the wait. When something is off tonight, it knows.',
        does: [{ t: 'Reservations', d: 'Real tables, real times' }, { t: 'Menu & allergens', d: "From tonight's menu" }, { t: 'Waiting time', d: 'Honest, not optimistic' }, { t: 'Large groups', d: 'Passes to a person' }],
        stats: [{ v: '96%', l: 'answered during service' }, { v: '18s', l: 'during the rush' }, { v: '41', l: 'covers saved weekly' }],
        msg: 'Table for 2 tonight around 8? Also is the mushroom dish vegan?', tag: 'Reservation · dietary',
        answer: '20:15 is free. Shall I book it? The mushroom dish has butter in it, but the chef does it with oil on request.',
        foot: 'Booked. Note attached to the table, and the kitchen sees the request when you open service.' }
    ];

    const FAQ = [
      ['What is GOTCHA, exactly?', 'One AI platform for everything customers send you. It merges every channel into a single inbox and adds an AI employee and a copilot that do not just talk: they carry out real actions and turn every conversation into customer intelligence inside your CRM.'],
      ['Does the AI really take action, or is it just a chatbot?', 'It takes real action. The AI employee understands the request and handles it end to end: it finds the order, opens the exchange, sends the tracking, updates the CRM. Not a set of canned replies.'],
      ['Will it replace my human agents?', 'No. It handles the routine and hands over to a person the moment it should, with the whole customer picture on one screen. From there Copilot makes your agents faster, and Call Pilot guides them live during phone calls.'],
      ['Which channels do you work with?', 'WhatsApp, Instagram, Messenger, email, web chat and Slack, plus phone calls, where Call Pilot guides your agents in real time. Every channel in one merged inbox, with the full cross-channel history for each customer.'],
      ['How much control do I have over what the AI does?', 'Full control. You set the autonomy level for each action: suggest only, ask me first with a human in the loop, or fully autonomous. Sensitive actions such as refunds or discounts can always require approval.'],
      ['Does it connect to my CRM and my tools?', 'Yes. Conversations are summarised and synced to your CRM or ERP, the customer profile is enriched automatically, and tasks and follow-ups are created for you. No copy and paste.'],
      ['How long does it take to get started?', 'Fast. You connect your channels, add your knowledge base and invite your team. Most teams are live the same day.'],
      ['What about data security?', 'Everything is encrypted, in transit and at rest, with role-based permissions and full separation between organisations. We never sell or expose your data.']
    ];

    const SOLS = {
      'sol-cosmetics': {
        kicker: 'By industry · Cosmetics & skincare', icon: 'sparkles', bg: '#EAE4FB', ic: '#4B3E8E',
        h1a: 'Nobody buys a shade', h1b: 'without asking first',
        sub: 'Which shade for her undertone, whether it is safe in pregnancy, what to use it with and how long the bottle lasts, answered from your own product pages and formulations, in seconds, at any hour.',
        asideHead: 'Where the impact is',
        aside: 'Skincare and colour are question-heavy by nature: shade, undertone, ingredients, pregnancy, routine order. Almost every one of those answers already exists in your own guide, and almost every one arrives at night. Answering them instantly is the difference between a sale and a browser tab that closes.',
        stats: [{ v: 'Shade matched', l: 'from your own guide, in seconds, at eleven at night' }, { v: 'Fewer wrong shades', l: 'when the match happens before the order, not after the return' }, { v: 'Nothing medical', l: 'anything about a reaction goes straight to a person' }],
        dayTitle: 'The questions that stand between her and the checkout.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'instagram', chBg: '#EAE4FB', chIc: '#4B3E8E', when: 'Instagram · 22:51', tag: 'Shade match', tagFg: '#4B3E8E', tagBg: '#EAE4FB', edge: '#5B4CB8',
            msg: "I'm between 220 and 230. I go warm and olive in summer. Which one?",
            steps: ['Read your shade guide and undertone chart', 'Checked her past order. She bought 220 in winter', 'Checked stock in both shades'],
            reply: 'You bought 220 in January, so 230 is the summer step for an olive undertone. Both in stock. Want me to add 230?',
            after: 'Ordered nine minutes later. Shade noted on her record for next time.' },
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 08:12', tag: 'Ingredients', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F',
            msg: 'Is the retinol serum ok while breastfeeding? And can I use it with the acid?',
            steps: ['Found your ingredient guidance, retinol: not advised', 'Checked your own written policy on layering', 'Flagged it as a health-adjacent question'],
            reply: 'Our guidance is to pause retinol while breastfeeding. The bakuchiol serum is the swap we suggest. And never on the same night as the acid.',
            after: 'Answered from your own words. Anything beyond your guidance goes to a person, not to the AI.' },
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 16:04', tag: 'Wants to buy', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'How long does the 30ml last if I use it twice a day? Is the refill cheaper?',
            steps: ['Read the product page: 30ml, twice daily', 'Checked the refill price and subscription option', 'Checked her cart: 30ml already in it'],
            reply: 'About seven weeks at twice a day. The refill is ₪38 less and I can set it to arrive every seven weeks. Cancel any time.',
            after: 'Switched to a refill subscription.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Shade and undertone matching from your guide', n: 'handled alone' },
          { t: 'Ingredient and sensitivity questions, quoted', n: 'handled alone' },
          { t: 'Routine and layering order', n: 'handled alone' },
          { t: 'How long a size lasts, refills and subscriptions', n: 'handled alone' },
          { t: 'Order status, returns and exchanges', n: 'handled alone' },
          { t: 'Restock alerts for a sold-out shade', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'Skin is personal and legally sensitive.',
        stops: [
          { t: 'Anything medical or a reaction', n: 'to a person' },
          { t: 'Pregnancy questions beyond your written guidance', n: 'to a person' },
          { t: 'A refund over your limit', n: 'Approvals' },
          { t: 'A promise your ingredient list does not support', n: 'never made' }
        ],
        stopFoot: 'It never gives dermatological advice and never improvises a claim. If your own guidance does not cover it, it says it will check with the team.',
        quote: '"Beauty is the most question-heavy category we know. Every shade question left until morning is a customer comparing you with someone who answered."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'Before the order', l: 'shade and ingredient questions answered while she is still deciding' }, { v: 'Repeat purchase', l: 'refill and routine questions turned into subscriptions, in the chat' }],
        ctaTitle: 'See it answer your shade and ingredient questions.',
        ctaBody: 'Connect your store and GOTCHA replays last month\'s conversations using your own shade guide, formulations and policies. You judge it on your own products.'
      },

      'sol-fashion': {
        kicker: 'By industry · Fashion & clothing', icon: 'shirt', bg: '#FBEEE8', ic: '#C4552F',
        h1a: 'Every sale hinges on', h1b: '"will it fit me?"',
        sub: 'Sizing, fabric, fit on a real body, whether it arrives before Saturday and how the return works, answered from your own size charts and product copy, so fewer people order two sizes to be safe.',
        asideHead: 'Where the impact is',
        aside: 'Sizing and fit generate the most repetitive questions in retail, and the most returns. Your size chart already holds the answer; it just never gets read. When fit is settled in the conversation, fewer people order two sizes, and fewer parcels come back.',
        stats: [{ v: 'Fit, before the order', l: 'from your size chart, the fit note and past answers' }, { v: 'Fewer double orders', l: 'one size ordered instead of two to be safe' }, { v: 'Exchanges done', l: 'opened in your returns platform, stock adjusted, nobody touched it' }],
        dayTitle: 'Fit answered before the order, not after the return.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'instagram', chBg: '#FBEEE8', chIc: '#C4552F', when: 'Instagram · 23:18', tag: 'Sizing', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F',
            msg: "I'm usually M but the reviews say it runs small. 168cm, broader shoulders.",
            steps: ['Read your size chart and the fit note on the page', 'Read what your team answered on this item before', 'Checked L in stock'],
            reply: 'It does run small in the shoulder, with 168cm and a broader shoulder, take the L. It sits slightly longer, which is how it is photographed.',
            after: 'One size ordered instead of two. No return.' },
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 09:40', tag: 'Exchange', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: 'The trousers are too long. Can I swap for the shorter length?',
            steps: ['Found the order and the item', 'Checked the 28" inseam in her size: 4 left', 'Read your exchange window: inside 30 days'],
            reply: "Swapped to the 28\" in the same size and colour, no charge. Your return label is on its way. Send the long pair back whenever suits.",
            after: 'Exchange opened in your returns platform, stock adjusted, nobody touched it.' },
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 12:26', tag: 'Wants to buy', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'Need it for a wedding Saturday. Will it get to Haifa in time, and does it wrinkle?',
            steps: ['Checked the dispatch cut-off, 14:00 today', 'Checked the courier zone for Haifa', 'Read the fabric and care note'],
            reply: 'Order in the next two hours and it lands Thursday. The viscose blend hangs out overnight, no iron needed.',
            after: 'Ordered eleven minutes later.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Sizing, fit and measurements from your chart', n: 'handled alone' },
          { t: 'Fabric, care and washing questions', n: 'handled alone' },
          { t: 'Exchanges for a different size or colour', n: 'handled alone' },
          { t: 'Returns with a label, inside your window', n: 'handled alone' },
          { t: 'Delivery date for a specific city and deadline', n: 'handled alone' },
          { t: 'Restock alerts for a sold-out size', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'Money and anything outside the policy.',
        stops: [
          { t: 'A return after your window closed', n: 'Approvals' },
          { t: 'A refund over your limit', n: 'Approvals' },
          { t: 'A faulty item or a quality complaint', n: 'to a person' },
          { t: 'A customer writing a third time', n: 'to a person' }
        ],
        stopFoot: 'Roughly three decisions a day reach you, each with the order, the reason and what it costs to wait. Everything else is already done.',
        quote: '"Fashion support is the same twenty questions all day. Nobody on your team should be answering "does it run small" for the four hundredth time."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'The repetitive questions', l: 'size, fit, fabric, delivery and returns, answered the same way every time' }, { v: 'Returns that never happen', l: 'because the size question was answered before checkout' }],
        ctaTitle: 'See what it would have answered about fit last month.',
        ctaBody: 'Connect your store and it replays your real sizing conversations using your own charts and product copy, before you trust it with a customer.'
      },

      'sol-home': {
        kicker: 'By industry · Home & furniture', icon: 'sofa', bg: '#EFEAE1', ic: '#7A6A4F',
        h1a: 'A sofa is a', h1b: 'six-week conversation',
        sub: 'Lead times, dimensions, fabric options, delivery to a fourth floor, assembly and who takes the old one away. High-value questions that used to take a day to answer, answered while they are still choosing.',
        asideHead: 'Where the impact is',
        aside: 'Furniture is a long, high-value conversation: dimensions, lead times, fabrics, delivery to a fourth floor. Each one is a considered purchase, and each unanswered evening is a lost quote. Answering with real numbers from your own catalogue keeps the conversation alive until the order.',
        stats: [{ v: 'Real lead times', l: 'per product and fabric, from your own data' }, { v: 'Dimensions answered', l: 'doorways, lifts, depth with the legs off' }, { v: 'Quotes kept warm', l: 'a six-week conversation that never goes quiet' }],
        dayTitle: 'The long, expensive decision, answered the same evening.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 21:02', tag: 'High value', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: 'The three-seater in grey: how long from order, and does it fit a 78cm doorway?',
            steps: ['Read the product page: 74cm depth, legs detach', 'Checked the current lead time on grey, 5 weeks', 'Checked whether it is a stocked or made-to-order fabric'],
            reply: 'With the legs off it passes a 78cm door at 74cm. Grey is made to order. Five weeks from order, and delivery includes carrying it up.',
            after: 'Quote requested the next morning.' },
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 15:47', tag: 'Delivery', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F',
            msg: 'Fourth floor, no lift. Will they bring it up and take the old one?',
            steps: ['Read your delivery terms: walk-up above 3rd floor is chargeable', 'Checked the removal service and its price', 'Checked her postcode is in the zone'],
            reply: 'Yes to both, a walk-up above the third floor is ₪180, and old-furniture removal is ₪120. Both can go on the order.',
            after: 'Both services added. Nobody had to phone her back.' },
          { channel: 'mail', chBg: '#EFEAE1', chIc: '#7A6A4F', when: 'Email · 07:31', tag: 'Trade', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'Furnishing 12 apartments. Do you do a trade price and can you hold stock until October?',
            steps: ['Recognised a trade enquiry above your threshold', 'Pulled your trade tier and terms', 'Drafted the reply and flagged it for a person'],
            reply: 'Twelve units is our second trade tier, and we can hold allocated stock for 60 days. I have asked Eitan to send the price list this morning.',
            after: 'Trade account drafted overnight. Eitan sent a quote before nine.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Dimensions, materials and whether it fits', n: 'handled alone' },
          { t: 'Lead times per fabric and finish', n: 'handled alone' },
          { t: 'Delivery zones, walk-ups and removal', n: 'handled alone' },
          { t: 'Assembly, warranty and care', n: 'handled alone' },
          { t: 'Order and production status', n: 'handled alone' },
          { t: 'Showroom hours, stock and appointments', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'The big-ticket judgement calls stay human.',
        stops: [
          { t: 'A discount or a bundled price', n: 'to a person' },
          { t: 'A trade quote above your threshold', n: 'to a person' },
          { t: 'A damaged delivery or a claim', n: 'to a person' },
          { t: 'Cancelling a made-to-order item', n: 'Approvals' }
        ],
        stopFoot: 'It answers the twenty questions that come before the price, and hands you the conversation exactly at the point where a person is worth it.',
        quote: '"A sofa is a six-week conversation. The business that keeps answering through those six weeks is the one that gets the order."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'High-value questions', l: 'answered while the customer is still measuring the room' }, { v: 'Anything about price', l: 'a quote above your threshold goes to a person' }],
        ctaTitle: 'Answer the dimensions question tonight, not tomorrow.',
        ctaBody: 'Connect your catalogue and your lead times and it answers from your own numbers, with anything involving a price or a claim handed straight to you.'
      },

      'sol-clinics': {
        kicker: 'By industry · Clinics & aesthetics', icon: 'stethoscope', bg: '#EDF1F7', ic: '#3E5C99',
        h1a: 'Reception cannot answer', h1b: 'the phone and the WhatsApp',
        sub: 'It handles the routine: moving appointments, prices, what to bring, whether to fast, parking, and passes anything clinical to a person immediately, without pretending to be qualified.',
        asideHead: 'Where the impact is',
        aside: 'Reception cannot answer the phone and the WhatsApp at the same time, and most of what arrives is rescheduling, prices, preparation and parking. Pure calendar and information work. Taking it off the desk gives reception back to the patients in the room.',
        stats: [{ v: 'Rescheduling handled', l: 'straight into your calendar, any hour' }, { v: 'Preparation answered', l: 'what to bring, fasting, forms, from your own instructions' }, { v: 'Nothing clinical', l: 'every medical question goes to a person, immediately' }],
        dayTitle: 'The routine half of reception, off their desk.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 20:34', tag: 'Reschedule', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'I need to move my Sunday appointment, and does it need to be on an empty stomach?',
            steps: ['Found her appointment in the calendar', 'Offered real free slots with the same practitioner', 'Read your preparation instructions for the treatment'],
            reply: 'Moved to Tuesday 09:00 with Dr Amrani. And yes, nothing to eat or drink for eight hours beforehand, water is fine.',
            after: 'Calendar updated, reminder rescheduled, slot released to the waiting list.' },
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 11:15', tag: 'Price & cover', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F',
            msg: 'How much is the consultation, and do you take my insurance?',
            steps: ['Read your price list: consultation ₪280', 'Checked which insurers you are registered with', 'Offered the next two consultation slots'],
            reply: 'A first consultation is ₪280, and yes, we bill your insurer directly. Thursday 15:30 or Sunday 10:00 are free. Shall I hold one?',
            after: 'Booked Thursday. No phone call, no hold music.' },
          { channel: 'instagram', chBg: '#FBEEE8', chIc: '#C4552F', when: 'Instagram · 22:08', tag: 'Clinical, escalated', tagFg: '#B0472A', tagBg: '#F6E3DC', edge: '#C4552F',
            msg: 'The area is swollen and quite red two days after. Is that normal?',
            steps: ['Recognised a clinical question: stopped immediately', 'Attached her treatment date and practitioner', 'Escalated to on-call staff with a summary'],
            reply: "I'm not able to advise on that, and I don't want to guess. I've flagged this to the clinical team now and someone will come back to you tonight.",
            after: 'Escalated in nine seconds with her history attached. Called back within the hour.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Rescheduling and cancelling appointments', n: 'handled alone' },
          { t: 'Prices, packages and insurance cover', n: 'handled alone' },
          { t: 'Preparation: fasting, forms, what to bring', n: 'handled alone' },
          { t: 'Hours, parking and how to find you', n: 'handled alone' },
          { t: 'Reminders the day before, on WhatsApp', n: 'handled alone' },
          { t: 'Filling a cancelled slot from the waiting list', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops, every time', stopNote: 'No exceptions and no judgement calls.',
        stops: [
          { t: 'Any clinical or symptom question', n: 'immediately' },
          { t: 'Anything about medication or dosage', n: 'never answered' },
          { t: 'A distressed or urgent message', n: 'straight to staff' },
          { t: 'Results or anything in a medical record', n: 'staff only' }
        ],
        stopFoot: 'Nothing clinical is automated, and it says plainly that it is not qualified rather than hedging. Everything it does say comes from your own written instructions.',
        quote: '"A clinic does not need AI to give medical advice. It needs the calendar work handled so the people at the desk can look up."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'The routine half of reception', l: 'moved off the desk without automating anything clinical' }, { v: 'No-shows chased', l: 'confirmations, reminders and rebooking from the waiting list' }],
        ctaTitle: 'Take the routine half off reception this week.',
        ctaBody: 'Start with rescheduling and preparation only. The two highest volumes and the two lowest risks, and widen it once you have watched it work.'
      },

      'sol-food': {
        kicker: 'By industry · Restaurants & local', icon: 'utensils', bg: '#EDF4E7', ic: '#2E7D5B',
        h1a: 'The busiest hour is when', h1b: 'nobody can look at the phone',
        sub: 'It takes reservations from your real table plan, answers about parking, allergens and tonight\'s menu, and tells people the truth about the wait, during service, when no one is free to type.',
        asideHead: 'Where the impact is',
        aside: 'The busiest hour of service is exactly when nobody can look at the phone. Reservations, parking, allergens and the menu tonight are all answerable from your own table plan and menu, and a straight answer about the wait keeps a table that would otherwise book elsewhere.',
        stats: [{ v: 'Reservations taken', l: 'from your real table plan, during service' }, { v: 'Allergens and menu', l: 'answered from the menu tonight, not a guess' }, { v: 'The truth about the wait', l: 'so people come, or come later, instead of not at all' }],
        dayTitle: 'Service is covered while service is happening.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 18:52', tag: 'Reservation', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'Table for 2 tonight around 8? Also is the mushroom dish vegan?',
            steps: ['Checked the table plan, 20:15 free', 'Read tonight\'s menu, mushroom dish contains butter', 'Checked the kitchen note on substitutions'],
            reply: '20:15 is free. Shall I book it? The mushroom dish has butter, but the chef does it with oil on request.',
            after: 'Booked. Note attached to the table so the kitchen sees it at service.' },
          { channel: 'instagram', chBg: '#FBEEE8', chIc: '#C4552F', when: 'Instagram · 12:20', tag: 'Allergens', tagFg: '#B0472A', tagBg: '#F6E3DC', edge: '#C4552F',
            msg: 'Severe nut allergy: can you do the tasting menu safely?',
            steps: ['Recognised a severe allergy: flagged it', 'Read your allergen policy', 'Escalated to the kitchen with the booking'],
            reply: 'I do not want to answer that from a menu. The kitchen will confirm directly, today. Which date were you thinking?',
            after: 'Chef replied in twenty minutes. Booked with the allergy on the ticket.' },
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 19:41', tag: 'Wait time', tagFg: '#8A6A16', tagBg: '#F6EFD8', edge: '#E0B341',
            msg: 'Walking over now with 4 people, what is the wait?',
            steps: ['Checked the current table state', 'Checked the waiting list. Three groups ahead', 'Read your honest-wait policy'],
            reply: 'Right now about 35 minutes for four. I can put you on the list from this message so the clock starts now.',
            after: 'On the list before they arrived.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Reservations, changes and cancellations', n: 'handled alone' },
          { t: 'Tonight\'s menu, dishes and prices', n: 'handled alone' },
          { t: 'Parking, accessibility and how to find you', n: 'handled alone' },
          { t: 'Honest waiting times during service', n: 'handled alone' },
          { t: 'Opening hours and holiday changes', n: 'handled alone' },
          { t: 'Refilling a cancelled table from the list', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'Anything where being wrong is expensive.',
        stops: [
          { t: 'A severe allergy', n: 'to the kitchen' },
          { t: 'Groups above your table limit', n: 'to a person' },
          { t: 'Private events and buyouts', n: 'to a person' },
          { t: 'A complaint about a meal', n: 'to the manager' }
        ],
        stopFoot: 'Allergens are never answered from a guess. It quotes your own allergen list or it hands the question to the kitchen. Nothing in between.',
        quote: '"Restaurants lose bookings at the exact moment they are too busy to answer. That is the gap an AI employee fills."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'During service', l: 'the hour nobody is free to type is the hour it answers' }, { v: 'Large groups and events', l: 'handed to a person with the details already gathered' }],
        ctaTitle: 'Cover the phone during service, starting Friday.',
        ctaBody: 'Connect WhatsApp and your table plan and it answers from tonight\'s real menu and real availability, with allergies always going to your kitchen.'
      },

      'sol-electronics': {
        kicker: 'By industry · Electronics & gadgets', icon: 'cpu', bg: '#EDF1F7', ic: '#3E5C99',
        h1a: 'Compatibility questions', h1b: 'decide the sale',
        sub: 'Will it work with her model, what is in the box, is the warranty local, and can it be fixed rather than returned. Answered from your own specification sheets, before the question becomes a return.',
        asideHead: 'Where the impact is',
        aside: 'Compatibility decides the sale and drives the return. Will it work with her model, what is in the box, is the warranty local. The answers sit in your specification sheets. Reading them for her, before she orders the wrong one, is where the value is.',
        stats: [{ v: 'Compatibility checked', l: 'against your own specification sheets' }, { v: 'Warranty and repair', l: 'fix rather than return, when your policy allows it' }, { v: 'Technical to a person', l: 'anything beyond your sheets goes to someone who knows' }],
        dayTitle: 'The spec question answered before the wrong thing ships.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 13:22', tag: 'Compatibility', tagFg: '#3E5C99', tagBg: '#EDF1F7', edge: '#5B4CB8',
            msg: 'Does this dock work with a 2019 MacBook Pro and drive two 4K screens?',
            steps: ['Read the specification sheet: Thunderbolt 3, dual 4K at 60Hz', 'Checked your compatibility notes for 2019 models', 'Checked stock: 6 in the warehouse'],
            reply: 'Yes, Thunderbolt 3 on that model drives two 4K screens at 60Hz through this dock. You will want the 0.8m cable, which is in the box.',
            after: 'Ordered fourteen minutes later.' },
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 20:11', tag: 'Warranty', tagFg: '#8A6A16', tagBg: '#F6EFD8', edge: '#E0B341',
            msg: 'Bought headphones in March, right side cut out. Is that under warranty?',
            steps: ['Found the order: March, inside the 2-year warranty', 'Read your service process for this brand', 'Checked the local service centre'],
            reply: 'You are inside the two-year warranty. I have opened a service case and you can drop them at the Ramat Gan centre or I can send a courier label.',
            after: 'Service case opened with the invoice attached. No phone call needed.' },
          { channel: 'mail', chBg: '#EFEAE1', chIc: '#7A6A4F', when: 'Email · 06:48', tag: 'B2B quote', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: 'We need 25 monitors and docks for a new office. Price and lead time?',
            steps: ['Recognised a business enquiry above your threshold', 'Pulled your business tier and stock position', 'Drafted the reply for a person to send'],
            reply: 'Twenty-five units qualifies for business pricing, and both items are in stock for next-week delivery. Our business desk is sending the quote this morning.',
            after: 'Draft quote waiting when the team opened.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Compatibility with a specific model', n: 'handled alone' },
          { t: 'Specifications, ports and what is in the box', n: 'handled alone' },
          { t: 'Warranty status and opening a service case', n: 'handled alone' },
          { t: 'Stock, delivery date and pickup point', n: 'handled alone' },
          { t: 'Setup and first-use troubleshooting', n: 'handled alone' },
          { t: 'Restock alerts on a specific SKU', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'Anything involving a technician or a price.',
        stops: [
          { t: 'A business quote above your threshold', n: 'to a person' },
          { t: 'A repair estimate or a diagnosis', n: 'to a technician' },
          { t: 'A refund over your limit', n: 'Approvals' },
          { t: 'A compatibility claim your specs do not confirm', n: 'never made' }
        ],
        stopFoot: 'It will not guess a specification. If the sheet does not say it, it says it will confirm, which is the difference between a sale and a return.',
        quote: '"Most electronics returns are a compatibility question that was never asked, or never answered in time."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'Before the wrong order', l: 'compatibility answered while the cart is still open' }, { v: 'Trade and business quotes', l: 'above your threshold, to a person' }],
        ctaTitle: 'Let it read the spec sheets so nobody guesses.',
        ctaBody: 'Connect your catalogue and it answers compatibility and warranty from your own documents, and hands you every business quote as a draft.'
      },

      'sol-jewellery': {
        kicker: 'By industry · Jewellery & gifting', icon: 'gem', bg: '#F7F0E2', ic: '#8A6A16',
        h1a: 'A gift has', h1b: 'a deadline attached',
        sub: 'Ring sizing, chain lengths, engraving, gift wrapping and whether it can possibly arrive by Friday. High-emotion, high-value questions where a slow answer is the same as a no.',
        asideHead: 'Where the impact is',
        aside: 'A gift has a deadline attached and a lot of emotion behind it. Ring sizing, chain lengths, engraving, wrapping and whether it can possibly arrive by Friday. A slow answer is the same as a no. A fast, accurate one from your own delivery and sizing rules closes the sale.',
        stats: [{ v: 'Deadlines answered honestly', l: 'dispatch cut-off and courier zone, for her address' }, { v: 'Sizing and engraving', l: 'from your own guides, with no improvised promise' }, { v: 'Bespoke to a person', l: 'custom commissions handed over with the brief' }],
        dayTitle: 'The deadline question, answered honestly and instantly.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'instagram', chBg: '#F7F0E2', chIc: '#8A6A16', when: 'Instagram · 23:44', tag: 'Deadline', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F',
            msg: 'Anniversary is Friday. Can I get the pendant engraved in time?',
            steps: ['Checked the engraving turnaround: 2 working days', 'Checked stock and the dispatch cut-off', 'Checked the courier to her city'],
            reply: 'Yes, if the engraving text is with me by 14:00 tomorrow. That ships Wednesday and lands Thursday, a day early.',
            after: 'Delivered Thursday.' },
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 10:16', tag: 'Sizing', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: "It's a surprise. I don't know her ring size. What do I do?",
            steps: ['Read your sizing guide and the surprise-gift note', 'Checked your resize policy. One free within 60 days', 'Checked which sizes are in stock'],
            reply: 'Take her most-worn ring and measure the inside, or order our most common size, 54, with one free resize within 60 days.',
            after: 'Done inside your systems, and written down.' },
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 17:05', tag: 'High value', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: 'Is the gold solid or plated, and does it come with a certificate?',
            steps: ['Read the product page: 14k solid gold', 'Checked what ships with the piece', 'Read your care and warranty terms'],
            reply: '14k solid gold, not plated, and it ships with a certificate and a two-year warranty on the setting.',
            after: 'Ordered the same evening.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Ring sizing, chain lengths and resizing', n: 'handled alone' },
          { t: 'Engraving options and turnaround', n: 'handled alone' },
          { t: 'Real delivery dates against a gift deadline', n: 'handled alone' },
          { t: 'Materials, hallmarks and certificates', n: 'handled alone' },
          { t: 'Gift wrapping, notes and discreet packaging', n: 'handled alone' },
          { t: 'Care, cleaning and warranty questions', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'The pieces where a person should be involved.',
        stops: [
          { t: 'Bespoke and custom commissions', n: 'to a person' },
          { t: 'Valuations and repairs', n: 'to the workshop' },
          { t: 'A refund over your limit', n: 'Approvals' },
          { t: 'A delivery promise it cannot verify', n: 'never made' }
        ],
        stopFoot: 'It will not promise a date it has not checked against your cut-off, your engraving queue and the courier. A gift deadline is not a place to be optimistic.',
        quote: '"Nobody buys a gift from the shop that answers tomorrow."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'High-emotion, high-value', l: 'the questions where a slow answer loses the gift' }, { v: 'Care and warranty', l: 'answered after the sale, from your own terms' }],
        ctaTitle: 'Answer the deadline question at midnight.',
        ctaBody: 'Connect your store, your engraving turnaround and your courier cut-offs, and it gives an honest date every time, never an optimistic one.'
      },

      'sol-ecommerce': {
        kicker: 'By business · Ecommerce', icon: 'shopping-bag', bg: '#FBEEE8', ic: '#C4552F',
        h1a: 'Half your day is', h1b: '"where is my order"',
        sub: 'GOTCHA opens the order in your store, reads the real tracking, and answers with the truth. When someone wants to cancel it checks whether the parcel has been packed before promising anything.',
        asideHead: 'Where the impact is',
        aside: '"Where is my order" is half the day for most stores. GOTCHA opens the order, reads the real tracking and answers with the truth, at any hour. Cancellations, exchanges and returns are carried out in your store and your returns platform, not written down for someone to do later.',
        stats: [{ v: 'Order status, live', l: 'from your store and the courier, not a template' }, { v: 'Returns and\nexchanges done', l: 'inside your systems, within the limits you set' }, { v: 'Money asks first', l: 'refunds above your line wait for your approval' }],
        dayTitle: 'The same three questions, answered before you wake up.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 02:14', tag: 'Shipping', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F',
            msg: "My package still hasn't arrived and I've been waiting two weeks. This was a gift.",
            steps: ['Found order #1842: stuck with the carrier since Tuesday', 'Read your refund policy: eligible', 'Refund under ₪200: allowed without asking'],
            reply: "I'm sorry: #1842 has been stuck since Tuesday. I've refunded the full ₪179 to your card. If you'd still like it, I can hold one from tomorrow's batch.",
            after: 'Refund processed. She left a five-star review the next day.' },
          { channel: 'instagram', chBg: '#FBEEE8', chIc: '#C4552F', when: 'Instagram · 21:40', tag: 'Exchange', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: 'Hey, can I swap the sand set for the navy? Ordered Tuesday.',
            steps: ['Matched her to the order automatically', 'Checked fulfilment: not packed yet', 'Checked navy stock, 11 left'],
            reply: "Yes, it hasn't left us yet, so I've swapped it to navy in the same size. No charge, and it ships tomorrow.",
            after: 'Exchange opened in your returns platform. Stock adjusted.' },
          { channel: 'globe', chBg: '#EDF1F7', chIc: '#3E5C99', when: 'Web chat · 11:06', tag: 'Wants to buy', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'Do you deliver to Eilat next day? Need it for Friday.',
            steps: ['Checked your dispatch cut-off, 14:00', 'Checked the courier zone for Eilat', 'Checked stock in her size'],
            reply: 'Next-day does reach Eilat if you order before 14:00 today. That lands Thursday, a day early. Shall I hold it?',
            after: 'Ordered eleven minutes later.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Order status and real tracking', n: 'handled alone' },
          { t: 'Cancellations, after checking fulfilment', n: 'handled alone' },
          { t: 'Returns and exchanges, label included', n: 'handled alone' },
          { t: 'Refunds within your limit', n: 'handled alone' },
          { t: 'Stock checks and product search', n: 'handled alone' },
          { t: 'Sizing and care, from your own product copy', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'The decisions that involve money or judgement.',
        stops: [
          { t: 'A refund over your limit', n: 'Approvals' },
          { t: 'A cancellation after dispatch', n: 'Approvals' },
          { t: 'A customer writing a third time', n: 'To a person' },
          { t: 'Anything a policy does not cover', n: 'To a person' }
        ],
        stopFoot: 'Roughly three a day reach you, each one a card with the order, the reason and what it costs to wait. Everything else is already done.',
        quote: '"Ecommerce support is mostly lookups. Lookups are exactly what software should be doing at two in the morning."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'The routine volume', l: 'handled end to end before it reaches your team' }, { v: 'The judgement calls', l: 'brought to you with the order, the amount and the reason' }],
        ctaTitle: 'See what it would have answered last month.',
        ctaBody: 'Connect your store and GOTCHA replays your own past conversations, your products, your policies, your customers. You judge it on your business before you trust it with one.'
      },

      'sol-leads': {
        kicker: 'By business · Lead handling', icon: 'user-plus', bg: '#EDF4E7', ic: '#2E7D5B',
        h1a: 'The enquiry that waited a day', h1b: 'bought somewhere else',
        sub: 'Every enquiry gets the same six questions answered in seconds, qualified against what you actually want, and either booked, quoted, or handed to a person while they are still interested.',
        asideHead: 'Where the impact is',
        aside: 'The enquiry that waited a day bought somewhere else. Every lead gets answered in seconds, qualified against what you actually want, and either booked, quoted or handed to a person while they are still interested. On the phone, Call Pilot guides your salesperson live.',
        stats: [{ v: 'Answered in seconds', l: 'every enquiry, every channel, any hour' }, { v: 'Qualified your way', l: 'budget, timeline, volume, fit, asked in a conversation' }, { v: 'Booked or handed over', l: 'a meeting in your calendar, or a person with the context' }],
        dayTitle: 'Qualified, quoted and booked before anyone opened a laptop.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'mail', chBg: '#EFEAE1', chIc: '#7A6A4F', when: 'Email · 23:12', tag: 'High value', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: "We'd like 40 sand king sets for a hotel opening on 20 September. Price and can you make that date?",
            steps: ['Checked trade pricing for 40 units', 'Checked stock: 26 on hand', 'Checked the workshop queue. Three weeks'],
            reply: '40 at trade is ₪124 each, ₪4,960 total. We have 26 in stock and the rest in three weeks, so 20 September is comfortable. Shall I hold the 26?',
            after: 'Eitan woke to a live deal instead of an enquiry. Closed at the same price.' },
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 19:48', tag: 'Booking', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'Do you have anything Thursday afternoon? Preferably late.',
            steps: ['Read real availability from your calendar', 'Noted she prefers late slots', 'Held the slot pending confirmation'],
            reply: 'Thursday 16:30 or 17:45 are both free. Shall I hold 17:45 for you?',
            after: 'Booked, reminder scheduled, preference saved for next time.' },
          { channel: 'instagram', chBg: '#FBEEE8', chIc: '#C4552F', when: 'Instagram · 08:20', tag: 'Not a fit', tagFg: '#8A6A16', tagBg: '#F6EFD8', edge: '#E0B341',
            msg: 'Hi! Do you do custom embroidery on single items?',
            steps: ['Checked your minimum order', 'Checked what you actually offer', 'Did not invent a service you do not sell'],
            reply: 'We only embroider from 12 pieces up, so a single item is not something we can do well. If you ever need a set, I am here.',
            after: 'Politely closed. Never reached your inbox, never wasted a reply.' }
        ],
        aloneTitle: 'What it handles without anyone', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Prices and terms, from your real list', n: 'handled alone' },
          { t: 'Lead times per product', n: 'handled alone' },
          { t: 'Availability and booking, straight into the calendar', n: 'handled alone' },
          { t: 'Qualifying, budget, volume, timeline', n: 'handled alone' },
          { t: 'Chasing a quote that went quiet', n: 'handled alone' },
          { t: 'Declining what you do not sell', n: 'handled alone' }
        ],
        stopTitle: 'Where it stops and asks you', stopNote: 'Anything that commits the business.',
        stops: [
          { t: 'Opening a trade account', n: 'Approvals' },
          { t: 'A discount beyond your limit', n: 'Approvals' },
          { t: 'Payment terms', n: 'Your team only' },
          { t: 'An order over ₪5,000', n: 'To a person' }
        ],
        stopFoot: 'It gathers everything first, so what reaches you is a decision with the numbers already attached, not an enquiry to start working on.',
        quote: '"Speed is most of lead handling. The rest is not forgetting to follow up."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'Nothing goes cold', l: 'quotes that went quiet are chased, politely, on time' }, { v: 'Your CRM stays current', l: 'every lead, every answer and every next step written back' }],
        ctaTitle: 'Point it at last month and see what you missed.',
        ctaBody: 'GOTCHA reads your price list, your lead times and your calendar, then replays your real enquiries, including the ones nobody got back to.'
      },

      'sol-owner': {
        kicker: 'By role · Running it alone', icon: 'crown', bg: '#F0EDE7', ic: '#55524C',
        h1a: 'You are the founder,', h1b: 'and also the night shift',
        sub: 'Nobody else is going to answer that message at eleven at night. GOTCHA takes the part that is lookup and admin, asks you only about money and judgement, and gives you back the evening.',
        asideHead: 'Where the impact is',
        aside: 'Nobody else is going to answer that message at eleven at night. GOTCHA takes the part that is lookup and admin, asks you only about money and judgement, and gives you back the evening.',
        stats: [{ v: 'The evening, back', l: 'the routine answered while you are not looking' }, { v: 'Only the real decisions', l: 'money and judgement reach you, nothing else' }, { v: 'Everything written down', l: 'what was asked, what was done, in one log' }],
        dayTitle: 'One person, and none of these interrupted her.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 07:12', tag: 'Handled', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: 'Has my order shipped yet? Ordered Sunday.',
            steps: ['Found the order', 'Read the tracking', 'Answered with the real date'],
            reply: 'It went out yesterday and the courier has it for Thursday. Here is the tracking link.',
            after: 'You were still asleep. Nothing needed you.' },
          { channel: 'phone', chBg: '#F0EDE7', chIc: '#55524C', when: 'Phone · 13:30', tag: 'While you worked', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: '[Missed call. You were at the workshop]',
            steps: ['Answered, took the question', 'Checked stock in her size', 'Wrote it all to her on WhatsApp'],
            reply: 'Hi. You called about the sand king. It is in stock and I have held one for 24 hours under your name.',
            after: 'Transcript attached to her record. You read it in four seconds.' },
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 22:47', tag: 'Asked you', tagFg: '#8A6A16', tagBg: '#F6EFD8', edge: '#E0B341',
            msg: 'The towels arrived damaged. Photo attached. Can I get a refund?',
            steps: ['Checked delivery. Four days ago', 'Read the photo and your policy, within it', 'Refund is ₪420: over your limit'],
            reply: 'Waiting on you: refund ₪420 to Dana Cohen · damaged, photo attached, within policy · reversible for 24 hours.',
            after: 'One tap in the morning. She had already been told you would look at it.' }
        ],
        aloneTitle: 'What it takes off you entirely', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Order status, tracking, delivery dates', n: 'handled alone' },
          { t: 'Answering the phone when you cannot', n: 'handled alone' },
          { t: 'Sizes, care, stock, prices', n: 'handled alone' },
          { t: 'Returns and exchanges inside policy', n: 'handled alone' },
          { t: 'Following up after delivery', n: 'handled alone' },
          { t: 'Remembering what each customer prefers', n: 'handled alone' }
        ],
        stopTitle: 'What still reaches you', stopNote: 'Three a day, and it says why.',
        stops: [
          { t: 'Money above the limit you set', n: 'Approvals' },
          { t: 'An unhappy customer, second time', n: 'To you' },
          { t: 'Something no policy covers', n: 'To you' },
          { t: 'A system stopped responding', n: 'Notification' }
        ],
        stopFoot: 'Each one arrives as a card you can decide in seconds, with the order, the reason, what happens if you approve, and how long you have to undo it.',
        quote: '"We built this for the founder who is also the night shift."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'One person, covered', l: 'like a business with a support team' }, { v: 'Watch first', l: 'a week in shadow mode before it says anything to anyone' }],
        ctaTitle: 'Get the evening back, starting tonight.',
        ctaBody: 'Connect WhatsApp and your store. It starts in watch-only mode. It tells you what it would have said, on your real conversations, before it says anything to anyone.'
      },

      'sol-agent': {
        kicker: 'By role · On the front line', icon: 'headphones', bg: '#EDF1F7', ic: '#3E5C99',
        h1a: 'Nine tabs open', h1b: 'to answer one question',
        sub: 'The copilot has already found the order, read the policy and checked the stock before you finish reading the message. You choose how to answer. It does the gathering, and it never sends anything by itself.',
        asideHead: 'Where the impact is',
        aside: 'Nine tabs open to answer one question. Copilot has already found the order, read the policy and checked the stock before you finish reading the message. You choose how to answer. It does the gathering, and it never sends anything by itself.',
        stats: [{ v: 'The reading, done', l: 'order, policy, history and stock, before you start' }, { v: 'A few ways to answer', l: 'in your tone, with what each one costs' }, { v: 'You press send', l: 'nothing reaches a customer without a person deciding' }],
        dayTitle: 'The context was already there when you opened it.', dayNote: 'How a conversation like this plays out, step by step.',
        cases: [
          { channel: 'message-circle', chBg: '#EDF4E7', chIc: '#2E7D5B', when: 'WhatsApp · 09:41', tag: 'Third time', tagFg: '#8E3418', tagBg: '#FBEEE8', edge: '#C4552F',
            msg: "Still nothing. This is the third time I'm writing.",
            steps: ['Order #1842 found: stuck since Tuesday', 'Policy read: refund is within it', 'Found a promise made on 25 Aug that never shipped'],
            reply: 'Three ways to answer: refund ₪179 · apologise and hold one from tomorrow · escalate to the carrier. Each with what it costs.',
            after: 'You picked one and sent it. Total time: eleven seconds.' },
          { channel: 'instagram', chBg: '#FBEEE8', chIc: '#C4552F', when: 'Instagram · 10:02', tag: 'Handover', tagFg: '#4B3E8E', tagBg: '#EFEAE1', edge: '#5B4CB8',
            msg: '[AI employee passed this to you]',
            steps: ['Everything it already tried is listed', 'Why it stopped is stated in one line', 'Her full history across channels is open'],
            reply: 'Passed to you because she asked for a person. Nothing was lost. She has not had to repeat herself.',
            after: 'You take over mid-conversation. The AI stops instantly.' },
          { channel: 'phone', chBg: '#F0EDE7', chIc: '#55524C', when: 'Phone · 11:15', tag: 'Live', tagFg: '#4F7A2E', tagBg: '#E7F0D4', edge: '#A8C57A',
            msg: '[On a call: transcript running]',
            steps: ['Transcribing as she speaks', 'Found the prior promise, unprompted', 'Suggested a line to say out loud'],
            reply: 'Say this: "I can see we promised you a replacement on the 25th and it never went out. I am sorting that now."',
            after: 'Refund run without hanging up. Everything agreed written to her afterwards.' }
        ],
        aloneTitle: 'What the copilot does for you', aloneNote: 'Inside the limits you set.',
        alone: [
          { t: 'Finds the order and reads the tracking', n: 'handled alone' },
          { t: 'Reads the policy that applies', n: 'handled alone' },
          { t: 'Pulls her history across every channel', n: 'handled alone' },
          { t: 'Offers a few ways to answer, with the cost of each', n: 'handled alone' },
          { t: 'Rewrites, shortens or translates your draft', n: 'handled alone' },
          { t: 'Runs the action once you approve it', n: 'handled alone' }
        ],
        stopTitle: 'What stays yours', stopNote: 'The copilot never acts on its own.',
        stops: [
          { t: 'Nothing sends without you pressing send', n: 'always' },
          { t: 'Money above your own limit', n: 'to a manager' },
          { t: 'Tone and wording', n: 'your call' },
          { t: 'Taking over from an AI employee', n: 'instant' }
        ],
        stopFoot: 'It is a colleague who has already done the reading, not a system that answers over your shoulder. You can ignore every suggestion it makes.',
        quote: '"A good agent is wasted on copy and paste. Copilot does the gathering so they can do the judging."',
        quoteName: 'Matan & Omer', quoteRole: 'Co-founders · GOTCHA',
        proof: [{ v: 'Less time gathering', l: 'more time on the conversations that need a human' }, { v: 'Take over any time', l: 'the AI stops the moment you start typing' }],
        ctaTitle: 'Give your team the four minutes back.',
        ctaBody: 'Every agent gets the copilot on every conversation, on every plan, with no per-seat charge. Nothing it finds is hidden, and nothing it drafts is sent without a person.'
      }
    };

    const FEATS = {
      'feat-omnichannel': {
        name: 'Omnichannel', kicker: 'Product · Omnichannel', icon: 'inbox', bg: '#EDF4E7', ic: '#2E7D5B',
        h1a: 'Every channel in.', h1b: 'One inbox out.',
        sub: 'Wherever your customers already write to you, it lands here: WhatsApp, Instagram, Messenger, Facebook, email, web chat and the phone. And whatever the channel, everything known about that customer sits beside the conversation: who she is, what she bought, what she asked last time and what was promised.',
        asideHead: 'On a business answering on four channels',
        aside: 'Nobody switches tabs, nobody asks a returning customer to explain herself again, and nothing important sits unopened in an app only one person has on their phone.',
        stats: [{ v: '6', l: 'channels in one thread' }, { v: '19s', l: 'average first reply, day or night' }, { v: '0', l: 'conversations living on a personal phone' }],
        capsTitle: 'Every channel your customers are on comes in. Everything about them stays with the conversation.',
        capsNote: 'Connecting a channel takes minutes and nothing about the customer experience changes. They write where they always wrote.',
        caps: [
          { icon: 'message-circle', bg: '#EDF4E7', ic: '#2E7D5B', t: 'WhatsApp, properly', d: 'Official WhatsApp Business API on your existing number, with templates, media and read state. Your history can be imported on the way in.', n: 'keep your number' },
          { icon: 'instagram', bg: '#FBEEE8', ic: '#C4552F', t: 'Instagram, Messenger, email, web', d: 'DMs, story replies and comments, Messenger threads, your support mailbox and the site widget, all in the same queue.', n: '5 more channels' },
          { icon: 'users-round', bg: '#EDF1F7', ic: '#3E5C99', t: 'Threaded by person', d: 'Channels merge into one customer record. An Instagram question and today\'s email sit in one conversation with one order attached.', n: 'one identity' },
          { icon: 'split', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Routing and handover', d: 'To a department, an agent or an AI employee, mid-conversation. The AI stops the instant a person takes over, and can be handed back.', n: 'instant' }
        ],
        shotTitle: 'One inbox for every channel your customers use.', shotMeta: 'The omnichannel inbox',
        shotCaption: 'One queue, threaded by customer rather than by app, with her order, her history and everything Copilot found already beside the conversation. No second window, no asking her to explain herself again.',
        shot: '/assets/shots/inbox.png',
        shotChannelsLabel: 'Everything arrives here',
        shotChannels: [
          { t: 'WhatsApp', logo: 'https://cdn.simpleicons.org/whatsapp/25D366' },
          { t: 'Instagram', logo: 'https://cdn.simpleicons.org/instagram/E4405F' },
          { t: 'Messenger', logo: 'https://cdn.simpleicons.org/messenger/0084FF' },
          { t: 'Facebook', logo: 'https://cdn.simpleicons.org/facebook/0866FF' },
          { t: 'Email', logo: 'https://cdn.simpleicons.org/gmail/EA4335' },
          { t: 'Web chat', icon: 'globe', noLogo: true },
          { t: 'Phone', icon: 'phone', noLogo: true }
        ],
        callouts: [
          { n: '01', t: 'Channel badge on every thread, so you always know where she will receive the answer.' },
          { n: '02', t: 'Tags the AI assigned: subject, urgency, whether she has written before about this.' },
          { n: '03', t: 'Her order, her history and her language sit beside the thread, not behind a search.' }
        ],
        doesTitle: 'What lands here on a normal day', doesNote: 'One month on a business doing roughly 3,000 conversations.',
        does: [
          { t: 'WhatsApp: the majority of everything', n: '1,840' },
          { t: 'Instagram DMs, story replies and comments', n: '610' },
          { t: 'Email, threaded with the same customer', n: '318' },
          { t: 'Web chat from the site widget', n: '204' },
          { t: 'Merged into an existing customer automatically', n: '71%' },
          { t: 'Answered without anyone opening the thread', n: '88%' }
        ],
        limitTitle: 'What stays in your hands', limitNote: 'One inbox does not mean one undifferentiated pile.',
        limits: [
          { t: 'Which channels an AI employee may answer', n: 'per channel' },
          { t: 'Which department owns which subject', n: 'routing' },
          { t: 'Hours a channel is answered by a person', n: 'schedule' },
          { t: 'Who can see which conversations', n: 'roles' }
        ],
        limitFoot: 'You can start with delivery questions on WhatsApp only, and widen it a channel at a time once you have watched it work.',
        quote: '"She wrote on Instagram in March and WhatsApp yesterday. I used to have no idea it was the same person, now it is one thread and she never repeats herself."',
        quoteName: 'Maya Levi', quoteRole: 'Founder · linen & bath textiles',
        proof: [{ v: '4 → 1', l: 'apps open to answer one customer' }, { v: '71%', l: 'of new messages matched to someone you already know' }],
        ctaTitle: 'Put every channel in one place this afternoon.',
        ctaBody: 'Connect WhatsApp and Instagram in minutes, keep your number, and import the history so it already knows how your business talks.'
      },

      'feat-copilot': {
        name: 'Copilot', kicker: 'Product · Copilot', icon: 'square-pen', bg: '#EAE4FB', ic: '#4B3E8E',
        h1a: 'Copilot: the whole customer,', h1b: 'in one place, at your side',
        sub: 'Copilot is a 360-degree view of the customer beside every conversation, run by an AI employee that does the back-office work for you. Who she is, what she bought, what she asked before, and the actions in Shopify or your CRM one click away. No more checking history in five tabs. It is the shortcut to everything.',
        asideHead: 'What it replaces',
        aside: 'The tabs. Store admin, courier site, CRM, the policy doc and the old thread. Copilot has already opened all of them, read them and written the summary before you finish reading the message.',
        stats: [],
        capsTitle: 'Everything an agent needs, before they need it.',
        capsNote: 'Copilot never sends anything by itself. It gathers, drafts and prepares the action. Your person decides.',
        caps: [
          { icon: 'scan-eye', bg: '#EAE4FB', ic: '#4B3E8E', t: '360 degrees around the customer', d: 'Orders, returns, past conversations on every channel, preferences it noticed, what was promised last time. One panel, always up to date.', n: 'no history to dig for' },
          { icon: 'search-check', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Already read, already found', d: 'The order in Shopify, the tracking from the courier, the policy that applies. Quoted with its source so an agent can check rather than trust.', n: 'facts, not guesses' },
          { icon: 'zap', bg: '#FBEEE8', ic: '#C4552F', t: 'Actions from the conversation', d: 'Refund, cancel, open a return, change an address, book a slot, update the CRM. Run inside Shopify or your CRM from Copilot, logged against the conversation.', n: 'one click, any system' },
          { icon: 'square-pen', bg: '#EDF1F7', ic: '#3E5C99', t: 'A few ways to answer', d: 'Drafts in your tone, with what each option costs. Edit, send, or ignore. The agent stays in charge of what the customer hears.', n: 'you press send' },
          { icon: 'bot', bg: '#F7F0E2', ic: '#8A6A16', t: 'Run by an AI employee', d: 'The back-office work behind every reply, the lookups, the summaries, the CRM updates, is done by an AI employee so your people do not have to.', n: 'back office, handled' },
          { icon: 'hand', bg: '#F0EDE7', ic: '#55524C', t: 'Take over, hand back', d: 'The AI stops the moment a person starts typing, and can be handed the conversation back just as easily. Two voices never answer the same question.', n: 'instant' }
        ],
        shot: '/assets/shots/inbox.png',
        shotTitle: 'Copilot beside the conversation.', shotMeta: 'Copilot in the inbox',
        shotCaption: 'The conversation in the middle, and on the right the whole customer: her order, her history, what the AI already found and the actions ready to run. Nothing to look up elsewhere.',
        callouts: [
          { n: '01', t: 'What it found, quoted with its source, so an agent can check rather than trust.' },
          { n: '02', t: 'Each draft with its consequence: what it costs, whether it can be undone.' },
          { n: '03', t: 'A summary of a long thread for whoever picks it up next.' }
        ],
        doesTitle: 'What it hands your team, per conversation', doesNote: 'Measured on a four-person support team.',
        does: [
          { t: 'Order and delivery status, already looked up', n: 'always' },
          { t: 'The policy paragraph that applies, quoted', n: 'always' },
          { t: 'Her past conversations, summarised in two lines', n: 'always' },
          { t: 'Suggested replies in Hebrew or English', n: '2–3' },
          { t: 'Suggested next action with its limit shown', n: 'when relevant' },
          { t: 'Handover note when it passes to a person', n: '350 / week' }
        ],
        limitTitle: 'What Copilot never does', limitNote: 'It advises. Your team decides.',
        limits: [
          { t: 'Nothing sends without a person pressing send', n: 'always' },
          { t: 'Money above your limit goes to a manager', n: 'approvals' },
          { t: 'Tone and final wording', n: 'your call' },
          { t: 'Taking over from an AI employee', n: 'instant' }
        ],
        limitFoot: 'Copilot is on every plan, for every agent, with no per-seat charge. Charging more as each person handles more would be backwards.',
        quote: '"I used to have Shopify, the courier site and two chat windows open. Now the answer is sitting there and I decide which one to send."',
        quoteName: 'Shira Nave', quoteRole: 'Support agent · Aviv & Co.',
        proof: [{ v: '4 min', l: 'of lookup work removed from every reply' }, { v: '184h', l: 'a month the team stopped spending on it' }],
        ctaTitle: 'Give your team the four minutes back.',
        ctaBody: 'Copilot works on your real conversations from the first afternoon. Nothing it finds is hidden, and nothing it drafts reaches a customer without a person.'
      },

      'feat-callpilot': {
        name: 'Call pilot', beta: true, kicker: 'Product · Call pilot', icon: 'phone-call', bg: '#EDF1F7', ic: '#3E5C99',
        h1a: 'The phone stops being', h1b: 'the channel nobody covers',
        sub: 'Call pilot answers calls in your voice, transcribes as people speak, and finds the caller\'s order while they are still explaining it. When a person takes the call, it stays on the line as a copilot.',
        asideHead: 'Currently in beta',
        aside: 'Call pilot is live with a limited group of businesses on Full operation. Hebrew and English, inbound and outbound, with 300 minutes included.',
        stats: [{ v: '0', l: 'calls that ring out at 21:00' }, { v: '2s', l: 'to the caller\'s history, mid-sentence' }, { v: '100%', l: 'of calls transcribed and searchable' }],
        capsTitle: 'It answers, it listens, and it hands over cleanly.',
        capsNote: 'A call is a conversation like any other. It lands in the same inbox, on the same customer, with the same permissions.',
        caps: [
          { icon: 'phone-incoming', bg: '#EDF1F7', ic: '#3E5C99', t: 'Answers instead of the voicemail', d: 'Hours, availability, order status, opening a return, booking a slot. The routine calls, handled in the caller\'s language.', n: 'inbound' },
          { icon: 'captions', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Live transcript and summary', d: 'Every call written down as it happens, summarised when it ends, and attached to the customer so the next person knows what was said.', n: 'searchable' },
          { icon: 'headphones', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Copilot on the line', d: 'When your own person takes the call, Copilot keeps working beside them. The order on screen, the answer to what was just asked, actions ready to run.', n: 'no hold music' },
          { icon: 'phone-outgoing', bg: '#FBEEE8', ic: '#C4552F', t: 'Calls out when it matters', d: 'A confirmation nobody answered in writing, a delivery gone wrong, a quote that needs a voice. Always with a written record.', n: 'outbound' }
        ],
        shotTitle: 'A call in progress, with everything already found.', shotMeta: 'Call Pilot',
        shotCaption: 'Live transcript on one side, the caller and her orders on the other, and the actions you might need loaded before you ask for them.',
        shot: '/assets/shots/call.png',
        callouts: [
          { n: '01', t: 'Live transcript, with the question it thinks is being asked marked as it goes.' },
          { n: '02', t: 'The caller recognised from her number and matched to her last order.' },
          { n: '03', t: 'Transfer to a person mid-call, with everything said so far handed over.' }
        ],
        doesTitle: 'What it takes off the phone', doesNote: 'From the beta group, first eight weeks.',
        does: [
          { t: 'Hours, location, parking and stock questions', n: '61%' },
          { t: 'Order and delivery status by phone', n: '340 calls' },
          { t: 'Booking, moving and cancelling appointments', n: '186' },
          { t: 'Calls answered outside working hours', n: '44%' },
          { t: 'Transferred to a person within 20 seconds', n: 'when needed' },
          { t: 'Written summary on the customer record', n: 'every call' }
        ],
        limitTitle: 'What we are honest about in beta', limitNote: 'Phone is the hardest channel and we will not pretend otherwise.',
        limits: [
          { t: 'Anything clinical, legal or emotional goes to a person', n: 'immediately' },
          { t: 'Payments over the phone', n: 'never' },
          { t: 'Noisy lines and heavy accents', n: 'we hand over' },
          { t: 'Callers who ask for a person', n: 'always get one' }
        ],
        limitFoot: 'Beta means a shorter list of things it will attempt and a shorter fuse for handing over. You choose which numbers and which hours it answers at all.',
        quote: '"It answered forty calls on a Friday afternoon and transferred four. Those four were the ones that actually needed me."',
        quoteName: 'Eitan Barzilai', quoteRole: 'Owner · trade & wholesale supplier',
        proof: [{ v: '44%', l: 'of calls arrive when nobody can pick up' }, { v: '300 min', l: 'included on Full operation' }],
        ctaTitle: 'Ask for a place in the phone beta.',
        ctaBody: 'Twenty minutes on a call and we will tell you honestly whether your call mix is a good fit yet, and which numbers to start with if it is.'
      },

      'feat-knowledge': {
        name: 'Knowledge base', kicker: 'Product · Knowledge base', icon: 'library', bg: '#F7F0E2', ic: '#8A6A16',
        h1a: 'Everything that matters,', h1b: 'in one place. The base of it all.',
        sub: 'The knowledge base is everything GOTCHA knows about your business, and the only place your AI employees learn from. Your products, your policies, your delivery rules, the way your team has always answered. Everything here is kept, learned and applied on every reply. Invest in it and you get the most out of the whole system.',
        asideHead: 'Why it is worth the hour',
        aside: 'Every AI employee, every Copilot suggestion and every automation reads from here. One good answer written once is applied on every channel, by every employee, from then on. Nothing is invented from the internet.',
        stats: [],
        capsTitle: 'Feed it once. Every AI employee learns it.',
        capsNote: 'Most of it fills itself from your site and your store. The rest is a list of questions it could not answer, waiting for one line from you.',
        caps: [
          { icon: 'globe', bg: '#F7F0E2', ic: '#8A6A16', t: 'Reads your business by itself', d: 'Your site, your product pages, your policies, your delivery times and your past replies, imported and kept current. No prompt writing.', n: 'automatic' },
          { icon: 'file-text', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Add what only you know', d: 'Carrier cut-off times, what to say about a delayed batch, the tone for a complaint. Plain documents and short notes, in your words.', n: 'plain language' },
          { icon: 'git-compare', bg: '#FBEEE8', ic: '#C4552F', t: 'Catches your own contradictions', d: 'When two of your documents disagree it shows you both instead of picking one. You fix the source and every employee updates.', n: 'one truth' },
          { icon: 'circle-help', bg: '#EDF1F7', ic: '#3E5C99', t: 'Tells you what it cannot answer', d: 'A ranked list of questions customers asked that your knowledge does not cover. Answer once and every AI employee has it.', n: 'gaps, ranked' },
          { icon: 'library', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Shared by every AI employee', d: 'Support, sales, the widget, the phone: all of them read the same knowledge. Change it once and everyone learns it at the same time.', n: 'one base, all employees' },
          { icon: 'link', bg: '#F0EDE7', ic: '#55524C', t: 'Every answer traceable', d: 'Each reply points at the page, document or past conversation it came from. You can check any answer back to its source.', n: 'with sources' }
        ],
        shotTitle: 'Knowledge', shotMeta: 'knowledge · 2 conflicts open',
        shotCaption: 'Sources on the left, what it learned in the middle, and the questions it could not answer waiting for one line from you.',
        slot: 'feat-knowledge-shot', slotHint: 'product screenshot: knowledge sources, conflicts and gap list',
        callouts: [
          { n: '01', t: 'Every answer traceable to the page or reply it came from.' },
          { n: '02', t: 'Conflicts held rather than guessed, with both sources side by side.' },
          { n: '03', t: 'The gap list: the questions your customers ask that your site never answered.' }
        ],
        doesTitle: 'What it learned in the first week', doesNote: 'A store with 340 products and a nine-page policy section.',
        does: [
          { t: 'Product pages, specifications and care', n: '340' },
          { t: 'Policy pages: returns, shipping, warranty', n: '9' },
          { t: 'Past conversations read for tone and precedent', n: '11,400' },
          { t: 'Facts confirmed by a person', n: '86' },
          { t: 'Conflicts found and settled', n: '7' },
          { t: 'Missing answers written once, used since', n: '23' }
        ],
        limitTitle: 'What it refuses to do', limitNote: 'Silence is a better answer than a confident wrong one.',
        limits: [
          { t: 'Answer from outside your sources', n: 'never' },
          { t: 'Choose between two conflicting facts', n: 'asks you' },
          { t: 'Guess at a price or a lead time', n: 'never' },
          { t: 'Keep trying when it is unsure', n: 'hands over' }
        ],
        limitFoot: 'This is the single biggest reason businesses trust it with customers: it would rather look uncertain to you than sound certain to them.',
        quote: '"It found seven places where our own site contradicted itself. We had been giving customers two different answers for a year."',
        quoteName: 'Tomer Adler', quoteRole: 'Customer lead · four-person team',
        proof: [{ v: '23', l: 'answers written once that removed 900 repeat questions' }, { v: '7', l: 'contradictions in your own documents, found in week one' }],
        ctaTitle: 'Point it at your site and see what it knows.',
        ctaBody: 'It reads your pages and your products in an afternoon, then shows you exactly what it learned, and what your own site never answered.'
      },

      'feat-approvals': {
        name: 'Approvals', kicker: 'Product · Approvals', icon: 'check-check', bg: '#EDF4E7', ic: '#2E7D5B',
        h1a: 'It acts on its own,', h1b: 'up to the line you draw',
        sub: 'Every action is set to do it, ask me, or never. What it may do alone happens in seconds; everything else becomes a card with the order, the reason, what it costs to wait, and whether it can be undone.',
        asideHead: 'Roughly three a day reach you',
        aside: 'Not a queue to process: a short list of the decisions that were always yours, with the reading already done and the clock stated.',
        stats: [{ v: '3', l: 'decisions a day actually reach you' }, { v: '11s', l: 'median time to clear one' }, { v: '100%', l: 'of AI actions in one audit log' }],
        capsTitle: 'Nobody trusts software with money. So you set exactly how far it goes.',
        capsNote: 'The permission table is the product. Everything else follows from where you put each line.',
        caps: [
          { icon: 'sliders-horizontal', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Do it / Ask me / Never', d: 'Per action, not per plan. Look up an order: do it. Refund under ₪200: do it. Refund over ₪200: ask me. Change bank details: never.', n: 'per action' },
          { icon: 'timer', bg: '#F7F0E2', ic: '#8A6A16', t: 'The cost of waiting, stated', d: '"This order packs at 11:20, after that a cancellation costs ₪28." You are deciding with the deadline in front of you.', n: 'on every card' },
          { icon: 'undo-2', bg: '#EDF1F7', ic: '#3E5C99', t: 'Reversible for a stated window', d: 'Anything with money attached can be undone for a defined period, and the card says how long you have.', n: 'undo window' },
          { icon: 'smartphone', bg: '#FBEEE8', ic: '#C4552F', t: 'Clear them from anywhere', d: 'Keyboard only at your desk, or approve straight from WhatsApp while you are out. The customer waits minutes, not until morning.', n: 'desk or phone' }
        ],
        shotTitle: 'Every decision that needs you, in one queue.', shotMeta: 'Approvals',
        shotCaption: 'One card at a time, with the amount, the customer, what the AI wants to do and why. Approve, edit or reject, and the conversation carries on without you.',
        shot: '/assets/shots/approvals.png',
        callouts: [
          { n: '01', t: 'What it wants to do, in money and in plain words.' },
          { n: '02', t: 'Why it asked: the limit it hit, not a generic "needs review".' },
          { n: '03', t: 'The full log: every action it took alone, with the order and the amount.' }
        ],
        doesTitle: 'What it does without asking', doesNote: 'One month on an AI Team plan, limits set by the owner.',
        does: [
          { t: 'Order status and real tracking', n: '904' },
          { t: 'Stock checks and product search', n: '612' },
          { t: 'Returns and exchanges, label included', n: '112' },
          { t: 'Refunds inside the ₪200 limit', n: '41' },
          { t: 'Address changes before dispatch', n: '38' },
          { t: 'Bookings and reschedules', n: '186' }
        ],
        limitTitle: 'What always comes to you', limitNote: 'Money and judgement, every time.',
        limits: [
          { t: 'A refund over your limit', n: 'approvals' },
          { t: 'A cancellation after dispatch', n: 'approvals' },
          { t: 'A send to more than 100 customers', n: 'approvals' },
          { t: 'Anything a policy does not cover', n: 'to a person' }
        ],
        limitFoot: 'Start with everything on ask me. Most businesses move the safe lookups to do it in the first week, and money follows once they have watched it work.',
        quote: '"Three cards in the morning and I am done. Before, everything needed me and none of it was actually a decision."',
        quoteName: 'Maya Levi', quoteRole: 'Founder · linen & bath textiles',
        proof: [{ v: '41', l: 'refunds it handled alone last month, none disputed' }, { v: '38 min', l: 'the average deadline it puts in front of you' }],
        ctaTitle: 'Draw the line yourself, in the first ten minutes.',
        ctaBody: 'Setup asks three questions in plain language: what should it be responsible for, what may it do alone, and when should it come to you.'
      },

      'feat-customers': {
        name: 'Customers', kicker: 'Product · Customers', icon: 'contact', bg: '#EFEAE1', ic: '#7A6A4F',
        h1a: 'Your contact list,', h1b: 'with everything that ever happened',
        sub: 'Every person who has ever written to you, in one searchable list. Open a contact and you see all of it: every conversation, every order, every channel she used. The same person who wrote on WhatsApp in March and from Instagram this morning is one contact, not three.',
        asideHead: 'Built without anyone typing it',
        aside: 'Records assemble themselves from your channels and your store. Nobody logs a call, nobody tags a contact, and nothing depends on someone remembering.',
        stats: [{ v: '71%', l: 'of new messages matched to a known customer' }, { v: '4', l: 'channels merged into one person' }, { v: '0', l: 'notes anyone has to write by hand' }],
        capsTitle: 'Search a person. Open them. See everything.',
        capsNote: 'Not a CRM to maintain. A contact list that fills itself from your channels and your store, and is read on every single reply.',
        caps: [
          { icon: 'search', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Search anyone, instantly', d: 'By name, number, handle, email or order. Open the contact and the whole relationship is on one screen, with nothing to look up elsewhere.', n: 'one list' },
          { icon: 'link', bg: '#EDF4E7', ic: '#2E7D5B', t: 'The same person, not three', d: 'A phone number, an Instagram handle and an email address resolve to one contact, with a clear record of why they were merged and the option to split them.', n: 'merged automatically' },
          { icon: 'shopping-bag', bg: '#FBEEE8', ic: '#C4552F', t: 'Orders, returns and value', d: 'Pulled live from Shopify or your CRM: what she bought, what came back, what she is worth, what she is waiting for.', n: 'live from your systems' },
          { icon: 'bookmark', bg: '#EDF1F7', ic: '#3E5C99', t: 'Preferences it noticed', d: 'She prefers late slots. She writes in Hebrew. She has had two late deliveries. Small facts that change the next answer.', n: 'used on every reply' }
        ],
        shotTitle: 'One contact, everything that ever happened.', shotMeta: 'The customer record',
        shotCaption: 'Search the list, open a person, and read the whole relationship: the channels she uses merged into one contact, her orders read live from your store, and every conversation she has ever had with you.',
        shot: '/assets/shots/customer.png',
        callouts: [
          { n: '01', t: 'The channels she uses, merged, with her preferred one marked.' },
          { n: '02', t: 'Order and return history read live from your store, not copied.' },
          { n: '03', t: 'Segments you can act on: reorder due, waiting on stock, at risk.' }
        ],
        doesTitle: 'What the record gives you', doesNote: 'A store with 8,400 customers on four channels.',
        does: [
          { t: 'People with more than one channel merged', n: '3,180' },
          { t: 'Conversations attached to the right person automatically', n: '96%' },
          { t: 'Orders visible without opening your store', n: 'all' },
          { t: 'Customers who asked for something you do not stock', n: '212' },
          { t: 'Segments built from real behaviour', n: '14' },
          { t: 'Records exportable, in full, any time', n: 'yours' }
        ],
        limitTitle: 'Whose data this is', limitNote: 'Your customers\' conversations are not our training material.',
        limits: [
          { t: 'Used to train models for anyone else', n: 'never' },
          { t: 'Visible to a role you did not grant', n: 'never' },
          { t: 'Deletion on request, end to end', n: 'GDPR' },
          { t: 'Full export whenever you ask', n: 'one click' }
        ],
        limitFoot: 'Merging is always shown and always reversible. If two people were joined who should not have been, you can split them and the history follows.',
        quote: '"A customer wrote \'the same as last time\'. It knew what last time was. That is the whole thing, really."',
        quoteName: 'Eitan Barzilai', quoteRole: 'Owner · trade & wholesale supplier',
        proof: [{ v: '3,180', l: 'people who no longer explain themselves twice' }, { v: '212', l: 'requests for products you do not stock, counted' }],
        ctaTitle: 'Import your history and watch the records build themselves.',
        ctaBody: 'Your past WhatsApp and Instagram conversations come in on setup, which is also the fastest way for it to learn how your customers actually talk.'
      },

      'feat-studio': {
        name: 'AI Studio', kicker: 'Product · AI Studio', icon: 'sliders-horizontal', bg: '#EAE4FB', ic: '#4B3E8E',
        h1a: 'This is where', h1b: 'the magic happens.',
        sub: 'Everything AI in GOTCHA is run from Studio. Here you create new AI employees and give them new capabilities, connect them to the tools they need, build the workflows that route, reply and act, and keep the knowledge base that all of them learn from.',
        asideHead: 'Three questions, in plain language',
        aside: 'What should this employee be responsible for, what may it do on its own, and when should it come to you. Studio turns those answers into a working colleague. No prompts, no code.',
        stats: [],
        capsTitle: 'Create employees. Build workflows. Connect tools. Teach knowledge.',
        capsNote: 'Studio is the control room. Everything the AI does anywhere in GOTCHA is decided here, and can be changed here in a minute.',
        caps: [
          { icon: 'user-round-plus', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Create AI employees', d: 'Hire one for support, one for sales, one for wholesale. Give each a responsibility in plain words, its channels, and the hours it works.', n: 'as many as you need' },
          { icon: 'sliders-horizontal', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Give them capabilities', d: 'Look up orders, issue refunds, book appointments, update the CRM. Switch each capability on per employee, and set it to do it, ask me or never.', n: 'per employee, per action' },
          { icon: 'plug', bg: '#EDF1F7', ic: '#3E5C99', t: 'Connect the tools', d: 'Shopify, your CRM, your calendar, your returns platform. Connecting a tool gives your employees new things they can do, and you decide which.', n: 'real systems' },
          { icon: 'workflow', bg: '#FBEEE8', ic: '#C4552F', t: 'Build workflows', d: 'When this happens, do that, and here is what to do in each case. Visual automations that route, reply and act without an agent, with a record of every run.', n: 'no code' },
          { icon: 'library', bg: '#F7F0E2', ic: '#8A6A16', t: 'Update the knowledge base', d: 'Everything your employees know lives here too. Add a document, fix a contradiction, answer a gap, and every employee learns it at once.', n: 'one base' },
          { icon: 'eye', bg: '#F0EDE7', ic: '#55524C', t: 'Watch before you trust', d: 'Run a new employee in watch-only mode. It tells you what it would have said, on real conversations, before it says anything to anyone.', n: 'shadow mode' }
        ],
        shotTitle: 'Build a rule the way you would explain it.', shotMeta: 'Studio · Automations',
        shotCaption: 'When this happens, do that, and here is what to do in each case. Every automation shows how often it ran, how much it finished alone and where it stopped for a person.',
        shot: '/assets/shots/automations.png',
        callouts: [
          { n: '01', t: 'Its brief in plain language: what it owns and what it never touches.' },
          { n: '02', t: 'The permission table: do it, ask me, never, per action.' },
          { n: '03', t: 'Test it on your own past conversations before it goes live.' }
        ],
        doesTitle: 'Setting one up', doesNote: 'A first afternoon, in order.',
        does: [
          { t: 'Connect your channels and your store', n: '10 min' },
          { t: 'Let it read your site, products and policies', n: '30 min' },
          { t: 'Say what it is responsible for', n: '1 question' },
          { t: 'Say what it may do alone', n: '1 table' },
          { t: 'Say when it should come to you', n: '1 question' },
          { t: 'Watch it in shadow mode on real messages', n: 'as long as you like' }
        ],
        limitTitle: 'What we will not make you do', limitNote: 'If it needs an implementation project, we have failed.',
        limits: [
          { t: 'Write or tune prompts', n: 'never' },
          { t: 'Build decision trees for every question', n: 'never' },
          { t: 'Pay for an onboarding project', n: 'no setup fee' },
          { t: 'Hire a developer to change its behaviour', n: 'it is a setting' }
        ],
        limitFoot: 'There is an API and a webhook catalogue for the businesses with an ERP and a developer. Everyone else never opens them.',
        quote: '"I answered three questions about what it was allowed to do. That was the setup. I kept waiting for the hard part."',
        quoteName: 'Tomer Adler', quoteRole: 'Customer lead · four-person team',
        proof: [{ v: 'One afternoon', l: 'from connecting a channel to answering real customers' }, { v: '0', l: 'prompts written by any customer, ever' }],
        ctaTitle: 'Put one to work on one thing this week.',
        ctaBody: 'Start with delivery questions, keep it in watch-only mode as long as you like, and widen its responsibility once you have read what it would have said.'
      },

      'feat-analytics': {
        name: 'Analytics', kicker: 'Product · Analytics', icon: 'bar-chart-3', bg: '#EDF1F7', ic: '#3E5C99',
        h1a: 'The managers\' room.', h1b: 'Everything that matters to you, in one view.',
        sub: 'Analytics is built for whoever runs the operation. The KPIs you defined, how your team and your AI employees are performing, what customers are writing about and why, and where the money is. Everything a manager actually wants to know, without asking anyone to build a report.',
        asideHead: 'Numbers you can open',
        aside: 'Every figure clicks through to the conversations behind it, unedited. Nothing here is a number you have to take on trust.',
        stats: [],
        capsTitle: 'Your KPIs, your people, your customers. Measured, not guessed.',
        capsNote: 'Set the targets that matter to your business and watch them move. Analytics tells you what changed, where, and what to do about it.',
        caps: [
          { icon: 'target', bg: '#EDF1F7', ic: '#3E5C99', t: 'The KPIs you defined', d: 'First reply, resolution time, handled alone, customer rating, revenue per conversation. You choose what counts as good, and see it against target every day.', n: 'your targets' },
          { icon: 'users', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Your team, per agent', d: 'Resolved, escalated, reopened, response times and where handovers actually happen. Coaching material, not surveillance.', n: 'per agent' },
          { icon: 'bot', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Your AI employees, held to the same bar', d: 'What each employee handled, what it passed to a person and why, and where widening its permissions would take work off the team.', n: 'per employee' },
          { icon: 'message-square-text', bg: '#FBEEE8', ic: '#C4552F', t: 'What customers are asking about', d: 'Subjects grouped automatically and ranked by volume, what changed this week and why, and how those conversations end.', n: 'topics, ranked' },
          { icon: 'trending-up', bg: '#F7F0E2', ic: '#8A6A16', t: 'Where the money is', d: 'Carts recovered, quotes closed, bookings filled, tied to the conversation that caused them. Revenue you can attribute, not estimate.', n: 'attributed' },
          { icon: 'gauge', bg: '#F0EDE7', ic: '#55524C', t: 'The operational basics', d: 'Volume by hour and channel, peaks, backlog and coverage. The argument for answering at night, in your own numbers.', n: 'by hour, by channel' }
        ],
        shotTitle: 'Not how many wrote. What they wrote about.', shotMeta: 'Analytics · Topics',
        shotCaption: 'Subjects grouped automatically and ranked, what changed this week and why, how much of each the AI handled alone, and how those conversations end.',
        shot: '/assets/shots/topics.png',
        callouts: [
          { n: '01', t: 'The ranked causes: subject, volume, and what each one costs you.' },
          { n: '02', t: 'Volume by hour, which is usually the argument for answering overnight.' },
          { n: '03', t: 'Any number opens the conversations behind it, unedited.' }
        ],
        doesTitle: 'What last month told one business', doesNote: 'Real findings from a store doing 3,000 conversations.',
        does: [
          { t: 'People asking for navy towels you do not stock', n: '212' },
          { t: 'Conversations caused by one courier\'s delays', n: '184' },
          { t: 'Sizing questions from two product pages', n: '141' },
          { t: 'Messages that arrived after 18:00', n: '68%' },
          { t: 'Questions your site never answered', n: '23' },
          { t: 'Revenue from conversations that used to wait', n: '₪84,200' }
        ],
        limitTitle: 'What we do not do with the numbers', limitNote: 'Measurement should not become surveillance.',
        limits: [
          { t: 'Score your agents for you', n: 'you decide' },
          { t: 'Hide how a figure was calculated', n: 'never' },
          { t: 'Charge for historical data', n: 'included' },
          { t: 'Lock your data in', n: 'full export' }
        ],
        limitFoot: 'Weekly digest by email or WhatsApp if you would rather not open a dashboard. Three causes, ranked, with what changed since last week.',
        quote: '"It told me 212 people had asked for a colour we do not stock. We stocked it. That report paid for the year."',
        quoteName: 'Maya Levi', quoteRole: 'Founder · linen & bath textiles',
        proof: [{ v: '₪84,200', l: 'in revenue attributed to conversations, last month' }, { v: '3', l: 'fixes that removed a third of all incoming questions' }],
        ctaTitle: 'Find out why your customers write to you.',
        ctaBody: 'Connect your channels and the first report reads your own last month. The ranked causes, the hours, and the questions your site never answered.'
      },

      'feat-employee': {
        name: 'Your new employee', kicker: 'Product · Your new employee', icon: 'user-round-check', bg: '#EAE4FB', ic: '#4B3E8E',
        h1a: 'Hire an AI employee.', h1b: 'It never sleeps, and it costs less.',
        save: {
          kicker: 'What it takes off your desk',
          title: 'One ordinary message, and everything it costs you.',
          note: 'Not a saving we calculated for you. The same request, side by side: what a person does today, and what is left once an AI employee owns it.',
          msg: '"Hi, I ordered the linen set last week in queen. Can I swap it for king, and where is my order?"',
          msgMeta: 'WhatsApp · 22:40',
          manualT: 'Someone on your team does this', manualTag: 'today',
          manual: [
            { n: '01', t: 'Opens the store admin and searches for her by name', where: 'Shopify' },
            { n: '02', t: 'Finds the order and checks what she actually bought', where: 'Shopify' },
            { n: '03', t: 'Opens the courier site and reads the tracking', where: 'courier' },
            { n: '04', t: 'Checks whether an exchange is still inside the policy', where: 'your policy' },
            { n: '05', t: 'Opens the exchange and generates the return label', where: 'Shopify' },
            { n: '06', t: 'Writes the reply, then writes it all into the CRM', where: 'CRM' }
          ],
          manualFoot: 'Six steps, four systems, one reply. Tomorrow morning, because at 22:40 nobody is at a desk.',
          autoT: 'Your AI employee does this', autoTag: 'in one go',
          auto: [
            { t: 'Reads the request and pulls her order from your store', where: 'Shopify', icon: 'check' },
            { t: 'Checks the tracking and the exchange window itself', where: 'courier · policy' , icon: 'check' },
            { t: 'Opens the exchange, sends the label, answers her', where: 'Shopify', icon: 'check' },
            { t: 'Writes the summary and the follow-up into the CRM', where: 'CRM', icon: 'check' },
            { t: 'Asks you first for anything you marked as yours', where: 'approvals', icon: 'hand' }
          ],
          autoFoot: 'She has an answer at 22:41. Your team reads what happened in the morning instead of starting the day behind.',
          sysT: 'It works inside whatever you already run.',
          sysNote: 'Connect a system and it gains real things it can do there. Anything with an API, usually in a week.',
          sys: [
            { t: 'Shopify', logo: 'https://cdn.simpleicons.org/shopify/7AB55C' },
            { t: 'WooCommerce', logo: 'https://cdn.simpleicons.org/woocommerce/96588A' },
            { t: 'HubSpot', logo: 'https://cdn.simpleicons.org/hubspot/FF7A59' },
            { t: 'Airtable', logo: 'https://cdn.simpleicons.org/airtable/18BFFF' },
            { t: 'Zoho', logo: 'https://cdn.simpleicons.org/zoho/E42527' },
            { t: 'monday.com', icon: 'kanban', noLogo: true },
            { t: 'Your ERP', icon: 'server', noLogo: true },
            { t: 'Anything with an API', icon: 'plug', noLogo: true }
          ]
        },
        sub: 'An AI employee takes real responsibility for a part of your operation and works it end to end: reads what was asked, finds the facts in your systems, does the thing, and writes it back. It works nights, weekends and holidays without a break, it makes the day lighter for your human team, and how much it may do on its own is entirely your call.',
        asideHead: 'Why we call it an employee',
        aside: 'Because it has a job description, not a script. You give it a responsibility, the systems it may touch and the line it may not cross. It handles what it is trusted with, brings you what it is not, and gets better at the job the longer it does it.',
        stats: [],
        capsTitle: 'Costs less than a shift. Never takes one off. Works beside the people you already have.',
        capsNote: 'Everything below is a dial you set per employee and per action, from suggest only to fully autonomous. Start cautious, widen it as you watch it work.',
        caps: [
          { icon: 'moon', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Never off shift', d: 'Eleven at night, Saturday, the holidays. It answers in seconds at the hours your customers actually write, and your morning starts with what was handled rather than what is waiting.', n: 'every hour, every day' },
          { icon: 'wallet', bg: '#EDF4E7', ic: '#2E7D5B', t: 'A fraction of the cost', d: 'Priced on the conversations it handles, not a salary, not a seat. It carries the routine volume so a small team can serve like a much larger one.', n: 'no salary, no seat' },
          { icon: 'heart-handshake', bg: '#FBEEE8', ic: '#C4552F', t: 'Makes life easier for your team', d: 'It takes the repetitive questions, the lookups and the back-office writing. Your people keep the conversations that need a human, with the facts already found for them.', n: 'beside your people' },
          { icon: 'zap', bg: '#EDF1F7', ic: '#3E5C99', t: 'End to end, if you want it to', d: 'Find the order, open the return, send the label, update the CRM, tell the customer. Or stop at any of those steps and ask you first. Suggest only, ask me, or do it: your choice, per action.', n: 'you set the line' },
          { icon: 'brain', bg: '#F7F0E2', ic: '#8A6A16', t: 'Knows your business, not the internet', d: 'Every answer comes from your knowledge base: your products, your policies, your past replies. When it is unsure it hands over rather than guessing.', n: 'from your knowledge' },
          { icon: 'users-round', bg: '#F0EDE7', ic: '#55524C', t: 'Hire more than one', d: 'Support, sales, wholesale, bookings. Each employee owns its area, with its own tools and its own permissions, and all of them learn from the same knowledge base.', n: 'a team, not a bot' }
        ],
        shotTitle: 'Your AI employees, and what each one is responsible for.', shotMeta: 'Studio · Employees',
        shotCaption: 'What it handled today, what it resolved alone, what it passed to a person and why, plus exactly what it may do on its own. The same view you would want on any new hire.',
        shot: '/assets/shots/employees.png',
        callouts: [
          { n: '01', t: 'Its job description in plain words, editable by anyone on your team.' },
          { n: '02', t: 'Today\'s work: conversations closed, actions run, decisions escalated.' },
          { n: '03', t: 'Every action traceable to the order, the amount and the rule that allowed it.' }
        ],
        doesTitle: 'A shift, end to end', doesNote: 'One employee on delivery and returns, one month.',
        does: [
          { t: 'Read the question and recognised the customer', n: '3,041' },
          { t: 'Looked up the order and the real tracking', n: '904' },
          { t: 'Refunded, cancelled or opened a return', n: '199' },
          { t: 'Booked, moved or confirmed something', n: '186' },
          { t: 'Wrote back in the customer\'s language', n: 'all of them' },
          { t: 'Handed the conversation to a person', n: '350' }
        ],
        limitTitle: 'It is an employee, not a manager', limitNote: 'The things a new hire would also have to ask about.',
        limits: [
          { t: 'Money above the limit you set', n: 'asks you' },
          { t: 'Anything your policies do not cover', n: 'to a person' },
          { t: 'A customer who is upset or writing again', n: 'to a person' },
          { t: 'Its own scope. It never widens it', n: 'you decide' }
        ],
        limitFoot: 'Give it one responsibility, watch it for a week in watch-only mode, then give it the next one. That is how people onboard, and it works here too.',
        quote: '"We describe it to new staff as the person who does the first ten minutes of every conversation. By the time anyone looks, the work is mostly done."',
        quoteName: 'Tomer Adler', quoteRole: 'Customer lead · four-person team',
        proof: [{ v: '184h', l: 'a month of work it took off a four-person team' }, { v: '₪4,200', l: 'what the evening shift it replaced used to cost' }],
        ctaTitle: 'Put your first one to work this week.',
        ctaBody: 'Start with the one thing you are asked most, keep it in watch-only mode as long as you like, and widen its responsibility once you have read what it would have said.'
      },

      'feat-channels': {
        name: 'Channels', kicker: 'Product · Channels', icon: 'radio', bg: '#EDF4E7', ic: '#2E7D5B',
        h1a: 'Wherever they wrote,', h1b: 'that is where you answer',
        sub: 'WhatsApp on your own number, Instagram, Facebook, TikTok, email, web chat and the phone, connected on official APIs in minutes, with nothing changing for the customer.',
        asideHead: 'What connecting a channel involves',
        aside: 'A sign-in, a permission screen and a verification. No number porting, no new app for your customers, and your history can come with you.',
        stats: [{ v: '8', l: 'channels, one queue' }, { v: '10 min', l: 'to connect WhatsApp and Instagram' }, { v: '100%', l: 'official APIs: no unofficial bridges' }],
        capsTitle: 'Every channel a small business actually gets messages on.',
        capsNote: 'Add them one at a time. Most start with WhatsApp, then Instagram, then quietly stop opening either app.',
        marquee: [
          { t: 'WhatsApp', n: 'your own number', logo: 'https://cdn.simpleicons.org/whatsapp/25D366' },
          { t: 'Instagram', n: 'DMs, story replies, comments', logo: 'https://cdn.simpleicons.org/instagram/E4405F' },
          { t: 'Messenger', n: 'page inbox', logo: 'https://cdn.simpleicons.org/messenger/0084FF' },
          { t: 'Facebook', n: 'posts and comments', logo: 'https://cdn.simpleicons.org/facebook/0866FF' },
          { t: 'Gmail', n: 'your support mailbox', logo: 'https://cdn.simpleicons.org/gmail/EA4335' },
          { t: 'Outlook', n: 'or any IMAP mailbox', logo: 'https://cdn.simpleicons.org/maildotru/0078D4' },
          { t: 'Web chat', n: 'the widget on your site', icon: 'globe', noLogo: true },
          { t: 'Phone', n: 'Call Pilot, in beta', icon: 'phone', noLogo: true }
        ],
        caps: [
          { icon: 'message-circle', bg: '#EDF4E7', ic: '#2E7D5B', t: 'WhatsApp Business API', d: 'Your existing number, kept. Templates, media, read receipts and approved sending, plus your past chats imported on setup.', n: 'keep your number' },
          { icon: 'instagram', bg: '#FBEEE8', ic: '#C4552F', t: 'Instagram, Facebook, TikTok', d: 'DMs, story replies, comments and ad comments. Public replies and private messages handled from the same thread.', n: 'DMs & comments' },
          { icon: 'mail', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Email and web chat', d: 'Your support mailbox threaded onto the same customer, and a site widget that knows the page and the cart in front of it.', n: 'inbox & widget' },
          { icon: 'phone-call', bg: '#EDF1F7', ic: '#3E5C99', t: 'Phone, in beta', d: 'Inbound and outbound calls, transcribed and summarised onto the customer record like any other conversation.', n: 'Call pilot' }
        ],
        shotTitle: 'Channels', shotMeta: 'channels · 6 connected',
        shotCaption: 'What is connected, what it is allowed to answer, and the hours a person covers instead. One row per channel.',
        slot: 'feat-channels-shot', slotHint: 'product screenshot: connected channels list with permissions',
        callouts: [
          { n: '01', t: 'Connect, verify, done, with a test message before it goes live.' },
          { n: '02', t: 'Per-channel rules: what the AI may answer and when a person takes over.' },
          { n: '03', t: 'Every channel lands in one inbox, threaded onto one customer.' }
        ],
        doesTitle: 'What each channel brings in', doesNote: 'One month on a business running six of them.',
        does: [
          { t: 'WhatsApp: the majority of everything', n: '1,840' },
          { t: 'Instagram DMs, story replies and comments', n: '610' },
          { t: 'Facebook and Messenger', n: '188' },
          { t: 'TikTok comments and messages', n: '142' },
          { t: 'Email, threaded to the same person', n: '318' },
          { t: 'Web chat from the site widget', n: '204' }
        ],
        limitTitle: 'What we will not do to a channel', limitNote: 'Nothing that risks your account or your number.',
        limits: [
          { t: 'Unofficial WhatsApp workarounds', n: 'never' },
          { t: 'Bulk sending outside the rules', n: 'never' },
          { t: 'Post as you without your approval', n: 'your setting' },
          { t: 'Move your number away from you', n: 'it stays yours' }
        ],
        limitFoot: 'We are a verified Meta Business Partner, which is why WhatsApp and Instagram connect properly and stay connected.',
        quote: '"Connecting WhatsApp took ten minutes and nothing changed for our customers. They still message the same number they always did."',
        quoteName: 'Tomer Adler', quoteRole: 'Customer lead · four-person team',
        proof: [{ v: '10 min', l: 'from sign-in to answering on WhatsApp' }, { v: '0', l: 'customers who had to change anything' }],
        ctaTitle: 'Connect your first channel this afternoon.',
        ctaBody: 'Start with WhatsApp on your existing number, import the history, and add the rest one at a time once you have watched it work.'
      },

      'feat-integrations': {
        name: 'Integrations', kicker: 'Product · Integrations', icon: 'plug', bg: '#EDF1F7', ic: '#3E5C99',
        h1a: 'A system you connect', h1b: 'becomes something it can do',
        sub: 'Connect Shopify and GOTCHA can look up an order, check stock and issue a refund. Connect your calendar and it can book. Every connection is read and write, and you decide which parts it may use alone.',
        asideHead: 'Why this is the whole difference',
        aside: 'Software that only reads can answer. Software connected properly can finish the job, refund, cancel, reschedule, update, inside the systems where the work actually lives.',
        stats: [{ v: '40+', l: 'systems connected out of the box' }, { v: '7', l: 'actions Shopify alone unlocks' }, { v: 'Any API', l: 'anything else, including your ERP' }],
        capsTitle: 'Commerce, CRM, calendars, and whatever you built yourself.',
        capsNote: 'Connecting takes a sign-in. What it may then do without asking is a table you fill in once.',
        caps: [
          { icon: 'shopping-bag', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Commerce', d: 'Shopify, WooCommerce and returns platforms: orders, tracking, stock, refunds, cancellations, exchanges and customer history.', n: 'Shopify · WooCommerce · returns' },
          { icon: 'database', bg: '#EDF1F7', ic: '#3E5C99', t: 'CRM and business systems', d: 'Zoho, monday.com, HubSpot and ERPs, reads and writes both ways, so a conversation updates the record and the record informs the answer.', n: 'two-way sync' },
          { icon: 'calendar', bg: '#FBEEE8', ic: '#C4552F', t: 'Day to day', d: 'Google Calendar and Calendly for real availability, Drive as a knowledge source, payment links, couriers and delivery tracking.', n: 'calendars · files · payments' },
          { icon: 'code-2', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Anything with an API', d: 'A REST API, webhooks and an event catalogue for the businesses with their own systems and a developer to point at them.', n: 'custom' }
        ],
        shotTitle: 'What GOTCHA can see and change on your behalf.', shotMeta: 'Business systems',
        shotCaption: 'Each connected system, whether it is working, and the actions it unlocks, with allowed, ask first or never beside every one.',
        shot: '/assets/shots/systems.png',
        shotPins: [
          { t: 'Shopify', logo: 'https://cdn.simpleicons.org/shopify/7AB55C', left: '36.18%', top: '25.22%', w: '2.22%', h: '3.56%' },
          { t: 'HubSpot', logo: 'https://cdn.simpleicons.org/hubspot/FF7A59', left: '36.18%', top: '32.67%', w: '2.22%', h: '3.56%' },
          { t: 'Returns platform', icon: 'undo-2', noLogo: true, left: '36.18%', top: '40.11%', w: '2.22%', h: '3.56%' },
          { t: 'Your ERP', icon: 'server', noLogo: true, left: '36.18%', top: '47.56%', w: '2.22%', h: '3.56%' }
        ],
        shotChannelsLabel: 'Systems it connects to',
        shotChannels: [
          { t: 'Shopify', logo: 'https://cdn.simpleicons.org/shopify/7AB55C' },
          { t: 'WooCommerce', logo: 'https://cdn.simpleicons.org/woocommerce/96588A' },
          { t: 'HubSpot', logo: 'https://cdn.simpleicons.org/hubspot/FF7A59' },
          { t: 'Salesforce', icon: 'cloud', noLogo: true },
          { t: 'monday.com', icon: 'kanban', noLogo: true },
          { t: 'Airtable', logo: 'https://cdn.simpleicons.org/airtable/18BFFF' },
          { t: 'Zoho CRM', logo: 'https://cdn.simpleicons.org/zoho/E42527' },
          { t: 'Your ERP', icon: 'server', noLogo: true }
        ],
        callouts: [
          { n: '01', t: 'The actions a system unlocks, listed in plain words rather than endpoints.' },
          { n: '02', t: 'A permission per action, not per integration.' },
          { n: '03', t: 'Every action it runs is logged against the order and the conversation.' }
        ],
        doesTitle: 'What connecting a store unlocks', doesNote: 'The seven Shopify actions, and how often they were used in a month.',
        does: [
          { t: 'Look up an order and its real tracking', n: '904' },
          { t: 'Check stock and search products', n: '612' },
          { t: 'Open a return or an exchange', n: '112' },
          { t: 'Issue a refund within your limit', n: '41' },
          { t: 'Cancel before dispatch', n: '46' },
          { t: 'Update a delivery address', n: '38' }
        ],
        limitTitle: 'How we treat your systems', limitNote: 'Read widely, write only where you allow it.',
        limits: [
          { t: 'Write to a system you did not tick', n: 'never' },
          { t: 'Act outside the limits you set', n: 'never' },
          { t: 'Take an action without logging it', n: 'never' },
          { t: 'Keep a connection after you disconnect it', n: 'revoked instantly' }
        ],
        limitFoot: 'Not on the list? If it has an API, it usually takes us days rather than a quarter, and it becomes a capability everyone else gets too.',
        quote: '"Once it could actually refund and reorder inside our systems, the conversation stopped being a message and started being the work."',
        quoteName: 'Eitan Barzilai', quoteRole: 'Owner · trade & wholesale supplier',
        proof: [{ v: '1,753', l: 'actions run inside customers\' own systems in a month' }, { v: '0', l: 'of them outside the limits that were set' }],
        ctaTitle: 'Connect your store and see what it can suddenly do.',
        ctaBody: 'One sign-in turns lookups, refunds and stock checks into things it can handle alone, and you decide which of them it may do without asking.'
      },

      'feat-social': {
        name: 'Social engagement', kicker: 'Product · Social engagement', icon: 'at-sign', bg: '#EAE4FB', ic: '#4B3E8E',
        h1a: 'Never miss a comment', h1b: 'again',
        sub: 'Comments, story replies, mentions and DMs on Instagram, Facebook and TikTok arrive in the same inbox as everything else, answered publicly where it helps you, and moved into a private conversation where it sells.',
        asideHead: 'On a brand posting four times a week',
        aside: 'Most comments are questions with a price attached: is it in stock, how much, does it ship to me. They are answered by whoever happens to open the app, or not at all.',
        stats: [{ v: '92%', l: 'of comments answered within a minute' }, { v: '34%', l: 'of story replies become a conversation' }, { v: '0', l: 'questions left sitting under a post' }],
        capsTitle: 'Every place people talk to you in public, covered.',
        capsNote: 'It answers in your voice, in the customer\'s language, and it knows when a public reply is the wrong place for the answer.',
        caps: [
          { icon: 'message-square', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Comments and replies', d: 'Post comments, ad comments and reply threads on Instagram, Facebook and TikTok, answered publicly, with the price and the stock correct.', n: 'public replies' },
          { icon: 'send', bg: '#FBEEE8', ic: '#C4552F', t: 'Story replies and mentions', d: 'A reply to a story is the warmest message you get. It answers it, recognises her from her past orders, and keeps the thread going.', n: 'DMs & mentions' },
          { icon: 'arrow-right-left', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Public to private, cleanly', d: '"Sent you the details in a message": an order number, an address or a complaint moves into the DM before anyone types it in public.', n: 'one step' },
          { icon: 'shield', bg: '#EDF1F7', ic: '#3E5C99', t: 'Spam and abuse handled', d: 'Bots and offers hidden, angry comments answered once and taken private, and anything about a person or a claim passed to your team.', n: 'moderation' }
        ],
        flowTitle: 'A comment under a post, all the way to a person.',
        flowNote: 'The same conversation the whole way through. She never repeats herself, and nobody on your team starts from nothing.',
        flow: [
          { where: 'Instagram, in public', tag: 'Comment', logo: 'https://cdn.simpleicons.org/instagram/E4405F',
            kind: 'comment', handle: '@yourbrand', status: 'Post · 2 hours ago',
            postCaption: 'New in: the linen set, now in four colours.', postMeta: '3 comments',
            bubbles: [
              { t: 'Is the beige one back in stock? 😍', side: 'in', who: 'dana.k', when: '2m' },
              { t: 'It is, in every size. Sent you the details in a message.', side: 'out', who: 'yourbrand', when: 'just now' }
            ],
            foot: 'Answered publicly in under a minute, with the stock actually checked. The price and the availability are read live, not guessed.' },
          { where: 'DM, with your AI employee', tag: 'Private', logo: 'https://cdn.simpleicons.org/instagram/E4405F', arrowLabel: 'moves to DM',
            handle: '@dana.k', status: 'Active now',
            bubbles: [
              { t: 'Hi! Beige, size 38 is in stock at ₪249. Want me to hold it for you?', side: 'out' },
              { t: 'Yes please. Can it get here before Friday?', side: 'in' },
              { t: 'Yes, ordered today it arrives Thursday. Shall I put it through?', side: 'out' }
            ],
            foot: 'It recognises her from her last two orders, so the size and the address are already known. Nothing about the order is discussed in public.' },
          { where: 'Maya, on your team', tag: 'Handover', icon: 'user-round', noLogo: true, arrowLabel: 'handed over',
            handle: '@dana.k', status: 'Maya is typing…',
            bubbles: [
              { t: 'Actually I want to swap the one I bought last month for this instead.', side: 'in' },
              { t: 'Of course. I can see the order from March, let me sort the exchange for you.', side: 'agent', who: 'Maya' }
            ],
            foot: 'An exchange needs a person, so it stops and hands over with the whole thread, her order history and what it already checked attached.' }
        ],
        shotTitle: 'Social in the inbox', shotMeta: 'social · 46 open',
        shotCaption: 'The post on one side, the comment thread on the other, and the same customer record you see on every other channel.',
        slot: 'feat-social-shot', slotHint: 'product screenshot: social comments and story replies in the inbox',
        callouts: [
          { n: '01', t: 'The post or story the message came from, attached to the conversation.' },
          { n: '02', t: 'Whether the reply goes out in public or into her DMs, decided per message.' },
          { n: '03', t: 'The same customer history as WhatsApp and email. One person, not one handle.' }
        ],
        doesTitle: 'What one campaign week looks like', doesNote: 'A brand running four posts and two ads on Instagram and TikTok.',
        does: [
          { t: 'Comments answered publicly, with correct prices', n: '1,140' },
          { t: 'Story replies turned into conversations', n: '486' },
          { t: 'Comments moved into a private message', n: '212' },
          { t: 'Orders that started as a comment', n: '84' },
          { t: 'Spam and offer comments hidden', n: '318' },
          { t: 'Repeat customers recognised from their handle', n: '64%' }
        ],
        limitTitle: 'What it will not post in your name', limitNote: 'Public is permanent, so the limits are tighter here.',
        limits: [
          { t: 'Argue with a bad review', n: 'never' },
          { t: 'Discuss an order in public', n: 'moves to DM' },
          { t: 'Answer a crisis or a press comment', n: 'to a person' },
          { t: 'Post anything a policy does not cover', n: 'to a person' }
        ],
        limitFoot: 'You can keep public replies on approval while private ones go out on their own. Most brands do that for the first two weeks.',
        quote: '"Eighty-four orders last week started as a comment under a post. We used to answer those on Sunday, if at all."',
        quoteName: 'Noa Gil', quoteRole: 'Head of brand · skincare & colour',
        proof: [{ v: '84', l: 'orders in one week that began as a public comment' }, { v: '1 min', l: 'from a comment to an answer, day or night' }],
        ctaTitle: 'Answer every comment before the post goes cold.',
        ctaBody: 'Connect Instagram, Facebook and TikTok and it covers comments, story replies and mentions from the first afternoon, with public replies held for your approval until you are ready.'
      },

      'feat-broadcast': {
        name: 'WhatsApp broadcast', kicker: 'Product · WhatsApp broadcast', icon: 'megaphone', bg: '#EDF4E7', ic: '#2E7D5B',
        h1a: 'Send to thousands.', h1b: 'Answer every reply that comes back.',
        sub: 'Restocks, launches, price lists and reminders sent from your own WhatsApp number on the official Business Platform. The difference is what happens next: every reply lands in the inbox, and your AI employees answer, check stock and take the order without you opening the phone.',
        shot: '/assets/shots/outreach.png',
        shotTitle: 'Every campaign, and who is answering it.', shotMeta: 'outreach · 2 in flight',
        shotCaption: 'One screen for what is sending, what is waiting for your approval and what finished, with the audience, the exact message and the reply rules on the right.',
        callouts: [
          { n: '01', t: 'Sending, scheduled, waiting on you or finished, on one list.' },
          { n: '02', t: 'The audience built from your own orders and past conversations.' },
          { n: '03', t: 'The exact message you are sending, before it goes out.' },
          { n: '04', t: 'Who answers the replies, and when it hands over to a person.' }
        ],
        ctaTitle: 'Send the campaign. Let it answer the replies.',
        ctaBody: 'Connect your WhatsApp number and your store, and the first campaign can go out this week: your segment, your approved template, and your AI employees handling everything that comes back.'
      },

      'feat-widget': {
        name: 'Store widget', kicker: 'Product · Store widget', icon: 'shopping-cart', bg: '#FBEEE8', ic: '#C4552F',
        h1a: 'The widget on your store', h1b: 'that actually sells',
        sub: 'A chat window that knows your catalogue, your stock and the cart in front of it. The AI employee answers first, straight away, and works the sale: the question standing between someone and buying, answered in seconds. And at any moment you can take the conversation into your own hands.',
        asideHead: 'Built for online stores',
        aside: 'Installs on Shopify or WooCommerce in one click, matches your typography and colours, and works on the product page, the cart and the checkout.',
        stats: [{ v: '₪12,400', l: 'carts recovered monthly, average store' }, { v: '31%', l: 'of chats on a product page end in an order' }, { v: '2s', l: 'to answer a sizing question' }],
        capsTitle: 'It sells the way a good shop assistant sells.',
        capsNote: 'Not a pop-up begging for an email. A person on the shop floor who knows the stock and does not follow you around.',
        caps: [
          { icon: 'shopping-cart', bg: '#FBEEE8', ic: '#C4552F', t: 'Knows the page and the cart', d: 'Which product she is looking at, which variant, what is already in her basket and whether it is in stock in her size.', n: 'live context' },
          { icon: 'ruler', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Answers the buying question', d: 'Size, fit, care, materials, delivery date to her city, whether it arrives before Friday, from your own product copy, in two seconds.', n: 'from your catalogue' },
          { icon: 'sparkles', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Suggests, and completes', d: 'The matching item, the right size when hers is out, and a payment link so the order finishes in the chat rather than the checkout.', n: 'order in chat' },
          { icon: 'undo-2', bg: '#F7F0E2', ic: '#8A6A16', t: 'Catches the leaving cart', d: 'When she hesitates it asks one useful question, not a discount reflex. If she leaves, the conversation continues on WhatsApp with her consent.', n: 'one nudge, not five' },
          { icon: 'hand', bg: '#EDF1F7', ic: '#3E5C99', t: 'Take it over whenever you want', d: 'The AI employee opens the conversation and pushes the sale forward. The second anyone on your team starts typing it steps back, and it can be handed back just as easily.', n: 'you, any moment' }
        ],
        shotTitle: 'The widget on a product page', shotMeta: 'widget · product page',
        shotCaption: 'Your fonts, your colours, your language, with the product, the variant and the stock already in the conversation.',
        slot: 'feat-widget-shot', slotHint: 'product screenshot: store page with the chat widget open on a product',
        callouts: [
          { n: '01', t: 'The product she is on, attached to the conversation without her saying so.' },
          { n: '02', t: 'A real delivery date for her address, not "3-5 business days".' },
          { n: '03', t: 'Add to cart and pay inside the chat, then the thread continues on WhatsApp.' }
        ],
        doesTitle: 'What it does on a store doing ₪400k a month', doesNote: 'One month, widget only. The other channels are counted separately.',
        does: [
          { t: 'Product, sizing and stock questions answered', n: '1,204' },
          { t: 'Real delivery dates given for a specific address', n: '486' },
          { t: 'Chats on a product page that ended in an order', n: '31%' },
          { t: 'Carts recovered before she left the page', n: '₪12,400' },
          { t: 'Orders completed inside the conversation', n: '86' },
          { t: 'Conversations continued on WhatsApp after she left', n: '212' }
        ],
        limitTitle: 'What it will not do to your visitors', limitNote: 'Nothing that makes your store feel cheap.',
        limits: [
          { t: 'Open by itself and interrupt', n: 'your setting' },
          { t: 'Discount to close a sale', n: 'only if you allow it' },
          { t: 'Promise a delivery date it cannot check', n: 'never' },
          { t: 'Claim stock it has not verified', n: 'never' }
        ],
        limitFoot: 'You control when it appears, on which pages, in which languages, and whether it may offer anything at all beyond an answer.',
        quote: '"It answered a sizing question at midnight and she bought ₪740 of towels eleven minutes later. That was the whole sale."',
        quoteName: 'Shira Nave', quoteRole: 'Ecommerce manager · Aviv & Co.',
        proof: [{ v: '31%', l: 'of product-page conversations end in an order' }, { v: '₪12,400', l: 'a month in carts that would have gone quiet' }],
        ctaTitle: 'Put it on your store and watch one week.',
        ctaBody: 'One click on Shopify, your own fonts and colours, and a report at the end of the week telling you what it answered and what it sold.'
      }
    };

    const BLOG = {
      kicker: 'Journal', h1a: 'What we learn from', h1b: 'other people\'s inboxes',
      sub: 'Notes on customer conversations, on AI that takes actions rather than only replying, and on the operational detail behind good service. Written by the two of us, between building it.',
      cadence: 'We write when we have something worth saying. No newsletter tricks, no gated PDFs.',
      cats: ['All', 'Operations', 'AI in practice', 'Product', 'Service'],
      posts: [
        { tag: 'Operations', t: 'The shift nobody works', d: 'Your customers write in the evening, on the sofa, with the phone in one hand. That is exactly when the business is closed and nobody is reading.', when: 'Journal', read: '5 min', by: 'Matan', hero: '/assets/shots/inbox.png',
          body: [
            'Ask any small business owner when the messages arrive and you get the same answer: at night. Not because customers are nocturnal, but because that is the first moment of the day when someone sits down and finally deals with the thing they meant to deal with. The order that has not arrived. The size they were unsure about. The gift they need by Friday.',
            'The business is closed. The owner is either asleep or has the phone face-down on purpose. So the message waits. By the morning it is one of eleven, and the customer who wrote it has already had time to look elsewhere.',
            'The usual answer to this is a chatbot that says someone will get back to you during business hours, which is a polite way of saying nothing happened. The customer already knew that. What they wanted was the answer.',
            'The whole point of an AI employee is that the evening shift stops being empty. Not with a canned reply, but with the actual answer: this is where your order is, yes it comes in king, here is the exchange, it is done. The owner reads what happened in the morning instead of starting the day behind.'
          ] },
        { tag: 'AI in practice', t: 'Answering is easy. Acting is the job.', d: 'A model that writes a reply solves the smallest part of the problem. The work is checking the order, reading the policy and actually doing the thing.', when: 'Journal', read: '6 min', by: 'Omer',
          body: [
            'Writing a plausible reply to a customer is close to free now. Any decent model does it. That is why every tool on the market can do it, and why none of it changed how much work the business actually has.',
            'Look at what a real reply takes. Someone opens the store admin and finds the order. Opens the courier site and reads the tracking. Remembers, or looks up, what the returns policy says. Decides whether this case is inside it. Then writes three sentences. The three sentences are the last ten percent.',
            'So the interesting question is not whether software can write the sentences. It is whether it can do the ninety percent before them, and then carry out what it just promised: open the exchange, send the label, update the record, so nobody has to go and do it afterwards.',
            'That is also where the responsibility appears. Text is reversible. Actions are not, or not always. Which is why acting has to come with limits, and with a log of everything it did, before it comes with any speed.'
          ] },
        { tag: 'Product', t: 'Do it, ask me, never', d: 'The permission table is the product. Everything else follows from where you decide to put each line.', when: 'Journal', read: '5 min', by: 'Omer',
          body: [
            'The first question every business asks is not how good the AI is. It is what happens when it is wrong about money. That is the right question, and the honest answer is not a promise about accuracy. It is a setting.',
            'Every action GOTCHA can take has three positions: do it, ask me first, or never. Look up an order: do it. Refund below the amount you chose: do it. Refund above it: ask me. Cancel a subscription: maybe never, if that is how you feel about it.',
            'We ship the defaults conservative on purpose. Most people start with everything on ask me, watch a week of decisions go by, and then move the lines themselves once they can see what it would have done. Trust that arrives that way tends to stay.',
            'The part people do not expect is how much it reveals about the business itself. Deciding what software may do alone forces you to write down what you actually allow, which most small businesses have never put into words.'
          ] },
        { tag: 'Service', t: 'Your customer does not know which channel they used', d: 'They wrote on WhatsApp, then on Instagram, then sent an email. To them it is one conversation. To most businesses it is three strangers.', when: 'Journal', read: '4 min', by: 'Matan',
          body: [
            'Nobody thinks in channels. Someone messages you where they happen to be standing: the DM because they were looking at your post, WhatsApp because that is where their thumb is, email because they got no answer and are now being formal about it.',
            'On the business side those arrive in three different places, usually in front of three different people, and each of them starts from nothing. The customer repeats the story every time, which is the fastest way to make a mildly annoyed person genuinely angry.',
            'Merging them is not a UI nicety. It is the difference between "sorry, which order was this?" and "I can see you wrote about this last night, it has been sorted".',
            'Once the conversation is one thing, everything after it gets simpler: one history, one customer record, one place where whatever you promised is written down.'
          ] },
        { tag: 'AI in practice', t: 'It should say "I do not know" more often than it is wrong', d: 'Escalation is a feature, not a failure. The systems worth trusting are the ones that stop rather than guess.', when: 'Journal', read: '5 min', by: 'Omer',
          body: [
            'There is a temptation to measure an AI employee by how much it handles alone, and to push that number up. It is the wrong thing to optimise first. A system that answers everything is a system that occasionally invents a policy you do not have.',
            'We would rather it stopped. If your sources disagree, or the answer is not in them, it says it will check with the team and passes the conversation to a person, with what it already found attached.',
            'That has a useful side effect: the questions it could not answer become a list. Each one is a hole in what your business has actually written down somewhere. Answer it once and every AI employee has it from then on.',
            'The measure we care about is not messages answered. It is decisions that no longer need you, with nothing embarrassing sent in your name along the way.'
          ] },
        { tag: 'Service', t: 'What a good handover looks like', d: 'The moment software passes a conversation to a person is where most tools quietly ruin the experience.', when: 'Journal', read: '4 min', by: 'Matan',
          body: [
            'Every automated system hands over eventually. The question is what the person receives when it does. Usually it is a transcript and a shrug: here, you deal with it.',
            'A good handover arrives with the work already done. Who is writing, what they bought, what they asked before, what the AI checked, and what it thinks the issue is. The agent reads for a few seconds instead of starting an investigation.',
            'It also has to be instant in the other direction. The moment a person starts typing, the AI stops. Nothing is worse for a customer than two voices answering the same question differently.',
            'Handovers are not the embarrassing part of an AI system. They are where it either respects your team\'s time or wastes it.'
          ] }
      ]
    };

    const ABOUT = {
      kicker: 'About us', h1a: 'It started with', h1b: 'one unanswered message',
      sub: 'GOTCHA is built for the businesses where the owner is also the support team, where a message that waited until morning is a customer who bought somewhere else.',
      asideHead: 'In one sentence',
      aside: 'A working layer that connects your customers, your team and your business systems, and uses AI to understand a request, find the facts, take the action and finish the job.',
      stats: [{ v: 'Ramat Gan', l: 'where we build it' }, { v: 'HE / EN', l: 'both languages, every channel' }, { v: 'Founder-led', l: 'we answer our own support' }],
      storyTitle: 'Twenty years of knowing each other, and one unanswered message.',
      story: [
        'We have known each other since we were five, which is more than twenty years of arguing about how things should work. Omer went the technical way: a classified military unit, then a computer science degree. Matan went the business way: five years running the family business, doing the marketing, the service and the sales himself, and a degree in business administration.',
        'That is also where the problem came from. One of us was answering WhatsApp at eleven at night, retyping the same delivery answer, with the courier site open in one tab and Shopify in another. Not short of software. Short of someone who had already done the reading.',
        'Every tool we looked at either replied without knowing anything, or knew everything and did nothing. Both leave the actual work, checking the order, reading the policy, deciding whether a refund is allowed, with the one person who has no time. So in early 2026, between stretches of reserve duty, we started building the opposite: something that reads your own business, knows which customer is writing, takes the action inside your systems, and stops precisely where you told it to stop.'
      ],
      qKicker: 'The question everyone asks first',
      qTitle: 'So what is GOTCHA?',
      qAnswer: 'One AI platform for everything your customers send you. It merges every channel into a single inbox, and adds an AI employee and a copilot that do not just talk: they read the request, find the facts in your own systems, carry out the action, and write it all back as customer intelligence in your CRM. Your team stays in charge, and decides how much of that happens without them.',
      qPoints: [
        { icon: 'inbox', t: 'One inbox, every channel', d: 'WhatsApp, Instagram, Messenger, email, web chat and phone, with one history per customer.' },
        { icon: 'user-round-check', t: 'An AI employee, not a chatbot', d: 'It works a request end to end inside your systems, and hands over to a person when it should.' },
        { icon: 'square-pen', t: 'A copilot beside your team', d: 'The whole customer on one screen, with the next action already prepared.' },
        { icon: 'sliders-horizontal', t: 'You set the limits', d: 'Do it, ask me first, or never. Per action, decided by you.' }
      ],
      visionKicker: 'Our vision',
      visionTitle: 'Every business should answer like its best person, at any hour, without hiring one more.',
      vision: [
        'A small business loses customers for one reason more than any other: nobody got to the message in time. Not a lack of care, and not a lack of software. A lack of hours in the day.',
        'We think the answer is not another dashboard for a person to work in, but a layer that does the reading and the doing itself: knows your products and your policies, recognises the person writing, acts inside the systems you already pay for, and stops exactly where you told it to stop.',
        'The goal is not to remove people from service. It is to give a four-person business the reach of a forty-person one, and to give the four people back their evenings.'
      ],
      painsKicker: 'Why we built it',
      painsTitle: 'Three kinds of pain, in the same broken conversation.',
      painsNote: 'Everything in the product exists because of one of these. If a feature does not answer one of them, it does not ship.',
      pains: [
        { t: 'The customer', who: 'Customer pain', icon: 'user-round', bg: '#FBEEE8', ic: '#C4552F',
          items: [
            'Long waits and slow replies, for a question that takes seconds to answer',
            'Repeating the whole story again with every new agent or channel, because nothing carries over',
            'Feeling like a ticket number rather than a person, and sometimes getting no answer at all',
            'Not trusting the bot in front of them, because it has been confidently wrong before'
          ],
          fix: 'One conversation that remembers, answers in seconds, and says "let me check" instead of guessing.' },
        { t: 'The team', who: 'Employee pain', icon: 'users-round', bg: '#EDF1F7', ic: '#3E5C99',
          items: [
            'Volume and fragmentation: too many requests across too many systems',
            'Every conversation ending in manual work, documenting, transcribing and summarising',
            'Customer information scattered, so nobody has the full picture before they reply',
            'Constant context switching between tools, tabs and apps to answer one question'
          ],
          fix: 'The reading and the writing done for them, on one screen, with the next action already drafted.' },
        { t: 'The business', who: 'Business & management pain', icon: 'trending-up', bg: '#EDF4E7', ic: '#2E7D5B',
          items: [
            'Slow replies cooling expensive leads, and closing rates falling with them',
            'A broken service experience pushing existing customers to churn',
            'No real-time picture of the team or the pipeline, so managing turns into guessing',
            'Customer data that is never updated automatically, and stops being useful'
          ],
          fix: 'Answers within seconds at any hour, every conversation summarised into the CRM, and one place to see it all.' },
      ],
      foundersTitle: 'Who is behind it',
      foundersNote: 'Two founders who have known each other since they were five. One came from the business side, one from the technical side, and between reserve duty in early 2026 they started GOTCHA.',
      founders: [
        { in: 'M', img: '/assets/team/founder-1.png', n: 'Matan Amran', r: 'Co-founder · business', d: 'Ran the family business for the last five years, mostly marketing, service and sales, so he has answered the messages this product answers. BA in business administration. Still takes support conversations most weeks, which is where the roadmap comes from.' },
        { in: 'O', img: '/assets/team/founder-2.jpg', n: 'Omer Serruya', r: 'Co-founder · technology', d: 'Comes from a technological background: a graduate of a classified military unit and a BSc in computer science. Owns the engineering and the AI layer, and the rule that the system stops rather than guesses.' }
      ],
      timelineTitle: 'How it got here',
      timeline: [
        { y: 'Age 5', t: 'We meet', d: 'Two kids who would spend the next twenty years arguing about how things should work.' },
        { y: 'Before', t: 'Two different schools', d: 'Omer: a classified military unit, then computer science. Matan: five years running the family business, marketing, service and sales.' },
        { y: 'Early 2026', t: 'GOTCHA starts', d: 'Founded between stretches of reserve duty, from a problem one of us was living every night.' },
        { y: 'Now', t: 'Answering, and acting', d: 'Every channel in one inbox, an AI employee that takes real actions, and a permission table that decides how far it goes.' }
      ],
      ctaTitle: 'Come and take it apart.',
      ctaBody: 'Connect a channel and watch it work on your own conversations for a week before you decide anything. That is how we would want to be sold to.'
    };

    const CAREERS = {
      kicker: 'Careers', h1a: 'Small team,', h1b: 'unreasonable standards',
      sub: 'A founder-led team in Ramat Gan building something businesses trust with their customers and their money. Everyone here talks to customers, including the engineers.',
      asideHead: 'How we work',
      aside: 'In the office four days a week because the product is still being figured out. Ship weekly, own an area end to end, and answer real support conversations at least one day a month.',
      stats: [{ v: 'None', l: 'open roles right now' }, { v: 'One office', l: 'Israel, Ramat Gan' }, { v: 'Always', l: 'reading what comes in' }],
      valuesTitle: 'What we care about',
      values: [
        { icon: 'headphones', bg: '#EDF4E7', ic: '#2E7D5B', t: 'The customer is the whole job', d: 'Everyone here reads real conversations, whatever their title. It is the fastest way to know whether what we shipped is any good.' },
        { icon: 'shield-check', bg: '#EDF1F7', ic: '#3E5C99', t: 'Trust before automation', d: 'We hold the most sensitive thing a business has: what its customers say to it. Nothing acts beyond the limits the business set, and every action is in the log.' },
        { icon: 'scale', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Say what is true', d: 'No invented numbers, no gated PDFs, no promises the product cannot keep. If we do not know, we say so and go and find out.' },
        { icon: 'zap', bg: '#FBEEE8', ic: '#C4552F', t: 'Ship it, own it', d: 'Small team, no committees. You get a problem, the customers who have it, and the authority to decide how it gets solved.' }
      ],
      rolesTitle: 'No open roles right now', rolesNote: 'We are not hiring at the moment. If you think you belong here anyway, leave your details: we read everything that comes in and we come back to people when a role opens.',
      formFields: [
        { l: 'Your name', p: 'first and last' },
        { l: 'Email or WhatsApp', p: 'however you prefer to be reached' },
        { l: 'What you would want to own here', p: 'engineering, design, customers, sales…' },
        { l: 'Something that shows your work', p: 'a link: GitHub, portfolio, a product you built' }
      ],
      formNote: 'A person reads it, and you get an answer either way. We keep details on file for a year unless you ask us not to.',
      writeBack: [
        'Something you actually built, shipped and can talk about honestly.',
        'A clear line on what you want to own, not a list of everything you can do.',
        'Comfort with talking to customers, whatever the role.',
        'Ramat Gan, four days a week in the office.'
      ],
      benefitsTitle: 'The practical parts', benefitsNote: 'What we can put in writing.',
      benefits: [
        { t: 'Meaningful equity, explained in plain numbers', n: 'all roles' },
        { t: 'Four days in the office, one wherever you like', n: 'hybrid' },
        { t: 'The hardware and software you ask for', n: 'no forms' },
        { t: 'Lunch in the office and a stocked kitchen', n: 'daily' },
        { t: 'Learning budget you do not have to justify', n: '₪6,000 / yr' },
        { t: 'Two weeks paid leave beyond the statutory minimum', n: 'plus holidays' }
      ],
      processTitle: 'The process', processNote: 'Two weeks, four conversations, no take-home marathon.',
      process: [
        { t: '30 minutes with a founder: what we are building and what you want', n: 'week 1' },
        { t: 'A working session on a real problem from our backlog', n: 'week 1' },
        { t: 'Two conversations with the people you would work beside', n: 'week 2' },
        { t: 'An offer, or a straight answer about why not', n: 'week 2' }
      ],
      ctaTitle: 'No open role, but you still want in?',
      ctaBody: 'Write to us anyway. Tell us what you would want to own and show us something you have built. We read all of it, and we answer.'
    };

    const SECURITY = {
      kicker: 'Security', h1a: 'Your customers\' conversations', h1b: 'are not our product',
      sub: 'GOTCHA holds the most sensitive thing a business has: what its customers say to it. Here is where that data lives, who can reach it, what the AI does with it, and what we will never do.',
      asideHead: 'Published, not on request',
      aside: 'How we hold your data, our sub-processors and our retention periods are public. If a security page only exists as a PDF after you sign an NDA, that tells you something.',
      stats: [{ v: 'GDPR', l: 'aligned, DPA on request' }, { v: 'Encrypted', l: 'in transit and at rest' }, { v: 'Meta', l: 'verified business partner' }],
      badges: [
        { t: 'GDPR aligned', icon: 'file-check', ic: '#3E5C99' },
        { t: 'Encrypted in transit and at rest', icon: 'lock', ic: '#7A6A4F' },
        { t: 'Role-based access', icon: 'shield-check', ic: '#2E7D5B' },
        { t: 'Meta Business Partner', icon: 'badge-check', ic: '#3E5C99' }
      ],
      postureTitle: 'How the platform is built',
      posture: [
        { icon: 'lock', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Encrypted, in transit and at rest', d: 'TLS 1.3 on every connection, AES-256 at rest, keys managed and rotated by our cloud provider\'s key service.', n: 'AES-256 · TLS 1.3' },
        { icon: 'server', bg: '#EDF1F7', ic: '#3E5C99', t: 'Isolation per business', d: 'Every business\'s data is logically separated and queried through a tenant boundary. Backups are encrypted and restore-tested quarterly.', n: 'EU / IL regions' },
        { icon: 'users-round', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Least privilege, everywhere', d: 'Role-based access inside your account, two-step sign-in, and named-employee access on our side only with your ticket and an expiry.', n: 'audited access' },
        { icon: 'brain', bg: '#EAE4FB', ic: '#4B3E8E', t: 'What the AI does with it', d: 'Your conversations are used to answer your customers, and nothing else. They are never used to train models for anyone, and no model provider we use may retain them.', n: 'no cross-training' }
      ],
      factsTitle: 'The specifics', factsNote: 'The answers your IT person will ask for.',
      facts: [
        { t: 'Where data is stored', n: 'EU or Israel, your choice' },
        { t: 'Encryption', n: 'AES-256 at rest, TLS 1.3 in transit' },
        { t: 'Conversation retention', n: 'your setting, 30 days to unlimited' },
        { t: 'Deletion on request', n: 'end to end within 30 days' },
        { t: 'Backups', n: 'encrypted, daily, restore-tested' },
        { t: 'Penetration testing', n: 'annual, third party, summary on request' },
        { t: 'Sub-processors', n: 'published list, notice before changes' },
        { t: 'Data export', n: 'full, any time, one click' }
      ],
      neverTitle: 'What we never do', neverNote: 'Commitments, not intentions.',
      nevers: [
        { t: 'Train models for other customers on your data', n: 'never' },
        { t: 'Sell or share customer data with advertisers', n: 'never' },
        { t: 'Access your conversations without a ticket from you', n: 'never' },
        { t: 'Hold your data hostage if you leave', n: 'full export' }
      ],
      neverFoot: 'A DPA is available on any plan, signed as standard rather than as an enterprise upgrade. Report a vulnerability to security@gotcha.co.il and you will hear back the same working day.',
      ctaTitle: 'Send us your security questionnaire.',
      ctaBody: 'We answer them ourselves, usually within two working days, and we will tell you plainly where we do not yet meet a requirement rather than wording around it.'
    };

    const CHAT = {
      kicker: "Let's chat", h1a: 'Talk to someone', h1b: 'who knows the product',
      sub: 'No qualification call, no discovery framework. Twenty minutes with a person who will open GOTCHA on your real channels and tell you honestly whether it is worth your money.',
      asideHead: 'What happens on the call',
      aside: 'We look at where your conversations arrive, what people ask you, and which systems you use. You leave with a straight answer and a number, even if the answer is not yet.',
      stats: [{ v: '20 min', l: 'the whole conversation' }, { v: 'Same day', l: 'we usually reply within two hours' }, { v: 'No deck', l: 'we open the product instead' }],
      waysTitle: 'Pick whichever suits you',
      ways: [
        { icon: 'calendar', bg: '#FBEEE8', ic: '#C4552F', t: 'Book twenty minutes', d: 'Screen shared, your channels open, your real questions. A founder joins for anything over 5,000 conversations a month.', n: 'this week', cta: 'Pick a time', href: 'https://calendar.app.google/Fv9DCtUycjqSV3a77' },
        { icon: 'mail', bg: '#EDF1F7', ic: '#3E5C99', t: 'Email us', d: 'support@gotcha.co.il, for security questionnaires, partnerships and anything that needs writing down.', n: 'within 2 hours', cta: 'Write to us', href: 'mailto:support@gotcha.co.il' }
      ],
      formTitle: 'Leave your details',
      formNote: 'Four fields, and we get back to you today or tomorrow with a real answer.',
      fields: [
        { l: 'Your name', p: 'Dana Cohen' },
        { l: 'Business name or website', p: 'aviv-textiles.co.il' },
        { l: 'Where do your customers write to you?', p: 'WhatsApp, Instagram, email' },
        { l: 'What would you want it to handle first?', p: 'Delivery questions and returns' }
      ],
      submit: 'Leave your details',
      formFoot: 'We do not add you to a list, and nothing is charged or installed until you say so.',
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

    const WHY = (() => {
      const M = {
        yes: { icon: 'check', markBg: '#EDF4E7', markFg: '#2E7D5B', fg: '#3A3833', bg: 'transparent' },
        no: { icon: 'x', markBg: '#F5F2EC', markFg: '#A29B8E', fg: '#A29B8E', bg: 'transparent' },
        part: { icon: 'minus', markBg: '#F7F0E2', markFg: '#8A6A16', fg: '#6B5A24', bg: 'transparent' },
        us: { icon: 'check', markBg: '#A8C57A', markFg: '#16150F', fg: '#16150F', bg: '#F5F7EF' }
      };
      const cell = (m, note) => Object.assign({ note }, M[m]);
      const row = (k, a, b, c, d) => ({ k, cells: [cell(a[0], a[1]), cell(b[0], b[1]), cell(c[0], c[1]), cell(d[0] === 'yes' ? 'us' : d[0], d[1])] });
      return {
        kicker: 'Why us', h1a: 'Most tools reply.', h1b: 'We take the whole thing, end to end.',
        sub: 'From the first message a customer sends to the action that closes it: GOTCHA merges every channel, looks up the order, reads your policy, carries out the action inside your systems and writes it back, then stops exactly where you told it to. Built for small and growing businesses, from a one-man show to a team of agents under load, not for enterprise contact centres.',
        duelLabel: 'The same message at 22:41. Three tools. One outcome.', duelMeta: 'Dana · WhatsApp · 22:41 · nobody on your team awake',
        duelMsg: 'Third time I am writing. Where is my order? It was a gift and the date has passed.',
        duel: [
          { t: 'A website chatbot', icon: 'bot', time: '22:41 · instant', reply: 'I\'m sorry to hear that! Orders usually arrive within 3 to 5 business days. Is there anything else I can help you with today?', verdict: 'Knows nothing about her order. She writes a fourth time.', verdictIcon: 'x',
            bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#A29B8E', iconBg: '#F5F2EC', iconFg: '#8E887C', bubbleBg: '#F5F2EC', verdictFg: '#8E887C', shadow: 'none', lift: 'none' },
          { t: 'A helpdesk with AI', icon: 'ticket', time: '22:41 · instant', reply: 'Thanks for reaching out. Ticket #4821 has been created and an agent will get back to you within one business day.', verdict: 'Waits for a person. She reads it at 09:15, after leaving a review.', verdictIcon: 'minus',
            bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#A29B8E', iconBg: '#F5F2EC', iconFg: '#8E887C', bubbleBg: '#F5F2EC', verdictFg: '#8A6A16', shadow: 'none', lift: 'none' },
          { t: 'GOTCHA', icon: 'sparkles', time: '22:41 · 19 seconds', trace: 'found #1842 · carrier stalled since Tue · policy read · limit ₪200 · 6 previous orders', reply: 'I am sorry Dana, this is on us. #1842 has been stuck with the carrier since Tuesday. I have refunded the full ₪179 and can hold a king from tomorrow\'s batch.', verdict: 'Order found, refund done, logged with the amount. Closed at 22:41.', verdictIcon: 'check-check',
            bg: '#16150F', bd: '#16150F', fg: '#F7F5F1', muted: '#8E8A83', iconBg: '#A8C57A', iconFg: '#16150F', bubbleBg: '#262521', verdictFg: '#A8C57A', shadow: '0 30px 70px rgba(22,21,15,.22)', lift: 'translateY(-6px)' }
        ],
        numbers: [
          { v: 88, sfx: '%', l: 'of conversations answered and closed without a person', src: 'median across 400+ businesses' },
          { v: 19, sfx: 's', l: 'average first reply, at 14:00 and at 02:00', src: 'last 30 days, all channels' },
          { v: 184, sfx: 'h', l: 'a month a four-person team stopped spending on lookups', src: 'Aviv & Co., measured' },
          { v: 1753, sfx: '', l: 'actions a month carried out inside customers\' own systems', src: 'refunds, changes, bookings' }
        ],
        fitsKicker: 'Who it is for',
        fitsTitle: 'Small and growing businesses. Whoever is currently answering the phone.',
        fitsNote: 'The whole conversation is handled end to end: it arrives, it gets answered, the action is carried out in your systems, and it is written back against the customer.',
        fits: [
          { icon: 'user-round', bg: '#FBEEE8', ic: '#C4552F', t: 'A one-man show', n: 'you are the support team',
            d: 'You answer WhatsApp between doing the actual work. GOTCHA takes the routine end to end and brings you only the decisions that are genuinely yours.' },
          { icon: 'users-round', bg: '#EDF4E7', ic: '#2E7D5B', t: 'A small team', n: 'two to ten people',
            d: 'Everyone sees the same conversation, the same customer and the same history. No handovers by screenshot, no two people answering the same message differently.' },
          { icon: 'headphones', bg: '#EDF1F7', ic: '#3E5C99', t: 'Several agents under load', n: 'a real service desk',
            d: 'The routine volume is handled before it reaches anyone. Your agents keep the conversations that need judgement, with the lookup already done for them.' }
        ],
        fitsFoot: 'What we are not: an enterprise contact-centre platform with workforce planning and a six-month rollout. If that is what you need, we will say so on the first call.',
        humanKicker: 'People stay',
        humanTitle: 'Customers will always want a person. So we built the AI to work beside yours, not instead of them.',
        humanBody: 'We do not believe in a business with nobody home. Some conversations need a human being, and the ones that do should reach one fast, with everything already looked up. How much the AI employees do on their own is your call, per action, and you can move that line any day.',
        levels: [
          { n: 'Level 01', t: 'Suggest only', dot: '#8E887C', who: 'a person sends everything',
            d: 'The AI employee drafts, finds the order and quotes your policy. Nothing reaches a customer until someone on your team presses send.' },
          { n: 'Level 02', t: 'Ask me first', dot: '#E0B341', who: 'human in the loop',
            d: 'It answers and prepares the action, then waits for approval on anything you flagged: refunds, discounts, anything above the amount you chose.' },
          { n: 'Level 03', t: 'Fully autonomous', dot: '#A8C57A', who: 'inside your limits',
            d: 'For the routine you have already watched it handle. It answers and acts on its own, logs everything, and still hands over the moment it is unsure.' }
        ],
        beside: [
          { icon: 'square-pen', t: 'Copilot sits with your agents', d: 'When a person takes the conversation, the order, the history and the policy are already on screen, with a few ways to answer and what each one costs.' },
          { icon: 'phone-call', t: 'Call pilot stays on the line', d: 'On the phone it transcribes, finds the caller and loads the actions, while your person does the talking.' },
          { icon: 'hand', t: 'Anyone can take over, instantly', d: 'The AI stops mid-conversation the moment a person starts typing, and hands back when they are done. No two voices answering the same question.' }
        ],
        reasonsTitle: 'Four reasons customers give when they explain the decision.',
        reasonsNote: 'Not a feature list. These are the things people say on the first call when we ask why they switched.',
        reasons: [
          { n2: '01', icon: 'zap', bg: '#FBEEE8', ic: '#C4552F', n: 'acts, not answers', t: 'It finishes the task, inside your systems.', d: 'Refunds, cancellations, exchanges, bookings and address changes are carried out in Shopify, your CRM or your calendar, then logged against the order. Nobody copies anything into another tab.',
            proofLabel: 'Last month, one customer', proof: [ { k: 'Refunds completed alone', v: '412', c: '#2E7D5B' }, { k: 'Addresses changed before shipping', v: '96', c: '#2E7D5B' }, { k: 'Meetings booked in the calendar', v: '138', c: '#2E7D5B' } ] },
          { n2: '02', icon: 'sliders-horizontal', bg: '#EDF4E7', ic: '#2E7D5B', n: 'your limits', t: 'You draw the line, one action at a time.', d: 'Do it, ask me, or never. Nothing about money is decided by us, everything with money attached is reversible for a stated window, and you can widen a limit only after watching it work.',
            proofLabel: 'How most shops start', proof: [ { k: 'Look up an order, check stock', v: 'do it', c: '#2E7D5B' }, { k: 'Refund up to ₪200', v: 'do it · above: ask', c: '#8A6A16' }, { k: 'Change customer details', v: 'never', c: '#7A6A4F' } ] },
          { n2: '03', icon: 'shield', bg: '#EDF1F7', ic: '#3E5C99', n: 'no invented answers', t: 'It would rather stop than guess.', d: 'Answers come only from your own pages, documents and past replies. When two of your sources disagree it shows you both instead of picking one, and when it is unsure it hands over.',
            proofLabel: 'First week on a 340-product store', proof: [ { k: 'Contradictions found in your own site', v: '7', c: '#8A6A16' }, { k: 'Questions your site never answered', v: '23 · written once', c: '#3E5C99' }, { k: 'Handed to a person out of uncertainty', v: '350 / week', c: '#3E5C99' } ] },
          { n2: '04', icon: 'receipt', bg: '#EFEAE1', ic: '#7A6A4F', n: 'no per-seat charge', t: 'Priced against your outcome, not your headcount.', d: 'Per conversation, never per seat. Add the whole team at no extra cost. The point is that they answer less, not that you pay for more of them, and the counter is on your billing page.',
            proofLabel: 'AI Team plan, a normal month', proof: [ { k: 'Credits included', v: 'monthly allowance', c: '#3A3833' }, { k: 'Team members', v: 'unlimited', c: '#2E7D5B' }, { k: 'Per seat', v: '₪0', c: '#2E7D5B' } ] }
        ],
        altTitle: 'What you are really choosing between.', altNote: 'Same problem, four honest options, at the volume of a typical growing business. The prices are what our customers told us they paid.',
        alts: [
          { t: 'An evening shift', v: '₪4,200 / mo', n: 'one person · 18:00 to 23:00', bg: '#FFFFFF', fg: '#16150F', muted: '#8E887C' },
          { t: 'A website chatbot', v: '₪200 / mo', n: 'answers · cannot act', bg: '#FFFFFF', fg: '#16150F', muted: '#8E887C' },
          { t: 'Helpdesk with AI', v: '₪1,800 / mo', n: 'per seat · 3 seats', bg: '#FFFFFF', fg: '#16150F', muted: '#8E887C' },
          { t: 'GOTCHA · AI Team', v: '$97 / mo', n: 'every hour · whole team', bg: '#16150F', fg: '#F7F5F1', muted: '#A29D95' }
        ],
        matrix: [
          row('Answers at 02:00', ['no', 'shift ends 23:00'], ['yes', 'instantly'], ['part', 'auto-reply, then queue'], ['yes', 'in 19 seconds']),
          row('Knows her order and her history', ['yes', 'looks it up, slowly'], ['no', 'knows nothing'], ['part', 'if someone typed it in'], ['yes', 'before replying']),
          row('Refunds, changes or cancels the order itself', ['yes', 'in another tab'], ['no', ''], ['no', 'a person does it'], ['yes', 'inside your limits']),
          row('Asks you before spending money', ['part', 'if you told them to'], ['no', 'never spends'], ['no', ''], ['yes', 'do / ask / never']),
          row('Says "let me check" instead of guessing', ['yes', 'a good one does'], ['no', 'fluent guessing'], ['part', 'depends on the agent'], ['yes', 'only your sources']),
          row('Answers the phone', ['yes', 'five hours a day'], ['no', ''], ['no', ''], ['yes', 'beta, any hour']),
          row('Every action logged with the amount', ['no', 'in their head'], ['no', ''], ['part', 'tickets, not actions'], ['yes', 'full audit log']),
          row('Whole team included', ['no', 'one person'], ['yes', 'nobody uses it'], ['no', 'per seat'], ['yes', 'no per-seat charge'])
        ],
        matrixFoot: 'A great evening person beats every tool on this table for the five hours they are there. We are not replacing them. We are covering the other nineteen, and the lookups that ate their shift.',
        replayKicker: 'Zero-risk way to find out', replayTitle: 'Judge it on your own last month, not on our promises.',
        replayBody: 'Connect one channel and it reads your products, your policies and your customers. Then it replays what you were actually asked in the last thirty days and shows you what it would have done, decision by decision. You decide with the evidence in front of you.',
        replayPromises: ['No card to start', 'Cancel whenever you like', 'We sit with you through setup', 'Watch-only until you say otherwise'],
        replaySteps: [
          { n: '01', t: 'Connect a channel', d: 'WhatsApp or Instagram, on your own number. Nothing about the customer experience changes.', when: '4 minutes' },
          { n: '02', t: 'It reads your business', d: 'Products, policies, delivery times, past replies. It shows you what it learned and what your site never answered.', when: 'same afternoon' },
          { n: '03', t: 'It replays last month', d: 'Every real question, with the answer it would have sent and the action it would have taken, marked do / ask / never.', when: 'by the evening' },
          { n: '04', t: 'You draw the lines and go live', d: 'Watch-only for the first week. It drafts, you correct, nothing reaches a customer without you pressing send.', when: 'when you say' }
        ],
        voicesTitle: 'People who tried the alternatives first.', voicesNote: 'Real customers, their own numbers. We can put you in touch with any of them.',
        voices: [
          { q: 'We tried a chatbot and a helpdesk. Both left the actual work with me. This is the first one that finished a refund on its own and showed me exactly why.', v: '9h → 19s', l: 'first reply, evenings', ini: 'ML', name: 'Maya Levi', role: 'Founder · linen & bath textiles' },
          { q: 'It found seven places where our own site contradicted itself. We had been giving customers two different answers for a year and nobody noticed.', v: '7', l: 'contradictions found in week one', ini: 'TA', name: 'Tomer Adler', role: 'Customer lead · four-person team' },
          { q: 'The no-shows were killing the diary. It confirms, reminds, and rebooks the ones who go quiet. I got my receptionist back for the patients in the room.', v: '41 → 6', l: 'no-shows a month', ini: 'NP', name: 'Dr. Noa Peretz', role: 'Owner · aesthetic clinic' }
        ],
        objKicker: 'The questions everyone asks first', objTitle: 'Fair objections, straight answers.',
        objections: [
          { q: 'What if it gets something wrong?', a: 'It only acts inside limits you set, anything with money is reversible for a stated window, and every action is logged with the amount. Week one is watch-only, so you see its judgement before it touches a customer.' },
          { q: 'Will my customers feel they are talking to a robot?', a: 'It learns tone from your own past replies, not a template. It never pretends to be a person, and the moment someone on your team takes over it stops mid-conversation.' },
          { q: 'Where does my data go?', a: 'Your data trains only your AI employees, never anyone else\'s. Two-step sign-in for everyone who can act on a customer\'s behalf, a full audit log, and export of everything whenever you want it.' },
          { q: 'How long until it is actually useful?', a: 'Live in an afternoon. It reads your site in four minutes, replays last month by the evening, and one of us sits with you through the setup call rather than sending a PDF.' }
        ],
        notTitle: 'When we are the wrong choice', notNote: 'We would rather say it here than on a call.',
        nots: [
          { t: 'Under 200 conversations a month', n: 'not yet worth it' },
          { t: 'You want it to sound human but never act', n: 'a chatbot is cheaper' },
          { t: 'A 40-agent contact centre with workforce planning', n: 'not our shape' },
          { t: 'Nothing of yours has an API', n: 'talk to us first' }
        ],
        notFoot: 'If one of those is you, we will say so on the first call and tell you what to fix first. A bad fit costs us more than a lost sale.',
        ctaTitle: 'Judge it on your own last month.',
        ctaBody: 'Connect a channel and it replays what you were actually asked, your products, your policies, your customers. Then decide whether it beats the alternative.'
      };
    })();

    const HELP = {
      kicker: 'Help center', h1a: 'Everything, written', h1b: 'in the same language as the product',
      sub: 'How to set it up, what each setting does, and the playbook for your trade. Written by the people who built it, and kept current, no screenshots from two versions ago.',
      searchPlaceholder: 'Search: refund limits, WhatsApp setup, watch-only mode…',
      asideHead: 'Cannot find it?',
      aside: 'Message us on WhatsApp and a person answers, usually in minutes. Support is on every plan and is not a paid upgrade.',
      stats: [{ v: '148', l: 'articles, all public' }, { v: '2 min', l: 'median time to an answer on WhatsApp' }, { v: 'HE / EN', l: 'both languages' }],
      catsTitle: 'Start where you are',
      cats: [
        { icon: 'flag', bg: '#FBEEE8', ic: '#C4552F', t: 'Getting started', d: 'Connecting your first channel, letting it read your business, and going live in an afternoon.', items: ['Your first afternoon, step by step', 'Watch-only mode explained', 'Importing your WhatsApp history'], n: '18 articles' },
        { icon: 'radio', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Channels', d: 'WhatsApp, Instagram, Facebook, TikTok, email, web chat and the phone beta.', items: ['Connecting WhatsApp on your own number', 'Instagram comments and story replies', 'Installing the store widget'], n: '26 articles' },
        { icon: 'sliders-horizontal', bg: '#EDF1F7', ic: '#3E5C99', t: 'Permissions & approvals', d: 'Do it, ask me, never, and the limits that decide what reaches you.', items: ['Setting refund and spending limits', 'Approving from WhatsApp', 'Reading the action log'], n: '21 articles' },
        { icon: 'plug', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Integrations', d: 'Shopify, WooCommerce, CRMs, calendars, couriers and your own API.', items: ['Connecting Shopify and its seven actions', 'Two-way sync with Zoho and monday.com', 'Webhooks and the event catalogue'], n: '32 articles' },
        { icon: 'library', bg: '#F7F0E2', ic: '#8A6A16', t: 'Knowledge & AI Studio', d: 'Where the answers come from and how to give an AI employee a responsibility.', items: ['Adding sources it should read', 'Resolving a conflict between two pages', 'Answering the gap list'], n: '29 articles' },
        { icon: 'receipt', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Billing & account', d: 'What counts as a conversation, changing plan, invoices, roles and export.', items: ['What counts as one conversation', 'Changing plan mid-month', 'Exporting everything you have'], n: '22 articles' }
      ],
      popTitle: 'Read most this month', popNote: 'Usually the fastest route to what you came for.',
      pop: [
        { t: 'Your first afternoon: from connected channel to first answer', n: '6 min' },
        { t: 'How to set refund limits you will actually be comfortable with', n: '4 min' },
        { t: 'Watch-only mode: reading what it would have said', n: '5 min' },
        { t: 'Connecting WhatsApp Business on your existing number', n: '7 min' },
        { t: 'What counts as a conversation, with examples', n: '3 min' },
        { t: 'Giving an AI employee its first responsibility', n: '8 min' }
      ],
      guidesTitle: 'Playbooks by trade', guidesNote: 'What to turn on first, in the order that works for your kind of business.',
      guides: [
        { t: 'Online stores', n: 'delivery first' },
        { t: 'Fashion & apparel', n: 'sizing first' },
        { t: 'Cosmetics & skincare', n: 'shade & ingredients' },
        { t: 'Clinics & aesthetics', n: 'rescheduling first' },
        { t: 'Restaurants & local', n: 'reservations first' },
        { t: 'Wholesale & trade', n: 'price lists first' }
      ],
      ctaTitle: 'Still stuck? Ask a person.',
      ctaBody: 'Support is answered by the people who build it, on WhatsApp, in Hebrew or English, on every plan, including the trial.'
    };

    const yr = st.yearly;
    // one pricing model for the whole page: the cards' sliders and the sticky compare
    // header read the same selection
    const PRICE = (() => {
      const TIERS = [10, 25, 50, 100, 200];
      const CP = [39, 69, 119, 189, 329];
      const AI = [97, 189, 309, 519, 889];
      const CALL = [
        [229, 341, 486, 745, 1207],
        [322, 434, 579, 838, 1300],
        [442, 554, 699, 958, 1420],
        [647, 759, 904, 1163, 1625],
        [1017, 1129, 1274, 1533, 1995]
      ];
      const cp = st.pcp || 0, ai = st.pai || 0, ccp = st.ccp || 0, cai = st.cai || 0;
      const money = (m) => '$' + (yr ? m * PP : m).toLocaleString();
      const ticks = (active, dark) => TIERS.map((t, i) => ({
        t: String(t),
        c: i === active ? (dark ? '#F7F5F1' : '#16150F') : (dark ? '#5E5A53' : '#B4AFA5')
      }));
      const slider = (unit, label, index, setter, dark) => ({
        unit, label, index, value: String(TIERS[index]), ticks: ticks(index, dark),
        set: (ev) => setter(parseInt(ev.target.value, 10))
      });
      const per = yr ? '/ year' : '/ month';
      const vat = ' · excluding 18% VAT';
      return {
        prices: [money(CP[cp]), money(AI[ai]), money(CALL[ccp][cai])],
        subs: [
          TIERS[cp] + ' chats a day · ' + TIERS[cp] + ' users',
          TIERS[ai] + ' chats a day · ' + TIERS[ai] + ' AI employees',
          TIERS[ccp] + ' chats · ' + TIERS[cai] + ' calls a day'
        ],
        plans: [
          { name: 'Co-Pilot', badge: null, who: 'AI beside your team: it prepares every reply, and your agents run the service and the sales.',
            price: money(CP[cp]), per, sub: TIERS[cp] + ' Co-Pilot users' + vat,
            bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#8E887C', dot: '#C8C2B6', rule: '#F0EDE7', accent: '#C4552F', sliderBoxH: '188px',
            sliders: [slider('chat conversations a business day', 'Co-Pilot users', cp, (v) => this.setState({ pcp: v }), false)],
            featHead: 'Includes', feats: ['Multichannel unified inbox and broadcasts', 'Automations, AI routing and the command centre', 'Copilot drafting every reply for your agents', 'Conversation summaries into your CRM', 'Knowledge base and the full customer picture', 'Your whole team, no per-seat surprises'],
            cta: 'Start free', btnBg: '#FFFFFF', btnFg: '#16150F', btnBd: '#D8D2C6' },
          { name: 'AI Team', badge: 'Most businesses', badgeBg: '#EFD9CD', badgeFg: '#5C2410',
            who: 'AI employees that handle service, copilot work and tasks for your team, end to end.',
            price: money(AI[ai]), per, sub: TIERS[ai] + ' AI employees' + vat,
            bg: '#16150F', bd: '#16150F', fg: '#F7F5F1', muted: '#A29D95', dot: '#4A4740', rule: '#262521', accent: '#E0A458', sliderBoxH: '188px',
            sliders: [slider('chat conversations a business day', 'AI employees', ai, (v) => this.setState({ pai: v }), true)],
            featHead: 'Everything in Co-Pilot, plus', feats: ['AI employees answering and acting on their own', 'Autonomy set per action: suggest, ask, or do it', 'Back office work done for you, not just replies', 'Actions inside Shopify, your CRM and your tools', 'Analytics that name the cause, not just the volume'],
            cta: 'Start free', btnBg: '#F7F5F1', btnFg: '#16150F', btnBd: '#F7F5F1' },
          { name: 'Call Pilot', badge: null, who: 'Both together, with the phone included: pick your chat volume and your voice volume.',
            price: money(CALL[ccp][cai]), per, sub: TIERS[ccp] + ' users · ' + TIERS[cai] + ' AI employees' + vat,
            bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#8E887C', dot: '#C8C2B6', rule: '#F0EDE7', accent: '#C4552F', sliderBoxH: '188px',
            sliders: [
              slider('chat conversations a business day', 'Co-Pilot users', ccp, (v) => this.setState({ ccp: v }), false),
              slider('voice calls a business day', 'AI employees on the phone', cai, (v) => this.setState({ cai: v }), false)
            ],
            featHead: 'Everything in AI Team, plus', feats: ['Call Pilot live on phone calls', 'Transcript, caller history and actions while you talk', 'The next line to say, prepared as the call runs', 'One price for chat and voice together'],
            cta: 'Talk to us', btnBg: '#FFFFFF', btnFg: '#16150F', btnBd: '#D8D2C6' }
        ]
      };
    })();
    const pTab = (on) => 'font-size:13px;font-weight:500;border-radius:9px;padding:9px 16px;cursor:pointer;'
      + (on ? 'background:#16150F;color:#FAF8F4;' : 'background:transparent;color:#5B564D;');

    const PFAQ = [
      ['What is a credit?', 'A credit is how GOTCHA measures AI work. Reading a message, drafting a reply, retrieving knowledge, updating your CRM and summarising a conversation all draw on your balance. Credits are the only unit you are billed in.'],
      ['How are conversation estimates calculated?', 'Each plan is configured with a commercial assumption about how many credits an average conversation uses, and how many business days a month contains. The estimate divides the plan\'s credit allowance by that assumption. It describes the plan configuration, not a measurement of anyone\'s usage.'],
      ['Will my usage match the estimate?', 'Not exactly. Actual credit consumption varies by conversation length, channel, AI actions, enabled features and voice duration. The estimate is there to size a plan, not to predict a bill.'],
      ['What happens when credits run out?', 'AI actions stop until credits are added. Your shared inbox, conversation history and human agents keep working, and no data is removed. You can buy credits or enable automatic top-up.'],
      ['How does automatic top-up work?', 'You choose when it triggers, how much it buys, and a monthly spending limit. Once the limit is reached nothing further is charged, and you are notified so you can decide what to do.'],
      ['Can I buy extra credits without changing plan?', 'Yes. Prepaid credit packages are added to your balance and stay there until consumed. Included plan credits are always used first.'],
      ['What happens when I upgrade?', 'An upgrade starts immediately. You are charged the prorated difference for the rest of the current billing period, and the larger credit allowance is available straight away.'],
      ['What happens when I downgrade?', 'Your current plan stays exactly as it is until your renewal date. Nothing is removed before then, and the smaller plan starts at renewal.'],
      ['What happens if I cancel?', 'Cancellation takes effect at the end of the current billing period. You keep full access until your renewal date, and you can resume before it. Your data is not deleted when the subscription ends.'],
      ['Why are prices shown in dollars?', 'Prices are set in US dollars. Shekel amounts are a display conversion at the official representative rate, rounded up, and are marked as an estimate. The currency you will actually be charged in is shown before you confirm.'],
      ['Do you offer a trial or a pilot?', 'Trials and pilots are arranged with our team rather than started self-serve, so the credit budget and duration can be set to match what you want to evaluate. Ask us when you get in touch.'],
      ['Can we get a custom plan?', 'Yes. Custom plans set their own capabilities, numeric limits, credit allocation and chat and voice volumes, with commercial terms agreed with you.']
    ];

    return {
      navItems,
      mnav,
      mnavOpen: !!st.mnav,
      mnavIcon: st.mnav ? 'x' : 'menu',
      mnavToggle: () => this.setState(s => ({ mnav: !s.mnav, menu: null })),
      menuData: st.menu ? (() => {
        const m = MENUS[st.menu];
        return Object.assign({}, m, {
          railImg: m.railShot ? React.createElement('img', { src: m.railShot, alt: m.railTitle, style: { position: 'absolute', left: '8%', top: 12, width: '118%', maxWidth: 'none', borderRadius: 8, boxShadow: '0 12px 30px rgba(0,0,0,.35)' } }) : null,
          cols: m.cols.map(c => Object.assign({}, c, {
            items: c.items.map(it => Object.assign({}, it, {
              go: () => {
                if (it.page) { this.setState({ menu: null, page: it.page, post: null }); window.scrollTo(0, 0); }
                else this.setState({ menu: null });
              }
            }))
          }))
        });
      })() : null,

      isHomePage: st.page === 'home',
      isPricing: st.page === 'pricing',
      isSolution: !!SOLS[st.page],
      isFeature: !!FEATS[st.page],
      isBlog: st.page === 'co-blog', isAbout: st.page === 'co-about', isCareers: st.page === 'co-careers',
      isSecurity: st.page === 'co-security', isChat: st.page === 'co-chat',
      isWhy: st.page === 'why', isHelp: st.page === 'co-help',
      isOffer: st.page === 'offer',
      why: WHY, help: HELP,
      blog: Object.assign({}, BLOG, {
        cats: BLOG.cats.map((c, i) => ({ t: c, bg: i === 0 ? '#16150F' : '#FFFFFF', fg: i === 0 ? '#FAF8F4' : '#5B564D', bd: i === 0 ? '#16150F' : '#E8E3D9' })),
        featured: Object.assign({}, BLOG.posts[0], { open: () => { this.setState({ post: 0 }); window.scrollTo(0, 0); } }),
        rest: BLOG.posts.slice(1).map((p, i) => Object.assign({}, p, { open: () => { this.setState({ post: i + 1 }); window.scrollTo(0, 0); } }))
      }),
      postOpen: st.post != null,
      postList: st.post == null,
      post: st.post != null ? Object.assign({}, BLOG.posts[st.post], {
        back: () => { this.setState({ post: null }); window.scrollTo(0, 0); },
        nextT: BLOG.posts[(st.post + 1) % BLOG.posts.length].t,
        next: () => { this.setState({ post: (st.post + 1) % BLOG.posts.length }); window.scrollTo(0, 0); }
      }) : null,
      about: ABOUT,
      careers: CAREERS,
      security: SECURITY,
      chat: CHAT,
      feat: (() => {
        const key = FEATS[st.page] ? st.page : 'feat-omnichannel';
        const b = FEATS[key];
        // the four stages of a knowledge base, as the stepper on the knowledge page
        const KB_STEPS = [
          { label: 'It reads what you already published', t: 'It crawls your site first.',
            d: 'Point it at your domain and it reads the pages a customer would read: shipping, returns, sizing, the product pages, the FAQ you wrote two years ago.',
            meta: 'a few minutes, no writing', icon: 'globe', ic: '#3E5C99',
            cardT: 'Reading avivandco.co.il', cardMeta: 'crawl',
            rows: [
              { t: 'Shipping & delivery', n: '6 pages', icon: 'check', bg: '#EDF4E7', fg: '#2E7D5B' },
              { t: 'Returns & exchanges', n: '3 pages', icon: 'check', bg: '#EDF4E7', fg: '#2E7D5B' },
              { t: 'Size guides', n: '11 pages', icon: 'check', bg: '#EDF4E7', fg: '#2E7D5B' },
              { t: 'Product pages', n: '84 pages', icon: 'check', bg: '#EDF4E7', fg: '#2E7D5B' },
              { t: 'Care instructions', n: 'not found', icon: 'minus', bg: '#F7F0E2', fg: '#8A6A16' }
            ] },
          { label: 'It reads how you actually answer', t: 'Then it imports your old chats.',
            d: 'Your real conversations are the best manual you have. It reads them, groups the same question asked ninety different ways, and keeps the answer you gave.',
            meta: 'your voice, not a template', icon: 'messages-square', ic: '#C4552F',
            cardT: 'Learning from past conversations', cardMeta: 'import',
            rows: [
              { t: '"Where is my order?"', n: '1,204 asks', icon: 'sparkles', bg: '#FBEEE8', fg: '#C4552F' },
              { t: '"Does this run small?"', n: '486 asks', icon: 'sparkles', bg: '#FBEEE8', fg: '#C4552F' },
              { t: '"Do you ship to Eilat?"', n: '318 asks', icon: 'sparkles', bg: '#FBEEE8', fg: '#C4552F' },
              { t: '"Can I exchange a gift?"', n: '204 asks', icon: 'sparkles', bg: '#FBEEE8', fg: '#C4552F' }
            ] },
          { label: 'You correct, it remembers', t: 'It answers what is left, once.',
            d: 'Anything it could not find becomes a short list of questions for you. Answer each one in a sentence and every AI employee has it from then on.',
            meta: 'usually 10 to 20 questions', icon: 'square-pen', ic: '#4B3E8E',
            cardT: 'Questions waiting for you', cardMeta: '3 left',
            rows: [
              { t: 'How long does a linen order take to ship?', n: 'answered', icon: 'check', bg: '#EDF4E7', fg: '#2E7D5B' },
              { t: 'Do you price match?', n: 'answered', icon: 'check', bg: '#EDF4E7', fg: '#2E7D5B' },
              { t: 'Can a gift be exchanged without a receipt?', n: 'asks you', icon: 'hand', bg: '#F7F0E2', fg: '#8A6A16' },
              { t: 'Is the sand colour the same as last season?', n: 'asks you', icon: 'hand', bg: '#F7F0E2', fg: '#8A6A16' }
            ] },
          { label: 'It never stops growing', t: 'And you can always add more.',
            d: 'Drop in a file, paste a link, connect a Drive folder, or write a line yourself. When something changes, you change it in one place and every channel answers the new way.',
            meta: 'one source of truth, forever', icon: 'folder-plus', ic: '#2E7D5B',
            cardT: 'Add to the knowledge base', cardMeta: 'any time',
            rows: [
              { t: 'Upload a file · PDF, DOCX, CSV', n: 'drag in', icon: 'upload', bg: '#EDF1F7', fg: '#3E5C99' },
              { t: 'Paste a link · a page or a policy', n: 'one click', icon: 'link', bg: '#EDF1F7', fg: '#3E5C99' },
              { t: 'Connect Google Drive · a whole folder', n: 'stays in sync', icon: 'hard-drive', bg: '#EDF4E7', fg: '#2E7D5B' },
              { t: 'Write it yourself · one sentence', n: 'instant', icon: 'square-pen', bg: '#EAE4FB', fg: '#4B3E8E' }
            ] }
        ];
        // one hero, three arrangements: text beside the demo (either side), or a centred stage with the demo below
        const LAY = {
          'feat-omnichannel': 'stage', 'feat-copilot': 'side', 'feat-callpilot': 'dark', 'feat-knowledge': 'flip',
          'feat-approvals': 'side', 'feat-customers': 'stage', 'feat-studio': 'flip', 'feat-analytics': 'side',
          'feat-employee': 'dark', 'feat-channels': 'stage', 'feat-integrations': 'flip', 'feat-social': 'side', 'feat-widget': 'stage'
        };
        const lay = LAY[key] || 'side';
        const stage = lay === 'stage' || lay === 'dark', dark = lay === 'dark';
        const L = {
          heroCols: stage ? '1fr' : 'repeat(auto-fit,minmax(460px,1fr))',
          textOrder: lay === 'flip' ? 2 : 1, demoOrder: lay === 'flip' ? 1 : 2,
          heroAlign: stage ? 'center' : 'start', heroJustify: stage ? 'center' : 'flex-start',
          textMax: stage ? '860px' : 'none', textMargin: stage ? '0 auto' : '0', textMargin2: stage ? 'auto' : '0',
          demoMax: stage ? '1040px' : 'none', h1Size: stage ? '76px' : '58px',
          band: dark ? '#16150F' : (stage ? b.bg : 'transparent'),
          heroFg: dark ? '#F7F5F1' : '#16150F', heroMuted: dark ? '#A8A39A' : '#5B564D', heroLine: dark ? '#2A2823' : '#E8E3D9',
          ctaBg: dark ? '#F7F5F1' : '#16150F', ctaFg: dark ? '#16150F' : '#FAF8F4', cta2Bd: dark ? '#4A4740' : '#D8D2C6'
        };
        const P = { allowed: ['#EDF4E7', '#2E7D5B'], 'ask first': ['#F7F0E2', '#8A6A16'], never: ['#EFEAE1', '#7A6A4F'], connected: ['#EDF4E7', '#2E7D5B'], working: ['#EDF4E7', '#2E7D5B'], beta: ['#F7F0E2', '#8A6A16'], connect: ['#EFEAE1', '#7A6A4F'], 'not responding': ['#FBEEE8', '#C4552F'], done: ['#EDF4E7', '#2E7D5B'], 'to dm': ['#EAE4FB', '#4B3E8E'], public: ['#EDF1F7', '#3E5C99'], refunded: ['#EDF4E7', '#2E7D5B'] };
        const pill = (r) => { const p = P[(r.pill || '').toLowerCase()] || ['#EFEAE1', '#55524C']; return Object.assign({}, r, { v: r.v || '', pill: r.pill || '', pillBg: p[0], pillFg: p[1] }); };
        const MB = { in: { bg: '#F5F2EC', fg: '#16150F', radius: '14px 14px 14px 4px', align: 'flex-start' }, out: { bg: '#16150F', fg: '#F7F5F1', radius: '14px 14px 4px 14px', align: 'flex-end' } };
        const MBd = { in: { bg: '#262521', fg: '#F7F5F1', radius: '14px 14px 14px 4px', align: 'flex-start' }, out: { bg: '#F7F5F1', fg: '#16150F', radius: '14px 14px 4px 14px', align: 'flex-end' } };
        const msgs = (list, onDark) => list.map(m => Object.assign({}, (onDark ? MBd : MB)[m.side || 'in'], m, { meta: m.meta || '', dot: m.dot || (m.side === 'out' ? '#C4552F' : '#2E7D5B') }));
        const keys = (list, onDark) => list.map((k, i) => Object.assign(i === 0
          ? (onDark ? { bg: '#F7F5F1', fg: '#16150F', bd: '#F7F5F1', keyBd: '#C8C2B6', anim: 'gkey 2.2s ease-in-out infinite' } : { bg: '#16150F', fg: '#F7F5F1', bd: '#16150F', keyBd: '#4A4740', anim: 'gkey 2.2s ease-in-out infinite' })
          : (onDark ? { bg: '#262521', fg: '#F7F5F1', bd: '#2E2C28', keyBd: '#4A4740', anim: 'none' } : { bg: '#FFFFFF', fg: '#16150F', bd: '#E8E3D9', keyBd: '#DCD8D0', anim: 'none' }), k));
        const wave = [10, 16, 22, 14, 26, 18, 12, 24, 16, 20, 10, 22, 14, 18].map((h, j) => ({ h: h + 'px', d: (j * 0.09).toFixed(2) + 's' }));
        const seg = (sel) => ['Do it', 'Ask me', 'Never'].map((t, i) => i === sel ? { t, bg: '#16150F', fg: '#F7F5F1', sh: '0 2px 6px rgba(22,21,15,.18)' } : { t, bg: 'transparent', fg: '#8E887C', sh: 'none' });
        const DEMOS = {
          'feat-omnichannel': { kind: 'Threads', who: 'Dana Cohen', whoMeta: 'Tel Aviv · with you since March 2024',
            sources: [ { icon: 'instagram', bg: '#FBEEE8', ic: '#C4552F', t: 'Instagram DM', when: '12 Mar · asked about linen' }, { icon: 'mail', bg: '#EDF1F7', ic: '#3E5C99', t: 'Email', when: 'Tue · order confirmation reply' }, { icon: 'message-circle', bg: '#EDF4E7', ic: '#2E7D5B', t: 'WhatsApp', when: 'today 22:41 · where is my order' }, { icon: 'phone', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Phone', when: 'she called last week' } ],
            msgs: msgs([ { side: 'in', meta: 'Instagram · 12 Mar', dot: '#C4552F', t: 'Does the linen set come in king?' }, { side: 'in', meta: 'Email · Tuesday', dot: '#3E5C99', t: 'Thanks, order #1842 confirmed. Can it ship to my office instead?' }, { side: 'in', meta: 'WhatsApp · today 22:41', dot: '#2E7D5B', t: 'My package still has not arrived. This was a gift.' }, { side: 'out', meta: 'GOTCHA · 22:41 · answered on WhatsApp', t: 'I am sorry Dana, #1842 has been stuck since Tuesday. Refunded the full ₪179, and I can hold a king from tomorrow\'s batch.' } ], true) },
          'feat-copilot': { kind: 'Draft', thread: 'WhatsApp · Dana Cohen · order #1842',
            msgs: msgs([ { side: 'in', meta: 'Dana · 09:12', t: 'Third time I am writing. Where is my order? It was a gift and the date has passed.' } ]),
            draft: 'I am sorry Dana, this is on us. #1842 has been stuck with the carrier since Tuesday. I have refunded the full ₪179 and can hold a king from tomorrow\'s batch',
            found: [ { k: 'Order #1842', v: 'stalled since Tue' }, { k: 'Carrier investigation', v: 'opened 25 Aug' }, { k: 'Promise made', v: 'Maya · replacement' }, { k: 'Her mood', v: 'frustrated · 3rd contact' }, { k: 'Refund limit', v: '₪200 · inside' } ],
            keys: keys([ { key: '↵', t: 'Send' }, { key: 'S', t: 'Softer' }, { key: 'E', t: 'Edit' } ], true),
            foot: 'It read the thread, her orders and your policy before you opened it. You press one key.' },
          'feat-callpilot': { kind: 'Call', who: 'Dana Cohen', whoMeta: '+972 52 418 9930 · she called you · about order #1842', wave,
            lines: [ { t: '0:04', who: 'Dana', fg: '#F7F5F1', text: 'Hi, I called last week about a parcel that never came. I was told I would get a replacement.' }, { t: '0:19', who: 'You', fg: '#A8A39A', text: 'Let me pull that up, sorry about the wait.' }, { t: '0:41', who: 'Dana', fg: '#F7F5F1', text: 'Honestly if it is another two weeks I would rather have my money back. It was a gift.', tag: 'Refund asked for · gift date passed' } ],
            found: [ { k: 'The call from 25 Aug', v: 'Tomer promised a replacement' }, { k: 'Parcel checked again', v: 'still stalled' }, { k: 'Sand king in stock', v: '11 left' } ],
            say: 'You were promised a replacement and it has not moved, so I am refunding the full ₪179 now. And yes, sand comes in king, I will hold one for you.',
            keys: keys([ { key: '↵', t: 'Read it out' }, { key: 'S', t: 'Softer' }, { key: 'R', t: 'Refund ₪179' } ], true) },
          'feat-knowledge': { kind: 'Sources',
            msgs: msgs([ { side: 'in', meta: 'Web chat · 14:02', t: 'What is the minimum order for wholesale, and how long does delivery take to Eilat?' }, { side: 'out', meta: 'GOTCHA · 14:02', t: 'Wholesale starts at ₪550. Eilat is 3 to 4 working days by courier, free over ₪300. I have checked the minimum with the team since two of our pages disagreed.' } ]),
            sources: [ { icon: 'globe', t: 'yourstore.co.il/shipping', d: 'Eilat: 3 to 4 working days. Free over ₪300.', n: 'read 2 days ago' }, { icon: 'file-text', t: 'Wholesale terms.pdf', d: 'Minimum first order ₪550, net 30 for approved accounts.', n: 'page 2' }, { icon: 'message-square', t: 'Maya\'s reply · 14 Jun', d: 'The way you actually phrase delivery times to customers.', n: 'tone' } ],
            conflictT: 'Your website says ₪500. The PDF says ₪550.', conflictD: 'It did not pick one. It asked you, once, and has used ₪550 since. Twenty-three questions like this were settled in the first week.' },
          'feat-approvals': { kind: 'Approval', req: 'Requested by Support AI · 09:39', title: 'Refund ₪179 to Dana Cohen', sub: 'Order #1842 · damaged item · full refund recommended', rev: 'Yes, within 24h',
            why: [ 'Delivered 4 days ago, marked damaged on arrival', 'Customer sent a photo, damage visible', 'Inside the 14-day damage window', 'Third contact about this order' ],
            leave: 'Dana has waited 17 hours already. GOTCHA keeps her posted, but it cannot close this without you.',
            chain: [ '₪179 refunded to card', 'Marked refunded in Shopify', 'Dana told on WhatsApp' ],
            keys: keys([ { key: 'A', t: 'Approve' }, { key: 'E', t: 'Edit amount' }, { key: 'R', t: 'Reject' } ], true) },
          'feat-customers': { kind: 'Profile', who: 'Dana Cohen', whoMeta: 'Tel Aviv · with you since March 2024',
            channels: [ { t: 'WhatsApp', dot: '#2E7D5B' }, { t: 'Instagram', dot: '#C4552F' }, { t: 'Email', dot: '#3E5C99' }, { t: 'Phone', dot: '#7A6A4F' } ],
            worth: [ { v: '₪2,140', l: 'lifetime' }, { v: '6', l: 'orders' }, { v: '0', l: 'refunds' } ],
            timeline: [ { when: 'Today', dot: '#C4552F', t: 'Third message about order #1842', d: 'WhatsApp · frustrated · refund awaiting your approval' }, { when: '25 Aug', dot: '#4B3E8E', t: 'GOTCHA opened a carrier investigation', d: 'automatic · no response from carrier yet' }, { when: '14 Aug', dot: '#2E7D5B', t: 'Order #1842 · ₪179', d: 'linen set, sand, king · in transit since 16 Aug' }, { when: '2 Jun', dot: '#DCD8D0', t: 'Asked about washing instructions', d: 'Instagram · answered by Support AI in 3 minutes' } ],
            memory: [ 'Prefers sand over grey. Sent back grey once.', 'Ships to a work address; home deliveries get missed.', 'Replies fastest in the evening.' ] },
          'feat-studio': { kind: 'Hire',
            steps: [ { n: '✓', t: 'Responsibility', bg: '#EDF4E7', fg: '#2E7D5B' }, { n: '2', t: 'Limits', bg: '#16150F', fg: '#F7F5F1' }, { n: '3', t: 'Try it', bg: '#F5F2EC', fg: '#8E887C' } ],
            rows: [ { k: 'Answer delivery and order questions', d: 'WhatsApp, email, web chat · any hour', opts: seg(0) }, { k: 'Refund an order', d: 'up to ₪200 · above that it asks', opts: seg(1) }, { k: 'Offer a discount', d: 'anything over 10%', opts: seg(1) }, { k: 'Change a customer\'s address', d: 'before the parcel ships', opts: seg(0) }, { k: 'Cancel an order', d: 'once it has been packed', opts: seg(2) } ],
            foot: 'Watch-only for the first week: it drafts, you correct, nothing reaches a customer without you pressing send.' },
          'feat-analytics': { kind: 'Fixlist', title: 'Things to fix this week', meta: 'last 7 days · vs the week before',
            rows: [ { k: 'Does this run small?', d: '204 conversations · all point at one size chart', w: '78%', c: '#C4552F', v: '₪18,400', n: 'returns at risk' }, { k: 'Where is my order?', d: '312 conversations · 41 late on the north route', w: '100%', c: '#16150F', v: '9h → 19s', n: 'first reply' }, { k: 'Back in stock: sand king', d: '141 asked while it was out · 41 bought', w: '46%', c: '#2E7D5B', v: '₪18,400', n: 'sold from a nudge' }, { k: 'Wholesale minimum', d: '23 asked · your pages disagree', w: '12%', c: '#8A6A16', v: '2 pages', n: 'to reconcile' } ],
            foot: 'Fix the size chart and 204 conversations a week stop happening. That is the list, not a dashboard.' },
          'feat-employee': { kind: 'Jobcard', name: 'Support AI', meta: 'hired by you, 09:41 · watch-only until 7 September',
            rows: [ { k: 'Answers', v: 'delivery, returns, sizing, stock, where is my order' }, { k: 'Hours', v: 'any hour, every day · your team covers 09:00 to 18:00' }, { k: 'Channels', v: 'WhatsApp, email, web chat · not Instagram yet' }, { k: 'May do alone', v: 'refund up to ₪200 · change address before shipping' }, { k: 'Hands over', v: 'refunds over ₪200 · anyone angry · anything it is unsure of' } ],
            progressT: 'This week it drafts, and tells you', progressN: '7 days left', progressW: '46%',
            stats: [ { v: '412', l: 'handled this week' }, { v: '9', l: 'handed to a person' }, { v: '2', l: 'reached you' } ] },
          'feat-channels': { kind: 'Channels',
            tiles: [ { icon: 'message-circle', bg: '#EDF4E7', ic: '#2E7D5B', t: 'WhatsApp', pill: 'Connected', n: '1,480', d: 'this week · your number, official API' }, { icon: 'instagram', bg: '#FBEEE8', ic: '#C4552F', t: 'Instagram', pill: 'Connected', n: '610', d: 'DMs, story replies and comments' }, { icon: 'messages-square', bg: '#EDF1F7', ic: '#3E5C99', t: 'Messenger', pill: 'Connected', n: '96', d: 'same queue as everything else' }, { icon: 'mail', bg: '#EDF1F7', ic: '#3E5C99', t: 'Email', pill: 'Connected', n: '318', d: 'threaded with the same customer' }, { icon: 'globe', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Web chat', pill: 'Connected', n: '204', d: 'the widget on your store' }, { icon: 'phone-call', bg: '#F7F0E2', ic: '#8A6A16', t: 'Phone', pill: 'Beta', n: '46', d: 'answered, transcribed, attached' } ].map(pill) },
          'feat-integrations': { kind: 'Permissions',
            systems: [ { icon: 'shopping-bag', bg: '#EDF4E7', ic: '#2E7D5B', t: 'Shopify', d: 'orders, products, stock, refunds · 4,180 customers synced', pill: 'Working' }, { icon: 'database', bg: '#EDF1F7', ic: '#3E5C99', t: 'Your CRM', d: 'customer records and deal history', pill: 'Working' }, { icon: 'package', bg: '#FBEEE8', ic: '#C4552F', t: 'Returns platform', d: '11 exchange requests held rather than guessed', pill: 'Not responding' }, { icon: 'server', bg: '#EFEAE1', ic: '#7A6A4F', t: 'Your ERP', d: 'stock across warehouses, supplier lead times', pill: 'Connect' } ].map(pill),
            permTitle: 'What Shopify lets GOTCHA do', permNote: 'Applies to every AI employee unless you narrow it',
            perms: [ { k: 'Find a product', pill: 'Allowed' }, { k: 'Look up an order', pill: 'Allowed' }, { k: 'Check stock', v: 'live', pill: 'Allowed' }, { k: 'Refund', v: 'up to ₪200', pill: 'Ask first' }, { k: 'Cancel an order', pill: 'Ask first' }, { k: 'Change customer details', pill: 'Never' } ].map(pill) },
          'feat-social': { kind: 'Comments', handle: 'aviv.and.co', post: 'Linen set · sand · back in king', likes: '1,204 likes', commentsN: '38 comments',
            comments: [ { who: 'noa.br', t: 'do you ship to Eilat?? 🙏', when: '2h · public comment', reply: 'We do, 3 to 4 working days and free over ₪300. Sent you the link in DM.', tags: [ { t: 'Answered publicly', bg: '#EDF1F7', fg: '#3E5C99' }, { t: 'Moved to DM', bg: '#EAE4FB', fg: '#4B3E8E' } ] }, { who: 'ron_k', t: 'still waiting on my order from 2 weeks ago', when: '4h · public comment', reply: 'Ron, that is on us. I found #1793 and have messaged you with the refund and the tracking.', tags: [ { t: 'Order found', bg: '#EDF4E7', fg: '#2E7D5B' }, { t: 'Refunded in DM', bg: '#EDF4E7', fg: '#2E7D5B' } ] }, { who: 'maya.s', t: 'obsessed 😍 does it come in grey?', when: '6h · story reply', reply: 'It does, and grey ships tomorrow. Want me to hold one?', tags: [ { t: 'Sale in progress', bg: '#FBEEE8', fg: '#C4552F' } ] } ] },
          'feat-widget': { kind: 'Widget', store: 'AVIV & CO.', product: 'Linen set · sand', price: '₪179', widgetName: 'Ask us anything', action: 'Add king · sand to cart',
            sizes: [ { t: 'Single', bd: '#E8E3D9', bg: '#FFFFFF', fg: '#16150F' }, { t: 'Double', bd: '#E8E3D9', bg: '#FFFFFF', fg: '#16150F' }, { t: 'Queen', bd: '#E8E3D9', bg: '#FFFFFF', fg: '#16150F' }, { t: 'King', bd: '#16150F', bg: '#16150F', fg: '#F7F5F1' } ],
            msgs: msgs([ { side: 'in', meta: 'visitor · on this page', t: 'Will king fit a 220×240 duvet? And is sand in stock?' }, { side: 'out', meta: 'GOTCHA · 6 seconds', t: 'King is made for 220×240, and 11 are left in sand. Want me to add it?' } ], true) }
        };
        const dm = DEMOS[key] || DEMOS['feat-omnichannel'];
        return Object.assign({}, b, L, {
          dm,
          marquee: b.marquee ? b.marquee.concat(b.marquee) : null,   // doubled so the -50% loop is seamless
          shotImg: b.shot ? React.createElement('img', { src: b.shot, alt: b.shotTitle || '', style: { display: 'block', width: '100%' } }) : null,
          shotShown: (b.shot && ['feat-omnichannel', 'feat-customers', 'feat-studio', 'feat-callpilot', 'feat-analytics', 'feat-approvals', 'feat-broadcast'].indexOf(key) >= 0) ? true : null,
          showCaps: !b.marquee,
          tw: key === 'feat-widget' ? this.tryWidget() : null,
          saveDisplay: b.save ? 'block' : 'none',
          traceDisplay: key === 'feat-copilot' ? 'block' : 'none',
          graphDisplay: key === 'feat-channels' ? 'block' : 'none',
          kbDisplay: key === 'feat-knowledge' ? 'block' : 'none',
          dirDisplay: key === 'feat-integrations' ? 'block' : 'none',
          dir: key === 'feat-integrations' ? this.integrationDir() : null,
          kb: key === 'feat-knowledge' ? KB_STEPS.map((s, i) => Object.assign({}, s, {
            n: '0' + (i + 1),
            textLeft: i % 2 === 0 ? true : null, cardRight: i % 2 === 0 ? true : null,
            cardLeft: i % 2 === 1 ? true : null, textRight: i % 2 === 1 ? true : null,
            leftJustify: i % 2 === 0 ? 'flex-end' : 'flex-end',
            rightJustify: 'flex-start'
          })) : null,
          tr: key === 'feat-copilot' ? this.copilotTrace() : null,
          save: b.save ? Object.assign({}, b.save, {
            auto: b.save.auto.map(a => Object.assign({}, a, {
              tick: a.icon === 'check' ? '#A8C57A' : '#E0A458',      // the one line that waits for you
              fg: a.icon === 'check' ? '#F7F5F1' : '#EFE3CF'
            })),
            sys: b.save.sys.map(s => Object.assign({}, s, { noLogo: !s.logo }))
          }) : null,
          hasFlow: b.flow ? true : null,   // null unmounts the branch; false leaves the shell
          flowKicker: b.flow ? (b.flowKicker || 'One comment, end to end') : '', flowDisplay: b.flow ? 'block' : 'none',
          flowTitle: b.flowTitle || '', flowNote: b.flowNote || '',
          flow: b.flow ? b.flow.map((s, i) => {
            const last = i === b.flow.length - 1;
            return Object.assign({}, s, {
              hasArrow: i > 0, noLogo: !s.logo,
              bg: last ? '#16150F' : '#FFFFFF', bd: last ? '#16150F' : '#E8E3D9',
              fg: last ? '#F7F5F1' : '#16150F', muted: last ? '#A8A39A' : '#6B6660',
              line: last ? '#2A2823' : '#F0EDE7',
              iconBg: last ? '#2A2823' : '#F5F2EC', iconFg: last ? '#F7F5F1' : '#55524C',
              pillBg: last ? '#211F1B' : '#FFFDFA', pillBd: last ? '#2F2D28' : '#F0D6C9', pillFg: last ? '#D8D3CA' : '#8E3418',
              tagBg: last ? '#2A2823' : (i === 0 ? '#EAE4FB' : '#FBEEE8'),
              tagFg: last ? '#D8D3CA' : (i === 0 ? '#4B3E8E' : '#8E3418'),
              isComment: s.kind === 'comment', isDm: s.kind !== 'comment',
              ini: (s.handle || '').replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase(),
              bubbles: s.bubbles.map(x => ({
                t: x.t, who: x.who || '', when: x.when || '',
                ini: (x.who || '').replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase(),
                indent: x.side === 'in' ? '0px' : '22px',
                avaBg: x.side === 'in' ? '#EFEFEF' : '#16150F',
                avaFg: x.side === 'in' ? '#262626' : '#FFFFFF',
                heart: x.side === 'in' ? '#C7C7C7' : '#ED4956',
                align: x.side === 'in' ? 'flex-start' : 'flex-end',
                radius: x.side === 'in' ? '18px 18px 18px 5px' : '18px 18px 5px 18px',
                bg: x.side === 'in' ? '#EFEFEF' : (x.side === 'agent' ? '#C4552F' : (/whatsapp/i.test(s.logo || '') ? '#1E8E5A' : '#0095F6')),
                fg: x.side === 'in' ? '#262626' : '#FFFFFF'
              }))
            });
          }) : null,
          demoThreads: dm.kind === 'Threads', demoDraft: dm.kind === 'Draft', demoCall: dm.kind === 'Call', demoSources: dm.kind === 'Sources',
          demoApproval: dm.kind === 'Approval', demoProfile: dm.kind === 'Profile', demoHire: dm.kind === 'Hire', demoFixlist: dm.kind === 'Fixlist',
          demoJobcard: dm.kind === 'Jobcard', demoChannels: dm.kind === 'Channels', demoPermissions: dm.kind === 'Permissions', demoComments: dm.kind === 'Comments', demoWidget: dm.kind === 'Widget',
          glyph: this.glyph(b.icon, 15, b.ic),
          beta: !!b.beta,
          others: Object.keys(FEATS).filter(k => k !== key).map(k => ({
            t: FEATS[k].name + (FEATS[k].beta ? ' (beta)' : ''), icon: FEATS[k].icon, bg: FEATS[k].bg, ic: FEATS[k].ic,
            go: () => { this.setState({ menu: null, page: k }); window.scrollTo(0, 0); }
          }))
        });
      })(),
      sol: (() => {
        const base = SOLS[st.page] || SOLS['sol-ecommerce'];
        return Object.assign({}, base, {
          glyph: this.glyph(base.icon, 15, base.ic),
          cases: base.cases.map(c => Object.assign({}, c, { glyph: this.glyph(c.channel, 13, c.chIc) }))
        });
      })(),
      goHome: () => { this.setState({ menu: null, page: 'home' }); window.scrollTo(0, 0); },
      goChat: () => { this.setState({ menu: null, page: 'co-chat' }); window.scrollTo(0, 0); },
      goIntegrations: () => { this.setState({ menu: null, page: 'feat-integrations' }); window.scrollTo(0, 0); },
      goOffer: () => { this.offerDismissed = true; this.setState({ menu: null, page: 'offer', offerOpen: false }); window.scrollTo(0, 0); },
      seeProduct: () => {
        this.setState({ menu: null, page: 'home' });
        // the canvas host owns the scroll container, so drive it through the native hash jump
        const go = (tries) => {
          const el = document.getElementById('screens');
          if (el) { try { location.hash = ''; location.hash = 'screens'; } catch (e) {} return; }
          if (tries > 0) setTimeout(() => go(tries - 1), 80);
        };
        setTimeout(() => go(8), 80);
      },

      offerShown: st.offerOpen ? true : null,
      bars: { offerBar: st.barOffer ? 'flex' : 'none', headTop: (st.barOffer ? 38 : 0) + 'px' },
      op: {
        badge: 'Launch offer', scarcity: 'For the first 50 businesses only',
        h1a: '3 months of GOTCHA', h1b: 'for $1!',
        sub: 'We are opening the system to the first 50 businesses, and we would rather earn you than charge you. $1 in total for three months, on the plan you choose, with us setting it up beside you.',
        priceLabel: '3 months for', price: '$1',
        priceNote: 'in total, one payment, for the plan you choose. After that, regular pricing from $39 a month.',
        cta: 'Claim a place', ctaNote: 'Two minutes to leave your details.',
        formLead: 'Leave your details and we get back to you today or tomorrow.',
        shotHead: 'Every conversation, every channel, every customer, in one calm, organised place.',
        shotSub: 'WhatsApp, Instagram, email, phone and web chat arrive in the same queue, threaded by customer instead of by app. Nothing sits in someone\'s private phone, and nothing gets answered twice.',
        shotMeta: 'GOTCHA · your morning view',
        shotAlt: 'The GOTCHA home screen on a Monday morning',
        shotTitle: 'This is what you open on Monday morning.',
        shotNote: 'Everything handled overnight, closed and filed. What is left is the one thing that needed you, with the answer already drafted.',
        items: [
          '1,000 credits every month of the offer',
          'Co-Pilot or AI Team, your choice',
          'Connection, onboarding and personal guidance',
          'Billing starts only once you are connected'
        ],
        trust: [
          { icon: 'layers', t: 'Co-Pilot or AI Team, your choice' },
          { icon: 'clock', t: 'Live the same day, usually' },
          { icon: 'x-circle', t: 'Cancel whenever you like' }
        ],
        bandTitle: 'Three months of the full system, for the price of a coffee you would not order.',
        bandNote: 'Fifty places, and the offer closes when they are taken. Two minutes now, and you know by tomorrow whether this is for you.',
        cards: [
          { icon: 'layers', bg: '#EFD9CD', ic: '#8E3418', t: 'Choose Co-Pilot or AI Team', d: 'The offer covers either of the first two plans. Take Co-Pilot if your team answers, or AI Team if you want AI employees handling it end to end. Switch between them during the three months.' },
          { icon: 'coins', bg: '#F7F0E2', ic: '#8A6A16', t: '1,000 credits every month', d: 'Enough for a real month of conversations, not a demo. Unused credits reset with each month of the offer.' },
          { icon: 'plug', bg: '#EDF4E7', ic: '#2E7D5B', t: 'We connect it with you', d: 'Your channels, your store or site and your systems. You are not handed a login and left to work it out.' },
          { icon: 'user-round-check', bg: '#EAE4FB', ic: '#4B3E8E', t: 'Onboarding and personal guidance', d: 'We build the first knowledge base with you, set the autonomy limits, and stay reachable while you settle in.' },
          { icon: 'users-round', bg: '#FBEEE8', ic: '#C4552F', t: 'Only 50 businesses', d: 'So that each one gets our attention. When the fiftieth business joins, the offer closes.' }
        ],
        whyKicker: 'Why we are doing this',
        whyTitle: 'We want fifty businesses that will tell us the truth.',
        whyNote: 'This is not a discount funnel. It is how we learn what a small business actually needs before we scale.',
        why: [
          { n: '01', t: 'You get a real month, three times', d: 'A trial that ends in fourteen days tells you nothing. Three months is long enough to see the evenings come back and the answers land while you sleep.' },
          { n: '02', t: 'We get to build it around you', d: 'The roadmap comes from the fifty stores in this group. What you ask for in these three months is what we build next.' },
          { n: '03', t: 'Nobody is buying blind', d: 'By the time the offer ends you already know what it handled, what it escalated and what it saved you. Then you choose a plan on evidence.' }
        ],
        pickKicker: 'Your plan, your choice',
        pickTitle: 'Pick the plan that fits your business. The dollar covers any of them.',
        pickNote: 'The offer is not tied to one package. Choose the one that matches how you work, and three months of it cost $1 in total.',
        pick: [
          { name: 'Co-Pilot', badge: 'Team-led', badgeBg: '#EFEAE1', badgeFg: '#5C4A2A', who: 'AI beside your team: it prepares every reply and does the lookups, your people send and decide.', offerLine: 'Three months for $1', after: 'Then from $39 a month, on the volume you pick.', bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#5B564D', rule: '#F0EDE7' },
          { name: 'AI Team', badge: 'Most businesses', badgeBg: '#EFD9CD', badgeFg: '#5C2410', who: 'AI employees that handle service and back-office work end to end, up to the limits you set.', offerLine: 'Three months for $1', after: 'Then from $97 a month, on the volume you pick.', bg: '#16150F', bd: '#16150F', fg: '#F7F5F1', muted: '#A29D95', rule: '#262521' },
          { name: 'Call Pilot', badge: 'With voice', badgeBg: '#EDF1F7', badgeFg: '#2F4670', who: 'Everything in AI Team with the phone included: chat volume and voice volume chosen separately.', offerLine: 'Three months for $1', after: 'Then a combined chat and voice plan, agreed on the call.', bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#5B564D', rule: '#F0EDE7' }
        ],
        pickCta: 'Claim a place and choose on the call',
        pickCompare: 'Compare the two plans',
        pickFoot: 'You can switch plan during the three months, and you are not asked to decide before the call.',
        howKicker: 'How it works',
        howTitle: 'From this page to answering, usually the same day.',
        steps: [
          { n: '1', t: 'Leave your details', d: 'Your store, your channels and how you would rather we reach you.' },
          { n: '2', t: 'A short call with one of us', d: 'Twenty minutes, with a founder, to see whether we can genuinely help you.' },
          { n: '3', t: 'We connect and onboard you', d: 'Channels, Shopify and your systems, plus the first knowledge base built together.' },
          { n: '4', t: 'The three months start', d: 'Billing and the offer period begin only once you are connected and answering.' }
        ],
        fineTitle: 'The terms, in full',
        fine: [
          '$1 in total for three months, charged once.',
          '1,000 credits included every month of the offer.',
          'Connection, onboarding and personal guidance included.',
          'For the first 50 businesses.',
          'The offer ends on 31 October 2026 or when 50 businesses have joined, whichever comes first.',
          'After three months the price follows the plan and usage you choose. Regular pricing starts at $39 a month.',
          'Billing and the three month period start after connection.',
          'Prices are in USD and exclude 18% VAT.'
        ],
        ctaTitle: 'One of fifty. Then it closes.',
        ctaBody: 'Leave your details and one of us will call you today or tomorrow. If GOTCHA is not right for your store, we will say so on that call.',
        formTitle: 'Claim your place',
        fields: ['Your name *', 'Phone *', 'Website address *', 'Email (optional)'],
        submit: 'Leave your details',
        formFoot: 'Answered by Matan or Omer, not a queue. No card, and nothing charged until you are connected.'
      },
      offer: {
        badge: 'Launch offer',
        barText: 'First 3 months for $1 in total! For the first 50 businesses.',
        tabLabel: '$1 for 3 months',
        tabDisplay: st.offerOpen ? 'none' : 'flex',   // the drawer carries its own handle when open
        title: 'Your first 3 months for $1!',
        price: '$1', priceNote: 'in total, for 3 months, one payment',
        items: [
          '1,000 credits every month',
          'Connection, onboarding and personal guidance from us',
          'For the first 50 businesses',
          'Billing and the three months start once you are connected'
        ],
        bookLabel: 'Book a call', seeMore: 'See more',
        termsLabel: 'Offer terms',
        terms: 'Offer ends 31 October 2026 or when 50 businesses have joined, whichever comes first. After three months you continue on the plan and usage you choose. Regular pricing starts at $39 a month, excluding 18% VAT.',
        hideBar: () => this.setState({ barOffer: false }),
        hideAnn: () => this.setState({ barAnn: false }),
        open: () => this.setState({ offerOpen: true }),
        close: () => { this.offerDismissed = true; this.setState({ offerOpen: false }); },
        toggle: () => { if (st.offerOpen) this.offerDismissed = true; this.setState({ offerOpen: !st.offerOpen }); }
      },
      volIndex: st.vol,
      setVol: (e) => this.setState({ vol: parseInt(e.target.value, 10) }),
      volLabel: v.n > 200 ? '200+' : String(v.n),
      volTicks: VOL.map((x, i) => ({ t: x.t, c: i === st.vol ? '#16150F' : '#B4AFA5' })),
      recPlan: v.plan,
      recPrice: v.m ? (yr ? '$' + (v.m * 12).toLocaleString() + ' / yr' : 'from $' + v.m + ' / mo') : 'Talk to us',
      recUnit: v.unit || '—',
      recNote: v.note,

      setMonthly: () => this.setState({ yearly: false }),
      setYearly: () => this.setState({ yearly: true }),
      tabMonthly: pTab(!yr),
      tabYearly: pTab(yr),
      cycleNote: yr ? 'Billed once a year, one invoice. Prices exclude 18% VAT.' : 'Billed monthly, cancel whenever. Prices exclude 18% VAT.',

      customBullets: [
        'Feature selection and numeric limits set per organisation',
        'Credit allocation and chat and voice volumes agreed up front',
        'Monthly or annual terms with a defined contract period',
        'Priced for your business rather than a published tier'
      ],

      cmpPlans: [
        { name: 'Co-Pilot', badge: '', badgeBg: 'transparent', badgeFg: 'transparent', price: PRICE.prices[0], per: yr ? '/ yr' : '/ mo', sub: PRICE.subs[0], bg: 'transparent', cta: 'Start free', btnBg: '#FFFFFF', btnFg: '#16150F', btnBd: '#D8D2C6' },
        { name: 'AI Team', badge: 'Most businesses', badgeBg: '#EFD9CD', badgeFg: '#5C2410', price: PRICE.prices[1], per: yr ? '/ yr' : '/ mo', sub: PRICE.subs[1], bg: '#FBF9F5', cta: 'Start free', btnBg: '#16150F', btnFg: '#F7F5F1', btnBd: '#16150F' },
        { name: 'Call Pilot', badge: '', badgeBg: 'transparent', badgeFg: 'transparent', price: PRICE.prices[2], per: yr ? '/ yr' : '/ mo', sub: PRICE.subs[2], bg: 'transparent', cta: 'Talk to us', btnBg: '#FFFFFF', btnFg: '#16150F', btnBd: '#D8D2C6' }
      ],

      cmpGroups: (() => {
        const CMP = [
          ['Communication', [
            ['Multichannel unified inbox', 1, 1, 1],
            ['Broadcasts to a segmented audience', 1, 1, 1],
            ['Automations that route, reply and act without an agent', 1, 1, 1],
            ['Social engagement: comments on posts into private chats', 1, 1, 1],
            ['Conversation summaries written into your CRM', 1, 1, 1],
            ['AI routing to the right department', 1, 1, 1]
          ]],
          ['Context and knowledge', [
            ['The command centre', 1, 1, 1],
            ['Knowledge base', 1, 1, 1],
            ['The full customer picture', 1, 1, 1],
            ['Sentiment analysis', 1, 1, 1],
            ['Integrations', 1, 1, 1]
          ]],
          ['Running the team', [
            ['Manager dashboard', 1, 1, 1],
            ['Agent monitoring', 1, 1, 1],
            ['Usage tracking', 1, 1, 1],
            ['Your whole team, no per-seat charge', 1, 1, 1]
          ]],
          ['AI employees and voice', [
            ['Copilot beside your team in every conversation', 1, 1, 1],
            ['AI employees answering and acting end to end', 0, 1, 1],
            ['Autonomy per action: suggest, ask me, or do it', 0, 1, 1],
            ['Call Pilot on live phone calls', 0, 0, 1],
            ['Voice minutes drawn from your credit balance', 0, 0, 1]
          ]],
          ['Credits and billing', [
            ['Monthly credit allowance', '750', 'Larger', 'Chat + voice'],
            ['Estimated conversations a month', '~250', 'On request', 'On request'],
            ['Prepaid credit packages', 1, 1, 1],
            ['Automatic top-up with a spending limit', 1, 1, 1],
            ['Price a month, excluding 18% VAT', PRICE.prices[0], PRICE.prices[1], PRICE.prices[2]]
          ]]
        ];
        const cell = (x, i) => {
          const bg = i === 1 ? '#FBF9F5' : 'transparent';
          if (typeof x === 'number') return x ? { v: '✓', c: '#4F7A2E', w: '600', bg } : { v: '—', c: '#C8C2B6', w: '400', bg };
          return { v: x, c: '#3A3833', w: '500', bg };
        };
        return CMP.map(g => ({ t: g[0], rows: g[1].map(r => ({ t: r[0], cells: [cell(r[1], 0), cell(r[2], 1), cell(r[3], 2)] })) }));
      })(),

      pplans: PRICE.plans,

      compare: [
        { t: 'What you switch on', v: 'Capabilities', d: 'Start with the shared inbox and add voice, autonomous replies, back-office actions or social engagement when you want them. Each one you turn on is priced; each one you turn off stops being charged.', bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#8E887C' },
        { t: 'How much you handle', v: 'Volume', d: 'Conversations, calls and AI actions are metered. A quiet month costs less than a launch month, without renegotiating anything.', bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#8E887C' },
        { t: 'It moves both ways', v: 'Up and down', d: 'Growth raises the bill in proportion to the work done for you. A slower season, or fewer capabilities, lowers it the same month.', bg: '#16150F', bd: '#16150F', fg: '#F7F5F1', muted: '#A29D95' },
        { t: 'You set the ceiling', v: 'Your limit', d: 'A monthly spending limit you choose. Usage is visible as it happens and nothing is charged beyond the limit you set.', bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#8E887C' }
      ],

      included: [
        { t: 'Communication', icon: 'inbox', bg: '#EDF4E7', ic: '#2E7D5B', items: ['Multichannel unified inbox', 'Broadcasts to a segmented audience', 'Automations that route, reply and act', 'Comments on social posts into private chats', 'Conversation summaries written into your CRM', 'AI routing to the right department'] },
        { t: 'Context and knowledge', icon: 'book-open', bg: '#EDF1F7', ic: '#3E5C99', items: ['The command centre', 'Knowledge base', 'The full customer picture', 'Sentiment analysis', 'Hebrew and English', 'Integrations'] },
        { t: 'Running the team', icon: 'users', bg: '#FBEEE8', ic: '#C4552F', items: ['Manager dashboard', 'Agent monitoring', 'Usage tracking', 'Policies and permissions', 'Your whole team, no per-seat charge', 'Approvals and the full action log'] },
        { t: 'Billing', icon: 'receipt', bg: '#F7F0E2', ic: '#8A6A16', items: ['One unit: credits', 'Prepaid packages that do not expire', 'Automatic top-up with a spending limit', 'Upgrade takes effect immediately, prorated', 'Downgrade or cancel at your renewal date', 'Prices in USD, excluding 18% VAT'] }
      ],



      pfaqs: PFAQ.map((f, i) => ({
        q: f[0], a: f[1],
        toggle: () => this.setState(s2 => ({ pfaq: s2.pfaq === i ? -1 : i })),
        sign: st.pfaq === i ? '−' : '+',
        h: st.pfaq === i ? '280px' : '0px',
        o: st.pfaq === i ? 1 : 0
      })),
      closeMenu: () => this.setState({ menu: null }),
      dir: st.lang === 'he' ? 'rtl' : 'ltr', lang: st.lang,
      navDir: st.lang === 'he' ? 'row-reverse' : 'row',
      navML: st.lang === 'he' ? '0' : 'auto', navMR: st.lang === 'he' ? 'auto' : '0',
      mlAuto: st.lang === 'he' ? '0' : 'auto', mrAuto: st.lang === 'he' ? 'auto' : '0',
      arrowFwd: st.lang === 'he' ? '←' : '→', arrowBack: st.lang === 'he' ? '→' : '←',
      arrowIcon: st.lang === 'he' ? 'arrow-left' : 'arrow-right',
      isHe: st.lang === 'he',
      setEn: () => { try { localStorage.setItem('gotcha-lang', 'en'); } catch (e) {} this.setState({ lang: 'en' }); },
      setHe: () => { try { localStorage.setItem('gotcha-lang', 'he'); } catch (e) {} this.setState({ lang: 'he' }); },
      enBg: st.lang === 'he' ? 'transparent' : '#262521', enFg: st.lang === 'he' ? '#8E8A83' : '#F7F5F1',
      heBg: st.lang === 'he' ? '#262521' : 'transparent', heFg: st.lang === 'he' ? '#F7F5F1' : '#8E8A83',
      trace, replyStarted: step >= 8, replyTyping: step === 8, replyDone: step >= 9,
      bizOpen: !!st.biz,
      bizCards: [
        { key: 'retail', t: 'Retail or ecommerce', tag: 'You sell products',
          d: 'Orders, deliveries, returns, sizes, stock. Most of what people write to you already has an answer inside your store.',
          hintNote: 'nine screens, one night in your shop', icon: 'shopping-bag' },
        { key: 'leads', t: 'Leads and enquiries', tag: 'You sell work',
          d: 'Quotes, availability, appointments, follow-ups. The money is in answering first and asking the right three questions.',
          hintNote: 'nine screens, one lead to a booked meeting', icon: 'user-plus' }
      ].map(c => {
        const on = st.biz === c.key;
        return Object.assign({}, c, {
          pick: () => this.setState({ biz: c.key }),   // one is always selected, so nobody scrolls past an empty section
          hint: on ? 'Showing below' : 'Show me this instead',
          hintFg: on ? '#A8A39A' : '#8E3418',
          on, off: !on,
          bg: on ? '#16150F' : '#FFFFFF',
          bd: on ? '#16150F' : '#E2DCD0',
          shadow: on ? '0 16px 38px rgba(22,21,15,.16)' : 'none',
          fg: on ? '#F7F5F1' : '#16150F',
          tagFg: on ? '#8E8A83' : '#8E887C',
          muted: on ? '#A8A39A' : '#5B564D',
          radioBd: on ? '#F7F5F1' : '#C8C2B6',
          radioBg: on ? '#F7F5F1' : 'transparent',
          radioDot: on ? '#16150F' : 'transparent',
          btnBg: on ? '#F7F5F1' : '#16150F',
          btnFg: on ? '#16150F' : '#F7F5F1',
          btnBd: on ? '#F7F5F1' : '#16150F',
          hintFg: on ? '#8E8A83' : '#8E887C',
          iconBg: on ? '#2A2823' : (c.key === 'retail' ? '#EDF4E7' : '#EAE4FB'),
          iconFg: on ? '#F7F5F1' : (c.key === 'retail' ? '#2E7D5B' : '#4B3E8E'),
          tagFg: on ? '#8E8A83' : '#A29B8E',
          tagBd: on ? '#2E2C28' : '#E8E3D9'
        });
      }),
      biz: (() => {
        const D = {
          retail: {
            accent: '#A8C57A', kicker: 'Retail and ecommerce',
            h: 'Your store already knows the answer. GOTCHA just gets there first.',
            sub: 'Connect Shopify or WooCommerce and it reads your products, your orders, your shipping and returns policy, then answers from them rather than guessing.',
            steps: [
              { n: '01', t: 'It finds the order before it answers', d: 'Name, phone or order number, on any channel. The tracking, the carrier and the real delay, not a template apology.' },
              { n: '02', t: 'Returns and refunds actually happen', d: 'Inside the limit you set it refunds, replaces or opens a return itself. Above it, the decision waits in your approvals with the cost of waiting stated.' },
              { n: '03', t: 'It sells while it answers', d: 'Size and shade questions answered from your own charts, stock checked live, the nearest alternative offered when something is out.' },
              { n: '04', t: 'You see the cause, not the volume', d: 'Two hundred conversations traced to one bad size chart is a thing you fix this afternoon.' }
            ],
            stats: [
              { v: '72%', l: 'of shop questions are order status' },
              { v: '19s', l: 'average first reply, day or night' },
              { v: '₪200', l: 'the refund limit most shops start with' }
            ],
            demoTitle: 'WhatsApp · 02:14', demoMeta: 'nobody awake',
            demo: [
              { t: 'My package still has not arrived and it was a gift.', side: 'in' },
              { t: 'Checked the order, the carrier and your delay policy.', side: 'trace' },
              { t: 'Order #1842 has been stuck since Tuesday, which is not good enough. I have refunded the full ₪179 and can hold one from tomorrow\'s batch.', side: 'out' }
            ],
            demoFoot: 'Refunds under your limit are hers to make. Above it, nobody gets woken up, it waits until morning.',
            cta: 'See the ecommerce playbook', ctaNote: 'orders, returns, sizing, stock',
            railLabel: 'One night in your shop, screen by screen',
            moments: [
              { label: 'A customer writes', screen: 'WhatsApp · 22:41', icon: 'message-circle', time: 'nobody awake',
                t: 'She writes at 22:41. It answers in nineteen seconds.',
                note: 'Order found, carrier checked, refund policy read, six previous orders remembered. Then a reply that sounds like you on a good day.',
                msgs: [
                  { side: 'in', t: 'My package still has not arrived and I have been waiting two weeks. This was a gift.' },
                  { side: 'trace', t: 'found order #1842 · carrier stalled since Tue · limit ₪200 · 6 previous orders' },
                  { side: 'out', t: 'I am sorry, order #1842 has been stuck with the carrier since Tuesday, which is not good enough. I have refunded the full ₪179 and can hold one from tomorrow\'s batch.', meta: 'sent 22:41 · refund already processed' }
                ] },
              { label: 'The inbox', screen: 'Inbox · beside the conversation', icon: 'inbox', panel: 'light', time: 'one view, no second window',
                t: 'Six channels. One inbox. Everything about her beside the conversation.',
                note: 'WhatsApp, Instagram, email, web chat and the phone land in the same place, with the order, the customer and what Copilot did next to the message.',
                title: 'Dana Cohen · order #1842',
                prows: [ { k: 'Order #1842 · linen set, sand, king', v: '₪179', pill: 'Stalled' }, { k: 'Carrier', v: 'no movement since Tuesday' }, { k: 'Copilot', v: 'refunded, reply sent', pill: 'Done' }, { k: 'Also open', v: 'WhatsApp · Instagram · email', pill: 'Synced' } ] },
              { label: 'Your store, connected', screen: 'What Shopify lets GOTCHA do', icon: 'plug', panel: 'light', time: 'you set this once',
                t: 'It reads Shopify. You decide what it may touch.',
                note: 'Looking things up is allowed. Money asks you first. Customer details, never. The same rules apply to every AI employee unless you narrow them.',
                prows: [ { k: 'Find a product', pill: 'Allowed' }, { k: 'Look up an order', pill: 'Allowed' }, { k: 'Check stock', v: '11 sand king left', pill: 'Allowed' }, { k: 'Refund', v: 'up to ₪200 on its own', pill: 'Ask first' }, { k: 'Cancel an order', pill: 'Ask first' }, { k: 'Change customer details', pill: 'Never' } ] },
              { label: 'Above your limit', screen: 'Approvals', icon: 'check-check', panel: 'dark', time: 'requested 01:20 · reversible within 24h',
                t: 'A ₪480 refund waits for you. Nobody gets woken up.',
                note: 'Each decision arrives with why it is recommended, what happens if you approve and what it costs to wait. One key, and Dana is told on WhatsApp.',
                title: 'Refund ₪480 to Dana Cohen',
                prows: [ { k: 'Delivered 4 days ago, marked damaged on arrival', v: 'photo attached' }, { k: 'Inside the 14-day damage window', v: 'policy' }, { k: 'Third contact about this order', v: 'frustrated' } ],
                keys: [ { key: 'A', t: 'Approve' }, { key: 'E', t: 'Edit amount' }, { key: 'R', t: 'Reject' } ], keysNote: 'two more after this' },
              { label: 'One person, every channel', screen: 'Customers · Dana Cohen', icon: 'contact', panel: 'light', time: 'with you since March 2024',
                t: 'It remembers her the way a good shop assistant would.',
                note: 'Sand over grey, ships to a work address, replies fastest in the evening. Six orders, ₪2,140 lifetime, zero refunds, and the promise a colleague made her last week.',
                quote: 'Buys linen twice a year, always in sand. Patient until a delivery slips, then she writes three times in a day.',
                prows: [ { k: 'Lifetime', v: '₪2,140 · 6 orders · 0 refunds' }, { k: 'GOTCHA remembers', v: 'sand over grey · ships to work' }, { k: 'Note · Maya, 25 Aug', v: 'promised a replacement by Thursday' } ] },
              { label: 'Say what you want done', screen: '⌘K · works from every screen', icon: 'terminal', panel: 'dark', time: 'ESC to close',
                t: 'Type "refund dana". It does it.',
                note: 'The same line answers questions and takes actions, from any screen. How many refunds did we give this month, and why? Ask it.',
                title: 'refund dana|',
                prows: [ { k: 'Refund Dana Cohen · order #1842', v: '↵', pill: 'Ask first' }, { k: 'Go to Dana Cohen', v: 'customer · 6 orders · frustrated today' }, { k: 'Go to order #1842', v: '₪179 · in transit · stalled' }, { k: 'Ask: how many refunds did we give this month, and why?', v: '' } ] },
              { label: 'Where the money is', screen: 'Analytics · What conversations are worth', icon: 'trending-up', panel: 'light', time: 'last 7 days',
                t: 'Two hundred conversations traced to one bad size chart.',
                note: 'It groups what people ask about and what those conversations were worth. The thing you fix this afternoon is on this screen, not buried in a transcript.',
                quote: 'Conversations turned into ₪96,600 this week. Two thirds of it came from answering a product question within a minute.',
                prows: [ { k: 'Where is my order', v: '312 conversations', pill: 'Done' }, { k: 'Does this run small', v: '204 · one size chart', pill: 'Open' }, { k: 'Back in stock', v: '141 · ₪18,400 sold' } ] },
              { label: 'Your morning', screen: 'Home · Tuesday, 28 August', icon: 'sunrise', panel: 'light', time: '08:30',
                t: 'Fourteen closed overnight. One decision waiting.',
                note: 'You read the decision, press A, and the day starts. Nothing is sitting unanswered from last night.',
                title: 'Good morning, Maya',
                prows: [ { k: 'Closed overnight by GOTCHA', v: '14', pill: 'Done' }, { k: 'Waiting on you', v: 'refund ₪480 · Dana Cohen', pill: 'Open' }, { k: 'Unanswered from last night', v: '0' } ] },
              { label: 'Where it lands', big: '88%', bigNote: 'of shop conversations answered and closed without a person touching them.',
                t: 'The routine leaves. The judgment stays with you.',
                note: 'Order status, tracking, address changes and returns inside your limits. Everything else, and anything unusual, still comes to a person, with the answer already drafted.' }
            ],
            askTitle: 'The questions it answers without you.',
            askNote: 'Taken from real shop inboxes. Every one of them has an answer somewhere in your store already.',
            asks: ['Where is my order?', 'Can I change the delivery address?', 'Does this run small?', 'Is the black back in stock?', 'I want to exchange for a size up', 'Will it arrive before Friday?', 'What is your return window?', 'Which shade for olive skin?', 'Can I add to my order?'],
            weekTitle: 'Watching on Monday. Answering by Thursday.',
            week: [
              { d: 'Day 1', t: 'It reads your store', b: 'Products, orders, shipping and returns policy, and the last few months of your own replies. Nothing to write, nothing to train.' },
              { d: 'Day 2 to 3', t: 'Watch-only mode', b: 'It drafts what it would have sent on real conversations and you correct it. Your team keeps answering, nothing goes out unseen.' },
              { d: 'Day 4 onwards', t: 'It takes the routine', b: 'Order status, tracking, address changes and returns inside your limits. Everything else still comes to a person.' }
            ],
            before: ['The 22:40 "where is my order" sits until morning, and she has already left a review.', 'Your team retypes the same tracking answer forty times a day.', 'A return request goes quiet for two days and turns into a chargeback.'],
            after: ['She has the tracking, the real delay and a refund within nineteen seconds.', 'Your team sees only the conversations that actually need judgment.', 'Returns open themselves inside your rules, and you see them in the morning.'],
            closer: 'Live in an afternoon, no card to start.',
            page: 'sol-ecommerce'
          },
          leads: {
            accent: '#C9BCF7', kicker: 'Leads and enquiries',
            h: 'The lead that gets an answer in five minutes is the lead you keep.',
            sub: 'It answers the enquiry, asks the two or three things you actually need, books the call in your calendar and hands you a brief instead of a transcript.',
            steps: [
              { n: '01', t: 'It answers while they are still interested', d: 'Instagram, WhatsApp, the form on your site. Same minute, in their language, with the price range you allow it to quote.' },
              { n: '02', t: 'It qualifies with your questions', d: 'Budget, timing, location, scope. Whatever you ask on the phone, asked politely and in order, without interrogating anyone.' },
              { n: '03', t: 'It books, then reminds', d: 'Real availability from your calendar, the slot confirmed, the reminder sent, the no-show rebooked.' },
              { n: '04', t: 'It follows up twice, then stops', d: 'Two nudges, spaced the way a person would, and it tells you which leads went quiet rather than quietly dropping them.' }
            ],
            stats: [
              { v: '5 min', l: 'the window where a lead still replies' },
              { v: '3', l: 'questions to qualify, then a booking' },
              { v: '0', l: 'enquiries left sitting overnight' }
            ],
            demoTitle: 'Instagram DM · 21:40', demoMeta: 'after hours',
            demo: [
              { t: 'How much for a kitchen, roughly? We are in Haifa.', side: 'in' },
              { t: 'Checked your price ranges, your service area and Thursday\'s diary.', side: 'trace' },
              { t: 'For a kitchen your size it is usually ₪28k to ₪40k depending on the doors. We do work in Haifa. Thursday 10:00 or 16:00 for a measure and a real number?', side: 'out' }
            ],
            demoFoot: 'It quotes only inside the ranges you set. Anything unusual comes to you with the answer already drafted.',
            cta: 'See the lead handling playbook', ctaNote: 'qualifying, booking, follow-up',
            railLabel: 'One lead, from the first message to a booked meeting',
            moments: [
              { label: 'A lead comes in', screen: 'Instagram DM · 21:40', icon: 'instagram', time: 'after hours',
                t: 'She asks at 21:40. Your AI employee answers in fourteen seconds.',
                note: 'It quotes only inside the range you set, confirms the service area and offers two real slots from your calendar. Nobody on your team is awake.',
                msgs: [
                  { side: 'in', t: 'How much for a kitchen, roughly? We are in Haifa.' },
                  { side: 'trace', t: 'price range: kitchens ₪28k to ₪40k · Haifa inside zone · Thu 10:00 / 16:00 open' },
                  { side: 'out', t: 'For a kitchen your size it is usually ₪28k to ₪40k depending on the doors, and yes, we work in Haifa. Thursday 10:00 or 16:00 for a measure and a real number?', meta: 'sent 21:40 · 14 seconds after she wrote' }
                ] },
              { label: 'They get talking', screen: 'Instagram DM · 21:46', icon: 'instagram', time: 'qualifying',
                t: 'It asks your three questions, politely, in order.',
                note: 'Budget, timing, scope. Whatever you ask on the phone, asked the way a person would, and the meeting booked while she is still interested.',
                msgs: [
                  { side: 'in', t: 'Closer to 40 then. Do you handle the permits, and could we do 16:00?' },
                  { side: 'out', t: 'We handle the permits. Thursday 16:00 is yours, and I have sent you the two measurements to have ready so the visit takes twenty minutes.', meta: 'booked · reminder set for Wednesday night' }
                ] },
              { label: 'Everything lands in your CRM', screen: 'Your CRM · deal updated', icon: 'database', panel: 'light', time: 'written 21:47 · nobody typed it',
                t: 'The contact, the deal, the notes, the meeting. All of it in your CRM, as it happens.',
                note: 'HubSpot, Zoho, monday.com, Salesforce or your own system. Every message, every answer she gave and every promise made is written to her record the moment it happens, so your team opens the CRM and finds the whole story there.',
                title: 'Kitchen, Haifa · ₪34,000',
                prows: [ { k: 'Contact created', v: 'Instagram DM · after hours', pill: 'Synced' }, { k: 'Stage', v: 'Meeting booked · Thu 16:00', pill: 'Booked' }, { k: 'Notes', v: 'budget ~₪40k · permits · 6 to 8 doors', pill: 'Synced' }, { k: 'Conversation', v: 'full transcript attached', pill: 'Synced' }, { k: 'Owner', v: 'Matan · notified on WhatsApp' } ],
                keys: [ { key: 'H', t: 'HubSpot' }, { key: 'Z', t: 'Zoho' }, { key: 'M', t: 'monday' } ], keysNote: 'or the system you already use' },
              { label: 'What it already knew', screen: 'Customers · her record', icon: 'contact', panel: 'light', time: 'before replying',
                t: 'Everything it used to answer her, in one record you can open.',
                note: 'First wrote on 2 August about worktops. Haifa, inside your zone. Asked for a range, not a discount. Replies in the evening within minutes.',
                quote: 'Asked for a range, not a discount. Replies fastest in the evening, usually within minutes.',
                prows: [ { k: 'First wrote', v: '2 Aug · worktops' }, { k: 'Location', v: 'Haifa · inside your zone' }, { k: 'Interest', v: 'kitchen · 6 to 8 doors' }, { k: 'Also reaches you on', v: 'WhatsApp · Instagram' } ] },
              { label: 'Call pilot', screen: 'On the call · Copilot is listening', icon: 'phone-call', panel: 'dark', time: '1:24', wave: true, waveLabel: 'Hebrew · translating as she speaks',
                t: 'On the call, it tells you what to say. And when to ask for the meeting.',
                note: 'It listens, finds what she was promised, checks the diary while she talks, and puts the next line in front of you. Book the meeting now.',
                quote: 'Book the meeting now and I will hold Sunday 11:00 while we talk. Shall I put you in?',
                prows: [ { k: 'Found the promise from 25 Aug', v: 'Tomer, replacement' }, { k: 'Checked Sunday\'s diary', v: '11:00 open' } ],
                keys: [ { key: '↵', t: 'Read it out' }, { key: 'S', t: 'Softer' } ], keysNote: 'attached to her record when the call ends' },
              { label: 'Hire it for enquiries', screen: 'Studio · your AI employee', icon: 'user-plus', panel: 'light', time: 'hired by you, 09:41',
                t: 'Watch-only for a week. Then it answers on its own.',
                note: 'This week it drafts and tells you. From next week it answers, inside the ranges and hours you set. About two things a day will still reach you.',
                title: 'Enquiries is working',
                prows: [ { k: 'This week it drafts, and tells you', v: 'nothing reaches a customer without you', pill: 'Ask first' }, { k: 'From 11 September it answers on its own', v: 'Instagram, WhatsApp, web form · any hour', pill: 'Open' }, { k: 'About two things a day will reach you', v: 'discounts · jobs outside your zone' } ] },
              { label: 'It follows up, then stops', screen: 'Outreach · in flight', icon: 'send', panel: 'light', time: 'this week',
                t: 'Two nudges, spaced like a person would. Then it tells you who went quiet.',
                note: 'A day of silence gets a message, another gets a call, and the ones who chose not to answer are named rather than quietly dropped.',
                prows: [ { k: 'Quiet since Thursday · 14 leads', v: 'WhatsApp nudge · day 1', pill: 'Done' }, { k: 'Still quiet · 6 leads', v: 'GOTCHA called · day 3 · 4 answered', pill: 'Done' }, { k: 'Chose not to answer · 2 leads', v: 'named in your CRM, not dropped', pill: 'Synced' } ] },
              { label: 'Your morning', screen: 'Home · Thursday, 30 August', icon: 'sunrise', panel: 'light', time: '08:30',
                t: 'Three qualified leads. Two meetings booked. One decision for you.',
                note: 'Each one with a brief, not a transcript. The discount somebody asked for is waiting with the reply already drafted.',
                title: 'Good morning, Matan',
                prows: [ { k: 'Qualified overnight', v: '3 leads · briefs ready', pill: 'Done' }, { k: 'Meetings booked', v: 'Thu 16:00 · Sun 11:00', pill: 'Booked' }, { k: 'Waiting on you', v: 'a discount request · reply drafted', pill: 'Open' } ] },
              { label: 'Where it lands', big: '5 min', bigNote: 'the window where a lead still replies, and the reason it answers first, every time.',
                t: 'Zero enquiries left sitting overnight.',
                note: 'The lead that gets an answer in five minutes is the lead you keep. Everything unusual, a discount, a special job, still comes to you, drafted.' }
            ],
            askTitle: 'The questions it answers before you wake up.',
            askNote: 'Taken from real enquiry inboxes. Answering these fast is most of what wins the job.',
            asks: ['How much does it cost?', 'Do you work in my area?', 'When could you start?', 'Can I see examples?', 'Is a consultation free?', 'Can we do Thursday instead?', 'How long does it take?', 'Do you handle the permits?', 'Are you available next month?'],
            weekTitle: 'Every enquiry answered in the same minute.',
            week: [
              { d: 'Day 1', t: 'It learns what you sell', b: 'Your services, your price ranges, your service area and the questions you always ask before quoting.' },
              { d: 'Day 2 to 3', t: 'Watch-only mode', b: 'It drafts the reply and the qualifying questions on real enquiries. You approve, correct, and it learns your line.' },
              { d: 'Day 4 onwards', t: 'It answers and books', b: 'Ranges quoted inside your limits, calls booked in your calendar, follow-ups sent twice and then stopped.' }
            ],
            before: ['The 21:40 DM gets an answer at 09:15, by which time she has three other quotes.', 'You qualify the same three things on every call, and half of them were never a fit.', 'Two leads a week go quiet because nobody remembered to follow up.'],
            after: ['She has a range, your service area confirmed and a slot held, in the same minute.', 'You walk into calls with the brief already written and the questions answered.', 'Nothing goes quiet, and you see exactly which leads chose not to answer.'],
            closer: 'Live in an afternoon, no card to start.',
            page: 'sol-leads'
          }
        };
        const KIND = {
          in: { label: null, bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', iconBg: '#EDF4E7', iconFg: '#2E7D5B', metaFg: '#A29B8E', noteFg: '#8E887C', size: '15px', weight: '400', ls: '-0.006em', shadow: '0 10px 30px rgba(22,21,15,.05)' },
          work: { label: 'GOTCHA is working', icon: 'sparkles', bg: '#16150F', bd: '#16150F', fg: '#F7F5F1', iconBg: '#2A2823', iconFg: '#A8C57A', metaFg: '#8E8A83', noteFg: '#A8A39A', size: '14.5px', weight: '400', ls: '-0.004em', shadow: '0 14px 40px rgba(22,21,15,.18)' },
          out: { label: 'GOTCHA replied', icon: 'corner-up-left', bg: '#FFFFFF', bd: '#F0D6C9', fg: '#16150F', iconBg: '#FBEEE8', iconFg: '#C4552F', metaFg: '#A29B8E', noteFg: '#8E887C', size: '15px', weight: '400', ls: '-0.006em', shadow: '0 14px 40px rgba(196,85,47,.10)' },
          stat: { icon: 'trending-up', bg: '#F5F2EC', bd: '#F5F2EC', fg: '#16150F', iconBg: '#EFEAE1', iconFg: '#7A6A4F', metaFg: '#A29B8E', noteFg: '#6B6660', size: '30px', weight: '600', ls: '-0.032em', shadow: 'none' },
          wait: { label: 'Waiting for you', icon: 'check-check', bg: '#F7F0E2', bd: '#EADFC0', fg: '#4A3A12', iconBg: '#EFE3C4', iconFg: '#8A6A16', metaFg: '#A08C52', noteFg: '#6B5A24', size: '15px', weight: '400', ls: '-0.006em', shadow: 'none' },
          morning: { label: 'Your morning', icon: 'sunrise', bg: '#EDF4E7', bd: '#D6E4C9', fg: '#25321F', iconBg: '#DCE9D0', iconFg: '#2E7D5B', metaFg: '#6E8A5E', noteFg: '#3E5233', size: '15px', weight: '400', ls: '-0.006em', shadow: 'none' },
          crm: { label: 'Your CRM', icon: 'database', bg: '#EDF1F7', bd: '#D8E1EE', fg: '#1B2836', iconBg: '#DCE6F3', iconFg: '#3E5C99', metaFg: '#7A8BA3', noteFg: '#3E5061', size: '15px', weight: '400', ls: '-0.006em', shadow: 'none' },
          context: { label: 'What it already knew', icon: 'contact', bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', iconBg: '#EFEAE1', iconFg: '#7A6A4F', metaFg: '#A29B8E', noteFg: '#8E887C', size: '15px', weight: '400', ls: '-0.006em', shadow: '0 10px 30px rgba(22,21,15,.05)' },
          call: { label: 'Call pilot', icon: 'phone-call', bg: '#EAE4FB', bd: '#D8CFF5', fg: '#241C4A', iconBg: '#DED5FA', iconFg: '#4B3E8E', metaFg: '#8078AE', noteFg: '#463C7A', size: '15px', weight: '400', ls: '-0.006em', shadow: '0 14px 40px rgba(75,62,142,.10)' }
        };
        const b = D[st.biz] || D.retail;
        return Object.assign({}, b, {
          accentInk: st.biz === 'leads' ? '#4B3E8E' : '#2E7D5B',
          moments: (b.moments || []).map((m, i) => {
            const side = i % 2 === 0 ? 'left' : 'right';
            const accent = st.biz === 'leads' ? '#C9BCF7' : '#A8C57A';
            const kind = m.msgs ? 'chat' : m.panel ? 'panel' : 'stat';
            const dark = m.panel === 'dark';
            const PILL = { stalled: ['#FBEEE8', '#C4552F'], allowed: ['#EDF4E7', '#2E7D5B'], 'ask first': ['#F7F0E2', '#8A6A16'], never: ['#EFEAE1', '#7A6A4F'], booked: ['#EDF4E7', '#2E7D5B'], synced: ['#EDF1F7', '#3E5C99'], open: ['#EAE4FB', '#4B3E8E'], done: ['#EDF4E7', '#2E7D5B'] };
            const keyBase = dark ? { bg: '#262521', fg: '#F7F5F1', bd: '#2E2C28', keyBd: '#4A4740', anim: 'none' } : { bg: '#FFFFFF', fg: '#16150F', bd: '#E8E3D9', keyBd: '#DCD8D0', anim: 'none' };
            const keyHot = dark ? { bg: '#F7F5F1', fg: '#16150F', bd: '#F7F5F1', keyBd: '#C8C2B6', anim: 'gkey 2.2s ease-in-out infinite' } : { bg: '#16150F', fg: '#F7F5F1', bd: '#16150F', keyBd: '#4A4740', anim: 'gkey 2.2s ease-in-out infinite' };
            const B = { in: { bg: '#262521', fg: '#F7F5F1', radius: '14px 14px 14px 4px', align: 'flex-start', pad: '11px 14px', size: '13.5px', font: 'Archivo, sans-serif' },
                        out: { bg: '#F7F5F1', fg: '#16150F', radius: '14px 14px 4px 14px', align: 'flex-end', pad: '11px 14px', size: '13.5px', font: 'Archivo, sans-serif' },
                        trace: { bg: 'transparent', fg: '#8E8A83', radius: '0', align: 'flex-start', pad: '2px 4px', size: '11.5px', font: "'IBM Plex Mono', monospace" } };
            return Object.assign({}, m, {
              n: String(i + 1).padStart(2, '0'),
              side, isLeft: side === 'left', isRight: side === 'right',
              isChat: kind === 'chat', isStat: kind === 'stat', isPanel: kind === 'panel',
              accent, icon: m.icon || 'sparkles', screen: m.screen || m.label, note: m.note || '', time: m.time || '',
              panelBg: dark ? '#16150F' : '#FFFFFF', panelFg: dark ? '#F7F5F1' : '#16150F', panelBd: dark ? '#16150F' : '#E8E3D9',
              panelMuted: dark ? '#8E8A83' : '#8E887C', panelLine: dark ? '#2A2823' : '#EFEAE1', quoteBg: dark ? '#262521' : '#F5F2EC',
              title: m.title || '', titleText: (m.title || '').replace(/\|$/, ''), cursor: /\|$/.test(m.title || ''), quote: m.quote || '',
              wave: !!m.wave, waveLabel: m.waveLabel || '', waveBars: [10, 16, 22, 14, 26, 18, 12, 24, 16, 20, 10, 22, 14, 18].map((h, j) => ({ h: h + 'px', d: (j * 0.09).toFixed(2) + 's' })),
              prows: (m.prows || []).map(r => { const p = PILL[(r.pill || '').toLowerCase()] || ['#EFEAE1', '#55524C']; return { k: r.k, v: r.v || '', pill: r.pill || '', pillBg: p[0], pillFg: p[1] }; }),
              hasKeys: !!(m.keys && m.keys.length), keysNote: m.keysNote || '',
              keys: (m.keys || []).map((k, j) => Object.assign({}, j === 0 ? keyHot : keyBase, { key: k.key, t: k.t })),
              msgs: (m.msgs || []).map(g => Object.assign({}, B[g.side] || B.in, g, { meta: g.meta || '' })),
              big: m.big || '', bigNote: m.bigNote || '',
              rowsBd: (m.rows && m.rows.length) ? '#E8E3D9' : 'transparent',
              rowsPad: (m.rows && m.rows.length) ? '12px' : '0',
              rowsMt: (m.rows && m.rows.length) ? '4px' : '0',
              rowsText: (m.rows || []).map(r => r.k + '  ·  ' + r.v).join('\n')
            });
          }),
          go: () => { this.setState({ menu: null, page: b.page }); window.scrollTo(0, 0); },
          steps: b.steps.map((s, i) => Object.assign({}, s, { delay: (120 + i * 90) + 'ms' })),
          stats: b.stats.map((s, i) => Object.assign({}, s, { delay: (420 + i * 90) + 'ms' })),
          demo: b.demo.map((m, i) => Object.assign({}, m, {
            delay: (240 + i * 260) + 'ms',
            ml: m.side === 'out' ? 'auto' : '0',
            bg: m.side === 'out' ? '#F7F5F1' : (m.side === 'trace' ? 'transparent' : '#262521'),
            fg: m.side === 'out' ? '#16150F' : (m.side === 'trace' ? '#8E8A83' : '#F7F5F1'),
            radius: m.side === 'out' ? '14px 14px 4px 14px' : (m.side === 'trace' ? '0' : '14px 14px 14px 4px')
          }))
        });
      })(),
      logoFail,
      channels: [
        { t: 'WhatsApp', logo: L('whatsapp', '25D366') },
        { t: 'Instagram', logo: L('instagram', 'E4405F') },
        { t: 'Facebook', logo: L('facebook', '0866FF') },
        { t: 'Slack', icon: 'slack', noLogo: true },
        { t: 'Outlook', icon: 'mail-open', noLogo: true },
        { t: 'Gmail', logo: L('gmail', 'EA4335') },
        { t: 'Web chat', icon: 'message-circle', noLogo: true },
        { t: 'Phone', icon: 'phone-call', noLogo: true }
      ],

      logos: ['AVIV & CO.', 'Terra Ceramics', 'Nordi', 'Studio Dan', 'Halva', 'Beit Kafe', 'Lume'],

      heroStats: [
        { w: 'Faster', l: 'first response time' },
        { w: 'Shorter', l: 'average resolution time' },
        { w: 'Higher', l: 'first contact resolution' },
        { w: 'More', l: 'conversations handled per team member' },
        { w: 'Fewer', l: 'missed customer interactions' }
      ],

      shotTabs: SHOTS.map((t, i) => ({
        t, pick: () => this.setState({ shot: i }),
        bg: i === st.shot ? '#16150F' : '#FFFFFF',
        fg: i === st.shot ? '#FAF8F4' : '#5B564D',
        bd: i === st.shot ? '#16150F' : '#E8E3D9'
      })),
      isHome: st.shot === 0, isInbox: st.shot === 1, isApprovals: st.shot === 2,
      shotCaption: CAPTIONS[st.shot],

      railItems: [
        { t: 'Home', bg: st.shot === 0 ? '#262626' : 'transparent', fg: st.shot === 0 ? '#F7F5F1' : '#9A968E', dot: st.shot === 0 ? '#C9BCF7' : '#3A3A3A', n: '', live: true, pick: () => this.setState({ shot: 0 }) },
        { t: 'Inbox', bg: st.shot === 1 ? '#262626' : 'transparent', fg: st.shot === 1 ? '#F7F5F1' : '#9A968E', dot: st.shot === 1 ? '#C9BCF7' : '#3A3A3A', n: '14', live: true, pick: () => this.setState({ shot: 1 }) },
        { t: 'Approvals', bg: st.shot === 2 ? '#262626' : 'transparent', fg: st.shot === 2 ? '#F7F5F1' : '#9A968E', dot: st.shot === 2 ? '#C9BCF7' : '#3A3A3A', n: '3', live: true, pick: () => this.setState({ shot: 2 }) },
        { t: 'Customers', bg: 'transparent', fg: '#9A968E', dot: '#3A3A3A', n: '', pick: null },
        { t: 'Outreach', bg: 'transparent', fg: '#9A968E', dot: '#3A3A3A', n: '', pick: null },
        { t: 'Studio', bg: 'transparent', fg: '#9A968E', dot: '#3A3A3A', n: '', pick: null },
        { t: 'Analytics', bg: 'transparent', fg: '#9A968E', dot: '#3A3A3A', n: '', pick: null }
      ],

      convos: [
        { in: 'DC', n: 'Dana Cohen', t: '2m', m: "Still nothing. This is the third time I'm writing.", tag: 'Shipping · third time', tc: '#B0472A', tb: '#F6E3DC', edge: '#C4552F', bg: '#FFFFFF', w: '600' },
        { in: 'RS', n: 'Rotem Shani', t: '9m', m: 'Can I cancel? It hasn\'t shipped yet I think', tag: 'Cancel · packs 11:20', tc: '#8A6A16', tb: '#F6EFD8', edge: '#E0B341', bg: 'transparent', w: '500' },
        { in: 'AK', n: 'Adi Katz', t: '14m', m: 'Do you deliver to Eilat next day?', tag: 'Wants to buy', tc: '#4F7A2E', tb: '#E7F0D4', edge: '#A8C57A', bg: 'transparent', w: '500' },
        { in: 'NG', n: 'Noa Gil', t: '26m', m: 'The towels arrived, thank you! Quick question…', tag: 'Product question', tc: '#6B6660', tb: '#F0EDE7', edge: 'transparent', bg: 'transparent', w: '400' },
        { in: 'DA', n: 'Dan Amrani', t: '41m', m: 'Sending the trade form now', tag: 'Wholesale', tc: '#4B3E8E', tb: '#EAE4FB', edge: 'transparent', bg: 'transparent', w: '400' },
        { in: 'YM', n: 'Yael Mor', t: '1h', m: 'Is the sand king back in stock?', tag: 'Waiting on stock', tc: '#6B6660', tb: '#F0EDE7', edge: 'transparent', bg: 'transparent', w: '400' }
      ],

      approvals: [
        { t: 'Refund ₪179', d: 'Dana Cohen · damaged item', u: 'Waiting 21 minutes', uc: '#8E887C', edge: '#16150F', bg: '#FFFFFF', w: '600' },
        { t: 'Cancel order #4812', d: 'Rotem Shani · not shipped', u: 'Packs at 11:20, 38 min', uc: '#B0472A', edge: '#E0B341', bg: 'transparent', w: '500' },
        { t: 'Send to 640 customers', d: 'Autumn restock · WhatsApp', u: 'Scheduled 14:00', uc: '#8E887C', edge: 'transparent', bg: 'transparent', w: '500' }
      ],

      homeStats: [
        { l: 'Conversations today', v: '412', c: '#16150F' },
        { l: 'Handled by GOTCHA', v: '367', c: '#16150F' },
        { l: 'Need a person', v: '14', c: '#B0472A' },
        { l: 'Waiting on you', v: '3', c: '#8A6A16' }
      ],
      attention: [
        { t: 'Dana Cohen is asking a third time', d: 'Shipping · ₪4,180 customer', cta: 'Open', edge: '#C4552F' },
        { t: 'Cancel #4812 expires in 38 minutes', d: 'After that it costs ₪28 to return', cta: 'Decide', edge: '#E0B341' },
        { t: 'Returns platform is not responding', d: '11 exchanges held rather than guessed', cta: 'Fix', edge: '#C4552F' },
        { t: '22 people asked for navy towels', d: "You don't stock them · second week", cta: 'See', edge: 'transparent' }
      ],
      handled: [
        { t: 'Refunded ₪64 to Adi Katz', at: '07:40' },
        { t: 'Opened 2 returns', at: '08:15' },
        { t: 'Booked a studio visit for Friday', at: '09:02' },
        { t: 'Recovered a ₪740 cart', at: '09:26' }
      ],

      problems: [
        { t: 'Six inboxes, one person', icon: 'inbox', bg: '#FBEEE8', ic: '#C4552F',
          d: 'She wrote on Instagram in March and WhatsApp today. Your team has no idea it is the same customer, so she explains herself again.',
          k: 'The average SMB answers across 4 channels' },
        { t: 'The shift nobody works', icon: 'moon', bg: '#EDF1F7', ic: '#3E5C99',
          d: 'Most of what people ask arrives outside your hours. By morning, some of them have bought somewhere else.',
          k: 'The evening is when customers write' },
        { t: 'Nobody trusts software with money', icon: 'shield', bg: '#EDF4E7', ic: '#2E7D5B',
          d: 'Which is correct. So the question is not whether to let it act, but exactly how far, and that has to be yours to set.',
          k: 'Every action reversible, every limit yours' }
      ],

      ucTabs: UC.map((u, i) => ({
        t: u.t, pick: () => this.setState({ uc: i }),
        bg: i === st.uc ? '#16150F' : 'transparent',
        fg: i === st.uc ? '#FAF8F4' : '#6B6660',
        shadow: i === st.uc ? '0 6px 16px rgba(22,21,15,.18)' : 'none'
      })),
      uc: UC[st.uc],

      perms: [
        { t: 'Look up an order', n: 'used 904 times this week', b0: '#F7F5F1', c0: '#121212', b1: 'transparent', c1: '#7A766F', b2: 'transparent', c2: '#7A766F' },
        { t: 'Check stock', n: 'used 288 times', b0: '#F7F5F1', c0: '#121212', b1: 'transparent', c1: '#7A766F', b2: 'transparent', c2: '#7A766F' },
        { t: 'Refund up to ₪200', n: '41 this month · none disputed', b0: '#F7F5F1', c0: '#121212', b1: 'transparent', c1: '#7A766F', b2: 'transparent', c2: '#7A766F' },
        { t: 'Refund more than ₪200', n: 'comes to you', b0: 'transparent', c0: '#7A766F', b1: '#E8D9A8', c1: '#2A2412', b2: 'transparent', c2: '#7A766F' },
        { t: 'Cancel an order', n: 'comes to you', b0: 'transparent', c0: '#7A766F', b1: '#E8D9A8', c1: '#2A2412', b2: 'transparent', c2: '#7A766F' },
        { t: "Change a customer's details", n: 'your team only', b0: 'transparent', c0: '#7A766F', b1: 'transparent', c1: '#7A766F', b2: '#E4A88F', c2: '#2A1712' }
      ],

      intGroups: [
        { t: 'Channels', d: 'where your customers actually write', items: [
          { t: 'WhatsApp', logo: L('whatsapp', '25D366'), bg: '#EDF4E7', ic: '#2E7D5B' },
          { t: 'Instagram', logo: L('instagram', 'E4405F'), bg: '#FBEEE8', ic: '#C4552F' },
          { t: 'Messenger', logo: L('messenger', '0084FF'), bg: '#EDF1F7', ic: '#3E5C99' },
          { t: 'Email', logo: L('gmail', 'EA4335'), bg: '#FBEEE8', ic: '#C4552F' },
          { t: 'Web chat', icon: 'globe', noLogo: true, bg: '#F0EDE7', ic: '#55524C' },
          { t: 'Phone', icon: 'phone', noLogo: true, bg: '#F0EDE7', ic: '#55524C' }
        ] },
        { t: 'Systems of record', d: 'the data it reads, writes and acts on', items: [
          { t: 'Shopify', logo: L('shopify', '7AB55C'), bg: '#EDF4E7', ic: '#2E7D5B' },
          { t: 'WooCommerce', logo: L('woocommerce', '96588A'), bg: '#F3EEF5', ic: '#7A6A4F' },
          { t: 'HubSpot', logo: L('hubspot', 'FF7A59'), bg: '#FBEEE8', ic: '#7A6A4F' },
          { t: 'Salesforce', icon: 'cloud', noLogo: true, bg: '#EDF1F7', ic: '#3E5C99' },
          { t: 'monday.com', icon: 'kanban', noLogo: true, bg: '#FBEEE8', ic: '#C4552F' },
          { t: 'Airtable', logo: L('airtable', '18BFFF'), bg: '#EDF1F7', ic: '#3E5C99' },
          { t: 'Zoho CRM', logo: L('zoho', 'E42527'), bg: '#FBEEE8', ic: '#C4552F' },
          { t: 'Your ERP', icon: 'server', noLogo: true, bg: '#F0EDE7', ic: '#55524C' }
        ] },
        { t: 'Add-ons', d: 'the smaller tools it can operate for you', items: [
          { t: 'ReturnGO', icon: 'undo-2', noLogo: true, bg: '#EFEBFA', ic: '#4B3E8E' },
          { t: 'Google Calendar', logo: L('googlecalendar', '4285F4'), bg: '#EDF1F7', ic: '#3E5C99' },
          { t: 'Google Drive', logo: L('googledrive', '4285F4'), bg: '#EDF1F7', ic: '#8A6A16' },
          { t: 'Slack', icon: 'hash', noLogo: true, bg: '#F3EEF5', ic: '#7A6A4F' },
          { t: 'Stripe', icon: 'credit-card', noLogo: true, bg: '#EFEBFA', ic: '#4B3E8E' },
          { t: 'Zapier', logo: L('zapier', 'FF4F00'), bg: '#FBEEE8', ic: '#C4552F' }
        ] }
      ],

      quotes: [
        { t: '"I stopped checking the phone in the evening. That is the whole review, really. The evenings came back."', n: 'Maya Levi', r: 'Founder, linen & bath textiles', slot: 'q1' },
        { t: '"It refunded ₪179 at two in the morning and she left us a five star review the next day. I would have seen that message at nine."', n: 'Tomer Adler', r: 'Customer lead, 4-person team', slot: 'q2' }
      ].map(q => Object.assign({}, q, { ini: q.n.split(' ').map(w => w[0]).join('') })),

      plans: [
        { name: 'Start', badge: null, price: '₪490', per: '/ month', sub: 'Up to 1,500 conversations a month',
          bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#8E887C', dot: '#C8C2B6',
          feats: ['WhatsApp, Instagram, email and web chat', 'One AI employee', 'Your whole team, no per-seat charge', 'Approvals, limits and the full log', 'Shopify or your CRM'],
          cta: 'Start free', btnBg: '#FFFFFF', btnFg: '#16150F', btnBd: '#D8D2C6' },
        { name: 'Growth', badge: 'Most businesses', badgeBg: '#EFD9CD', badgeFg: '#5C2410', price: '₪1,290', per: '/ month', sub: 'Up to 5,000 conversations a month',
          bg: '#16150F', bd: '#16150F', fg: '#F7F5F1', muted: '#A29D95', dot: '#4A4740',
          feats: ['Everything in Start', 'Unlimited AI employees, split by responsibility', 'Copilot beside your team in every conversation', 'Outreach: campaigns, templates, scheduled sends', 'Analytics that name the cause', 'Automations and routing'],
          cta: 'Start free', btnBg: '#F7F5F1', btnFg: '#16150F', btnBd: '#F7F5F1' },
        { name: 'Full operation', badge: null, price: 'Talk to us', per: '', sub: 'From 15,000 conversations',
          bg: '#FFFFFF', bd: '#E8E3D9', fg: '#16150F', muted: '#8E887C', dot: '#C8C2B6',
          feats: ['Everything in Growth', 'Phone: it answers, transcribes and calls out', 'Copilot live on calls', 'ERP and custom systems', 'Departments, roles and audit export', 'Someone whose job is your account'],
          cta: 'Book 20 minutes', btnBg: '#FFFFFF', btnFg: '#16150F', btnBd: '#D8D2C6' }
      ],

      trades: [
        { t: 'Fashion & apparel', ask: 'Does it run small, where is my order, can I swap the colour',
          lede: 'Sizing and exchanges are most of your inbox, and both are answerable from what you already published.',
          does: ['Reads your size chart and answers on the specific item', 'Finds the order and opens an exchange in Shopify', 'Sends the return label and follows the tracking'],
          gain: ['Fewer returns, because the sizing question gets answered before the order', 'Exchanges close overnight instead of over three days'] },
        { t: 'Beauty & skincare', ask: 'Which shade, is it safe for me, when is it back in stock',
          lede: 'Advice questions that used to need you, answered from your own product pages and past replies.',
          does: ['Matches a shade or a routine from the questions it asks back', 'Reads ingredients and flags what your policy says', 'Tells them the real restock date and messages when it lands'],
          gain: ['The advice conversation happens at the moment of buying, not the next morning', 'Restock demand becomes a list instead of a guess'] },
        { t: 'Home & furniture', ask: 'How long is the lead time, will it fit, who carries it up',
          lede: 'High-value, slow decisions where one unanswered measurement question loses the sale.',
          does: ['Quotes dimensions, materials and the current lead time per fabric', 'Checks stock and books the delivery slot', 'Passes anything over your limit to a person with the full picture'],
          gain: ['Quotes go out the same evening the question is asked', 'Delivery days stop being a phone queue'] },
        { t: 'Jewellery & gifting', ask: 'Is it solid gold, does it come certified, can it arrive by Friday',
          lede: 'Trust questions with a deadline attached. Both parts have to be answered fast.',
          does: ['Quotes the exact spec and what ships with the piece', 'Holds a piece and confirms engraving or sizing', 'Checks whether the courier can still make the date'],
          gain: ['Gift deadlines stop being lost to a slow reply', 'The certificate and warranty question stops repeating'] },
        { t: 'Food & grocery', ask: 'What is in it, when does it arrive, an item is missing',
          lede: 'Volume, allergens and time pressure. Most of it is a lookup, not a judgement.',
          does: ['Answers allergens and ingredients from your own product data', 'Reads the delivery window and the courier status', 'Refunds a missing item inside the limit you set'],
          gain: ['Missing-item complaints resolve in one message, at any hour', 'Your team keeps the calls that actually need a person'] },
        { t: 'Clinics & services', ask: 'Do you have anything this week, what does it cost, what do I bring',
          lede: 'Bookings that arrive after hours and go to whoever answers first.',
          does: ['Offers real availability and books it in your calendar', 'Sends prices, prep instructions and reminders', 'Reschedules and fills a cancelled slot from the waiting list'],
          gain: ['Evening enquiries become next-day appointments', 'Fewer no-shows, because the reminder and the prep actually arrive'] },
        { t: 'B2B & wholesale', ask: 'What is the price at this quantity, minimum order, where is my invoice',
          lede: 'Repeat buyers who want a number, not a conversation, and a paper trail afterwards.',
          does: ['Pulls the price list and the terms for that account', 'Drafts the quote and logs it against the customer in your CRM', 'Finds invoices and chases an unanswered PO'],
          gain: ['Quotes answered in minutes, including outside office hours', 'Every conversation lands in the CRM without anyone copying it'] },
        { t: 'Trade & installers', ask: 'Do you cover my area, what does a visit cost, when can you come',
          lede: 'Leads that arrive while you are on a roof, and go cold before you climb down.',
          does: ['Qualifies the job: area, scope, urgency, photos', 'Books the site visit into your calendar', 'Writes the lead and the notes into your CRM'],
          gain: ['No lead waits until the end of the working day', 'You arrive at the visit already knowing the job'] }
      ].map((x, i) => ({
        ...x,
        n: String(i + 1).padStart(2, '0'),
        open: st.trade === i,
        mark: st.trade === i ? '–' : '+',
        fg: st.trade === i ? '#F7F5F1' : '#DCD8D0',
        numFg: st.trade === i ? '#E8D9A8' : '#6E6A63',
        toggle: () => this.setState(s => ({ trade: s.trade === i ? -1 : i }))
      })),

      centers: [
        { t: 'Help center', icon: 'book-open', bg: '#FBEEE8', ic: '#C4552F',
          d: 'How to set it up, what each setting does, and the playbook for your trade. Written by the people who built it and kept current.',
          items: ['Getting started in an afternoon', 'Permissions, limits and approvals', '148 articles, all public'], cta: 'Open the help center',
          go: () => { this.setState({ menu: null, page: 'co-help' }); window.scrollTo(0, 0); } },
        { t: 'Security', icon: 'shield-check', bg: '#EDF4E7', ic: '#2E7D5B',
          d: 'Where your customers\' conversations live, who can reach them, and what we will never do with them. Published, not on request.',
          items: ['GDPR aligned, DPA on request', 'Encryption, access and retention', 'What the AI is never trained on'], cta: 'Read our security posture',
          go: () => { this.setState({ menu: null, page: 'co-security' }); window.scrollTo(0, 0); } },
        { t: 'Journal', icon: 'newspaper', bg: '#EAE4FB', ic: '#4B3E8E',
          d: 'What we learn from other people\'s inboxes. Notes on customer conversations, and on AI that acts rather than only replies.',
          items: ['The shift nobody works', 'Answering is easy. Acting is the job.', 'Do it, ask me, never'], cta: 'Read the journal',
          go: () => { this.setState({ menu: null, page: 'co-blog', post: null }); window.scrollTo(0, 0); } }
      ],

      faqs: FAQ.map((f, i) => ({
        q: f[0], a: f[1],
        toggle: () => this.setState(s => ({ faq: s.faq === i ? -1 : i })),
        sign: st.faq === i ? '−' : '+',
        h: st.faq === i ? '280px' : '0px',
        o: st.faq === i ? 1 : 0
      })),

      badges: [
        { t: 'GDPR aligned', icon: 'file-check', ic: '#3E5C99' },
        { t: 'Meta Business Partner', icon: 'badge-check', ic: '#3E5C99' },
        { t: 'Encrypted in transit and at rest', icon: 'lock', ic: '#7A6A4F' },
        { t: 'Role-based access', icon: 'shield-check', ic: '#2E7D5B' }
      ],

      footer: (() => {
        const go = (p) => () => { this.setState({ menu: null, page: p }); window.scrollTo(0, 0); };
        const M = {
          'Omnichannel': 'feat-omnichannel', 'Social engagement': 'feat-social', 'Your new employee': 'feat-employee',
          'Copilot': 'feat-copilot', 'Call pilot (beta)': 'feat-callpilot', 'Knowledge base': 'feat-knowledge',
          'Approvals': 'feat-approvals', 'Customers': 'feat-customers', 'AI Studio': 'feat-studio',
          'Analytics': 'feat-analytics', 'Store widget': 'feat-widget', 'Channels': 'feat-channels', 'WhatsApp broadcast': 'feat-broadcast',
          'Cosmetics & skincare': 'sol-cosmetics', 'Fashion & clothing': 'sol-fashion', 'Home & furniture': 'sol-home',
          'Clinics & aesthetics': 'sol-clinics', 'Restaurants & local': 'sol-food', 'Electronics': 'sol-electronics',
          'Jewellery & gifting': 'sol-jewellery', 'Ecommerce': 'sol-ecommerce', 'Lead handling': 'sol-leads',
          'Running it alone': 'sol-owner', 'On the front line': 'sol-agent',
          'Shopify': 'feat-integrations', 'WooCommerce': 'feat-integrations', 'Zoho': 'feat-integrations',
          'Monday': 'feat-integrations', 'Browse all': 'feat-integrations',
          'Why GOTCHA': 'why', 'It acts, not just answers': 'why', 'Your limits, per action': 'why',
          'Priced per conversation': 'pricing', 'Security': 'co-security',
          'About us': 'co-about', 'Blog': 'co-blog', 'Help center': 'co-help', 'Careers': 'co-careers'
        };
        const COLS = [
          { t: 'Product', items: ['Omnichannel', 'Social engagement', 'WhatsApp broadcast', 'Your new employee', 'Copilot', 'Call pilot (beta)', 'Knowledge base', 'Approvals', 'Customers', 'AI Studio', 'Analytics', 'Store widget', 'Channels'] },
          { t: 'Solutions', items: ['Cosmetics & skincare', 'Fashion & clothing', 'Home & furniture', 'Clinics & aesthetics', 'Restaurants & local', 'Electronics', 'Jewellery & gifting', 'Ecommerce', 'Lead handling', 'Running it alone', 'On the front line'] },
          { t: 'Integrations', items: ['Shopify', 'WooCommerce', 'Zoho', 'Monday', 'Browse all'] },
          { t: 'Why us', items: ['Why GOTCHA', 'It acts, not just answers', 'Your limits, per action', 'Priced per conversation', 'Security'] },
          { t: 'Our Company', items: ['About us', 'Blog', 'Help center', 'Careers', 'Security'] }
        ];
        return COLS.map(c => ({ t: c.t, items: c.items.map(t => ({ t: t, click: go(M[t] || 'home') })) }));
      })(),
      social: [
        { t: 'Instagram', icon: 'instagram', href: 'https://www.instagram.com/gotcha.co.il/' },
        { t: 'Facebook', icon: 'facebook', href: 'https://www.facebook.com/gotchainbox' },
        { t: 'YouTube', icon: 'youtube', href: 'https://www.youtube.com/channel/UCBaxp7m0y5tIjdwkNezrdgA' }
      ]
    };
  }

  // dc-runtime: vals = { ...userProps, ...logic.renderVals() }
  __vals() {
    return { ...this.props, ...(this.renderVals() || {}) };
  }

  // UrlSync gives state.page a real address. The design never touched the URL,
  // so without it every one of these pages is unlinkable.
  __render(view, extra) {
    let vals;
    try {
      vals = this.__vals();
    } catch (e) {
      console.error('renderVals():', e);
      return React.createElement('pre', { style: { padding: 24, color: '#8E3418' } }, String(e && e.stack || e));
    }
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(UrlSync, {
        page: this.state.page,
        alwaysNavigate: !!extra,
        onNavigate: (page) => this.setState({ page, menu: null }),
        lang: this.state.lang,
        onLang: this.props.onLang,
      }),
      React.createElement(view, { v: vals, children: extra }),
    );
  }
}

/** The landing page: the design's chrome around the design's pages. */
export default class Landing extends LandingLogic {
  render() {
    return this.__render(Template, null);
  }
}

/**
 * The same chrome around something else - the Trust Center, a help article.
 *
 * Those sections are written by hand, but they are still the same website, so
 * they carry the real header and footer rather than a lookalike. A nav click
 * here is a real navigation: the landing's pages are separate documents from
 * where the reader is standing.
 */
export class LandingChrome extends LandingLogic {
  render() {
    return this.__render(Chrome, this.props.children);
  }
}
