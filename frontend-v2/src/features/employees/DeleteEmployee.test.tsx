import { act, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

import type { Employee } from '@/api/contracts/employees';
import messages from '@/i18n/messages/en/employees.json';

import { DeleteEmployee } from './DeleteEmployee';

/**
 * The three claims the delete dialog makes, and the one it must not.
 *
 * Deleting an AI employee **releases its live conversations, keeps the record
 * of the finished ones, and stops new conversations being routed to it**. All
 * three are true of the transaction; the third is the one a merchant could
 * never guess, and the second is the one that changes their decision.
 */

const { remove } = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('./actions', () => ({ deleteEmployee: remove }));

const employee = (over: Partial<Employee> = {}): Employee => ({
  id: 'a1',
  name: 'Maya',
  role: 'customer_support',
  status: 'ACTIVE',
  departmentName: null,
  knowledgeSources: [],
  lastTestedAt: null,
  openConversations: 14,
  handledConversations: 82,
  resolvedAlone: 60,
  tone: '',
  languages: {},
  escalationRules: [],
  identity: null,
  goal: null,
  persona: null,
  departmentId: null,
  createdAt: null,
  updatedAt: null,
  readinessReport: null,
  ...over,
});

function renderDelete(over: Partial<Employee> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ employees: messages }}>
      <DeleteEmployee employee={employee(over)} />
    </NextIntlClientProvider>,
  );
}

const openDialog = async () => act(async () => screen.getByTestId('delete-a1').click());

describe('the people mid-conversation', () => {
  it('names them with the count, in the approved wording', async () => {
    renderDelete();
    await openDialog();

    expect(screen.getByTestId('delete-live-a1')).toHaveTextContent(
      /14 people are mid-conversation with it/i,
    );
    // The two halves of the consequence: no replies, and no owner.
    expect(screen.getByTestId('delete-live-a1')).toHaveTextContent(/stop getting replies/i);
    expect(screen.getByTestId('delete-live-a1')).toHaveTextContent(
      /wait unassigned until someone claims them/i,
    );
  });

  it('still opens honestly when nobody is mid-conversation', async () => {
    renderDelete({ openConversations: 0 });
    await openDialog();
    expect(screen.getByTestId('delete-live-a1')).toHaveTextContent(/nobody is mid-conversation/i);
  });
});

describe('the finished conversations keep their record', () => {
  it('says the history survives, with the count', async () => {
    /*
     * 82 handled, 14 live → 68 finished, and those keep the employee's id.
     * On a closed thread that id is the record of WHO HANDLED IT, and it is
     * what this screen's own "handled in total" figure reads. Releasing them
     * would have erased history to tidy a foreign key.
     */
    renderDelete();
    await openDialog();
    expect(screen.getByTestId('delete-history-a1')).toHaveTextContent(/68 conversations/i);
    expect(screen.getByTestId('delete-history-a1')).toHaveTextContent(
      /doesn't unmake the work it did/i,
    );
  });

  it('never claims the history is removed', async () => {
    // A merchant who believes deleting an employee erases its record makes a
    // different decision than one who knows it does not.
    renderDelete();
    await openDialog();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/history (will be )?(removed|deleted|erased)/i);
    expect(text).not.toMatch(/its conversations are released/i);
  });

  it('omits the claim entirely when there is no history to keep', async () => {
    renderDelete({ handledConversations: 14, openConversations: 14 });
    await openDialog();
    expect(screen.queryByTestId('delete-history-a1')).toBeNull();
    // Positive control: the dialog did open.
    expect(screen.getByTestId('delete-live-a1')).toBeInTheDocument();
  });
});

describe('routing stops, which nobody would guess', () => {
  it('says new conversations stop being sent to it', async () => {
    renderDelete();
    await openDialog();
    expect(screen.getByTestId('delete-routing-a1')).toHaveTextContent(
      /new conversations will stop being sent to it/i,
    );
  });
});

describe('afterwards it reports what happened, not what it predicted', () => {
  it('shows the number the server released', async () => {
    /*
     * The forecast and the result can legitimately differ: the forecast
     * excludes sandbox rows and setup rehearsals, the release does not. The
     * server's number is the evidence, so it is the one shown.
     */
    remove.mockResolvedValue({
      ok: true,
      result: { removedRoutingRules: 1, removedToolGrants: 4, releasedConversations: 17 },
    });
    renderDelete();
    await openDialog();
    await act(async () => screen.getByTestId('delete-go-a1').click());

    const done = screen.getByTestId('deleted-a1');
    expect(done).toHaveTextContent(/17 conversations were released/i);
    // And not the number the dialog forecast.
    expect(done.textContent).not.toMatch(/\b14\b/);
  });

  it('says so plainly when nothing needed releasing', async () => {
    remove.mockResolvedValue({
      ok: true,
      result: { removedRoutingRules: 0, removedToolGrants: 0, releasedConversations: 0 },
    });
    renderDelete({ openConversations: 0 });
    await openDialog();
    await act(async () => screen.getByTestId('delete-go-a1').click());
    expect(screen.getByTestId('deleted-a1')).toHaveTextContent(/no conversation needed releasing/i);
  });

  it('keeps the dialog open and says why when the delete fails', async () => {
    remove.mockResolvedValue({ ok: false, reason: 'forbidden' });
    renderDelete();
    await openDialog();
    await act(async () => screen.getByTestId('delete-go-a1').click());

    expect(screen.getByTestId('delete-error-a1')).toHaveTextContent(/don't have permission/i);
    // Nothing may report a deletion that did not happen.
    expect(screen.queryByTestId('deleted-a1')).toBeNull();
  });
});
