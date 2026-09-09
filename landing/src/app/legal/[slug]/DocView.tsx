'use client';

import React from 'react';
import { LandingChrome } from '@/components/Landing';
import Markdown, { anchorFor } from '@/components/Markdown';
import { useLocale } from '@/lib/use-locale';
import { C, F, isHe } from '@/lib/site';

type Doc = { title: string; effectiveDate: string; placeholders: string[]; blocks: any[] };

const COPY = {
  back: ['Trust Center', 'מרכז האמון'],
  effective: ['In effect from', 'בתוקף מיום'],
  contents: ['On this page', 'בעמוד הזה'],
} as const;

/** Section headings, so a long contract has a way in other than scrolling. */
function outline(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind !== 'markdown') continue;
    for (const line of b.text.split('\n')) {
      const m = line.match(/^##\s+(.*)$/);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

export default function DocView({ en, he, slug }: { en: Doc; he: Doc; slug: string }) {
  const [locale, setLocale] = useLocale();
  const i = isHe(locale) ? 1 : 0;
  const doc = isHe(locale) ? he : en;
  const p = (k: keyof typeof COPY) => COPY[k][i];
  const headings = outline(doc.blocks);

  return (
    <LandingChrome initialLang={locale} onLang={(l: string) => setLocale(l === 'he' ? 'he' : 'en')}>
      <div data-no-translate style={{ padding: '98px 0 0' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '8px 24px 0' }}>
        <a href="/legal" style={{ font: `500 11px ${F.mono}`, letterSpacing: '.16em', textTransform: 'uppercase', color: C.accent }}>
          {isHe(locale) ? '→' : '←'} {p('back')}
        </a>

        <h1 style={{ margin: '18px 0 0', fontSize: 42, lineHeight: 1.1, letterSpacing: '-0.03em', maxWidth: 760 }}>
          {doc.title}
        </h1>

        <div style={{ margin: '16px 0 0', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          {doc.effectiveDate && (
            <span style={{ font: `400 12px ${F.mono}`, color: C.faint }}>
              {p('effective')} {doc.effectiveDate}
            </span>
          )}
        </div>

        <div
          className="doc-grid"
          style={{
            display: 'grid',
            gap: 44,
            gridTemplateColumns: headings.length > 2 ? 'minmax(0,1fr) 236px' : 'minmax(0,1fr)',
            alignItems: 'start',
            marginTop: 38,
          }}
        >
          <article style={{ minWidth: 0 }}>
            <Markdown blocks={doc.blocks} />
          </article>

          {headings.length > 2 && (
            <nav
              className="doc-toc"
              style={{
                position: 'sticky',
                top: 92,
                padding: '18px 20px',
                background: C.card,
                border: `1px solid ${C.line}`,
                borderRadius: 16,
              }}
            >
              <div style={{ font: `500 10.5px ${F.mono}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.faint }}>
                {p('contents')}
              </div>
              <div style={{ marginTop: 12, display: 'grid', gap: 9 }}>
                {headings.map((h) => (
                  <a
                    key={h}
                    href={`#${anchorFor(h)}`}
                    className="trust-toc"
                    style={{ fontSize: 13.5, lineHeight: 1.45, color: C.body }}
                  >
                    {h}
                  </a>
                ))}
              </div>
            </nav>
          )}
        </div>
      </div>
    </div>
    </LandingChrome>
  );
}
