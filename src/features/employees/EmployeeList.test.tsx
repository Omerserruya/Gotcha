import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import { employeeSchema } from '@/api/contracts/employees';
import channels from '@/i18n/messages/en/channels.json';
import messages from '@/i18n/messages/en/employees.json';

import { EmployeeList } from './EmployeeList';

/**
 * Screen 07 — what an AI employee IS, not only what it has done.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THREE FIELDS WERE PARSED AND RENDERED NOWHERE
 * ════════════════════════════════════════════════════════════════════════════
 * A browser walk read this screen as "a name and three numbers". `role`,
 * `knowledgeSources` and `lastTestedAt` were all in the contract and all on the
 * wire. So the finding was half tenant state — a dev employee with no department
 * and no channels really does render as name-plus-numbers — and half a component
 * that never asked for three of the fields it had.
 *
 * ⚠ NOTHING HERE PRESSES PAUSE OR DELETE. Both act on a real AI employee against
 * a tenant that answers real customers; the mocks throw.
 */

const pause = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call setEmployeePaused');
  }),
);
const remove = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('a test must never call deleteEmployee');
  }),
);
vi.mock('./actions', () => ({ setEmployeePaused: pause, deleteEmployee: remove }));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: 'employees' | 'channels') =>
    createTranslator({ locale: 'en', messages: { employees: messages, channels }, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Jerusalem' }),
}));

vi.mock('next-intl', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useTranslations: () => (key: string) => key,
}));

const employee = (over: Record<string, unknown> = {}) =>
  employeeSchema.parse({ id: 'e1', name: 'Dana', ...over });

const show = async (over: Record<string, unknown> = {}) =>
  render(await EmployeeList({ employees: [employee(over)] }));

describe('★★ the profile renders every row, empty or not', () => {
  it('★★ names a role the platform knows', async () => {
    await show({ role: 'customer_support' });
    expect(screen.getByTestId('role-e1')).toHaveTextContent('Customer support');
    expect(screen.getByTestId('role-e1')).not.toHaveTextContent('customer_support');
  });

  it('★★ humanises a role added since this catalogue was written', async () => {
    /*
     * The value is true and the only thing missing is our word for it. Dropping
     * the row would hide a fact; printing the code would make the reader
     * translate it.
     */
    await show({ role: 'returns_desk' });
    expect(screen.getByTestId('role-e1')).toHaveTextContent('Returns desk');
  });

  it('★★ says nobody has said what it is for, rather than omitting the row', async () => {
    /*
     * ════════════════════════════════════════════════════════════════════════
     * AN OMITTED ROW AND AN EMPTY ROW ARE DIFFERENT SENTENCES
     * ════════════════════════════════════════════════════════════════════════
     * Omitted reads as "this product has no such concept". Empty reads as "this
     * one is unfinished" — and an employee with no role, nothing attached and no
     * test chat is a draft somebody walked away from, which is the row a reader
     * most needs to see. `role` defaults to `''`, so this is a real state.
     */
    await show({ role: '' });
    const row = screen.getByTestId('role-e1');
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent(/nobody has said what this one is for/i);
  });

  it('lists the knowledge it reads from', async () => {
    await show({
      knowledgeSources: [
        { id: 'k1', name: 'Returns policy', isActive: true },
        { id: 'k2', name: 'Shipping FAQ', isActive: true },
      ],
    });
    const row = screen.getByTestId('knowledge-e1');
    expect(row).toHaveTextContent('Returns policy');
    expect(row).toHaveTextContent('Shipping FAQ');
    expect(screen.queryByTestId('knowledge-off-e1')).toBeNull();
  });

  it('★★ says out loud how many attached sources it cannot read', async () => {
    /*
     * The state that misleads. The list reads as "it knows these things" while
     * one of them is turned off and unreadable, so the count is a sentence rather
     * than a subtle style on one name — a style nobody reads is not a warning.
     */
    await show({
      knowledgeSources: [
        { id: 'k1', name: 'Returns policy', isActive: true },
        { id: 'k2', name: 'Shipping FAQ', isActive: false },
      ],
    });
    expect(screen.getByTestId('knowledge-off-e1')).toHaveTextContent(/one of these is turned off/i);
  });

  it('★ counts several unreadable sources, so both plural branches are covered', async () => {
    /*
     * An ICU message with a wrong `one` form reads perfectly in every test that
     * only ever passes two — which is how the assertion above was written
     * expecting "1 of these" against a message that says "One of these".
     */
    await show({
      knowledgeSources: [
        { id: 'k1', name: 'A', isActive: false },
        { id: 'k2', name: 'B', isActive: false },
        { id: 'k3', name: 'C', isActive: true },
      ],
    });
    expect(screen.getByTestId('knowledge-off-e1')).toHaveTextContent(/2 of these are turned off/i);
  });

  it('★ falls back to the id for a source with no name', async () => {
    await show({ knowledgeSources: [{ id: 'returns_policy', name: '', isActive: true }] });
    expect(screen.getByTestId('knowledge-e1')).toHaveTextContent('Returns policy');
  });

  it('★★ says nothing is attached, and what that means', async () => {
    await show({ knowledgeSources: [] });
    expect(screen.getByTestId('knowledge-e1')).toHaveTextContent(/nothing attached/i);
  });

  it('★★ says nobody opened the test chat — not that it was never tested', async () => {
    /*
     * The contract's own words are "last time someone opened the test chat".
     * "Never tested" would be a claim about whether anybody checked this
     * employee at all, and opening a chat window is not testing.
     */
    await show({ lastTestedAt: null });
    const row = screen.getByTestId('tested-e1');
    expect(row).toHaveTextContent(/nobody has opened the test chat/i);
    expect(row).not.toHaveTextContent(/never tested/i);
  });

  it('dates the last test chat', async () => {
    await show({ lastTestedAt: '2026-09-15T09:00:00.000Z' });
    expect(screen.getByTestId('tested-e1')).toHaveTextContent('2026');
  });
});

describe('the counts, still captioned as what they are', () => {
  it('★ "finished alone" is absent rather than 0% when nothing was routed', async () => {
    await show({ handledConversations: 0, resolvedAlone: 0 });
    expect(screen.getByTestId('alone-e1')).toHaveTextContent(/nothing routed here yet/i);
    expect(screen.getByTestId('alone-e1')).not.toHaveTextContent('0%');
  });

  it('★★ names the channels it answers on, never their enums', async () => {
    await show({ channels: ['WHATSAPP', 'INSTAGRAM'] });
    const row = screen.getByTestId('channels-e1');
    expect(row).toHaveTextContent('WhatsApp');
    expect(row).not.toHaveTextContent('WHATSAPP');
  });
});
