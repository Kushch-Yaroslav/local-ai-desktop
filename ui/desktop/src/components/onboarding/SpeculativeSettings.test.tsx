import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IntlTestWrapper } from '../../i18n/test-utils';
import SpeculativeSettings from './SpeculativeSettings';
import type { GgufProfile, RuntimeProbe } from '../../ggufTypes';
const profile: GgufProfile = {
  name: 'test',
  model: '/target',
  executable: '/runtime',
  gpuLayers: 0,
  context: 8192,
};
const probe: RuntimeProbe = {
  executable: '/runtime',
  version: 'd1d3c33',
  flags: ['--spec-type', '--spec-draft-n-max'],
  cacheTypes: ['f16', 'q8_0'],
  gpuAvailable: false,
  apiKeyEnvironment: true,
  devices: '',
  diagnosis: 'devicesInaccessible',
  speculativeModes: ['mtp-embedded'],
};
function show(value: GgufProfile = profile, capabilities: RuntimeProbe | undefined = probe) {
  const onChange = vi.fn();
  render(
    <SpeculativeSettings
      profile={value}
      probe={capabilities}
      busy={false}
      onChange={onChange}
      onProbe={vi.fn()}
      onValidate={vi.fn()}
    />,
    { wrapper: IntlTestWrapper }
  );
  return onChange;
}
describe('speculative settings disclosure', () => {
  it('enables only a mode advertised and allowed by the selected runtime', () => {
    const changed = show();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(changed.mock.calls[0][0].speculativeMode).toBe('mtp-embedded');
  });
  it('does not expose external draft or unsupported token controls for embedded-only runtime', () => {
    show({ ...profile, speculativeMode: 'mtp-embedded' });
    expect(screen.queryByLabelText('Draft GGUF absolute path')).toBeNull();
    expect(screen.queryByLabelText('Minimum draft tokens')).toBeNull();
    expect(screen.queryByLabelText('Draft GPU layers')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
  it('allows disabling an unsupported saved mode and preserves its inactive draft path', () => {
    const changed = show(
      { ...profile, speculativeMode: 'mtp-external', draft: '/saved/draft' },
      { ...probe, speculativeModes: [] }
    );
    const toggle = screen.getByRole('checkbox');
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(changed.mock.calls[0][0]).toMatchObject({
      speculativeMode: 'off',
      draft: '/saved/draft',
    });
  });
  it('keeps stale draft GPU settings editable so incompatible values can be cleared', () => {
    const changed = show({ ...profile, speculativeMode: 'mtp-embedded', draftGpuLayers: 10 });
    fireEvent.change(screen.getByLabelText('Draft GPU layers'), { target: { value: '' } });
    expect(changed.mock.calls[0][0].draftGpuLayers).toBeUndefined();
  });
});
