import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href} data-in-app="">
      {children}
    </a>
  ),
}));

import { AnswerText } from './AnswerText';

const show = (text: string) => render(<AnswerText text={text} />).container;

describe('★★ the answer’s markdown subset (assistant-threads-v1 §1)', () => {
  it('bold, italics, inline code - as elements', () => {
    const box = show('Returns are up **38%**, *mostly* one _product_: `duvet-king`.');
    expect(box.querySelector('strong')).toHaveTextContent(/^38%$/);
    expect([...box.querySelectorAll('em')].map((e) => e.textContent)).toEqual([
      'mostly',
      'product',
    ]);
    expect(box.querySelector('code')).toHaveTextContent(/^duvet-king$/);
    expect(box).toHaveTextContent('Returns are up 38%, mostly one product: duvet-king.');
  });

  it('bullet and numbered lists, each a list; paragraphs between', () => {
    const box = show('Top reasons:\n- Size runs small\n- Colour\n\n1. First\n2. Second\nDone.');
    expect([...box.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual([
      'Size runs small',
      'Colour',
    ]);
    expect([...box.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual([
      'First',
      'Second',
    ]);
    expect([...box.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Top reasons:',
      'Done.',
    ]);
    // Each block reads in its own direction.
    for (const block of box.querySelectorAll('p, ul, ol')) {
      expect(block).toHaveAttribute('dir', 'auto');
    }
  });

  it('★ an in-app path is the app’s own link; http(s) opens a new tab', () => {
    const box = show(
      'See [the inbox](/inbox?view=queue) or [Shopify](https://admin.shopify.com/x).',
    );
    const inApp = box.querySelector('a[data-in-app]');
    expect(inApp).toHaveAttribute('href', '/inbox?view=queue');
    const out = [...box.querySelectorAll('a')].find((a) => !a.hasAttribute('data-in-app'))!;
    expect(out).toHaveAttribute('href', 'https://admin.shopify.com/x');
    expect(out).toHaveAttribute('target', '_blank');
    expect(out).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('★★ any other link is its label as plain text - never a link', () => {
    for (const url of [
      'javascript:alert(1)',
      'mailto:a@b.co',
      'tel:+972500000000',
      '//evil.example/x',
      '/\\evil.example',
      'data:text/html,hi',
      'example.com/a',
    ]) {
      const box = show(`[click](${url})`);
      expect(box.querySelector('a'), url).toBeNull();
      // (A url with its own ")" ends at the first one: the rest is text too.)
      expect(box, url).toHaveTextContent(/^click\)?$/);
    }
  });

  it('★★ markup in the text is text: no HTML is ever parsed', () => {
    const box = show('<img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('b')).toBeNull();
    expect(box).toHaveTextContent('<img src=x onerror="alert(1)"> and <b>bold</b>');
  });

  it('★ inside a word, `_` and `*` are part of it - an identifier is never italicised', () => {
    const box = show('Channel SHOPIFY_LIVE_CHAT, file my_report_v2.csv, and 5*3*2 = 30.');
    expect(box.querySelector('em')).toBeNull();
    expect(box).toHaveTextContent(
      'Channel SHOPIFY_LIVE_CHAT, file my_report_v2.csv, and 5*3*2 = 30.',
    );
    // A word's END is not enough: its START must be one too ("order_id_ and", "a*b* c").
    expect(show('Keys like order_id_ and a*b* here.').querySelector('em')).toBeNull();
    // At a word's edge it is still emphasis - in Hebrew too.
    const he = show('זה _חשוב_ מאוד, וגם *דחוף*.');
    expect([...he.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['חשוב', 'דחוף']);
  });

  it('while it streams, a mark not closed yet reads as itself', () => {
    const box = show('Returns are up **38');
    expect(box.querySelector('strong')).toBeNull();
    expect(box).toHaveTextContent('Returns are up **38');
  });
});
