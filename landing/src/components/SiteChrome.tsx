'use client';

import React from 'react';
import { C, F, HEADER_PILL, MAXW, links, dirOf, isHe, type Locale } from '@/lib/site';

/**
 * The header and footer for the sections written by hand: the Trust Center, the
 * help articles, the cookie notice.
 *
 * Deliberately not the landing page's own chrome. That one is compiled from the
 * design and driven by the landing's state machine - mega-menus, scroll spies,
 * an offer bar that dismisses itself. Reusing it would tie a privacy policy to
 * the landing page's animation lifecycle for no benefit. This carries the same
 * marks, the same pill, the same dark footer and the same type, with the nav
 * reduced to what a reader of a legal document actually needs.
 */

const s = (css: string): React.CSSProperties =>
  Object.fromEntries(
    css
      .split(';')
      .map((d) => d.split(/:(.+)/))
      .filter((p) => p.length > 1)
      .map(([k, v]) => [
        k.trim().startsWith('--') ? k.trim() : k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
        v.trim(),
      ]),
  ) as React.CSSProperties;

const COPY = {
  product: ['Product', 'המוצר'],
  pricing: ['Pricing', 'תמחור'],
  help: ['Help center', 'מרכז עזרה'],
  trust: ['Trust Center', 'מרכז האמון'],
  login: ['Log in', 'התחברות'],
  demo: ['Book a demo', 'קבעו דמו'],
  rights: ['© 2026 GOTCHA', '© 2026 GOTCHA'],
  city: ['Ramat Gan', 'רמת גן'],
  live: ['Answering around the clock', 'עונים מסביב לשעון'],
  privacy: ['Privacy', 'פרטיות'],
  terms: ['Terms', 'תנאי שימוש'],
  dpa: ['DPA', 'הסכם עיבוד מידע'],
  cookies: ['Cookies', 'עוגיות'],
} as const;

export function SiteHeader({ locale, onLocale }: { locale: Locale; onLocale?: (l: Locale) => void }) {
  const p = (k: keyof typeof COPY) => COPY[k][isHe(locale) ? 1 : 0];

  return (
    <div style={s('position:sticky;top:0;z-index:90;padding:14px 0')}>
      <div style={{ ...s('margin:0 auto;padding:0 24px'), maxWidth: MAXW }}>
        <div
          style={{
            ...s(HEADER_PILL),
            ...s('padding:0 14px 0 22px;height:62px;display:flex;align-items:center;gap:14px'),
          }}
        >
          <a href={links.home()} style={s('display:flex;align-items:center;flex:none')}>
            <img
              src="/assets/logo/line-horizontal-dark.png"
              alt="GOTCHA"
              style={s('width:126px;height:auto;display:block')}
            />
          </a>

          <nav
            style={{
              ...s('display:flex;align-items:center;gap:2px;min-width:0;overflow:hidden'),
              marginInlineStart: 6,
            }}
          >
            {[
              [p('product'), links.home()],
              [p('pricing'), links.home() === '/' ? '/pricing' : `${links.home()}pricing`],
              [p('help'), links.help()],
              [p('trust'), links.trust()],
            ].map(([label, href]) => (
              <a
                key={label}
                href={href}
                className="chrome-nav"
                style={{
                  ...s('padding:8px 13px;border-radius:11px;font-size:14px;white-space:nowrap'),
                  color: C.ink,
                }}
              >
                {label}
              </a>
            ))}
          </nav>

          <div style={{ ...s('display:flex;align-items:center;gap:8px;flex:none'), marginInlineStart: 'auto' }}>
            {onLocale && (
              <div style={s('display:flex;gap:4px')}>
                {(['en', 'he'] as Locale[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => onLocale(l)}
                    aria-pressed={locale === l}
                    style={{
                      ...s('border:0;border-radius:7px;padding:6px 10px;cursor:pointer'),
                      font: `500 11px ${F.mono}`,
                      background: locale === l ? C.ink : 'transparent',
                      color: locale === l ? C.bg : C.faint,
                    }}
                  >
                    {l === 'en' ? 'EN' : 'עברית'}
                  </button>
                ))}
              </div>
            )}
            <a
              href={links.app()}
              style={{ ...s('font-size:14px;padding:8px 10px;white-space:nowrap'), color: C.ink }}
            >
              {p('login')}
            </a>
            <a
              href={links.home()}
              style={{
                ...s('font-size:14px;font-weight:600;border-radius:12px;padding:10px 16px;white-space:nowrap'),
                background: C.ink,
                color: C.bg,
              }}
            >
              {p('demo')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SiteFooter({ locale }: { locale: Locale }) {
  const p = (k: keyof typeof COPY) => COPY[k][isHe(locale) ? 1 : 0];

  return (
    <footer
      style={{
        ...s('margin-top:104px;border-radius:36px 36px 0 0;overflow:hidden'),
        background: C.footerBg,
        color: C.footerInk,
      }}
    >
      <div style={{ ...s('margin:0 auto;padding:52px 24px 0'), maxWidth: MAXW }}>
        <div style={{ ...s('display:flex;gap:40px;align-items:flex-end;padding-bottom:34px'), borderBottom: `1px solid ${C.footerLine}` }}>
          <div style={s('flex:1')}>
            <img
              src="/assets/logo/line-horizontal-light.png"
              alt="GOTCHA"
              style={s('width:132px;height:auto;display:block')}
            />
          </div>
        </div>

        <div
          style={{
            ...s('padding:20px 0 26px;display:flex;align-items:center;gap:22px;flex-wrap:wrap'),
          }}
        >
          <span style={{ fontSize: 12, color: C.footerMuted }}>{p('rights')}</span>
          <span style={{ fontSize: 12, color: C.footerMuted }}>{p('city')}</span>
          {[
            [p('privacy'), links.trust('privacy-policy')],
            [p('terms'), links.trust('terms-of-service')],
            [p('cookies'), links.trust('cookie-policy')],
            [p('dpa'), links.trust('dpa')],
          ].map(([label, href]) => (
            <a key={label} href={href} className="chrome-foot" style={{ fontSize: 12, color: C.footerMuted }}>
              {label}
            </a>
          ))}
          <div
            style={{
              ...s('display:flex;align-items:center;gap:9px'),
              marginInlineStart: 'auto',
            }}
          >
            <span
              style={{
                ...s('width:5px;height:5px;border-radius:50%;animation:gpulse 2.2s ease-in-out infinite'),
                background: C.live,
              }}
            />
            <span style={{ font: `400 11px ${F.mono}`, color: C.footerMuted }}>{p('live')}</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

/** Header, page, footer - the shell every hand-written section sits in. */
export default function SiteChrome({
  locale,
  onLocale,
  children,
}: {
  locale: Locale;
  onLocale?: (l: Locale) => void;
  children: React.ReactNode;
}) {
  return (
    <div dir={dirOf(locale)} lang={locale} style={{ minHeight: '100vh', background: C.bg, color: C.ink }}>
      <SiteHeader locale={locale} onLocale={onLocale} />
      <main>{children}</main>
      <SiteFooter locale={locale} />
    </div>
  );
}
