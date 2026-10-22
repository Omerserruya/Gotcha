import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, warn } = vi.hoisted(() => ({ get: vi.fn(), warn: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/api/client/server-api', () => ({ serverApi: () => ({ get }) }));
vi.mock('@/observability/logger', () => ({ logger: { warn } }));

const { loadScanRun } = await import('./load-scan-run');

beforeEach(() => {
  get.mockReset();
  warn.mockReset();
});

describe('the last rescan, read with the page', () => {
  it('the run as the server has it', async () => {
    get.mockResolvedValue({ run: { status: 'running' }, fieldSources: {} });
    expect(await loadScanRun()).toMatchObject({ status: 'running' });
  });

  it('a failed read is nothing to follow - the page still draws', async () => {
    get.mockRejectedValue(new Error('down'));
    expect(await loadScanRun()).toBeNull();
    expect(warn).toHaveBeenCalledWith('knowledge.scan_run_unread', expect.anything());
  });
});
