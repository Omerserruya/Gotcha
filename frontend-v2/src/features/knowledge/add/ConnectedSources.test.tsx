import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import knowledge from '@/i18n/messages/en/knowledge.json';

const s = vi.hoisted(() => ({
  readIntegrations: vi.fn(),
  readDriveFiles: vi.fn(),
  readDriveSources: vi.fn(),
  readSpaces: vi.fn(),
  learnDrive: vi.fn(),
  learnSpaces: vi.fn(),
  disconnectSource: vi.fn(),
}));
vi.mock('./sources', async (original) => ({ ...(await original<object>()), ...s }));

import { ConnectedSources } from './ConnectedSources';
import { FOLDER } from './sources';

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ knowledge }}>
      <ConnectedSources kbId="kb1" />
    </NextIntlClientProvider>,
  );
beforeEach(() => {
  for (const fn of Object.values(s)) fn.mockReset();
  s.readDriveSources.mockResolvedValue([]);
});

const drive = { id: 'int1', provider: 'google_drive', displayName: 'Maya’s Drive', isActive: true };

describe('★★ 08b after connecting - a list in the sheet’s shape, nothing learned before a press', () => {
  it('what is kept in sync is said; choosing reads the root, folders open', async () => {
    s.readIntegrations.mockResolvedValue([drive]);
    s.readDriveSources.mockResolvedValue([{ key: 'folder:f1', kind: 'folder', name: 'Policies' }]);
    s.readDriveFiles.mockResolvedValue([
      { id: 'f2', name: 'Returns', mimeType: FOLDER },
      { id: 'd1', name: 'Terms.pdf', mimeType: 'application/pdf' },
    ]);
    show();
    expect(await screen.findByTestId('drive-synced')).toHaveTextContent(
      'PoliciesFolder · new files learned automatically',
    );
    expect(s.readDriveFiles).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('drive-choose'));
    expect(s.readDriveFiles).toHaveBeenLastCalledWith('int1', undefined);
    await userEvent.click(await screen.findByTestId('drive-open-f2'));
    expect(s.readDriveFiles).toHaveBeenLastCalledWith('int1', 'f2');
    expect(s.learnDrive).not.toHaveBeenCalled();
  });

  it('★ one kind a round: picking a folder holds the files back; Learn sends exactly the picks', async () => {
    s.readIntegrations.mockResolvedValue([drive]);
    const files = [
      { id: 'f2', name: 'Returns', mimeType: FOLDER },
      { id: 'f3', name: 'Sizes', mimeType: FOLDER },
      { id: 'd1', name: 'Terms.pdf', mimeType: 'application/pdf' },
    ];
    s.readDriveFiles.mockResolvedValue(files);
    s.learnDrive.mockResolvedValue({ ok: true });
    show();
    await userEvent.click(await screen.findByTestId('drive-choose'));
    await userEvent.click(await screen.findByTestId('drive-pick-f2'));
    expect(screen.getByTestId('drive-pick-d1')).toBeDisabled();
    await userEvent.click(screen.getByTestId('drive-pick-f3'));
    await userEvent.click(screen.getByTestId('drive-learn'));
    expect(s.learnDrive).toHaveBeenCalledWith('int1', [files[0], files[1]]);
    expect(await screen.findByText(/Learning 2 items/)).toBeInTheDocument();
  });

  it('Confluence: spaces to tick, learned only on the press', async () => {
    s.readIntegrations.mockResolvedValue([
      { id: 'c1', provider: 'confluence', displayName: null, isActive: true },
    ]);
    s.readSpaces.mockResolvedValue([
      { key: 'OPS', name: 'Operations' },
      { key: 'HR', name: 'People' },
    ]);
    s.learnSpaces.mockResolvedValue({ ok: true });
    show();
    await userEvent.click(await screen.findByTestId('space-pick-OPS'));
    expect(s.learnSpaces).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('confluence-learn'));
    expect(s.learnSpaces).toHaveBeenCalledWith('c1', ['OPS']);
  });

  it('nothing connected: nothing drawn; an unread list is said', async () => {
    s.readIntegrations.mockResolvedValue([]);
    const one = show();
    await Promise.resolve();
    expect(screen.queryByTestId('connected-sources')).toBeNull();
    one.unmount();
    s.readIntegrations.mockResolvedValue(null);
    show();
    expect(await screen.findByTestId('sources-unread')).toBeInTheDocument();
  });
});

describe('★★ a connected source can be disconnected - confirmed, and its learning kept', () => {
  it('asks first, says what stops and what stays, then the card goes', async () => {
    s.readIntegrations.mockResolvedValue([drive]);
    s.disconnectSource.mockResolvedValue({ ok: true });
    const onConnected = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={{ knowledge }}>
        <ConnectedSources kbId="kb1" onConnected={onConnected} />
      </NextIntlClientProvider>,
    );
    await userEvent.click(await screen.findByTestId('source-disconnect-int1'));
    expect(s.disconnectSource).not.toHaveBeenCalled();
    expect(screen.getByTestId('source-disconnect-what')).toHaveTextContent(
      'Disconnect Maya’s Drive? GOTCHA stops syncing from it. What it already learned stays in your knowledge.',
    );
    await userEvent.click(screen.getByTestId('source-disconnect-yes'));
    expect(s.disconnectSource).toHaveBeenCalledExactlyOnceWith('int1');
    expect(screen.queryByTestId('source-int1')).toBeNull();
    expect(onConnected).toHaveBeenLastCalledWith(new Set());
  });

  it('refused: in words, and the source stays', async () => {
    s.readIntegrations.mockResolvedValue([drive]);
    s.disconnectSource.mockResolvedValue({ ok: false, reason: 'forbidden' });
    show();
    await userEvent.click(await screen.findByTestId('source-disconnect-int1'));
    await userEvent.click(screen.getByTestId('source-disconnect-yes'));
    expect(await screen.findByTestId('source-disconnect-problem')).toHaveTextContent(
      'Only an admin can disconnect a knowledge source.',
    );
    expect(screen.getByTestId('source-int1')).toBeInTheDocument();
  });
});
