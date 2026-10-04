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
    expect(rule('queueColumn > \\.queueCard')).toMatch(/overflow-y:\s*auto/);
    expect(rule('queueColumn > \\.workCard')).toMatch(/overflow-y:\s*auto/);
  });

  it('01b: the work card fills its column, the foot at the bottom', () => {
    expect(rule('queueColumn > \\.workCard')).toMatch(/flex:\s*1 1 auto/);
    expect(rule('workFooter')).toMatch(/margin-block-start:\s*auto/);
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

describe('★ 01c — First steps is one card that fits the frame', () => {
  const steps = readFileSync('src/features/home/FirstSteps.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const r = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{([^}]*)\\}`).exec(steps)?.[1] ?? '';
  it('a white bordered card, r18, 880, bounded', () => {
    expect(r('block')).toMatch(/background-color:\s*var\(--panel-field\)/);
    expect(r('block')).toMatch(/border-radius:\s*18px/);
    expect(r('block')).toMatch(/inline-size:\s*880px/);
    expect(r('block')).toMatch(/min-block-size:\s*0/);
  });
  it('the steps and Go live scroll together — Go live last, never pinned over a step', () => {
    expect(r('scroller')).toMatch(/overflow-y:\s*auto/);
    expect(r('list')).not.toMatch(/overflow-y/);
    expect(r('goLive')).toMatch(/flex:\s*none/);
  });
  it('a waiting row is one line', () => {
    expect(r('rowLine \\.rowBody')).toMatch(/white-space:\s*nowrap/);
    expect(r('rowLine \\.rowTitle')).toMatch(/white-space:\s*nowrap/);
    expect(r('doneText')).toMatch(/white-space:\s*nowrap/);
  });
  it('"Hide" is quiet text, not a link', () => {
    expect(r('hide')).toMatch(/text-decoration:\s*none/);
  });
});

describe('★ 01 — composition against 02: no line-height leaking into the head and strip', () => {
  it.each(['greeting', 'strip', 'statusPill'])('.%s is line-height normal', (selector) => {
    expect(rule(selector)).toMatch(/line-height:\s*normal/);
  });

  it('and so is everything inside the head and the strip cells', () => {
    expect(rule('greeting > \\*,\\s*\\.metric \\*,\\s*\\.channels \\*')).toMatch(
      /line-height:\s*normal/,
    );
  });

  it('02’s own spacing: the strip at 34, the pill 7px', () => {
    expect(rule('statusStrip')).toMatch(/padding-block:\s*34px 0/);
    expect(rule('statusPill')).toMatch(/padding-block:\s*7px/);
  });
});

describe('★ 12b / 12c — measured proportions', () => {
  const roles = readFileSync('src/features/roles/Roles.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const r = (selector: string) =>
    new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{([^}]*)\\}`).exec(roles)?.[1] ?? '';
  it('12b: the two cards 494 · 380', () => {
    expect(r('cards')).toMatch(/grid-template-columns:\s*minmax\(0, 494fr\) minmax\(0, 380fr\)/);
  });
  it('12c: the side column 240', () => {
    expect(r('newRole')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 240px/);
  });
});

describe('★ 05c — "Worth knowing" hugs its content', () => {
  const css = readFileSync('src/features/outreach/Outreach.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  it('is not stretched to the column’s foot', () => {
    const body = /(?:^|\n)\s*\.tplWorth\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(body).toMatch(/flex:\s*none/);
  });
});

describe('★ 06 — "Also worth a look" keeps its 300 beside the dark card', () => {
  const css = readFileSync('src/features/analytics/Analytics.module.css', 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  it('no rule widens it when alone', () => {
    expect(css).not.toMatch(/\.also\[data-alone\]/);
    expect(/(?:^|\n)\s*\.also\s*\{([^}]*)\}/.exec(css)?.[1]).toMatch(/inline-size:\s*300px/);
  });
});
