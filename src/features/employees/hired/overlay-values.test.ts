import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** 07b–07f's overlay values, read from the stylesheets. */
const read = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (css: string, selector: string) =>
  new RegExp(`(?:^|\\n)\\s*\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe('★ the studio overlays, measured', () => {
  it('the scrim is 72%: the mock dims the rail twice, and this matches its pixels', () => {
    expect(rule(read('src/features/employees/hire/Hire.module.css'), 'scrim')).toMatch(
      /background-color:\s*rgb\(10 10 10 \/ 72%\)/,
    );
  });

  it('07e: 720 wide, 120 from the top, centred', () => {
    const dialog = rule(read('src/features/employees/hired/Hired.module.css'), 'dialog');
    expect(dialog).toMatch(/inline-size:\s*min\(720px/);
    expect(dialog).toMatch(/inset-block-start:\s*120px/);
    expect(dialog).toMatch(/translate:\s*-50% 0/);
  });
});
