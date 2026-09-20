'use client';

import React, { useState } from 'react';
import { useConsent } from '@/lib/consent';
import { C, F, links } from '@/lib/site';

/**
 * The consent card, on a campaign page.
 *
 * WHY IT IS HERE AT ALL, ON A CONVERSION PAGE
 * -------------------------------------------
 * The `gotcha_consent` cookie is shared across `.gotcha.co.il`, so a visitor
 * who already answered on the marketing site is never shown this. But campaign
 * traffic arrives COLD - straight from an advertisement onto this host - and
 * has no record at all. Without this card those visitors are never asked, which
 * under the Cookie Policy means the Meta pixel is never loaded, which means the
 * campaign cannot report its own conversions. The banner is the price of the
 * measurement, and it is a price the policy already committed us to.
 *
 * A COPY of landing/src/components/CookieNotice.tsx, reduced to Hebrew, which
 * is the only language this host serves today. The category wording is the
 * marketing site's, verbatim, because it is the wording the Cookie Policy was
 * written against - with ONE exception, marked below.
 *
 * It deliberately does not cover the page. The rules require that non-essential
 * cookies do not run before a decision, which is enforced by nothing reading
 * `consent.marketing` until it is true, not that the page be held hostage.
 * Holding a paid landing page hostage would also be the most expensive possible
 * way to ask.
 */

const COPY = {
  title: 'לפני שתמשיכו',

  /**
   * CHANGED from the marketing site's wording, and this is the exception.
   *
   * There it says "signing in needs a couple of cookies" - true there, where
   * the same cookie banner covers a site that links to a login. This host has
   * no sign-in and no application: the only cookie it sets is the one holding
   * your answer, exactly as section 1 of the Cookie Policy describes. Repeating
   * the sign-in sentence here would describe something that does not exist on
   * this page.
   */
  body: 'העמוד הזה שומר עוגייה אחת בלבד - זו שזוכרת את התשובה שלכם. כל השאר נתון לבחירתכם.',
  necessary: 'שמירת הבחירה',
  necessaryNote:
    'עוגייה אחת שזוכרת מה עניתם, כדי שלא נשאל אתכם שוב בכל ביקור. אין בה מזהה והיא לא נשלחת לאף אחד.',
  always: 'תמיד פעיל',

  analytics: 'ספירת צפיות בעמודים',
  analyticsNote:
    'סופר כמה אנשים פתחו כל עמוד, כדי שנדע על מה כדאי לכתוב עוד. בלי שם, בלי אימייל, בלי פרופיל, ושום דבר לא נשלח למפרסם.',

  marketing: 'מדידת הפרסומות שלנו',
  marketingNote:
    'מאפשר ל-Meta לומר לנו איזו פרסומת הביאה אתכם לכאן, כדי שנפסיק לשלם על אלה שלא עובדות. זה כן שולח את הביקור שלכם ל-Meta, ו-Meta עשויה לזהות אתכם גם באתרים אחרים. זה הדבר היחיד כאן שמערב חברה אחרת.',

  on: 'פעיל',
  off: 'כבוי',
  acceptAll: 'לאפשר הכל',
  onlyNeeded: 'רק ההכרחיות',
  save: 'שמירת הבחירה',
  policy: 'למדיניות העוגיות',
} as const;

/**
 * One optional category: a label, a plain-words note, and a real switch.
 *
 * A `<button role="switch">` rather than something that merely looks tickable.
 * A consent form that ignores what you clicked is the pattern these rules exist
 * to stop.
 */
