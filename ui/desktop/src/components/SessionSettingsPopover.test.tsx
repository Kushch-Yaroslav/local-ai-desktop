import { rememberSessionConfiguration } from '../acp/sessionConfiguration';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import SessionSettingsPopover, { type NewChatSettings } from './SessionSettingsPopover';
import { IntlTestWrapper } from '../i18n/test-utils';
import russianMessages from '../i18n/compiled/ru.json';

const { request, sessionInfo, snapshot, setSessionMetadata, activitySnapshots, readDefault } = vi.hoisted(
  () => ({
    request: vi.fn(),
    readDefault: vi.fn(),
    sessionInfo: vi.fn(),
    snapshot: vi.fn(),
    setSessionMetadata: vi.fn(),
    activitySnapshots: vi.fn().mockReturnValue([]),
  })
);
let emitDiscoveryProgress:
  | ((state: {
      busy: boolean;
      stage: string;
      probeCount: number;
      currentCandidate?: {
        context: number;
        kv: 'f16' | 'q8_0';
        phase: 'base' | 'search' | 'final';
      };
    }) => void)
  | null = null;
vi.mock('../acp/config', () => ({ acpReadConfig: readDefault }));
vi.mock('@agentclientprotocol/sdk', () => ({
  methods: {
    agent: {
      session: { setMode: 'session/set_mode', setConfigOption: 'session/set_config_option' },
    },
  },
}));
vi.mock('../acp/acpConnection', () => ({
  getAcpClient: async () => ({
    connection: { agent: { request } },
    goose: { sessionInfo_unstable: sessionInfo },
  }),
}));
vi.mock('../acp/chatSessionStore', () => ({
  acpChatSessionActions: { setSessionMetadata },
  useAcpChatSessionSnapshot: snapshot,
  acpChatSessionStore: { getActivitySnapshots: activitySnapshots },
}));

const profile = {
  id: 'profile-1',
  name: 'Qwen local',
  model: '/models/qwen.gguf',
  executable: '/bin/llama-server',
  gpuLayers: 999,
  context: 8192,
  cacheK: 'f16',
  cacheV: 'f16',
  providerId: 'managed-provider',
  backend: 'external',
} as never;
const catalog = {
  options: [],
  previous: [],
  hardLimit: 262144,
  selectedContext: 8192,
  selectedKv: 'f16',
  supportedKv: ['f16', 'q8_0'],
};
const discoveredOption = {
  modelId: '/models/qwen.gguf',
  contextWindow: 65536,
  kvCacheType: 'f16' as const,
  kvOffload: true,
  discoveredAt: '2026-11-03T20:00:00.000Z',
  memoryBaseline: { hostAvailableBytes: 50e9, deviceAvailableBytes: 22e9 },
  measuredHeadroom: { hostBytes: 40e9, deviceBytes: 2e9 },
};
const RussianWrapper = ({ children }: { children: React.ReactNode }) => (
  <IntlProvider locale="ru" defaultLocale="ru" messages={russianMessages}>
    {children}
  </IntlProvider>
);

