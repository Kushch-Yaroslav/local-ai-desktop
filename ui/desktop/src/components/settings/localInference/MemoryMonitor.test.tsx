import { IntlProvider } from 'react-intl';
import ru from '../../../i18n/compiled/ru.json';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import MemoryMonitor from './MemoryMonitor';
import { IntlTestWrapper } from '../../../i18n/test-utils';
afterEach(() => vi.useRealTimers());
describe('model-page monitoring lifecycle', () => {
  it('defaults hidden and starts no telemetry when disabled', async () => {
    Object.assign(window.electron, {
      getSetting: vi.fn().mockResolvedValue(false),
      memorySample: vi.fn(),
      memoryCancel: vi.fn(),
    });
    const view = render(<MemoryMonitor />, { wrapper: IntlTestWrapper });
    await act(async () => {});
    expect(screen.queryByLabelText('System memory usage')).not.toBeInTheDocument();
    expect(window.electron.memorySample).not.toHaveBeenCalled();
    view.unmount();
  });
  it('uses the actual compiled Russian catalog for accessible monitoring labels', async () => {
    Object.assign(window.electron, {
      getSetting: vi.fn().mockResolvedValue(true),
      memorySample: vi.fn().mockResolvedValue({ ram: null, gpus: [] }),
      memoryCancel: vi.fn(),
    });
    const view = render(
      <IntlProvider locale="ru" messages={ru}>
        <MemoryMonitor />
      </IntlProvider>
    );
    expect(await screen.findByLabelText('Использование системной памяти')).toBeInTheDocument();
    view.unmount();
  });
  it('samples only when enabled, never overlaps and cancels on unmount', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    let resolve!: (v: unknown) => void;
    Object.assign(window.electron, {
      getSetting: vi.fn().mockResolvedValue(true),
      memorySample: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolve = r;
          })
      ),
      memoryCancel: vi.fn(),
    });
    const view = render(<MemoryMonitor />, { wrapper: IntlTestWrapper });
    await waitFor(() => expect(window.electron.memorySample).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(window.electron.memorySample).toHaveBeenCalledOnce();
    await act(async () => resolve({ ram: { used: 1024 ** 3, total: 2 * 1024 ** 3 }, gpus: [] }));
    expect(screen.getByText('RAM 1.0 / 2.0 GiB')).toBeInTheDocument();
    expect(screen.getByText('VRAM —')).toBeInTheDocument();
    expect(screen.getByText('GPU —')).toBeInTheDocument();
    view.unmount();
    expect(window.electron.memoryCancel).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(10000));
    expect(window.electron.memorySample).toHaveBeenCalledOnce();
  });

  it('shows utilization beside memory from the same physical GPU', async () => {
    Object.assign(window.electron, {
      getSetting: vi.fn().mockResolvedValue(true),
      memorySample: vi.fn().mockResolvedValue({
        ram: null,
        gpus: [{ id: '0', used: 20 * 1024 ** 3, total: 24 * 1024 ** 3, utilizationPercent: 82.6 }],
      }),
      memoryCancel: vi.fn(),
    });
    const view = render(<MemoryMonitor />, { wrapper: IntlTestWrapper });
    expect(await screen.findByText('VRAM 20.0 / 24.0 GiB')).toBeInTheDocument();
    expect(screen.getByText('GPU 83%')).toBeInTheDocument();
    view.unmount();
  });
});
