'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { C, F, links } from '@/lib/site';

/**
 * The header, on a phone.
 *
 * The design's header is a 62px pill holding a logo, six nav items and two
 * buttons. It is drawn for 1440px and there is no arrangement of it that fits
 * 390 - so under the breakpoint those items are hidden and this takes over.
 *
 * It is a remote control rather than a copy. The labels are read out of the
 * design's own hidden nav, and tapping one clicks the original element, so the
 * menu carries whatever the design says today, in whatever language the page is
 * in, and navigation runs through the design's own handlers. Nothing here has
 * to be updated when the design changes its menu.
 */

type Item = { label: string; el: HTMLElement };

const readNav = (): { items: Item[]; actions: Item[] } => {
  const text = (el: Element) => (el.textContent || '').replace(/\s*▾\s*$/, '').replace(/\s+/g, ' ').trim();
  const items = [...document.querySelectorAll<HTMLElement>('[data-nav-item]')]
    .map((el) => ({ label: text(el), el }))
    .filter((i) => i.label);
  const actions = [...document.querySelectorAll<HTMLElement>('[data-nav-secondary]')]
    .map((el) => ({ label: text(el), el }))
    .filter((i) => i.label);
  return { items, actions };
};

export default function MobileNav() {
  const [open, setOpen] = useState(false);
  const [nav, setNav] = useState<{ items: Item[]; actions: Item[] }>({ items: [], actions: [] });
  const [box, setBox] = useState<{ top: number; end: number } | null>(null);
  const [rtl, setRtl] = useState(false);

  // Where the design's pill actually is, so the button sits inside it rather
  // than at a guessed offset. The offer bar can be dismissed, which moves it.
  const measure = useCallback(() => {
    const pill = document.querySelector<HTMLElement>('[data-nav-item]')?.closest('div[style*="height:62px"]')
      ?? document.querySelector<HTMLElement>('div[style*="height:62px"]');
    const root = document.querySelector('[dir]');
    setRtl(root?.getAttribute('dir') === 'rtl');
    if (!pill) return setBox(null);
    const r = pill.getBoundingClientRect();
    setBox({ top: Math.round(r.top + r.height / 2 - 19), end: Math.round(window.innerWidth - r.right + 10) });
  }, []);

  useEffect(() => {
    const sync = () => {
      setNav(readNav());
      measure();
    };
    sync();
    // The design re-renders its nav on language and page changes.
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['dir', 'lang', 'style'] });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, [measure]);

  // The panel is a modal: nothing behind it should scroll away underneath.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!box || nav.items.length === 0) return null;

  const tap = (item: Item) => {
    setOpen(false);
    // After the panel closes, so the design's own scroll-to-top is not fighting
    // a body that is still locked.
    window.setTimeout(() => item.el.click(), 60);
  };

  return (
    <div className="mobile-nav">
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: 'fixed',
          top: box.top,
          insetInlineEnd: box.end,
          zIndex: 94,
          width: 38,
          height: 38,
          borderRadius: 11,
          border: `1px solid ${C.line}`,
          background: C.card,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span style={{ display: 'grid', gap: 4 }}>
          {[0, 1, 2].map((n) => (
            <span
              key={n}
              style={{
                display: 'block',
                width: 16,
                height: 1.6,
                borderRadius: 2,
                background: C.ink,
                transition: 'transform .2s ease, opacity .2s ease',
                transform: open ? (n === 0 ? 'translateY(5.6px) rotate(45deg)' : n === 2 ? 'translateY(-5.6px) rotate(-45deg)' : 'none') : 'none',
                opacity: open && n === 1 ? 0 : 1,
              }}
            />
          ))}
        </span>
      </button>

      {open && (
        <div
          dir={rtl ? 'rtl' : 'ltr'}
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 93,
            background: C.bg,
            paddingTop: box.top + 52,
            paddingInline: 20,
            paddingBottom: 28,
            overflowY: 'auto',
          }}
        >
          <nav style={{ display: 'grid', gap: 2 }}>
            {nav.items.map((item) => (
              <button
                key={item.label}
                onClick={() => tap(item)}
                style={{
                  textAlign: rtl ? 'right' : 'left',
                  border: 0,
                  borderBottom: `1px solid ${C.line}`,
                  background: 'transparent',
                  padding: '17px 2px',
                  cursor: 'pointer',
                  font: `600 19px ${F.sans}`,
                  color: C.ink,
                }}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div style={{ display: 'grid', gap: 10, marginTop: 22 }}>
            {nav.actions.map((item, n) => (
              <button
                key={item.label}
                onClick={() => tap(item)}
                style={{
                  border: n === nav.actions.length - 1 ? `1px solid ${C.ink}` : `1px solid ${C.line}`,
                  borderRadius: 12,
                  padding: '13px 16px',
                  cursor: 'pointer',
                  background: n === nav.actions.length - 1 ? C.ink : C.card,
                  color: n === nav.actions.length - 1 ? C.bg : C.ink,
                  font: `600 15px ${F.sans}`,
                }}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* The two sections that are not in the design's nav at all. */}
          <div style={{ display: 'flex', gap: 18, marginTop: 26, flexWrap: 'wrap' }}>
            <a href={links.help()} style={{ fontSize: 13.5, color: C.body, textDecoration: 'underline' }}>
              Help Center
            </a>
            <a href={links.trust()} style={{ fontSize: 13.5, color: C.body, textDecoration: 'underline' }}>
              Trust Center
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
