import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/i18n/messages/en/roles.json';
import he from '@/i18n/messages/he/roles.json';

/* A role change on a real person: a spy, always. */
const changeRole = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ changeRole }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { ChangeRole } from './ChangeRole';

beforeEach(() => {
  changeRole.mockReset();
  refresh.mockReset();
});

const show = (locale: 'en' | 'he' = 'en', held = 1) =>
  render(
    <NextIntlClientProvider locale={locale} messages={{ roles: locale === 'en' ? en : he }}>
      <ChangeRole
        userId="u1"
        personName="Maya"
        current={{ id: 'admin', name: locale === 'en' ? 'Admin' : 'מנהל/ת' }}
        scope="TEAM"
        held={held}
        choices={[
          { id: 'admin', name: 'Admin' },
          { id: 'agent', name: locale === 'en' ? 'Agent' : 'נציג/ה' },
        ]}
      />
    </NextIntlClientProvider>,
  );
const pick = async (id = 'agent') => {
  await userEvent.click(screen.getByTestId('change-role'));
  await userEvent.selectOptions(screen.getByTestId('change-role-select'), id);
};

describe('★★ 12d Change - chosen, said, and only then sent', () => {
  it('the role they hold is not offered; nothing is sent until Yes', async () => {
    show();
    await userEvent.click(screen.getByTestId('change-role'));
    const options = [...screen.getByTestId('change-role-select').querySelectorAll('option')];
    expect(options.map((o) => o.value)).toEqual(['', 'agent']);
    expect(screen.getByTestId('change-role-yes')).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId('change-role-select'), 'agent');
    expect(screen.getByTestId('change-role-ask')).toHaveTextContent(
      'Maya becomes Agent, instead of Admin. It takes effect within a minute.',
    );
    expect(changeRole).not.toHaveBeenCalled();
  });

  it('Yes sends the role and the scope kept; then "within a minute", never "done everywhere"', async () => {
    changeRole.mockResolvedValue({ ok: true });
    show();
    await pick();
    await userEvent.click(screen.getByTestId('change-role-yes'));
    expect(changeRole).toHaveBeenCalledWith('u1', 'agent', 'TEAM');
    expect(screen.getByTestId('change-role-done')).toHaveTextContent(
      'Maya is now Agent. It takes effect within a minute.',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('holding several: the question says all of them are replaced', async () => {
    show('en', 3);
    await pick();
    expect(screen.getByTestId('change-role-ask')).toHaveTextContent(
      'This replaces all 3 roles Maya holds now.',
    );
  });

  it('Cancel sends nothing', async () => {
    show();
    await pick();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(changeRole).not.toHaveBeenCalled();
    expect(screen.getByTestId('change-role')).toBeInTheDocument();
  });
});

describe('★★ the server’s refusals, said in words (Omer: "test that the UI says it in words")', () => {
  it.each([
    ['self_lockout', "You can't remove your own admin access. Ask another admin."],
    ['last_admin', "This is the workspace's last admin. Make someone else an admin first."],
    ['forbidden', "Only an admin can change a person's role."],
    ['gone', "This person or role isn't here any more."],
    ['failed', "The role wasn't changed. Try again."],
  ])('%s', async (reason, words) => {
    changeRole.mockResolvedValue({ ok: false, reason });
    show();
    await pick();
    await userEvent.click(screen.getByTestId('change-role-yes'));
    expect(screen.getByTestId('change-role-problem')).toHaveTextContent(words);
    expect(screen.getByTestId('change-role-problem')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('change-role-done')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('in Hebrew too - the two lock-outs, in Hebrew words', async () => {
    changeRole.mockResolvedValue({ ok: false, reason: 'self_lockout' });
    const one = show('he');
    await pick();
    await userEvent.click(screen.getByTestId('change-role-yes'));
    expect(screen.getByTestId('change-role-problem')).toHaveTextContent(
      'אי אפשר להסיר את הרשאת הניהול של עצמך',
    );
    one.unmount();
    changeRole.mockResolvedValue({ ok: false, reason: 'last_admin' });
    show('he');
    await pick();
    await userEvent.click(screen.getByTestId('change-role-yes'));
    expect(screen.getByTestId('change-role-problem')).toHaveTextContent(
      'זה המנהל/ת האחרון/ה של סביבת העבודה',
    );
  });
});

describe('★★ the grant ceiling, in the same sentences as every other save (auth 679b8812)', () => {
  it.each([
    [
      'above_own_role',
      { ok: false, reason: 'above_own_role', missing: ['crm:contacts:update'] },
      `You can't give permissions you don't hold yourself: ${en.form.row['crm:contacts']} · ${en.form.action.update}. Nothing was changed.`,
    ],
    ['owner_only', { ok: false, reason: 'owner_only' }, en.ceiling.ownerOnly],
  ])('%s', async (_reason, outcome, words) => {
    changeRole.mockResolvedValue(outcome);
    show();
    await pick();
    await userEvent.click(screen.getByTestId('change-role-yes'));
    expect(screen.getByTestId('change-role-problem')).toHaveTextContent(words);
    expect(screen.queryByTestId('change-role-done')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('in Hebrew, OWNER_ONLY in Hebrew words', async () => {
    changeRole.mockResolvedValue({ ok: false, reason: 'owner_only' });
    show('he');
    await pick();
    await userEvent.click(screen.getByTestId('change-role-yes'));
    expect(screen.getByTestId('change-role-problem')).toHaveTextContent(he.ceiling.ownerOnly);
  });
});
