import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import employees from '@/i18n/messages/en/employees.json';

import { EmployeeToolLevels, type ToolLevelRow } from './EmployeeToolLevels';

/** E5 (Omer, 2026-10-13). The write is mocked: what it is asked. */
const { setEmployeeToolLevel, refresh } = vi.hoisted(() => ({
  setEmployeeToolLevel: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('./tool-level-actions', () => ({ setEmployeeToolLevel }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

const row = (over: Partial<ToolLevelRow> = {}): ToolLevelRow => ({
  toolName: 'woocommerce.create_refund',
  label: 'WooCommerce · Create a refund',
  workspaceLevel: 'ask',
  ownLevel: null,
  employeeLevel: 'ask',
  allowedLevels: ['ask', 'never'],
  ...over,
});
const show = (rows: readonly ToolLevelRow[] | null = [row()]) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ employees }}>
      <EmployeeToolLevels employeeId="e1" rows={rows} />
    </NextIntlClientProvider>,
  );
const T = 'woocommerce.create_refund';

beforeEach(() => {
  setEmployeeToolLevel.mockReset();
  setEmployeeToolLevel.mockResolvedValue({ ok: true });
  refresh.mockReset();
});

describe('★★ E5 - this employee’s level per action, never looser than the workspace', () => {
  it('★★ the workspace’s forbidden level is drawn greyed, with why, and pressing it sends nothing', () => {
    show();
    const doIt = screen.getByTestId(`level-${T}-execute`);
    expect(doIt).toHaveAttribute('aria-disabled', 'true');
    expect(doIt).toHaveAttribute(
      'title',
      'The workspace sets this to “Ask me”. An employee can only be the same or stricter.',
    );
    fireEvent.click(doIt);
    expect(setEmployeeToolLevel).not.toHaveBeenCalled();
    expect(screen.getByTestId('levels-rule')).toHaveTextContent('never looser');
  });

  it('★★ a stricter level saves at once, as its own', async () => {
    show();
    fireEvent.click(screen.getByTestId(`level-${T}-never`));
    await waitFor(() => expect(setEmployeeToolLevel).toHaveBeenCalledWith('e1', T, 'never'));
    expect(screen.getByTestId(`level-${T}-never`)).toHaveAttribute('data-current', 'yes');
    expect(screen.getByTestId(`level-source-${T}`)).toHaveTextContent('own setting');
    expect(refresh).toHaveBeenCalled();
  });

  it('★ choosing the workspace’s own level is "like the workspace" (null)', async () => {
    show([row({ ownLevel: 'never', employeeLevel: 'never' })]);
    fireEvent.click(screen.getByTestId(`level-${T}-ask`));
    await waitFor(() => expect(setEmployeeToolLevel).toHaveBeenCalledWith('e1', T, null));
  });

  it('★ an own level offers the way back; "like the workspace" offers none', async () => {
    show([row({ ownLevel: 'never', employeeLevel: 'never' })]);
    fireEvent.click(screen.getByTestId(`level-reset-${T}`));
    await waitFor(() => expect(setEmployeeToolLevel).toHaveBeenCalledWith('e1', T, null));
    expect(screen.queryByTestId(`level-reset-${T}`)).toBeNull();
    expect(screen.getByTestId(`level-${T}-ask`)).toHaveAttribute('data-current', 'yes');
  });

  it('★★ refused: said in words, and the level goes back', async () => {
    setEmployeeToolLevel.mockResolvedValueOnce({ ok: false, reason: 'looser' });
    show();
    fireEvent.click(screen.getByTestId(`level-${T}-never`));
    expect(await screen.findByTestId(`level-problem-${T}`)).toHaveTextContent(
      'looser than the workspace allows',
    );
    expect(screen.getByTestId(`level-${T}-ask`)).toHaveAttribute('data-current', 'yes');
  });

  it('a failed read is said; none is said', () => {
    const { unmount } = show(null);
    expect(screen.getByTestId('levels-unavailable')).toBeInTheDocument();
    unmount();
    show([]);
    expect(screen.queryByTestId('levels-rows')).toBeNull();
  });
});
