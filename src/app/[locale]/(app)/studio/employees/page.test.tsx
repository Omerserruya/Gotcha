import type { ReactElement, ReactNode } from 'react';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import { EmployeeList } from '@/features/employees/EmployeeList';
import { EmployeeRail } from '@/features/employees/EmployeeRail';
import { StudioSplit } from '@/features/studio/StudioSplit';
import { PageContainer } from '@/shell/PageContainer';

const loadEmployees = vi.hoisted(() => vi.fn());
vi.mock('@/features/employees/load-employees', () => ({ loadEmployees }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/i18n/navigation', () => ({ Link: 'a' }));

const employee = (id: string, status = 'ACTIVE') =>
  employeeSchema.parse({ id, name: `Employee ${id}`, status });

function find<P>(node: ReactNode, type: unknown): P | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find<P>(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, ReactNode>>;
  if (element.type === type) return element.props as P;
  for (const value of Object.values(element.props ?? {})) {
    const hit = find<P>(value as ReactNode, type);
    if (hit) return hit;
  }
  return null;
}

const page = async (employees: unknown, query: Record<string, string> = {}) => {
  loadEmployees.mockResolvedValue(employees);
  const { default: Page } = await import('./page');
  return Page({ searchParams: Promise.resolve(query) });
};

describe('★★ 07 is 02’s screen — header, then the list beside the selected one', () => {
  it('a screen page, flush, with the hire action in the header', async () => {
    const tree = (await page([employee('a')])) as ReactElement<{
      layout: string;
      flush: boolean;
      actions: ReactNode;
    }>;
    expect(tree.type).toBe(PageContainer);
    expect(tree.props).toMatchObject({ layout: 'screen', flush: true });
    expect(isValidElement(tree.props.actions)).toBe(true);
  });

  it('★ the selected employee is the one asked for; the detail holds only it', async () => {
    const tree = await page([employee('a'), employee('b')], { employee: 'b' });
    expect(find<{ selectedId: string }>(tree, EmployeeRail)?.selectedId).toBe('b');
    const detail = find<{ employees: { id: string }[] }>(tree, EmployeeList);
    expect(detail?.employees.map((e) => e.id)).toEqual(['b']);
  });

  it('an unknown id falls back to the first — never an empty detail', async () => {
    const tree = await page([employee('a'), employee('b')], { employee: 'gone' });
    expect(find<{ selectedId: string }>(tree, EmployeeRail)?.selectedId).toBe('a');
  });

  it('none, or a failed read: the frame is still drawn, the state in the detail', async () => {
    for (const read of [[], null]) {
      const tree = await page(read);
      const split = find<{ list: ReactNode; detail: ReactElement }>(tree, StudioSplit);
      expect(split).not.toBeNull();
      expect(split!.list).toBeNull();
      expect((split!.detail.props as { 'data-testid': string })['data-testid']).toBe(
        read === null ? 'employees-unavailable' : 'employees-empty',
      );
    }
  });
});
