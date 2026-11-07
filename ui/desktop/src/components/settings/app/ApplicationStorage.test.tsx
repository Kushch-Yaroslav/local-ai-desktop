import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import ApplicationStorage from './ApplicationStorage';
import type { StorageStatus } from '../../../storageTypes';
const api = {
  storageStatus: vi.fn(),
  storageChoose: vi.fn(),
  storagePreview: vi.fn(),
  storageApply: vi.fn(),
  storageProgress: vi.fn(() => () => {}),
  storageCleanup: vi.fn(),
  storageRollback: vi.fn(),
};
const status: StorageStatus = {
  useDefault: true,
  customPath: '',
  defaultPath: '/xdg/app',
  layout: {
    dataRoot: '/xdg/app',
    bulkRoot: '/xdg/app',
    electronRoot: '/xdg/app/electron',
    backendRoot: '/xdg/app/goose-backend',
    configRoot: '/config/app',
    cacheRoot: '/cache/app',
    logsRoot: '/state/logs',
    artifactsRoot: '/xdg/app/artifacts',
    backupsRoot: '/xdg/app/backups',
  },
  filesystem: 'ext4',
  freeBytes: 10 ** 11,
  split: false,
  busy: false,
  cleanupAvailable: false,
  recoveryAvailable: false,
};
function show() {
  return render(
    <IntlProvider locale="en">
      <ApplicationStorage />
    </IntlProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window.electron, api);
  api.storageStatus.mockResolvedValue(status);
  api.storageChoose.mockResolvedValue(null);
});
describe('application storage settings', () => {
  it('shows saved default and changes only a draft checkbox', async () => {
    show();
    await screen.findByDisplayValue('/xdg/app');
    const checkbox = screen.getByRole('checkbox');
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled();
    fireEvent.click(checkbox);
    expect(api.storageApply).not.toHaveBeenCalled();
    expect(api.storagePreview).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose folder' })).not.toBeDisabled();
  });
  it('cancelling the native picker leaves the saved path unchanged', async () => {
    api.storageStatus.mockResolvedValue({
      ...status,
      useDefault: false,
      customPath: '/saved/custom',
    });
    show();
    await screen.findByDisplayValue('/saved/custom');
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    await waitFor(() => expect(api.storageChoose).toHaveBeenCalledOnce());
    expect(screen.getByDisplayValue('/saved/custom')).toBeInTheDocument();
    expect(api.storageApply).not.toHaveBeenCalled();
  });
  it('reopening discards unsaved changes and reads persisted state', async () => {
    const first = show();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeDisabled());
    fireEvent.click(screen.getByRole('checkbox'));
    first.unmount();
    show();
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    expect(api.storageStatus).toHaveBeenCalledTimes(2);
  });
  it('shows actual legacy split paths without changing them', async () => {
    api.storageStatus.mockResolvedValue({
      ...status,
      useDefault: false,
      customPath: '/ntfs/app',
      split: true,
      layout: {
        ...status.layout,
        dataRoot: '/ext4/app',
        cacheRoot: '/ntfs/app/cache',
        logsRoot: '/ntfs/app/logs',
      },
    });
    show();
    await screen.findByDisplayValue('/ntfs/app');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('/ext4/app')).toBeInTheDocument();
    expect(screen.getByText(/Chat history and sensitive state remain/)).toBeInTheDocument();
    expect(api.storageApply).not.toHaveBeenCalled();
  });
  it('applies only after preview confirmation and blocks repeated application', async () => {
    api.storageChoose.mockResolvedValue('/new/app');
    api.storagePreview.mockResolvedValue({
      choice: { useDefault: false, customPath: '/new/app' },
      layout: { ...status.layout, dataRoot: '/new/app/data' },
      filesystem: 'ext4',
      split: false,
      requiredBytes: 1000,
      freeBytes: 1e10,
      unchanged: false,
    });
    api.storageApply.mockResolvedValue(undefined);
    show();
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeDisabled());
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    await screen.findByDisplayValue('/new/app');
    fireEvent.click(screen.getByRole('button', { name: 'Apply location' }));
    await screen.findByRole('dialog');
    expect(api.storageApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move and restart' }));
    await waitFor(() =>
      expect(api.storageApply).toHaveBeenCalledExactlyOnceWith({
        useDefault: false,
        customPath: '/new/app',
      })
    );
    expect(screen.getByRole('button', { name: 'Apply location' })).toBeDisabled();
  });
  it('preview errors can be retried without changing storage', async () => {
    api.storageStatus.mockResolvedValue({
      ...status,
      useDefault: false,
      customPath: '/saved/custom',
    });
    api.storagePreview.mockRejectedValueOnce(new Error('insufficientSpace'));
    show();
    await screen.findByDisplayValue('/saved/custom');
    fireEvent.click(screen.getByRole('button', { name: 'Apply location' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not enough free space');
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeDisabled();
    expect(api.storageApply).not.toHaveBeenCalled();
  });
});
