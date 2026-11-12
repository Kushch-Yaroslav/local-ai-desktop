import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateMock = vi.hoisted(() => vi.fn());
const listRecentSessionsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const routerState = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));

vi.mock('react-router', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: '/pair', search: routerState.searchParams.toString() }),
  useSearchParams: () => [routerState.searchParams, vi.fn()],
}));

vi.mock('../acp/sessions', () => ({
  acpGetSessionListItem: vi.fn(() => new Promise(() => {})),
  acpListRecentSessions: listRecentSessionsMock,
}));

vi.mock('../contexts/ChatContext', () => ({
  useChatContext: () => ({ chat: { sessionId: undefined } }),
}));

import { useNavigationSessions } from './useNavigationSessions';

const injectedSessionId = 'session-1&shouldStartAgent=true';

function expectSingleSessionParameter(target: string) {
  const url = new URL(target, 'http://localhost');
  expect(url.searchParams.get('resumeSessionId')).toBe(injectedSessionId);
  expect(url.searchParams.get('shouldStartAgent')).toBeNull();
}

describe('useNavigationSessions', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    listRecentSessionsMock.mockReset().mockResolvedValue([]);
    routerState.searchParams = new URLSearchParams();
  });

  it('keeps a selected session ID in one query parameter', () => {
    const { result } = renderHook(() => useNavigationSessions());

    act(() => result.current.handleSessionClick(injectedSessionId));

    expectSingleSessionParameter(navigateMock.mock.calls[0][0]);
  });

  it('keeps a retained session ID in one query parameter', () => {
    routerState.searchParams = new URLSearchParams({ resumeSessionId: injectedSessionId });
    const { result } = renderHook(() => useNavigationSessions());

    act(() => result.current.handleNavClick('/pair'));

    expectSingleSessionParameter(navigateMock.mock.calls[0][0]);
  });

  it('removes a deleted session tree from the sidebar after a batch deletion event', async () => {
    const rows = [
      { id: 'parent', name: 'Parent', workingDir: '/tmp', messageCount: 1 },
      { id: 'child', name: 'Child', workingDir: '/tmp', messageCount: 1 },
      { id: 'other', name: 'Other', workingDir: '/tmp', messageCount: 1 },
    ];
    listRecentSessionsMock.mockResolvedValueOnce(rows).mockResolvedValueOnce([rows[2]]);
    const { result } = renderHook(() => useNavigationSessions());

    await act(async () => result.current.fetchSessions());
    expect(result.current.recentSessions.map((session) => session.id)).toEqual([
      'parent',
      'child',
      'other',
    ]);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('session-deleted', { detail: { sessionIds: ['parent', 'child'] } })
      );
    });

    await act(async () => Promise.resolve());
    expect(result.current.recentSessions.map((session) => session.id)).toEqual(['other']);
  });
});
