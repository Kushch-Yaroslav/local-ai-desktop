import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SubagentRows } from './SubagentRows';
import { ContextXrayDialog } from './context_xray/ContextXrayDialog';
import { receiveSubagent } from '../acp/subagentSessions';

const { info, report } = vi.hoisted(() => ({ info: vi.fn(), report: vi.fn() }));
vi.mock('../acp/acpConnection', () => ({
  getAcpClient: async () => ({ goose: { sessionInfo_unstable: info } }),
  subscribeToAcpRecovery: () => () => {},
}));
vi.mock('../acp/contextReport', () => ({ getContextReport: report }));
function Path() {
  return <p>{useLocation().search}</p>;
}
function fixtures(parent: string) {
  return {
    session: {
      sessionId: parent,
      cwd: '/',
      _meta: {
        children: ['a', 'b', 'c'].map((suffix, i) => ({
          sessionId: parent + suffix,
          title: `Chapters ${i + 1}`,
          cwd: '/',
          _meta: {
            parentSessionId: parent,
            createdAt: `2026-11-11T20:00:0${3 - i}Z`,
            subagent: {
              id: parent + suffix,
              parentId: parent,
              title: `Chapters ${i + 1}`,
              status: ['running', 'compacting', 'failed'][i],
              contextLimit: 28672,
              totalTokens: 20000 + i,
              updatedAt: '2026-11-11T20:00:00Z',
            },
          },
        })),
      },
    },
  };
}
describe('subagent monitoring', () => {
  it('restores persisted nested sessions, opens their existing viewer, and updates from real notifications', async () => {
    info.mockResolvedValue(fixtures('sidebar-parent'));
    render(
      <MemoryRouter>
        <IntlTestWrapper>
          <SubagentRows parentId="sidebar-parent" />
          <Path />
        </IntlTestWrapper>
      </MemoryRouter>
    );
    const child = await screen.findByRole('button', { name: /Chapters 1.*Running/ });
    expect(screen.getByText('Compacting')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    fireEvent.click(child);
    expect(screen.getByText('?resumeSessionId=sidebar-parenta')).toBeInTheDocument();
    act(() =>
      receiveSubagent({
        id: 'sidebar-parenta',
        parentId: 'sidebar-parent',
        title: 'Chapters 1',
        status: 'completed',
        updatedAt: '2026-11-11T20:01:00Z',
      })
    );
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });
  it('keeps the parent report and shows compact numbered child budgets after Free', async () => {
    info.mockResolvedValue(fixtures('context-parent'));
    report.mockImplementation(async (id: string) => ({
      model: { modelName: id, contextLimit: id === 'context-parent' ? 114688 : 28672 },
      totalTokens: id === 'context-parent' ? 9500 : 21000,
      segments: [],
      providerManagesContext: false,
      autoCompactionPending: false,
    }));
    render(
      <IntlTestWrapper>
        <ContextXrayDialog
          open
          onOpenChange={vi.fn()}
          sessionId="context-parent"
          totalTokens={9500}
          onCompact={vi.fn()}
          compactDisabled={false}
        />
      </IntlTestWrapper>
    );
    await screen.findByText('Subagent 2 · Compacting');
    expect(screen.queryByRole('combobox', { name: 'Agent session' })).not.toBeInTheDocument();
    expect(report).toHaveBeenCalledWith('context-parent');
    expect(screen.getByText('Subagents · 2 active')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar', { name: '20k / 29k' })[0]).toHaveAttribute(
      'aria-valuenow',
      '70'
    );
    const free = screen.getByText('Free');
    const summary = screen.getByRole('region', { name: 'Subagents · 2 active' });
    expect(free.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(screen.getByText(/not physical KV or VRAM usage/)).toBeInTheDocument();
    const before = report.mock.calls.length;
    act(() =>
      receiveSubagent({
        id: 'context-parentb',
        parentId: 'context-parent',
        title: 'Long private task instructions remain hidden from the compact summary',
        status: 'running',
        contextLimit: 28672,
        totalTokens: 2000,
        lastCompactionAt: '2026-11-11T20:02:00Z',
        updatedAt: '2026-11-11T20:02:00Z',
      })
    );
    await waitFor(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    expect(screen.getByText('Subagents · 2 active')).toBeInTheDocument();
    expect(screen.getByText('Subagent 2 · Running')).toBeInTheDocument();
    expect(screen.queryByText(/Long private task instructions/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeEnabled();
  });
  it('uses scheduler IPC waiting events and shares and removes its subscription', async () => {
    info.mockResolvedValue(fixtures('ipc-parent'));
    let listener: ((event: { sessionId?: string; phase: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    const previous = window.electron.ggufOnInference;
    const subscribe = vi.fn((callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    });
    window.electron.ggufOnInference = subscribe;
    const view = render(
      <MemoryRouter>
        <IntlTestWrapper>
          <SubagentRows parentId="ipc-parent" />
          <SubagentRows parentId="other-parent" />
        </IntlTestWrapper>
      </MemoryRouter>
    );
    await screen.findByText('Chapters 1');
    expect(subscribe).toHaveBeenCalledTimes(1);
    act(() => listener?.({ sessionId: 'ipc-parenta', phase: 'waiting' }));
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    act(() => listener?.({ sessionId: 'ipc-parenta', phase: 'admitted' }));
    expect(screen.getByText('Running')).toBeInTheDocument();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    window.electron.ggufOnInference = previous;
  });
});
