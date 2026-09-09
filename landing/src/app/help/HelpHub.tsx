'use client';

import React, { useMemo, useState } from 'react';
import SiteChrome from '@/components/SiteChrome';
import { useLocale } from '@/lib/use-locale';
import { C, F, MAXW, isHe } from '@/lib/site';
import { HELP_CATEGORIES, popularArticles } from '@/content/help';

/**
 * The Help Center hub.
 *
 * This replaces the hub in the design rather than rendering it. The designed
 * one is a mockup: it advertises 148 articles across six categories with
 * invented titles, and the help centre actually has 23 across seven. Shipping
 * the mockup would put a number on the page that fails on the first click, so
 * the layout and the language are the design's and the contents are real.
 */

const COPY = {
  kicker: ['Help center', 'מרכז עזרה'],
  h1a: ['Everything, written', 'הכול כתוב'],
  h1b: ['in the same language as the product', 'באותה שפה שבה המוצר מדבר'],
  sub: [
    'How to set it up, what each setting does, and the playbook for your trade. Written by the people who built it.',
    'איך מגדירים, מה כל הגדרה עושה, והשיטה לענף שלכם. נכתב על ידי מי שבנו את זה.',
  ],
  search: ['Search: refund limits, WhatsApp setup, watch-only mode…', 'חיפוש: מגבלות זיכוי, חיבור וואטסאפ, מצב צפייה בלבד…'],
  cats: ['Start where you are', 'התחילו איפה שאתם'],
  popular: ['Read most', 'הנקראים ביותר'],
  none: ['Nothing matched that. Try fewer words.', 'לא נמצאה התאמה. נסו פחות מילים.'],
  count: ['articles', 'מאמרים'],
  askHead: ['Cannot find it?', 'לא מוצאים?'],
  ask: [
    'Message us on WhatsApp and a person answers, usually in minutes. Support is on every plan and is not a paid upgrade.',
    'שלחו לנו וואטסאפ ואדם עונה, בדרך כלל תוך דקות. תמיכה נכללת בכל תוכנית ואינה שדרוג בתשלום.',
  ],
} as const;

const TINT: Record<string, [string, string]> = {
  rocket: [C.accentWash, C.accent],
  chat: [C.greenWash, C.green],
  bot: [C.violetWash, C.violet],
  plug: [C.sandWash, C.clay],
  book: [C.goldWash, C.gold],
  credit: [C.blueWash, C.blue],
  users: [C.sand, C.clay],
};

