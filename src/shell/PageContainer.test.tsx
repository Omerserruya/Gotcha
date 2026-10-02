import { readFileSync } from 'node:fs';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PageContainer } from './PageContainer';

/*
 * ★★ `layout="screen"` is 02's page header and body, measured on four
 *    screens (Approvals, Customers, Outreach, Analytics) — one variant that
 *    closes most of the visual gap on all of them.
 */
describe('★★ the screen layout: a header ROW, and a body the panel’s width', () => {
  it('★★ the title, the line under it, and the page’s own controls beside them', () => {
    render(
      <PageContainer
        layout="screen"
        title="Reaching out"
        description="Two running"
        actions={<button>Create</button>}
      >
        <p>body</p>
      </PageContainer>,
    );
    const header = screen.getByRole('banner');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reaching out');
    expect(header).toHaveTextContent('Two running');
    expect(header).toContainElement(screen.getByRole('button', { name: 'Create' }));
    expect(header).not.toContainElement(screen.getByText('body'));
  });

  it('★ the document layout is unchanged — every other page', () => {
    render(<PageContainer title="Settings">x</PageContainer>);
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Settings');
  });
});

describe('★ 02’s measurements, read from the stylesheet', () => {
  const css = readFileSync('src/shell/PageContainer.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const tokens = readFileSync('src/design-system/tokens/tokens.css', 'utf8');

  it('header: a row at 30px 40px 20px, the right side on its bottom edge, no cap', () => {
    expect(rule('screenHeader')).toMatch(/padding:\s*30px var\(--space-40\) var\(--space-20\)/);
    expect(rule('screenHeader')).toMatch(/align-items:\s*flex-end/);
    expect(rule('screen')).not.toMatch(/max-inline-size/);
    // The divider the first trees could not see — they recorded only border-top.
    expect(rule('screenHeader')).toMatch(/border-block-end:\s*1px solid var\(--border-subtle\)/);
  });

  it('title 26/600; the line under it 13px #6B6660', () => {
    expect(rule('screenTitle')).toMatch(/font-size:\s*var\(--font-size-screen-title\)/);
    expect(tokens).toMatch(/--font-size-screen-title:\s*26px/);
    expect(rule('screenDescription')).toMatch(/font-size:\s*13px/);
    expect(rule('screenDescription')).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it('body: the full width at 40px either side', () => {
    expect(rule('screenBody')).toMatch(/padding:\s*var\(--space-24\) var\(--space-40\)/);
  });
});

describe('⚠⚠ the four screens 02 draws this way use it', () => {
  it.each(['approvals', 'customers', 'outreach', 'analytics'])('%s', (page) => {
    const source = readFileSync(`src/app/[locale]/(app)/${page}/page.tsx`, 'utf8');
    const uses = source.match(/<PageContainer\b[^>]*>/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    // Every return — the unavailable and empty states too, not only the main one.
    for (const use of uses) expect(use).toContain('layout="screen"');
  });
});

describe('★★ `fill` — a window you scroll inside, not a document that runs off the screen', () => {
  const css = readFileSync('src/shell/PageContainer.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const pattern = readFileSync('src/design-system/styles/fill.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = (source: string, selector: string) =>
    new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';

  it('the screen is the panel’s height, and the body takes the rest of it', () => {
    expect(rule(css, 'screenFill')).toMatch(/block-size:\s*100%/);
    expect(rule(css, 'screenBodyFill')).toMatch(/flex:\s*1/);
    expect(rule(css, 'screenBodyFill')).toMatch(/min-block-size:\s*0/);
  });

  it('⚠⚠ the card can SHRINK, and its list is what scrolls', () => {
    // Without `min-block-size: 0` a flex child refuses to shrink below its
    // content, and pushes the page instead — the 1175px card on a 900 screen.
    expect(rule(pattern, 'fillCard')).toMatch(/min-block-size:\s*0/);
    expect(rule(pattern, 'fillScroll')).toMatch(/overflow-y:\s*auto/);
    expect(rule(pattern, 'fillScroll')).toMatch(/min-block-size:\s*0/);
  });

  it('★ the body element gets it', () => {
    const { container } = render(
      <PageContainer layout="screen" fill title="t">
        x
      </PageContainer>,
    );
    expect(container.innerHTML).toMatch(/screenBodyFill/);
  });
});
