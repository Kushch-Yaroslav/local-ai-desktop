import { useState } from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { GgufProfile } from '../../ggufTypes';
import PlacementSettings from './PlacementSettings';
it('edits detected blocks/ranges and cache settings without changing unrelated model fields', async () => {
  const initial = {
    name: 'test',
    model: '/test.gguf',
    gpuLayers: 999,
    context: 98304,
    cpuMoe: true,
    draftTokens: 2,
    visionEnabled: false,
    moeCacheMode: 'standard',
  } as GgufProfile;
  const onChange = vi.fn();
  window.electron.ggufPlacement = vi
    .fn()
    .mockResolvedValue({
      inspection: { identity: 'model-27', layers: 48 },
      supported: true,
      cacheSupported: true,
      sizes: [2048, 4096, 8192],
      estimate: { requiredMiB: 12000 },
      host: { requiredMiB: 10000, workingSetFits: true },
    });
  function Form() {
    const [p, set] = useState(initial);
    return (
      <PlacementSettings
        profile={p}
        onChange={(value) => {
          onChange(value);
          set(value);
        }}
      />
    );
  }
  const user = userEvent.setup();
  render(<Form />, { wrapper: IntlTestWrapper });
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
  await user.click(screen.getByRole('checkbox'));
  expect(
    screen.getByRole('group', { name: 'CPU / GPU blocks' }).querySelectorAll('button')
  ).toHaveLength(48);
  await user.click(screen.getByRole('button', { name: 'All CPU' }));
  await user.click(screen.getByRole('button', { name: '3: CPU' }));
  fireEvent.click(screen.getByRole('button', { name: '6: CPU' }), { shiftKey: true });
  expect(onChange.mock.lastCall?.[0].gpuBlockIds).toEqual([3, 4, 5, 6]);
  const ranges = screen.getByLabelText('GPU blocks (0-based ranges)');
  fireEvent.change(ranges, { target: { value: '1-2, 15' } });
  fireEvent.blur(ranges);
  expect(onChange.mock.lastCall?.[0].gpuBlockIds).toEqual([1, 2, 15]);
  await user.selectOptions(screen.getByLabelText('GPU Expert Cache'), 'manual');
  expect(screen.getByRole('option', { name: '16 GiB' })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('option', { name: '8 GiB' })).toBeEnabled());
  await user.selectOptions(screen.getByLabelText('Manual'), '8192');
  await user.click(screen.getByRole('button', { name: 'Confirm this GGUF for the placement' }));
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    context: 98304,
    gpuLayers: 999,
    cpuMoe: true,
    draftTokens: 2,
    visionEnabled: false,
    moeCacheMiB: 8192,
    placementIdentity: 'model-27',
  });
});

it('keeps cache-required CPU placement derived and leaves the standalone profile choice unchanged', async () => {
  const initial = {
    name: 'test',
    model: '/test.gguf',
    gpuLayers: 999,
    context: 8192,
    cpuMoe: undefined,
    moeCacheMode: 'standard',
  } as GgufProfile;
  const onChange = vi.fn();
  window.electron.ggufPlacement = vi.fn().mockResolvedValue({
    inspection: { identity: 'model-27', layers: 48 },
    supported: true,
    cacheSupported: true,
    sizes: [2048, 4096],
    estimate: { requiredMiB: 12000 },
    host: { requiredMiB: 10000, workingSetFits: true },
  });
  function Form() {
    const [profile, setProfile] = useState(initial);
    return (
      <PlacementSettings
        profile={profile}
        onChange={(next) => {
          onChange(next);
          setProfile(next);
        }}
      />
    );
  }
  render(<Form />, { wrapper: IntlTestWrapper });
  await waitFor(() => expect(screen.getByRole('option', { name: 'Automatic' })).toBeEnabled());
  await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'GPU Expert Cache' }), 'automatic');

  expect(onChange.mock.lastCall?.[0]).toMatchObject({ moeCacheMode: 'automatic' });
  expect(onChange.mock.lastCall?.[0].cpuMoe).toBeUndefined();
  expect(screen.getByRole('status').textContent).toContain('Cache mode keeps expert weights in CPU memory');
  await userEvent.setup().click(
    await screen.findByRole('button', { name: 'Confirm this GGUF for the placement' })
  );
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    cpuMoe: undefined,
    placementIdentity: 'model-27',
  });
});

