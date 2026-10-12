import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import messages from '@/i18n/messages/en/workspace.json';

import type { DepartmentSla } from './load-sla-setup';
import { SlaDrawer } from './SlaDrawer';

/** W2's drawer. The save is mocked: what it is asked to store. */
const { saveSla } = vi.hoisted(() => ({ saveSla: vi.fn() }));
vi.mock('./sla-actions', () => ({ saveSla }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const settings = { enabled: true, slaMinutes: 30, warningThreshold: 70 };
const departments: DepartmentSla[] = [
  { id: 'd1', name: 'Sales', own: { enabled: true, slaMinutes: 10, warningThreshold: null } },
  { id: 'd2', name: 'Support', own: { enabled: false, slaMinutes: null, warningThreshold: null } },
  { id: 'd3', name: 'Returns', own: null },
];
const show = (deps: readonly DepartmentSla[] | null = departments, s = settings) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ workspace: messages }}>
      <SlaDrawer settings={s} departments={deps} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  saveSla.mockReset();
  saveSla.mockResolvedValue({ ok: true });
});

describe('★★ W2 - the drawer saves exactly what it shows', () => {
  it('★★ the whole target, and only the departments that changed', async () => {
    show();
    fireEvent.change(screen.getByTestId('sla-minutes'), { target: { value: '45' } });
    fireEvent.click(screen.getByTestId('sla-department-own-d2'));
    fireEvent.change(screen.getByTestId('sla-department-minutes-d2'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    await waitFor(() => expect(saveSla).toHaveBeenCalledTimes(1));
    expect(saveSla).toHaveBeenCalledWith({
      enabled: true,
      slaMinutes: 45,
      warningThreshold: 70,
      departments: [{ id: 'd2', enabled: true, slaMinutes: 20 }],
    });
    expect(await screen.findByTestId('sla-saved')).toBeInTheDocument();
  });

  it('★ an empty warning is "no early warning", sent as null', async () => {
    show();
    fireEvent.change(screen.getByTestId('sla-warning'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    await waitFor(() => expect(saveSla).toHaveBeenCalled());
    expect(saveSla.mock.calls[0]![0].warningThreshold).toBeNull();
  });

  it('★ switching a department’s own target off sends it off', async () => {
    show();
    fireEvent.click(screen.getByTestId('sla-department-own-d1'));
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    await waitFor(() => expect(saveSla).toHaveBeenCalled());
    expect(saveSla.mock.calls[0]![0].departments).toEqual([
      { id: 'd1', enabled: false, slaMinutes: null },
    ]);
  });

  it('★★ a department whose target could not be read is shown, never editable, never sent', async () => {
    show();
    expect(screen.getByTestId('sla-department-unread-d3')).toBeInTheDocument();
    expect(screen.queryByTestId('sla-department-own-d3')).toBeNull();
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    await waitFor(() => expect(saveSla).toHaveBeenCalled());
    expect(saveSla.mock.calls[0]![0].departments).toEqual([]);
  });

  it.each([
    ['sla-minutes', '0'],
    ['sla-minutes', '1441'],
    ['sla-minutes', '2.5'],
    ['sla-warning', '101'],
  ])('★★ %s = %s is refused before anything is sent', async (field, value) => {
    show();
    fireEvent.change(screen.getByTestId(field), { target: { value } });
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    expect(await screen.findByTestId('sla-problem')).toHaveTextContent(
      'Fix the highlighted values first.',
    );
    expect(saveSla).not.toHaveBeenCalled();
  });

  it('★ a department switched to its own target with no minutes is refused too', async () => {
    show();
    fireEvent.click(screen.getByTestId('sla-department-own-d2'));
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    expect(await screen.findByTestId('sla-problem')).toHaveTextContent(
      'Fix the highlighted values first.',
    );
    expect(screen.getByTestId('sla-department-minutes-d2')).toHaveAttribute('aria-invalid', 'true');
    expect(saveSla).not.toHaveBeenCalled();
  });

  it('departments unread: said, and the workspace’s target still saves', async () => {
    show(null);
    expect(screen.getByTestId('sla-departments-unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    await waitFor(() => expect(saveSla).toHaveBeenCalled());
  });

  it('★ some departments failed: named, not "saved"', async () => {
    saveSla.mockResolvedValue({ ok: false, reason: 'departments', failed: ['d1'] });
    show();
    fireEvent.click(screen.getByTestId('drawer-save-sla'));
    expect(await screen.findByTestId('sla-problem')).toHaveTextContent(
      "The workspace's target saved. These departments didn't: Sales. Try again.",
    );
    expect(screen.queryByTestId('sla-saved')).toBeNull();
  });

  it('says it marks conversations and moves none', () => {
    show();
    expect(screen.getByTestId('sla-drawer')).toHaveTextContent("It doesn't move or reassign them.");
  });
});
