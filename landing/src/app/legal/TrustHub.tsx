'use client';

import React from 'react';
import { LandingChrome } from '@/components/Landing';
import { useLocale } from '@/lib/use-locale';
import { C, F, MAXW, isHe } from '@/lib/site';

type Card = {
  slug: string;
  icon: string;
  summary: [string, string];
  title: [string, string];
  effectiveDate: [string, string];
};

const COPY = {
  kicker: ['Trust Center', 'מרכז האמון'],
  h1a: ['Everything we agreed to,', 'כל מה שהתחייבנו אליו,'],
  h1b: ['in writing', 'בכתב'],
  sub: [
    'The agreements that govern your use of GOTCHA and the way we handle personal data, in one place. Every document is published in Hebrew and English, and the date on each one is the date it took effect.',
    'ההסכמים שמסדירים את השימוש שלכם ב-GOTCHA ואת הדרך שבה אנחנו מטפלים במידע אישי, במקום אחד. כל מסמך מתפרסם בעברית ובאנגלית, והתאריך שעל כל אחד הוא התאריך שבו נכנס לתוקף.',
  ],
  facts: [
    [
      ['Where data is stored', 'AWS il-central-1 (Israel)'],
      ['Our role', 'Processor for your customer data'],
      ['Privacy contact', 'privacy@gotcha.co.il'],
    ],
    [
      ['מיקום אחסון המידע', 'AWS il-central-1 (ישראל)'],
      ['התפקיד שלנו', 'מעבד עבור נתוני הלקוחות שלכם'],
      ['איש קשר לפרטיות', 'privacy@gotcha.co.il'],
    ],
  ],
  effective: ['In effect from', 'בתוקף מיום'],
  ask: ['Something not covered here?', 'משהו שלא מכוסה כאן?'],
  askBody: [
    'Write to privacy@gotcha.co.il and a person answers. Security reviews, data processing questions and vendor questionnaires all land in the same inbox.',
    'כתבו ל-privacy@gotcha.co.il ואדם עונה. סקירות אבטחה, שאלות על עיבוד מידע ושאלוני ספקים מגיעים כולם לאותה תיבה.',
  ],
} as const;

/** Line art, drawn rather than pulled from an icon font, so the set stays fixed. */
function Glyph({ name, color }: { name: string; color: string }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, style: { display: 'block' } };
  if (name === 'shield') return <svg {...common}><path d="M12 3l7 3v6c0 4.2-2.8 7.7-7 9-4.2-1.3-7-4.8-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>;
  if (name === 'cookie') return <svg {...common}><path d="M12 3a9 9 0 109 9 3 3 0 01-3-3 3 3 0 01-3-3 3 3 0 01-3-3z" /><circle cx="9" cy="10" r="1" /><circle cx="13" cy="15" r="1" /><circle cx="15" cy="9" r="1" /></svg>;
  if (name === 'handshake') return <svg {...common}><path d="M3 11l4-4 3 2 3-2 4 4" /><path d="M7 13l3 3 2-2 3 3" /><path d="M2 11h2M20 11h2" /></svg>;
  if (name === 'server') return <svg {...common}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></svg>;
  return <svg {...common}><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4" /><path d="M10 12h6M10 16h6" /></svg>;
}

const TINT: Record<string, [string, string]> = {
  scroll: [C.accentWash, C.accent],
  shield: [C.greenWash, C.green],
  cookie: [C.goldWash, C.gold],
  handshake: [C.violetWash, C.violet],
  server: [C.blueWash, C.blue],
};

export default function TrustHub({ cards }: { cards: Card[] }) {
  const [locale, setLocale] = useLocale();
  const i = isHe(locale) ? 1 : 0;
  const p = (k: keyof typeof COPY) => (COPY[k] as readonly string[])[i];

  return (
    <LandingChrome initialLang={locale} onLang={(l: string) => setLocale(l === 'he' ? 'he' : 'en')}>
      <div data-no-translate style={{ padding: '98px 0 0' }}>
      <div style={{ maxWidth: MAXW, margin: '0 auto', padding: '8px 24px 0' }}>
        <div style={{ font: `500 11px ${F.mono}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.accent }}>
          {p('kicker')}
        </div>
        <h1 style={{ margin: '18px 0 0', fontSize: 58, lineHeight: 1.03, letterSpacing: '-0.035em', maxWidth: 780 }}>
          {p('h1a')}{' '}
          <span style={{ font: `400 58px/1.03 ${F.serif}`, fontStyle: 'italic' }}>{p('h1b')}</span>
        </h1>
        <p style={{ margin: '22px 0 0', maxWidth: 640, fontSize: 17.5, lineHeight: 1.65, color: C.body }}>
          {p('sub')}
        </p>

        <div
          style={{
            margin: '40px 0 0',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            border: `1px solid ${C.line}`,
            borderRadius: 16,
            overflow: 'hidden',
            background: C.card,
          }}
        >
          {COPY.facts[i].map(([label, value], j) => (
            <div key={j} style={{ padding: '18px 22px', borderInlineStart: j ? `1px solid ${C.line}` : undefined }}>
              <div style={{ font: `500 10.5px ${F.mono}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.faint }}>
                {label}
              </div>
              <div style={{ marginTop: 7, fontSize: 15, fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>

        <div
          style={{
            margin: '26px 0 0',
            display: 'grid',
            gap: 14,
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          }}
        >
          {cards.map((c) => {
            const [wash, ink] = TINT[c.icon] ?? TINT.scroll;
            return (
              <a
                key={c.slug}
                href={`/legal/${c.slug}`}
                className="trust-card"
                style={{
                  display: 'block',
                  padding: '22px 24px',
                  background: C.card,
                  border: `1px solid ${C.line}`,
                  borderRadius: 18,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 9,
                      background: wash,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: 'none',
                    }}
                  >
                    <Glyph name={c.icon} color={ink} />
                  </span>
                  <span style={{ fontSize: 17.5, fontWeight: 600, letterSpacing: '-0.01em' }}>{c.title[i]}</span>
                </div>
                <p style={{ margin: '13px 0 0', fontSize: 14.5, lineHeight: 1.65, color: C.body }}>{c.summary[i]}</p>
                {c.effectiveDate[i] && (
                  <div style={{ marginTop: 14, font: `400 11.5px ${F.mono}`, color: C.faint }}>
                    {p('effective')} {c.effectiveDate[i]}
                  </div>
                )}
              </a>
            );
          })}
        </div>

        <div
          style={{
            margin: '30px 0 0',
            padding: '26px 28px',
            background: C.sand,
            borderRadius: 18,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>{p('ask')}</div>
          <p style={{ margin: '10px 0 0', maxWidth: 620, fontSize: 15, lineHeight: 1.7, color: C.body }}>
            {p('askBody')}
          </p>
        </div>
      </div>
    </div>
    </LandingChrome>
  );
}