function Optional({
  label,
  note,
  on,
  toggle,
}: {
  label: string;
  note: string;
  on: boolean;
  toggle: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: '12px 14px',
        background: on ? C.accentWash : C.surface,
        borderRadius: 12,
        transition: 'background .18s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          onClick={toggle}
          style={{
            marginInlineStart: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: 0,
            background: 'transparent',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <span style={{ font: `500 10px ${F.mono}`, letterSpacing: '.1em', color: C.muted }}>
            {on ? COPY.on : COPY.off}
          </span>
          <span
            style={{
              position: 'relative',
              width: 38,
              height: 22,
              borderRadius: 999,
              background: on ? C.accent : C.sand,
              transition: 'background .18s ease',
              display: 'block',
              flex: '0 0 auto',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 3,
                insetInlineStart: on ? 19 : 3,
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
      <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.55, color: C.body }}>{note}</p>
    </div>
  );
}

export default function CookieNotice() {
  const { pending, decide } = useConsent();
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [leaving, setLeaving] = useState(false);

  if (!pending) return null;

  /**
   * Both one-click answers, and the one that reads the switches.
   *
   * "רק ההכרחיות" sits beside "לאפשר הכל", same size, same weight, same row.
   * Refusing has to be exactly as easy as agreeing; a card where yes is a
   * button and no is a trip through two toggles is not a free choice.
   */
  const answer = (a: boolean, m: boolean) => {
    setLeaving(true);
    // Let the card fade before it goes, so the choice reads as acknowledged.
    window.setTimeout(() => decide(a, m), 160);
  };

  return (
    <>
      {/*
        Bottom clearance, which needs a media query and so cannot be inline.
        This page has two fixed things of its own at the bottom edge: the mobile
        call-to-action bar (z-index 40, bottom 0) and the WhatsApp widget
        (z-index 50, lifted to 76px on narrow screens). On a phone this card is
        nearly full width, so it has to sit above the bar rather than over it.
      */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
.gotcha-consent { bottom: calc(20px + env(safe-area-inset-bottom, 0px)); }
@media (max-width: 760px) {
  .gotcha-consent { bottom: calc(96px + env(safe-area-inset-bottom, 0px)); }
}`,
        }}
      />
      <div
        className="gotcha-consent"
        dir="rtl"
        lang="he"
        role="dialog"
        aria-label={COPY.title}
        style={{
          position: 'fixed',
          // The WhatsApp widget holds inset-inline-end, so this takes the other
          // side and the two never meet on a wide screen.
          insetInlineStart: 20,
          // Above the sticky bar (40) and the widget (50): a question about
          // consent should not be the thing that ends up underneath.
          zIndex: 60,
          width: 'min(430px, calc(100vw - 40px))',
          maxHeight: 'calc(100dvh - 140px)',
          overflowY: 'auto',
          background: C.card,
          border: `1px solid ${C.line}`,
          borderRadius: 20,
          boxShadow: '0 14px 44px rgba(22,21,15,.16)',
          padding: '20px 22px',
          opacity: leaving ? 0 : 1,
          transform: leaving ? 'translateY(8px)' : 'none',
          transition: 'opacity .16s ease, transform .16s ease',
          fontFamily: F.sans,
          color: C.ink,
        }}
      >
        <div
          style={{
            font: `500 10.5px ${F.mono}`,
            letterSpacing: '.16em',
            textTransform: 'uppercase',
            color: C.accent,
          }}
        >
          {COPY.title}
        </div>

        <p style={{ margin: '11px 0 0', fontSize: 13.5, lineHeight: 1.65, color: C.body }}>
          {COPY.body}
        </p>

        {/* Locked: shown as a statement, not as a control that ignores you. */}
        <div style={{ marginTop: 16, padding: '12px 14px', background: C.surface, borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{COPY.necessary}</span>
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
              {COPY.always}
            </span>
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, lineHeight: 1.55, color: C.body }}>
            {COPY.necessaryNote}
          </p>
        </div>

        {/* Two separate questions, two separate switches: counting page views
            and letting an ad network recognise you are not the same thing, and
            one yes must not be read as the other. */}
        <Optional
          label={COPY.analytics}
          note={COPY.analyticsNote}
          on={analytics}
          toggle={() => setAnalytics((v) => !v)}
        />
        <Optional
          label={COPY.marketing}
          note={COPY.marketingNote}
          on={marketing}
          toggle={() => setMarketing((v) => !v)}
        />

        <div
          style={{
            margin: '16px 0 0',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={() => answer(true, true)}
            style={{
              border: `1px solid ${C.ink}`,
              borderRadius: 11,
              padding: '10px 18px',
              cursor: 'pointer',
              background: C.ink,
              color: C.bg,
              font: `600 13.5px ${F.sans}`,
            }}
          >
            {COPY.acceptAll}
          </button>
          <button
            onClick={() => answer(false, false)}
            style={{
              // Same size, same weight, same row: only the fill differs, so
              // neither answer is the one the card is steering to.
              border: `1px solid ${C.ink}`,
              borderRadius: 11,
              padding: '10px 18px',
              cursor: 'pointer',
              background: 'transparent',
              color: C.ink,
              font: `600 13.5px ${F.sans}`,
            }}
          >
            {COPY.onlyNeeded}
          </button>
          <button
            onClick={() => answer(analytics, marketing)}
            style={{
              border: 0,
              borderRadius: 11,
              padding: '10px 6px',
              cursor: 'pointer',
              background: 'transparent',
              color: C.muted,
              font: `500 13px ${F.sans}`,
              textDecoration: 'underline',
            }}
          >
            {COPY.save}
          </button>
          <a
            href={links.trust('cookie-policy')}
            target="_blank"
            rel="noopener"
            style={{ fontSize: 12.5, color: C.faint, textDecoration: 'underline' }}
          >
            {COPY.policy}
          </a>
        </div>
      </div>
    </>
  );
}
