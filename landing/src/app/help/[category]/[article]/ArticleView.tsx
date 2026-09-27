'use client';

import React from 'react';
import { LandingChrome } from '@/components/Landing';
import { MarkdownText } from '@/components/Markdown';
import { useLocale } from '@/lib/use-locale';
import { localeHref } from '@/lib/locale-url';
import type { Locale } from '@/lib/site';
import { C, F, isHe } from '@/lib/site';
import type { HelpArticle, HelpCategory } from '@/content/help';

const COPY = {
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
  pinned,
}: {
  category: HelpCategory;
  article: HelpArticle;
  /**
   * Set when this article's language is part of its address. The switch then
   * navigates to the sibling article instead of swapping the text in place.
   */
  pinned?: Locale;
}) {
  const [locale, setLocale] = useLocale(pinned);
  const i = isHe(locale) ? 1 : 0;
  const siblings = category.articles.filter((a) => a.slug !== article.slug);

  return (
    <LandingChrome
      initialLang={locale}
      onLang={(l: string) => {
        const next = l === 'he' ? 'he' : 'en';
        if (pinned) {
          // Derived from the live path: the same page has a different
          // shape on the apex and on its own subdomain.
          window.location.href = localeHref(window.location.pathname, next);
          return;
        }
        setLocale(next);
      }}
    >
      <div data-no-translate style={{ padding: '98px 0 0' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '8px 24px 0' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <a href={localeHref("/help", locale)} style={{ font: `500 11px ${F.mono}`, letterSpacing: '.16em', textTransform: 'uppercase', color: C.accent }}>
            {isHe(locale) ? '→' : '←'} {category.title[i]}
          </a>
        </div>

        <h1 style={{ margin: '18px 0 0', fontSize: 38, lineHeight: 1.13, letterSpacing: '-0.03em', maxWidth: 760 }}>
          {article.title[i]}
        </h1>
        <p style={{ margin: '14px 0 0', maxWidth: 640, fontSize: 16.5, lineHeight: 1.6, color: C.body }}>
          {article.excerpt[i]}
        </p>


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
                  href={localeHref(`/help/${category.slug}/${a.slug}`, locale)}
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
    </div>
    </LandingChrome>
  );
}