export default function HelpHub() {
  const [locale, setLocale] = useLocale();
  const [q, setQ] = useState('');
  const i = isHe(locale) ? 1 : 0;
  const p = (k: keyof typeof COPY) => COPY[k][i];

  const total = HELP_CATEGORIES.reduce((n, c) => n + c.articles.length, 0);

  /** Title first, then excerpt, then keywords - and every term must hit. */
  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    const out: Array<{ cat: (typeof HELP_CATEGORIES)[number]; art: any; score: number }> = [];
    for (const cat of HELP_CATEGORIES) {
      for (const art of cat.articles) {
        const hay = [
          art.title.join(' '),
          art.excerpt.join(' '),
          art.keywords.join(' '),
        ].join(' ').toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
        const score = terms.reduce(
          (s, t) => s + (art.title.join(' ').toLowerCase().includes(t) ? 4 : 0) + (art.keywords.join(' ').includes(t) ? 2 : 1),
          0,
        );
        out.push({ cat, art, score });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }, [q]);

  const Card = ({ href, title, body, note }: { href: string; title: string; body: string; note?: string }) => (
    <a href={href} className="trust-card" style={{ display: 'block', padding: '20px 22px', background: C.card, border: `1px solid ${C.line}`, borderRadius: 18 }}>
      <div style={{ fontSize: 16.5, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</div>
      <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.65, color: C.body }}>{body}</p>
      {note && <div style={{ marginTop: 12, font: `400 11.5px ${F.mono}`, color: C.faint }}>{note}</div>}
    </a>
  );

  return (
    <SiteChrome locale={locale} onLocale={setLocale}>
      <div style={{ maxWidth: MAXW, margin: '0 auto', padding: '56px 24px 0' }}>
        <div style={{ font: `500 11px ${F.mono}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.accent }}>
          {p('kicker')}
        </div>
        <h1 style={{ margin: '18px 0 0', fontSize: 54, lineHeight: 1.05, letterSpacing: '-0.035em', maxWidth: 820 }}>
          {p('h1a')}{' '}
          <span style={{ font: `400 54px/1.05 ${F.serif}`, fontStyle: 'italic' }}>{p('h1b')}</span>
        </h1>
        <p style={{ margin: '20px 0 0', maxWidth: 620, fontSize: 17, lineHeight: 1.65, color: C.body }}>{p('sub')}</p>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={p('search')}
          className="help-search"
          style={{
            margin: '28px 0 0',
            width: '100%',
            maxWidth: 640,
            padding: '14px 18px',
            fontSize: 15,
            fontFamily: F.sans,
            color: C.ink,
            background: C.card,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            outline: 'none',
          }}
        />

        {results ? (
          <div style={{ margin: '26px 0 0', display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {results.length === 0 ? (
              <p style={{ fontSize: 15, color: C.body }}>{p('none')}</p>
            ) : (
              results.map(({ cat, art }) => (
                <Card
                  key={`${cat.slug}/${art.slug}`}
                  href={`/help/${cat.slug}/${art.slug}`}
                  title={art.title[i]}
                  body={art.excerpt[i]}
                  note={cat.title[i]}
                />
              ))
            )}
          </div>
        ) : (
          <>
            <h2 style={{ margin: '46px 0 16px', fontSize: 22, letterSpacing: '-0.02em' }}>
              {p('cats')}{' '}
              <span style={{ font: `400 13px ${F.mono}`, color: C.faint }}>
                {total} {p('count')}
              </span>
            </h2>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
              {HELP_CATEGORIES.map((c) => {
                const [wash, ink] = TINT[c.icon] ?? TINT.rocket;
                return (
                  <a key={c.slug} href={`/help/${c.slug}`} className="trust-card" style={{ display: 'block', padding: '22px 24px', background: C.card, border: `1px solid ${C.line}`, borderRadius: 18 }}>
                    <span style={{ display: 'inline-flex', width: 30, height: 30, borderRadius: 9, background: wash, alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: ink, display: 'block' }} />
                    </span>
                    <div style={{ marginTop: 13, fontSize: 17.5, fontWeight: 600, letterSpacing: '-0.01em' }}>{c.title[i]}</div>
                    <p style={{ margin: '9px 0 0', fontSize: 14, lineHeight: 1.65, color: C.body }}>{c.desc[i]}</p>
                    <div style={{ marginTop: 13, font: `400 11.5px ${F.mono}`, color: C.faint }}>
                      {c.articles.length} {p('count')}
                    </div>
                  </a>
                );
              })}
            </div>

            <h2 style={{ margin: '46px 0 16px', fontSize: 22, letterSpacing: '-0.02em' }}>{p('popular')}</h2>
            <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              {popularArticles().map(({ category, article }) => (
                <Card
                  key={`${category.slug}/${article.slug}`}
                  href={`/help/${category.slug}/${article.slug}`}
                  title={article.title[i]}
                  body={article.excerpt[i]}
                  note={category.title[i]}
                />
              ))}
            </div>
          </>
        )}

        <div style={{ margin: '38px 0 0', padding: '26px 28px', background: C.sand, borderRadius: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{p('askHead')}</div>
          <p style={{ margin: '10px 0 0', maxWidth: 620, fontSize: 15, lineHeight: 1.7, color: C.body }}>{p('ask')}</p>
        </div>
      </div>
    </SiteChrome>
  );
}
