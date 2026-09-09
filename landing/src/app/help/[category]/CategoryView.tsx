'use client';

import React from 'react';
import SiteChrome from '@/components/SiteChrome';
import { useLocale } from '@/lib/use-locale';
import { C, F, MAXW, isHe } from '@/lib/site';
import type { HelpCategory } from '@/content/help';

const COPY = {
  back: ['Help center', 'מרכז עזרה'],
  count: ['articles', 'מאמרים'],
} as const;

export default function CategoryView({ category }: { category: HelpCategory }) {
  const [locale, setLocale] = useLocale();
  const i = isHe(locale) ? 1 : 0;

  return (
    <SiteChrome locale={locale} onLocale={setLocale}>
      <div style={{ maxWidth: MAXW, margin: '0 auto', padding: '44px 24px 0' }}>
        <a href="/help" style={{ font: `500 11px ${F.mono}`, letterSpacing: '.16em', textTransform: 'uppercase', color: C.accent }}>
          {isHe(locale) ? '→' : '←'} {COPY.back[i]}
        </a>

        <h1 style={{ margin: '18px 0 0', fontSize: 42, lineHeight: 1.1, letterSpacing: '-0.03em' }}>
          {category.title[i]}
        </h1>
        <p style={{ margin: '16px 0 0', maxWidth: 640, fontSize: 16.5, lineHeight: 1.65, color: C.body }}>
          {category.desc[i]}
        </p>
        <div style={{ marginTop: 14, font: `400 11.5px ${F.mono}`, color: C.faint }}>
          {category.articles.length} {COPY.count[i]}
        </div>

        <div style={{ margin: '32px 0 0', display: 'grid', gap: 12 }}>
          {category.articles.map((a) => (
            <a
              key={a.slug}
              href={`/help/${category.slug}/${a.slug}`}
              className="trust-card"
              style={{
                display: 'block',
                padding: '20px 24px',
                background: C.card,
                border: `1px solid ${C.line}`,
                borderRadius: 16,
              }}
            >
              <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{a.title[i]}</div>
              <p style={{ margin: '8px 0 0', fontSize: 14.5, lineHeight: 1.65, color: C.body, maxWidth: '72ch' }}>
                {a.excerpt[i]}
              </p>
            </a>
          ))}
        </div>
      </div>
    </SiteChrome>
  );
}
