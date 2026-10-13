import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import employees from '@/i18n/messages/en/employees.json';
import he from '@/i18n/messages/he/employees.json';

import { EmployeeToolLevels, type ToolLevelRow } from './EmployeeToolLevels';

/** E5 (Omer, 2026-10-13). The write is mocked: what it is asked. */
const { setEmployeeToolLevel, setEmployeeToolGrant, refresh } = vi.hoisted(() => ({
  setEmployeeToolLevel: vi.fn(),
  setEmployeeToolGrant: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('./tool-level-actions', () => ({ setEmployeeToolLevel }));
vi.mock('./tool-grant-actions', () => ({ setEmployeeToolGrant }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

const row = (over: Partial<ToolLevelRow> = {}): ToolLevelRow => ({
  toolName: 'woocommerce.create_refund',
  label: 'WooCommerce · Create a refund',
  workspaceLevel: 'ask',
  ownLevel: null,
  employeeLevel: 'ask',
  allowedLevels: ['ask', 'never'],
  granted: true,
  grantable: true,
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
  setEmployeeToolGrant.mockReset();
  setEmployeeToolGrant.mockResolvedValue({ ok: true });
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

describe('★★ given to it (Backend 9339ca26): an integration action reaches it only when given', () => {
  it('given: on; switched off, taken away at once - and the page read again', async () => {
    show();
    const give = screen.getByTestId(`level-give-${T}`);
    expect(give).toBeChecked();
    expect(screen.queryByTestId(`level-not-given-${T}`)).toBeNull();
    fireEvent.click(give);
    await waitFor(() => expect(setEmployeeToolGrant).toHaveBeenCalledWith('e1', T, false));
    expect(screen.getByTestId(`level-give-${T}`)).not.toBeChecked();
    expect(screen.getByTestId(`level-not-given-${T}`)).toHaveTextContent(
      "Not given to it: it can't use this action.",
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('★ the words toggle it too: not given, pressing "Give it this" gives it', async () => {
    show([row({ granted: false })]);
    expect(screen.getByTestId(`level-not-given-${T}`)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Give it this'));
    await waitFor(() => expect(setEmployeeToolGrant).toHaveBeenCalledWith('e1', T, true));
  });

  it('★★ one the workspace has not set up: greyed, with why, and pressing it sends nothing', () => {
    show([row({ granted: false, grantable: false })]);
    const give = screen.getByTestId(`level-give-${T}`);
    expect(give).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId(`level-give-row-${T}`)).toHaveAttribute(
      'title',
      "The workspace hasn't set this action up yet, so it can't be given.",
    );
    fireEvent.click(give);
    expect(setEmployeeToolGrant).not.toHaveBeenCalled();
    expect(give).not.toBeChecked();
  });

  it('a built-in needs no grant: no switch, no note', () => {
    show([row({ toolName: 'send_message', granted: null, grantable: false })]);
    expect(screen.queryByTestId('level-give-send_message')).toBeNull();
    expect(screen.queryByTestId('level-not-given-send_message')).toBeNull();
  });

  it('★ refused: the switch goes back, and why is said', async () => {
    setEmployeeToolGrant.mockResolvedValueOnce({ ok: false, reason: 'not_provisioned' });
    show([row({ granted: false })]);
    fireEvent.click(screen.getByTestId(`level-give-${T}`));
    await waitFor(() =>
      expect(screen.getByTestId(`level-give-problem-${T}`)).toHaveTextContent(
        "The workspace hasn't set this action up yet",
      ),
    );
    expect(screen.getByTestId(`level-give-${T}`)).not.toBeChecked();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Hebrew: "לתת לו"', () => {
    render(
      <NextIntlClientProvider locale="he" messages={{ employees: he }}>
        <EmployeeToolLevels employeeId="e1" rows={[row({ granted: false })]} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId(`level-give-row-${T}`)).toHaveTextContent('לתת לו');
    expect(screen.getByTestId(`level-not-given-${T}`)).toHaveTextContent(
      'לא ניתן לו: הוא לא יכול להשתמש בפעולה הזו.',
    );
  });
});
