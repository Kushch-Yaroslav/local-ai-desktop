import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListItem } from '../../acp/sessions';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { groupSessionsByProject } from '../../utils/projectSessions';
import { Navigation } from './NavigationPanel';

const mocks = vi.hoisted(() => ({
  acpDeleteSession: vi.fn(),
  acpGetSessionDeletionPlan: vi.fn(),
  acpListAllSessions: vi.fn(),
  useNavigationSessions: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../acp/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../acp/sessions')>();
  return {
    ...actual,
    acpDeleteSession: mocks.acpDeleteSession,
    acpGetSessionDeletionPlan: mocks.acpGetSessionDeletionPlan,
    acpListAllSessions: mocks.acpListAllSessions,
  };
});

vi.mock('../../hooks/useNavigationSessions', () => ({
  useNavigationSessions: mocks.useNavigationSessions,
}));

vi.mock('../ConfigContext', () => ({ useConfig: () => ({ extensionsList: [] }) }));
vi.mock('./NavigationContext', () => ({ useNavigationContext: () => ({ isNavExpanded: true }) }));
vi.mock('../SubagentRows', () => ({ SubagentRows: () => null }));
vi.mock('../SessionIndicators', () => ({ SessionIndicators: () => null }));
vi.mock('../common/InlineEditText', () => ({
  InlineEditText: ({ value }: { value: string }) => <span>{value || 'Untitled session'}</span>,
}));
vi.mock('../ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock('react-toastify', () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));
vi.mock('../../acp/chatSessionStore', () => ({
  acpChatSessionActions: { deleteSnapshot: vi.fn() },
}));
vi.mock('../../acp/sessionConfiguration', () => ({ forgetSessionConfiguration: vi.fn() }));
vi.mock('../../acp/subagentSessions', () => ({ forgetSubagentSessions: vi.fn() }));

const sessions: SessionListItem[] = [
  {
    id: 'chat-a',
    name: 'Project A chat',
    workingDir: '/work/project-a',
    updatedAt: '2026-11-12T10:00:00Z',
    messageCount: 3,
    createdAt: '2026-11-12T09:00:00Z',
  },
  {
    id: 'chat-b',
    name: 'Other project chat',
    workingDir: '/work/project-ab',
    updatedAt: '2026-11-12T09:00:00Z',
    messageCount: 2,
    createdAt: '2026-11-12T08:00:00Z',
  },
];

function CurrentPath() {
  const location = useLocation();
  return <output data-testid="current-path">{location.pathname}</output>;
}

function renderNavigation(initialEntry = '/pair?resumeSessionId=chat-a') {
  return render(
    <IntlTestWrapper>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Navigation activeLiveVoiceSessionId={null} />
        <CurrentPath />
      </MemoryRouter>
    </IntlTestWrapper>
  );
}

describe('Navigation chat and project deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useNavigationSessions.mockReturnValue({
      recentSessions: sessions,
      recentSessionsByProject: groupSessionsByProject(sessions),
      isLoadingSessions: false,
      activeSessionId: 'chat-a',
      fetchSessions: vi.fn(),
      handleNavClick: vi.fn(),
      handleSessionClick: vi.fn(),
    });
    mocks.acpDeleteSession.mockResolvedValue(undefined);
    mocks.acpGetSessionDeletionPlan.mockImplementation(async (id: string) => ({
      sessionIds: id === 'chat-a' ? [id, 'child-1', 'child-2', 'child-3'] : [id],
      activeSessionIds: [],
    }));
    mocks.acpListAllSessions.mockResolvedValue(sessions);
  });

  it('cancels the confirmation without deleting a chat', async () => {
    const user = userEvent.setup();
    renderNavigation();

    await user.click(screen.getAllByRole('button', { name: 'More chat actions' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete chat' }));
    expect(await screen.findByText(/Delete the saved chat/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mocks.acpDeleteSession).not.toHaveBeenCalled();
  });

  it('deletes a chat tree through ACP and moves away from the removed current chat', async () => {
    const user = userEvent.setup();
    const deletedEvent = vi.fn();
    window.addEventListener('session-deleted', deletedEvent);
    renderNavigation();

    await user.click(screen.getAllByRole('button', { name: 'More chat actions' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete chat' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mocks.acpDeleteSession).toHaveBeenCalledWith('chat-a'));
    expect(mocks.acpDeleteSession).toHaveBeenCalledTimes(1);
    expect(deletedEvent).toHaveBeenCalledOnce();
    expect(await screen.findByTestId('current-path')).toHaveTextContent('/');
    window.removeEventListener('session-deleted', deletedEvent);
  });

  it('deletes only chats whose normalized working directory belongs to the selected project', async () => {
    const user = userEvent.setup();
    const allSessions = [
      { ...sessions[0], workingDir: '/work/project-a/' },
      {
        ...sessions[0],
        id: 'chat-a-second',
        name: 'Second Project A chat',
        workingDir: '/work/project-a',
      },
      { ...sessions[1], workingDir: '/work/project-ab' },
    ];
    mocks.acpListAllSessions.mockResolvedValue(allSessions);
    mocks.acpGetSessionDeletionPlan.mockImplementation(async (id: string) => ({
      sessionIds: [id],
      activeSessionIds: [],
    }));
    renderNavigation('/');

    await user.click(screen.getAllByRole('button', { name: 'More catalog actions' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete catalog and chats' }));
    expect(await screen.findByText(/Delete 2 saved chats from/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mocks.acpDeleteSession).toHaveBeenCalledWith('chat-a'));
    expect(mocks.acpDeleteSession).toHaveBeenCalledWith('chat-a-second');
    expect(mocks.acpDeleteSession).toHaveBeenCalledTimes(2);
    expect(mocks.acpDeleteSession).not.toHaveBeenCalledWith('chat-b');
  });

  it('does not send deletion for an active chat', async () => {
    const user = userEvent.setup();
    mocks.acpGetSessionDeletionPlan.mockResolvedValue({
      sessionIds: ['chat-a'],
      activeSessionIds: ['chat-a'],
    });
    renderNavigation();

    await user.click(screen.getAllByRole('button', { name: 'More chat actions' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete chat' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('still running'))
    );
    expect(mocks.acpDeleteSession).not.toHaveBeenCalled();
  });

  it('leaves sessions intact when project membership changed after confirmation opened', async () => {
    const user = userEvent.setup();
    const newlyAddedChat = {
      ...sessions[0],
      id: 'chat-a-new',
      name: 'New project A chat',
      updatedAt: '2026-11-12T11:00:00Z',
    };
    mocks.acpListAllSessions
      .mockResolvedValueOnce(sessions)
      .mockResolvedValueOnce([sessions[0], newlyAddedChat]);
    renderNavigation('/');

    await user.click(screen.getAllByRole('button', { name: 'More catalog actions' })[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete catalog and chats' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalled());
    expect(mocks.acpDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete 2 saved chats from/)).toBeInTheDocument();
  });
});
