'use client';

import React, { useState } from 'react';
import { useConsent } from '@/lib/consent';
import { usePageLocale } from '@/lib/use-page-locale';
import { C, F, isHe, links } from '@/lib/site';

/**
 * The consent card shown on a first visit.
 *
 * The first version drew two checkbox-shaped squares that were not controls.
 * They looked tickable and did nothing, which is worse than not drawing them:
 * a consent form that ignores the thing you clicked is exactly the pattern
 * these rules exist to stop. There is one switch here now, it is a real
 * <button role="switch">, and it works with a keyboard.
 *
 * The copy says what analytics would actually do in plain words. "Analytics"
 * on its own is a category name, not an explanation, and nobody should have to
 * guess what they are agreeing to.
 *
 * It does not cover the page. The rules require that non-essential cookies do
 * not run before a decision - enforced by nothing reading `consent.analytics`
 * until it is true - not that the site be held hostage until someone clicks.
 */

const COPY = {
  title: ['Before you read on', 'לפני שתמשיכו'],
  body: [
    'Signing in needs a couple of cookies, and those cannot be turned off. Everything else is your call.',
    'התחברות דורשת כמה עוגיות, ואותן אי אפשר לכבות. כל השאר נתון לבחירתכם.',
  ],
  necessary: ['Sign-in and security', 'התחברות ואבטחה'],
  necessaryNote: [
    'Keeps you signed in and protects the login form. Without these the site cannot sign anyone in.',
    'שומר אתכם מחוברים ומגן על טופס ההתחברות. בלעדיהן האתר לא יכול לחבר אף אחד.',
  ],
  always: ['Always on', 'תמיד פעיל'],
  analytics: ['Counting page views', 'ספירת צפיות בעמודים'],
  analyticsNote: [
    'Counts how many people opened each page, so we know which ones to write more of. No name, no email, no profile, and nothing is sent to an advertiser.',
    'סופר כמה אנשים פתחו כל עמוד, כדי שנדע על מה כדאי לכתוב עוד. בלי שם, בלי אימייל, בלי פרופיל, ושום דבר לא נשלח למפרסם.',
  ],
  on: ['On', 'פעיל'],
  off: ['Off', 'כבוי'],
  save: ['Save', 'שמירה'],
  policy: ['Read the Cookie Policy', 'למדיניות העוגיות'],
} as const;

export default function CookieNotice() {
  const { pending, decide } = useConsent();
  const locale = usePageLocale();
  const [analytics, setAnalytics] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const i = isHe(locale) ? 1 : 0;
  const p = (k: keyof typeof COPY) => COPY[k][i];

  if (!pending) return null;

  const save = () => {
    setLeaving(true);
    // Let the card fade before it goes, so the choice reads as acknowledged.
    window.setTimeout(() => decide(analytics), 160);
  };

  return (
    <div
      dir={isHe(locale) ? 'rtl' : 'ltr'}
      role="dialog"
      aria-label={p('title')}
      style={{
        position: 'fixed',
        insetInlineStart: 20,
        bottom: 20,
        // Above the launch bar (92) and the header (90), below the design's
        // mobile menu (94) - an open menu should cover this, not fight it.
        zIndex: 93,
        width: 'min(430px, calc(100vw - 40px))',
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

      {/* Locked: shown as a statement, not as a control that ignores you. */}
      <div style={{ marginTop: 16, padding: '12px 14px', background: C.surface, borderRadius: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p('necessary')}</span>
          <span
            style={{
              marginInlineStart: 'auto',
              font: `500 10px ${F.mono}`,
              letterSpacing: '.1em',
              textTransform: 'uppercase',
              color: C.muted,
              background: C.sand,
              borderRadius: 6,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
            }}
          >
            {p('always')}
          </span>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.55, color: C.body }}>{p('necessaryNote')}</p>
      </div>

      {/* Optional: a real switch. */}
      <div
        style={{
          marginTop: 10,
          padding: '12px 14px',
          background: analytics ? C.accentWash : C.surface,
          borderRadius: 12,
          transition: 'background .18s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p('analytics')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={analytics}
            aria-label={p('analytics')}
            onClick={() => setAnalytics((v) => !v)}
            style={{
              marginInlineStart: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: 0,
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
              font: `500 11px ${F.mono}`,
              color: analytics ? C.accent : C.muted,
            }}
          >
            {analytics ? p('on') : p('off')}
            <span
              aria-hidden
              style={{
                width: 38,
                height: 22,
                borderRadius: 999,
                background: analytics ? C.accent : C.line,
                position: 'relative',
                transition: 'background .18s ease',
                flex: 'none',
                display: 'block',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 3,
                  insetInlineStart: analytics ? 19 : 3,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: C.card,
                  transition: 'inset-inline-start .18s ease',
                  display: 'block',
                }}
              />
            </span>
          </button>
        </div>
        <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.55, color: C.body }}>{p('analyticsNote')}</p>
      </div>

      <div style={{ margin: '16px 0 0', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={save}
          style={{
            border: 0,
            borderRadius: 11,
            padding: '10px 20px',
            cursor: 'pointer',
            background: C.ink,
            color: C.bg,
            font: `600 13.5px ${F.sans}`,
          }}
        >
          {p('save')}
        </button>
        <a
          href={links.trust('cookie-policy')}
          style={{ fontSize: 12.5, color: C.faint, textDecoration: 'underline' }}
        >
          {p('policy')}
        </a>
      </div>
    </div>
  );
}