it('offers explicit confirmation when only filesystem device identity differs', async () => {
  const profile = {
    id: 'qwen80b',
    name: 'Qwen80B',
    model: '/models/qwen80b.gguf',
    executable: '/runtime/llama-server',
    gpuLayers: 999,
    context: 65536,
    gpuBlockIds: [0, 1, 2],
    moeCacheMode: 'manual',
    moeCacheMiB: 8192,
    placementIdentity: '66311:469820:48727680704:1792445698964670500:1792438890007308200',
  } as GgufProfile;
  const currentIdentity = '66306:469820:48727680704:1792445698964670500:1792438890007308200';
  const onChange = vi.fn();
  window.electron.ggufPlacement = vi.fn().mockResolvedValue({
    inspection: { identity: currentIdentity, layers: 48 },
    supported: true,
    cacheSupported: true,
    sizes: [2048, 4096, 8192],
    estimate: { requiredMiB: 12000 },
    host: { requiredMiB: 10000, workingSetFits: true },
  });
  render(<PlacementSettings profile={profile} onChange={onChange} />, { wrapper: IntlTestWrapper });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Placement is not confirmed for this GGUF'
  );
  await userEvent.setup().click(
    screen.getByRole('button', { name: 'Confirm this GGUF for the placement' })
  );
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    id: 'qwen80b',
    model: profile.model,
    placementIdentity: currentIdentity,
    gpuBlockIds: [0, 1, 2],
    moeCacheMiB: 8192,
  });
});

it('does not reuse an earlier profile preview when switching GPT-OSS to Qwen80B', async () => {
  type PlacementResult = Awaited<ReturnType<typeof window.electron.ggufPlacement>>;
  const pending: Record<string, (value: PlacementResult) => void> = {};
  const preview = (identity: string, layers: number) =>
    ({
      inspection: { identity, layers },
      supported: true,
      cacheSupported: true,
      sizes: [2048],
      estimate: { requiredMiB: 1000 },
      host: { requiredMiB: 1000, workingSetFits: true },
      parameters: { mode: 'gpu-layers' },
    }) as PlacementResult;
  window.electron.ggufPlacement = vi.fn(
    (profile: GgufProfile) =>
      new Promise<PlacementResult>((resolve) => {
        pending[profile.model] = resolve;
      })
  );
  const gpt = {
    id: 'gpt-oss',
    name: 'GPT-OSS',
    model: '/models/gpt-oss.gguf',
    executable: '/runtime/llama-server',
    gpuLayers: 999,
    context: 4096,
    gpuBlockIds: [0],
    placementIdentity: 'gpt-identity',
  } as GgufProfile;
  const qwen = {
    id: 'qwen80b',
    name: 'Qwen80B',
    model: '/models/qwen80b.gguf',
    executable: '/runtime/llama-server',
    gpuLayers: 999,
    context: 4096,
    gpuBlockIds: [0],
    placementIdentity: 'gpt-identity',
  } as GgufProfile;
  const onChange = vi.fn();
  const view = render(<PlacementSettings profile={gpt} onChange={onChange} />, {
    wrapper: IntlTestWrapper,
  });
  await waitFor(() => expect(pending[gpt.model]).toBeDefined());
  pending[gpt.model](preview('gpt-identity', 36));
  await waitFor(() => expect(screen.getByText('Detected blocks: 36')).toBeInTheDocument());

  view.rerender(<PlacementSettings profile={qwen} onChange={onChange} />);
  expect(screen.queryByText('Detected blocks: 36')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm this GGUF for the placement' })).toBeNull();
  await waitFor(() => expect(pending[qwen.model]).toBeDefined());
  pending[gpt.model](preview('late-gpt-identity', 36));
  pending[qwen.model](preview('qwen-identity', 48));
  await waitFor(() => expect(screen.getByText('Detected blocks: 48')).toBeInTheDocument());
  await userEvent.setup().click(
    await screen.findByRole('button', { name: 'Confirm this GGUF for the placement' })
  );
  expect(onChange.mock.lastCall?.[0]).toMatchObject({
    id: 'qwen80b',
    model: qwen.model,
    placementIdentity: 'qwen-identity',
  });
});
