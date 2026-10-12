import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client/api-error';

/** W2's write, against a mocked platform: what is stored, and in what order. */
const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ put }) }));
vi.mock('@/api/client/signed-out', () => ({ signInIfSignedOut: vi.fn() }));

const { saveSla } = await import('./sla-actions');

beforeEach(() => {
  put.mockReset();
  put.mockResolvedValue({});
});

const write = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  slaMinutes: 30,
  warningThreshold: 70 as number | null,
  departments: [] as { id: string; enabled: boolean; slaMinutes: number | null }[],
  ...over,
});

describe('★★ the whole target, every time', () => {
  it('★★ all three fields - the PUT stores its body, so a missing one is erased', async () => {
    expect(await saveSla(write())).toEqual({ ok: true });
    expect(put.mock.calls[0]![0].endpoint.path).toBe('/api/agents/settings/sla');
    expect(put.mock.calls[0]![0].body).toEqual({
      enabled: true,
      slaMinutes: 30,
      warningThreshold: 70,
    });
  });

  it('switched off keeps its minutes, so switching on restores them', async () => {
    await saveSla(write({ enabled: false }));
    expect(put.mock.calls[0]![0].body).toEqual({
      enabled: false,
      slaMinutes: 30,
      warningThreshold: 70,
    });
  });

  it('no early warning: the field is left out', async () => {
    await saveSla(write({ warningThreshold: null }));
    expect(put.mock.calls[0]![0].body).toEqual({ enabled: true, slaMinutes: 30 });
  });

  it('★★ out of range is refused before any request', async () => {
    for (const over of [
      { slaMinutes: 0 },
      { slaMinutes: 1441 },
      { warningThreshold: 101 },
      { departments: [{ id: 'd1', enabled: true, slaMinutes: null }] },
    ]) {
      expect(await saveSla(write(over)), JSON.stringify(over)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    }
    expect(put).not.toHaveBeenCalled();
  });
});

describe('★★ departments after the workspace, each named if it fails', () => {
  it('an own target, and one switched off', async () => {
    await saveSla(
      write({
        departments: [
          { id: 'd1', enabled: true, slaMinutes: 10 },
          { id: 'd2', enabled: false, slaMinutes: null },
        ],
      }),
    );
    expect(put.mock.calls.map(([r]) => [r.endpoint.path, r.body])).toEqual([
      ['/api/agents/settings/sla', { enabled: true, slaMinutes: 30, warningThreshold: 70 }],
      ['/api/agents/settings/sla/department/d1', { enabled: true, slaMinutes: 10 }],
      ['/api/agents/settings/sla/department/d2', { enabled: false }],
    ]);
  });

  it('★ one fails: the rest still saved, that one named', async () => {
    put.mockImplementation(async ({ endpoint }: { endpoint: { path: string } }) => {
      if (endpoint.path.endsWith('/d1')) throw new Error('down');
      return {};
    });
    expect(
      await saveSla(
        write({
          departments: [
            { id: 'd1', enabled: true, slaMinutes: 10 },
            { id: 'd2', enabled: true, slaMinutes: 20 },
          ],
        }),
      ),
    ).toEqual({ ok: false, reason: 'departments', failed: ['d1'] });
    expect(put).toHaveBeenCalledTimes(3);
  });

  it('★ the workspace refused: no department is written', async () => {
    put.mockRejectedValueOnce(new ApiError({ status: 403, kind: 'authorization' }));
    expect(
      await saveSla(write({ departments: [{ id: 'd1', enabled: true, slaMinutes: 10 }] })),
    ).toEqual({ ok: false, reason: 'forbidden' });
    expect(put).toHaveBeenCalledTimes(1);
  });
});
