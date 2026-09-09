'use client';

import React from 'react';
import SiteChrome from '@/components/SiteChrome';
import { MarkdownText } from '@/components/Markdown';
import { useLocale } from '@/lib/use-locale';
import { C, F, isHe } from '@/lib/site';
import type { HelpArticle, HelpCategory } from '@/content/help';

const COPY = {
  other: ['Read in Hebrew', 'Read in English'],
  more: ['More in this section', 'עוד בחלק הזה'],
  askHead: ['Still stuck?', 'עדיין תקועים?'],
  ask: [
    'Message us on WhatsApp and a person answers, usually in minutes.',
    'שלחו לנו וואטסאפ ואדם עונה, בדרך כלל תוך דקות.',
  ],
} as const;

export default function ArticleView({
  category,
  article,
}: {
  category: HelpCategory;
  article: HelpArticle;
}) {
  const [locale, setLocale] = useLocale();
  const i = isHe(locale) ? 1 : 0;
  const siblings = category.articles.filter((a) => a.slug !== article.slug);

  return (
    <SiteChrome locale={locale} onLocale={setLocale}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '44px 24px 0' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <a href="/help" style={{ font: `500 11px ${F.mono}`, letterSpacing: '.16em', textTransform: 'uppercase', color: C.accent }}>
            {isHe(locale) ? '→' : '←'} {category.title[i]}
          </a>
        </div>

        <h1 style={{ margin: '18px 0 0', fontSize: 38, lineHeight: 1.13, letterSpacing: '-0.03em', maxWidth: 760 }}>
          {article.title[i]}
        </h1>
        <p style={{ margin: '14px 0 0', maxWidth: 640, fontSize: 16.5, lineHeight: 1.6, color: C.body }}>
          {article.excerpt[i]}
        </p>

        <button
          onClick={() => setLocale(isHe(locale) ? 'en' : 'he')}
          style={{
            marginTop: 16,
            border: `1px solid ${C.line}`,
            background: C.card,
            borderRadius: 9,
            padding: '6px 12px',
            cursor: 'pointer',
            font: `500 12px ${F.sans}`,
            color: C.ink,
          }}
        >
          {COPY.other[i]}
        </button>

        <article style={{ marginTop: 34, minWidth: 0 }}>
          <MarkdownText text={article.body[i]} />
        </article>

        {siblings.length > 0 && (
          <>
            <h2 style={{ margin: '46px 0 14px', fontSize: 20, letterSpacing: '-0.02em' }}>{COPY.more[i]}</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              {siblings.map((a) => (
                <a
                  key={a.slug}
                  href={`/help/${category.slug}/${a.slug}`}
                  className="trust-card"
                  style={{ display: 'block', padding: '16px 20px', background: C.card, border: `1px solid ${C.line}`, borderRadius: 14 }}
                >
                  <span style={{ fontSize: 15.5, fontWeight: 600 }}>{a.title[i]}</span>
                </a>
              ))}
            </div>
          </>
        )}

        <div style={{ margin: '38px 0 0', padding: '24px 26px', background: C.sand, borderRadius: 18 }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{COPY.askHead[i]}</div>
          <p style={{ margin: '9px 0 0', fontSize: 15, lineHeight: 1.7, color: C.body }}>{COPY.ask[i]}</p>
        </div>
      </div>
    </SiteChrome>
  );
}
