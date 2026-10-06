import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** 07b-07f's overlay values, read from the stylesheets. */
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

describe('★ links drawn as buttons are not underlined', () => {
  it.each([
    ['src/features/employees/Employees.module.css', 'hire'],
    ['src/features/employees/EmployeeDetail.module.css', 'button'],
    ['src/features/knowledge/Knowledge.module.css', 'add'],
    ['src/features/employees/hired/Hired.module.css', 'small'],
    ['src/features/employees/hired/Hired.module.css', 'resolve,\\s*\\.primary'],
    ['src/features/employees/edit/Edit.module.css', 'save,\\s*\\.cancel'],
  ])('%s .%s', (path, selector) => {
    expect(rule(read(path), selector)).toMatch(/text-decoration:\s*none/);
  });
});

describe('★ 07f - what it may do stays one line a row, and scrolls inside its card', () => {
  const css = read('src/features/employees/edit/Edit.module.css');
  it('the name is one line, cut with an ellipsis', () => {
    expect(rule(css, 'mayName')).toMatch(/white-space:\s*nowrap/);
    expect(rule(css, 'mayName')).toMatch(/text-overflow:\s*ellipsis/);
  });
  it('the pills are 02’s compact size, on one line', () => {
    expect(rule(css, 'stance')).toMatch(/font-size:\s*var\(--font-size-counter\)/);
    expect(rule(css, 'stance')).toMatch(/white-space:\s*nowrap/);
  });
  it('the list is 176 tall at most, and scrolls', () => {
    expect(rule(css, 'scroll')).toMatch(/max-block-size:\s*176px/);
    expect(rule(css, 'scroll')).toMatch(/overflow-y:\s*auto/);
  });
});
