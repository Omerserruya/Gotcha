'use client';

import React, { useState } from 'react';
import { useConsent } from '@/lib/consent';
import { useLocale } from '@/lib/use-locale';
import { C, F, isHe, links } from '@/lib/site';

/**
 * The consent card shown on a first visit.
 *
 * Written to be answerable rather than dismissed: both buttons are real
 * choices, neither is styled to look like the only one, and refusing takes the
 * same single click as accepting. There is no "manage preferences" maze,
 * because there are only two categories and one of them is not optional.
 *
 * It does not cover the page. Consent rules require that non-essential cookies
 * do not run before a decision - which is enforced in code, by nothing reading
 * `consent.analytics` until it is true - not that the site be held hostage
 * until someone clicks.
 */

const COPY = {
  title: ['Cookies on this site', 'עוגיות באתר הזה'],
  body: [
    'We use cookies that are strictly necessary for signing in securely. We would also like to measure which pages are useful, and that part is up to you.',
    'אנחנו משתמשים בעוגיות חיוניות להתחברות מאובטחת. נשמח גם למדוד אילו עמודים מועילים, והחלק הזה נתון להחלטתכם.',
  ],
  necessary: ['Strictly necessary', 'חיוניות בהחלט'],
  necessaryNote: ['Sign-in and security. Always on.', 'התחברות ואבטחה. תמיד פעילות.'],
  analytics: ['Analytics', 'אנליטיקה'],
  analyticsNote: [
    'Which pages get read, in aggregate. No advertising, no profiles, no third-party trackers.',
    'אילו עמודים נקראים, במצטבר. בלי פרסום, בלי פרופילים, בלי גורמי מעקב חיצוניים.',
  ],
  accept: ['Accept analytics', 'אישור אנליטיקה'],
  reject: ['Necessary only', 'חיוניות בלבד'],
  policy: ['Cookie Policy', 'מדיניות העוגיות'],
} as const;

export default function CookieNotice() {
  const { pending, decide } = useConsent();
  const [locale] = useLocale();
  const [leaving, setLeaving] = useState(false);
  const i = isHe(locale) ? 1 : 0;
  const p = (k: keyof typeof COPY) => COPY[k][i];

  if (!pending) return null;

  const choose = (analytics: boolean) => {
    setLeaving(true);
    // Let the card fade before it goes, so a decision reads as acknowledged.
    window.setTimeout(() => decide(analytics), 160);
  };

  const Row = ({ label, note, on }: { label: string; note: string; on: boolean }) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span
        aria-hidden
        style={{
          marginTop: 3,
          width: 15,
          height: 15,
          borderRadius: 5,
          flex: 'none',
          background: on ? C.accent : 'transparent',
          border: `1.5px solid ${on ? C.accent : C.faint}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {on && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#FFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12l6 6L20 6" />
          </svg>
        )}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600 }}>{label}</span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 12.5, lineHeight: 1.55, color: C.body }}>{note}</span>
      </span>
    </div>
  );

  return (
    <div
      dir={isHe(locale) ? 'rtl' : 'ltr'}
      role="dialog"
      aria-label={p('title')}
      style={{
        position: 'fixed',
        insetInlineStart: 20,
        bottom: 20,
        zIndex: 95,
        width: 'min(420px, calc(100vw - 40px))',
        background: C.card,
        border: `1px solid ${C.line}`,
        borderRadius: 20,
        boxShadow: '0 14px 44px rgba(22,21,15,.16)',
        padding: '20px 22px',
        opacity: leaving ? 0 : 1,
        transform: leaving ? 'translateY(8px)' : 'none',
        transition: 'opacity .16s ease, transform .16s ease',
      }}
    >
      <div style={{ font: `500 10.5px ${F.mono}`, letterSpacing: '.16em', textTransform: 'uppercase', color: C.accent }}>
        {p('title')}
      </div>

      <p style={{ margin: '11px 0 0', fontSize: 13.5, lineHeight: 1.65, color: C.body }}>{p('body')}</p>

      <div style={{ margin: '15px 0 0', display: 'grid', gap: 11 }}>
        <Row label={p('necessary')} note={p('necessaryNote')} on />
        <Row label={p('analytics')} note={p('analyticsNote')} on={false} />
      </div>

      <div style={{ margin: '17px 0 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => choose(true)}
          style={{
            border: 0,
            borderRadius: 11,
            padding: '10px 15px',
            cursor: 'pointer',
            background: C.ink,
            color: C.bg,
            font: `600 13.5px ${F.sans}`,
          }}
        >
          {p('accept')}
        </button>
        <button
          onClick={() => choose(false)}
          style={{
            border: `1px solid ${C.line}`,
            borderRadius: 11,
            padding: '10px 15px',
            cursor: 'pointer',
            background: C.card,
            color: C.ink,
            font: `600 13.5px ${F.sans}`,
          }}
        >
          {p('reject')}
        </button>
        <a
          href={links.trust('cookie-policy')}
          style={{ marginInlineStart: 'auto', fontSize: 12.5, color: C.faint, textDecoration: 'underline' }}
        >
          {p('policy')}
        </a>
      </div>
    </div>
  );
}
