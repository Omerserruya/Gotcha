import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { automationSchema, catalogSchema } from '@/api/contracts/automations';
import automationsMessages from '@/i18n/messages/en/automations.json';
import commonMessages from '@/i18n/messages/en/common.json';

/**
 * ★★ AU2 (dev, 2026-10-14): "Create" hung for ever. The row was made (201),
 * the page never moved: `router.push` ran inside an async transition right
 * after a server action that revalidated the layout, and the navigation never
 * committed. Delete in the builder had the same shape.
 *
 * The rule asserted: a navigation after a write runs with NO transition open.
 * Every transition these screens open is counted while its callback runs, and
 * each `push` records the count it saw. (Whether Next commits it is a browser's
 * question; this is the shape that made it hang.)
 */
const open = vi.hoisted(() => ({ transitions: 0 }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  const counted =
    (start: (fn: () => unknown) => void) =>
    (fn: () => unknown): void =>
      start(async () => {
        open.transitions += 1;
        try {
          await fn();
        } finally {
          open.transitions -= 1;
        }
      });
  return {
    ...actual,
    startTransition: counted(actual.startTransition as (fn: () => unknown) => void),
    useTransition: () => {
      const [pending, start] = actual.useTransition();
      return [pending, counted(start as (fn: () => unknown) => void)] as const;
    },
  };
});

const pushes = vi.hoisted(() => [] as { href: unknown; inTransition: number }[]);
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useRouter: () => ({
    push: (href: unknown) => pushes.push({ href, inTransition: open.transitions }),
    replace: vi.fn(),
  }),
}));
const actions = vi.hoisted(() => ({
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  readCatalog: vi.fn(),
}));
vi.mock('./automation-actions', () => actions);

import { DeleteAutomation } from './DeleteAutomation';
import { NewAutomation } from './NewAutomation';

const wrap = (node: ReactModule.ReactNode) =>
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ automations: automationsMessages, common: commonMessages }}
    >
      {node}
    </NextIntlClientProvider>,
  );

const catalog = catalogSchema.parse({
  data: {
    context: { channel: null, firstStep: true, hasCustomer: true, afterNodeType: null },
    groups: [
      {
        key: 'trigger',
        items: [
          {
            type: 'trigger:schedule',
            label: 'On a schedule',
            description: '',
            channels: [],
            outputs: ['next'],
            synonyms: [],
            available: true,
            reason: null,
          },
        ],
      },
    ],
    variables: [],
  },
}).data;

beforeEach(() => {
  pushes.length = 0;
  open.transitions = 0;
  actions.createAutomation.mockReset();
  actions.deleteAutomation.mockReset();
});

describe('★★ AU2 - a navigation after a write never runs inside a transition', () => {
  it('Create: the builder is opened after the create, with no transition open', async () => {
    actions.createAutomation.mockResolvedValue({
      ok: true,
      automation: automationSchema.parse({
        id: 'new1',
        name: 'On a schedule',
        description: null,
        trigger: { type: 'schedule', config: {} },
        status: 'draft',
        path: [],
        stats: { runsThisWeek: 0, lastRunAt: null, lastRunStatus: null },
        updatedAt: '2026-10-14T10:00:00Z',
      }),
    });
    wrap(<NewAutomation catalog={catalog} />);
    fireEvent.click(screen.getByTestId('step-trigger:schedule'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-automation-create'));
    });
    expect(pushes).toEqual([{ href: '/studio/automations/new1', inTransition: 0 }]);
    // Still "creating" while the builder loads: never a second press.
    expect(screen.getByTestId('new-automation-create')).toBeDisabled();
  });

  it('a refused create: said, and the button back', async () => {
    actions.createAutomation.mockResolvedValue({ ok: false, reason: 'limit' });
    wrap(<NewAutomation catalog={catalog} />);
    fireEvent.click(screen.getByTestId('step-trigger:schedule'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-automation-create'));
    });
    expect(pushes).toEqual([]);
    expect(screen.getByTestId('new-automation-create')).toBeEnabled();
  });

  it('Delete: what was deleted is reported with no transition open', async () => {
    actions.deleteAutomation.mockResolvedValue(true);
    const seen: number[] = [];
    wrap(
      <DeleteAutomation
        targets={[{ id: 'a1', name: 'A' }]}
        onClose={() => {}}
        onDeleted={() => seen.push(open.transitions)}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-automation-yes'));
    });
    expect(seen).toEqual([0]);
  });
});
