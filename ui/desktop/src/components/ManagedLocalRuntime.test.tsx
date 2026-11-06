import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IntlTestWrapper } from '../i18n/test-utils';
import ManagedLocalRuntime from './ManagedLocalRuntime';
const mock = vi.hoisted(() => ({
  state: { phase: 'idle', profileId: undefined, error: undefined } as {
    phase: string;
    profileId?: string;
    error?: string;
  },
}));
vi.mock('../hooks/useManagedGgufState', () => ({ useManagedGgufState: () => mock.state }));
let provider: string;
let serial = 0;
beforeEach(() => {
  provider = 'compact-fixture-' + ++serial;
  mock.state = { phase: 'idle' };
  Object.assign(window.electron, {
    ggufList: vi.fn(async () => [
      {
        profile: {
          id: 'test',
          name: 'Test GGUF',
          providerId: provider,
          backend: 'external',
          gpuLayers: 24,
          context: 8192,
        },
        available: true,
      },
    ]),
    on: vi.fn(),
    off: vi.fn(),
    ggufStart: vi.fn(async () => ({})),
    ggufStop: vi.fn(async () => {}),
  });
});
const show = (props: Partial<React.ComponentProps<typeof ManagedLocalRuntime>> = {}) =>
  render(<ManagedLocalRuntime provider={provider} {...props} />, { wrapper: IntlTestWrapper });
describe('compact managed model controls', () => {
  it('is collapsed by default with an accessible disclosure and no action/help blocks', async () => {
    show();
    const toggle = await screen.findByRole('button', { name: 'Model controls: Test GGUF' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Load model' })).toBeNull();
    expect(screen.queryByText(/Stop in chat/)).toBeNull();
  });
  it('preserves expansion across navigation/remount and hiding never unloads', async () => {
    const first = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Model controls: Test GGUF' }));
    expect(screen.getByRole('button', { name: 'Load model' })).toBeInTheDocument();
    first.unmount();
    show();
    expect(await screen.findByRole('button', { name: 'Load model' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model controls: Test GGUF' }));
    expect(window.electron.ggufStop).not.toHaveBeenCalled();
  });
  it('keeps expanded model actions and settings without the redundant context/GPU summary', async () => {
    show({ onOpenSettings: vi.fn() });
    fireEvent.click(await screen.findByRole('button', { name: 'Model controls: Test GGUF' }));
    expect(screen.getByRole('button', { name: 'Load model' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Model settings' })).toBeInTheDocument();
    expect(screen.queryByText(/8192.*24/)).not.toBeInTheDocument();
  });
  it('automatically expands an actionable failure and exposes settings', async () => {
    mock.state = { phase: 'failed', profileId: 'test', error: 'GGUF:timeout:' };
    const settings = vi.fn();
    show({ onOpenSettings: settings });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Model controls: Test GGUF' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model settings' }));
    expect(settings).toHaveBeenCalledOnce();
  });
  it('keeps load cancellation explicit and never offers cancellation for another profile', async () => {
    mock.state = { phase: 'starting', profileId: 'test' };
    const cancel = vi.fn();
    const view = show({ onCancelGeneration: cancel });
    fireEvent.click(await screen.findByRole('button', { name: 'Model controls: Test GGUF' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel loading' }));
    await waitFor(() => expect(window.electron.ggufStop).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
    mock.state = { phase: 'starting', profileId: 'other' };
    view.rerender(<ManagedLocalRuntime provider={provider} />);
    expect(screen.queryByRole('button', { name: 'Cancel loading' })).toBeNull();
  });
  it('does not affect cloud providers or native Goose selection', async () => {
    Object.assign(window.electron, {
      ggufList: vi.fn(async () => [
        {
          profile: { id: 'native', name: 'Native', providerId: provider, backend: 'native' },
          available: true,
        },
      ]),
    });
    const view = show();
    await waitFor(() => expect(window.electron.ggufList).toHaveBeenCalled());
    expect(view.container.textContent).toBe('');
  });
});
