import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** 01's layout, read from the stylesheet. */
const css = readFileSync('src/features/home/Home.module.css', 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const rule = (selector: string) =>
  new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe('★ 01 sits inside the frame, in three columns', () => {
  it('the page is the frame’s height, not at least it', () => {
    expect(rule('page')).toMatch(/block-size:\s*100%/);
    expect(rule('page')).not.toMatch(/min-block-size:\s*100%/);
  });

  it('three columns, 447 · 331 · 331, in a bounded row', () => {
    expect(rule('columns')).toMatch(
      /grid-template-columns:\s*minmax\(0, 447fr\) minmax\(0, 331fr\) minmax\(0, 331fr\)/,
    );
    expect(rule('columns')).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
  });

  it('the queue scrolls inside its card', () => {
    expect(rule('queueColumn > \\.queueCard,\\s*\\.queueColumn > \\.workCard')).toMatch(
      /overflow-y:\s*auto/,
    );
  });

  it('a row is one line: the name cut, the channel beside it', () => {
    expect(rule('queueRowName')).toMatch(/white-space:\s*nowrap/);
    expect(rule('queueRowName')).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule('queueRowChannel')).toMatch(/white-space:\s*nowrap/);
    expect(rule('queueRowText')).toMatch(/flex-direction:\s*column/);
  });
});

describe('★ 01d — a lone "Mark read" aligns with the text', () => {
  const panel = readFileSync('src/features/notifications/Notifications.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  it('pulls back by its own padding when it is first on the row', () => {
    expect(/\.quiet:first-child\s*\{([^}]*)\}/.exec(panel)?.[1]).toMatch(
      /margin-inline-start:\s*calc\(-1 \* var\(--space-6\)\)/,
    );
  });
});

describe('★ 01b — a quiet day is two columns', () => {
  it('646 · 478, bounded like the busy grid', () => {
    expect(rule('columnsQuiet')).toMatch(
      /grid-template-columns:\s*minmax\(0, 646fr\) minmax\(0, 478fr\)/,
    );
    expect(rule('columnsQuiet')).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
  });
});

describe('★ 01b — the work rows: one line, buttons not links, edges by type', () => {
  it('the actions are links drawn as buttons', () => {
    expect(rule('actionPrimary,\\s*\\.actionSecondary')).toMatch(/text-decoration:\s*none/);
  });
  it('the body is one line', () => {
    expect(rule('workRowBody')).toMatch(/white-space:\s*nowrap/);
    expect(rule('workRowBody')).toMatch(/text-overflow:\s*ellipsis/);
  });
  it.each([
    ['workRowGap', 'intent-blocked-edge'],
    ['workRowConflict', 'intent-urgent-edge'],
    ['workRowOpportunity', 'intent-opportunity-edge'],
  ])('.%s is %s', (selector, token) => {
    expect(rule(selector)).toContain(`var(--${token})`);
  });
});