describe('SessionSettingsPopover', () => {
  it('shows the primary stage, actual restoration outcome and labels older measurements after failure', async () => {
    window.electron.ggufList = vi.fn().mockResolvedValue([{profile, available:true}]);
    window.electron.ggufDiscoveryCatalog = vi.fn().mockResolvedValue({...catalog, options:[discoveredOption]});
    window.electron.ggufDiscoveryRun = vi.fn().mockRejectedValue(new Error('GGUF:discoveryFailed:'+JSON.stringify({runId:'failed-run',stage:'generation',context:94208,kv:'q8_0',reason:'CUDA graph failure',restoration:'left-unloaded',receiptPath:'/logs/discovery/result.json'})));
    render(<SessionSettingsPopover sessionId={null} provider="managed-provider" />, {wrapper:IntlTestWrapper});
    await userEvent.click(screen.getByRole('button',{name:'Session settings'}));
    await userEvent.click(await screen.findByRole('button',{name:'Find maximum'}));
    const error=await screen.findByRole('alert');
    expect(error).toHaveTextContent('Probe generation');
    expect(error).toHaveTextContent('94208');
    expect(error).toHaveTextContent('CUDA graph failure');
    expect(error).toHaveTextContent('Left unloaded');
    expect(await screen.findByText('The last search failed. The results shown are from earlier measurements.')).toBeVisible();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    readDefault.mockResolvedValue('auto');
    Object.assign(window.electron, {
      ggufCapabilities: vi.fn().mockResolvedValue({ thinking: false, vision: false }),
      ggufList: vi.fn().mockResolvedValue([]),
      ggufState: vi.fn().mockResolvedValue({ phase: 'idle' }),
      ggufOnState: vi.fn().mockReturnValue(() => undefined),
      ggufOnDiscoveryProgress: vi.fn((callback) => {
        emitDiscoveryProgress = callback;
        return () => undefined;
      }),
      ggufDiscoveryCatalog: vi.fn().mockResolvedValue(catalog),
      ggufDiscoveryAcquire: vi.fn().mockResolvedValue('lease-1'),
      ggufDiscoveryRelease: vi.fn().mockResolvedValue(undefined),
      ggufDiscoveryRun: vi.fn().mockResolvedValue({ result: { options: [], unsupported: [] } }),
      ggufDiscoveryCancel: vi.fn().mockResolvedValue(undefined),
      ggufApplyContext: vi.fn().mockResolvedValue({ applied: false, loaded: false }),
    });
    activitySnapshots.mockReturnValue([]);
    emitDiscoveryProgress = null;
    snapshot.mockReturnValue({
      session: {
        goose_mode: 'auto',
        model_config: {
          model_name: 'reasoning-model',
          reasoning: true,
          request_params: { thinking_effort: 'medium' },
        },
      },
    });
    sessionInfo.mockResolvedValue({ session: { goose_mode: 'approve' } });
  });

  it('opens before session creation and keeps mode changes in the new-chat draft without ACP calls', async () => {
    function NewChat() {
      const [draft, change] = useState<NewChatSettings>({});
      return <SessionSettingsPopover sessionId={null} draft={draft} onDraftChange={change} />;
    }
    const user = userEvent.setup();
    render(<NewChat />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    await user.selectOptions(screen.getByLabelText('Agent mode'), 'approve');
    expect(screen.getByLabelText('Agent mode')).toHaveValue('approve');
    expect(request).not.toHaveBeenCalled();
    expect(window.electron.ggufDiscoveryAcquire).not.toHaveBeenCalled();
  });

  it('switches visible discovery maxima with KV precision without applying or loading', async () => {
    snapshot.mockReturnValue(undefined);
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
    window.electron.ggufDiscoveryCatalog = vi.fn().mockResolvedValue({
      ...catalog,
      selectedKv: 'f16',
      supportedKv: ['f16', 'q8_0'],
      options: [
        { ...discoveredOption, contextWindow: 53248, kvCacheType: 'f16' },
        { ...discoveredOption, contextWindow: 90112, kvCacheType: 'q8_0' },
      ],
    });
    const user = userEvent.setup();
    render(
      <SessionSettingsPopover sessionId={null} provider="managed-provider" model="local-gguf" />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(await screen.findByRole('button', { name: '52K · FP16' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '88K · Q8' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('KV Cache Precision'), 'q8_0');
    expect(await screen.findByRole('button', { name: '88K · Q8' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '52K · FP16' })).not.toBeInTheDocument();
    expect(window.electron.ggufApplyContext).not.toHaveBeenCalled();
    expect(window.electron.ggufDiscoveryAcquire).not.toHaveBeenCalled();
  });

  it('separates native Thinking and Effort and replaces stale draft budget only on explicit selection', async () => {
    snapshot.mockReturnValue(undefined);
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
    window.electron.ggufCapabilities = vi
      .fn()
      .mockResolvedValue({ thinking: true, nativeEfforts: true, vision: true });
    function Draft() {
      const [draft, setDraft] = useState<NewChatSettings>({ budget: 512 });
      return (
        <SessionSettingsPopover
          sessionId={null}
          provider="managed-provider"
          model="local-gguf"
          draft={draft}
          onDraftChange={setDraft}
        />
      );
    }
    const user = userEvent.setup();
    render(<Draft />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    await screen.findByRole('option', { name: 'XHigh' });
    expect(screen.queryByRole('option', { name: 'High' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'low');
    expect(screen.queryByLabelText('Thinking budget')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Thinking'), 'off');
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Thinking'), 'on');
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('low');
    expect(screen.getByLabelText('Thinking')).toHaveValue('on');
    expect(request).not.toHaveBeenCalled();
  });

  it('clears a stale sampler budget through ACP before sending native effort without reloading', async () => {
    snapshot.mockReturnValue({
      session: {
        provider_name: 'managed-provider',
        goose_mode: 'auto',
        model_config: {
          model_name: 'local-gguf',
          request_params: { thinking_effort: 'medium', reasoning_budget_tokens: 128 },
        },
      },
    });
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
    window.electron.ggufCapabilities = vi
      .fn()
      .mockResolvedValue({ thinking: true, nativeEfforts: true });
    request.mockResolvedValue({});
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="native-effort" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    await screen.findByLabelText('Thinking');
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'low');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session/set_config_option', {
        sessionId: 'native-effort',
        configId: 'thinking_effort',
        value: 'low',
      })
    );
    expect(request.mock.calls.slice(-2).map((call) => call[1])).toEqual([
      { sessionId: 'native-effort', configId: 'thinking_budget', value: '-1' },
      { sessionId: 'native-effort', configId: 'thinking_effort', value: 'low' },
    ]);
    expect(window.electron.ggufDiscoveryAcquire).not.toHaveBeenCalled();
  });

  it('offers only On/Off for a toggle-only local template', async () => {
    snapshot.mockReturnValue(undefined);
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
    window.electron.ggufCapabilities = vi
      .fn()
      .mockResolvedValue({ thinking: true, nativeEfforts: false, vision: false });
    const user = userEvent.setup();
    render(
      <SessionSettingsPopover sessionId={null} provider="managed-provider" model="local-gguf" />,
      { wrapper: IntlTestWrapper }
    );
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    await screen.findByRole('option', { name: 'On' });
    expect(screen.queryByRole('option', { name: 'Low' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'XHigh' })).not.toBeInTheDocument();
  });

  it('opens compact controls and applies existing Goose session mode APIs', async () => {
    rememberSessionConfiguration('session-1', { modes: { currentModeId: 'auto' } });
    request.mockResolvedValueOnce({});
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="session-1" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(screen.getByRole('dialog', { name: 'Session settings' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Agent mode'), 'chat');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session/set_mode', {
        sessionId: 'session-1',
        modeId: 'chat',
      })
    );
    expect(setSessionMetadata).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(screen.getByLabelText('Agent mode')).toHaveValue('chat');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(screen.getByLabelText('Agent mode')).toHaveValue('chat');
  });

  it('hides reasoning controls for an explicitly non-reasoning model and restores focus on Escape', async () => {
    snapshot.mockReturnValue({
      session: {
        goose_mode: 'auto',
        model_config: {
          model_name: 'plain-model',
          reasoning: false,
          request_params: {},
        },
      },
    });
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="session-2" />, { wrapper: IntlTestWrapper });
    const trigger = screen.getByRole('button', { name: 'Session settings' });
    await user.click(trigger);
    expect(screen.queryByLabelText('Thinking')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument();
    expect(screen.queryByText('Reasoning controls are not confirmed for this model.')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('sends the selected supported effort through Goose session configuration', async () => {
    rememberSessionConfiguration('session-3', {
      configOptions: [
        {
          id: 'thinking_effort',
          currentValue: 'medium',
          options: [{ value: 'off' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }],
        },
      ],
    });
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="session-3" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'high');
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('session/set_config_option', {
        sessionId: 'session-3',
        configId: 'thinking_effort',
        value: 'high',
      })
    );
  });

  it('shows only a concise unknown-capability status when reasoning support is not known', async () => {
    snapshot.mockReturnValue({
      session: { goose_mode: 'auto', model_config: { model_name: 'unknown-model' } },
    });
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="unknown-reasoning" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(await screen.findByText('Reasoning controls are not confirmed for this model.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Thinking')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument();
  });

  it('shows Effort without a separate Thinking toggle when ACP advertises no off option', async () => {
    rememberSessionConfiguration('effort-only', {
      configOptions: [
        { id: 'thinking_effort', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
      ],
    });
    snapshot.mockReturnValue({
      session: {
        goose_mode: 'auto',
        model_config: { model_name: 'effort-only-model', reasoning: true },
      },
    });
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="effort-only" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(await screen.findByLabelText('Reasoning effort')).toHaveValue('low');
    expect(screen.queryByLabelText('Thinking')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Low' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument();
  });

  it('moves focus into the popover and closes on outside pointer input', async () => {
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="session-4" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(screen.getByLabelText('Agent mode')).toHaveFocus();
    await user.click(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['session-local', null])(
    'applies shared runtime context in Russian with session %s',
    async (sessionId) => {
      snapshot.mockReturnValue({
        session: {
          provider_name: 'managed-provider',
          goose_mode: 'auto',
          model_config: {
            model_name: 'Qwen3.8',
            reasoning: true,
            request_params: { thinking_effort: 'medium' },
          },
        },
      });
      window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
      window.electron.ggufDiscoveryCatalog = vi
        .fn()
        .mockResolvedValue({ ...catalog, options: [discoveredOption] });
      const user = userEvent.setup();
      if (!sessionId) snapshot.mockReturnValue(undefined);
      render(
        <SessionSettingsPopover
          sessionId={sessionId}
          provider="managed-provider"
          model="local-gguf"
        />,
        { wrapper: RussianWrapper }
      );
      await user.click(screen.getByRole('button', { name: 'Настройки сеанса' }));
      expect(await screen.findByRole('group', { name: 'Контекст' })).toBeInTheDocument();
      expect(screen.getByLabelText('Свой размер')).toHaveAttribute(
        'title',
        'Вручную заданный контекст может превышать доступную память.'
      );
      expect(screen.getByText('Вручную заданный контекст может превышать доступную память.')).toHaveClass('sr-only');
      expect(screen.getByLabelText('Точность контекста (KV)')).toBeInTheDocument();
      await user.click(await screen.findByRole('button', { name: '64K · FP16' }));
      await user.selectOptions(screen.getByLabelText('Точность контекста (KV)'), 'q8_0');
      await user.click(screen.getByRole('button', { name: 'Применить' }));
      await waitFor(() =>
        expect(window.electron.ggufApplyContext).toHaveBeenCalledWith(
          'profile-1',
          65536,
          'q8_0',
          'lease-1'
        )
      );
      expect(window.electron.ggufDiscoveryRelease).toHaveBeenCalledWith('lease-1');
    }
  );

  it('shows real discovery-candidate activity, permits cancellation, and releases the runtime lease', async () => {
    snapshot.mockReturnValue({
      session: {
        provider_name: 'managed-provider',
        goose_mode: 'auto',
        model_config: {
          model_name: 'Qwen3.8',
          reasoning: true,
          request_params: { thinking_effort: 'medium' },
        },
      },
    });
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
    const discoveryResult = {
      result: {
        modelId: '/models/qwen.gguf',
        probeContextTokens: 0,
        options: [],
        unsupported: [],
        restored: false,
      },
      restoredProcess: 'left-unloaded',
    } satisfies Awaited<ReturnType<typeof window.electron.ggufDiscoveryRun>>;
    let resolveDiscovery!: (value: typeof discoveryResult) => void;
    window.electron.ggufDiscoveryRun = vi.fn(
      () =>
        new Promise<typeof discoveryResult>((resolve) => {
          resolveDiscovery = resolve;
        })
    );
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="session-local" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    await screen.findByRole('group', { name: 'Context' });
    await user.click(screen.getByRole('button', { name: 'Find maximum' }));
    await waitFor(() =>
      expect(window.electron.ggufDiscoveryRun).toHaveBeenCalledWith('profile-1', 'lease-1')
    );
    emitDiscoveryProgress?.({
      busy: true,
      stage: 'Evaluating measured candidate',
      probeCount: 2,
      currentCandidate: { context: 65536, kv: 'f16', phase: 'search' },
    });
    expect(await screen.findByText('Checking FP16 at 64K · probe 2')).toBeInTheDocument();
    expect(document.body.querySelector('.animate-pulse.ring-2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel search' }));
    expect(window.electron.ggufDiscoveryCancel).toHaveBeenCalledWith('lease-1');
    resolveDiscovery(discoveryResult);
    await waitFor(() =>
      expect(window.electron.ggufDiscoveryRelease).toHaveBeenCalledWith('lease-1')
    );
  });
  it('merges maxima into presets, keeps mixed KV read-only, and disables Q8 without Flash Attention', async () => {
    snapshot.mockReturnValue({
      session: {
        provider_name: 'managed-provider',
        goose_mode: 'auto',
        model_config: { model_name: 'plain', reasoning: false },
      },
    });
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
    window.electron.ggufSave = vi.fn();
    window.electron.ggufDiscoveryCatalog = vi
      .fn()
      .mockResolvedValue({
        ...catalog,
        selectedKv: 'custom',
        supportedKv: ['f16'],
        q8UnavailableReason: 'flashAttention',
        options: [{ ...discoveredOption, contextWindow: 102400, restored: true }],
        previous: [
          {
            ...discoveredOption,
            contextWindow: 114688,
            kvCacheType: 'q8_0',
            conditions: 'changed',
          },
        ],
      });
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId="mixed-session" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(screen.queryByRole('button', { name: '100K · FP16' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('KV Cache Precision'), 'f16');
    const saved = await screen.findByRole('button', { name: '100K · FP16' });
    expect(saved).toHaveAttribute('title', expect.stringContaining('102400 tokens'));
    expect(screen.queryByRole('button', { name: '112K · Q8' })).not.toBeInTheDocument();
    const precision = screen.getByLabelText('KV Cache Precision');
    expect(precision).toHaveValue('f16');
    expect(
      Array.from(precision.querySelectorAll('option')).some((option) => option.value === 'custom')
    ).toBe(false);
    expect(window.electron.ggufApplyContext).not.toHaveBeenCalled();
    expect(window.electron.ggufSave).not.toHaveBeenCalled();
    await user.click(saved);
    expect(precision).toHaveValue('f16');
    expect(screen.getByLabelText('Custom')).toHaveValue(102400);
    expect(window.electron.ggufApplyContext).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(window.electron.ggufApplyContext).toHaveBeenCalledWith(
        'profile-1',
        102400,
        'f16',
        'lease-1'
      )
    );
  });
  it('uses structured GGUF capabilities across model/session switches and preserves per-session effort', async () => {
    snapshot.mockReturnValue(undefined);
    const unsupportedProfile = { id: 'other-profile', providerId: 'other-provider', model: '/models/plain.gguf', name: 'Plain', context: 8192, executable: '/bin/llama-server', gpuLayers: 999 };
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }, { profile: unsupportedProfile, available: true }]);
    window.electron.ggufCapabilities = vi.fn().mockImplementation(async (id: string) => ({
      thinking: id === 'profile-1', nativeEfforts: id === 'profile-1', vision: false,
      reasoning: { thinkingSupported: id === 'profile-1', thinkingToggleSupported: id === 'profile-1',
        reasoningEffortSupported: id === 'profile-1', supportedEfforts: id === 'profile-1' ? ['low', 'medium', 'xhigh'] : [],
        status: id === 'profile-1' ? 'available' : 'unsupported' },
    }));
    const view = render(<SessionSettingsPopover sessionId={null} provider="managed-provider" model="local-gguf" draft={{ effort: 'medium' }} />, { wrapper: IntlTestWrapper });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(await screen.findByLabelText('Thinking')).toHaveValue('on');
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('medium');
    expect(screen.queryByRole('option', { name: 'High' })).not.toBeInTheDocument();
    view.rerender(<SessionSettingsPopover sessionId={null} provider="other-provider" model="local-gguf" />);
    await waitFor(() => expect(screen.queryByLabelText('Thinking')).not.toBeInTheDocument());
    snapshot.mockReturnValue({ session: { provider_name: 'managed-provider', model_config: { model_name: 'local-gguf', request_params: { thinking_effort: 'low' } } } });
    view.rerender(<SessionSettingsPopover sessionId="existing-local-a" provider="managed-provider" model="local-gguf" />);
    expect(await screen.findByLabelText('Reasoning effort')).toHaveValue('low');
    snapshot.mockReturnValue({ session: { provider_name: 'managed-provider', model_config: { model_name: 'local-gguf', request_params: { thinking_effort: 'medium' } } } });
    view.rerender(<SessionSettingsPopover sessionId="existing-local-b" provider="managed-provider" model="local-gguf" />);
    await waitFor(() => expect(screen.getByLabelText('Reasoning effort')).toHaveValue('medium'));
    expect(window.electron.ggufDiscoveryRun).not.toHaveBeenCalled();
    expect(window.electron.ggufApplyContext).not.toHaveBeenCalled();
  });

  it('reports an unknown local capability and retries metadata inspection on reopening', async () => {
    snapshot.mockReturnValue(undefined);
    window.electron.ggufList = vi.fn().mockResolvedValue([{ profile, available: true }]);
    window.electron.ggufCapabilities = vi.fn().mockRejectedValueOnce(new Error('temporary metadata failure')).mockResolvedValue({ thinking: true, nativeEfforts: true, vision: false });
    const user = userEvent.setup();
    render(<SessionSettingsPopover sessionId={null} provider="managed-provider" model="local-gguf" />, { wrapper: IntlTestWrapper });
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(await screen.findByText('Reasoning metadata could not be inspected.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    await user.click(screen.getByRole('button', { name: 'Session settings' }));
    expect(await screen.findByLabelText('Thinking')).toHaveValue('on');
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('high');
  });

});

it('shows the actual persisted Chat default and preserves explicit Autonomous across delayed hydration and model changes', async () => {
  let resolve!: (value: string) => void;
  readDefault.mockReturnValue(new Promise<string>(r => { resolve = r; }));
  const props = { sessionId: null, draft: { mode: 'auto' as const }, provider: 'local-one' };
  const { rerender } = render(<SessionSettingsPopover {...props} />, { wrapper: IntlTestWrapper });
  await userEvent.click(screen.getByRole('button', { name: 'Session settings' }));
  expect(screen.getByLabelText('Agent mode')).toHaveValue('auto');
  resolve('chat');
  await waitFor(() => expect(readDefault).toHaveBeenCalled());
  rerender(<SessionSettingsPopover {...props} model="reloaded-model" />);
  expect(screen.getByLabelText('Agent mode')).toHaveValue('auto');
});
it('hydrates the real global mode before a new-chat mode can be selected', async () => {
  let resolve!: (value: string) => void;
  readDefault.mockReturnValue(new Promise<string>(r => { resolve = r; }));
  render(<SessionSettingsPopover sessionId={null} draft={{}} />, { wrapper: IntlTestWrapper });
  await userEvent.click(screen.getByRole('button', { name: 'Session settings' }));
  expect(screen.getByLabelText('Agent mode')).toBeDisabled();
  resolve('chat');
  await waitFor(() => expect(screen.getByLabelText('Agent mode')).toHaveValue('chat'));
});
