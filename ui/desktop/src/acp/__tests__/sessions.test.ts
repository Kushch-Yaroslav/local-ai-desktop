import { methods, type SessionInfo } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpClient } from '../acpConnection';
import {
  acpDeleteSessionTree,
  acpGetSessionListItem,
  acpListAllSessions,
  acpListSessions,
  ActiveSessionDeletionError,
  acpLoadSession,
  acpNewSession,
  sessionInfoToSession,
  parseLoadMeta,
} from '../sessions';

vi.mock('../acpConnection', () => ({
  getAcpClient: vi.fn(),
}));

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'session-1',
    cwd: '/tmp',
    title: 'Scheduled session',
    updatedAt: '2026-01-01T00:00:00Z',
    _meta: {
      createdAt: '2026-01-01T00:00:00Z',
      messageCount: 0,
      sessionType: 'scheduled',
    },
    ...overrides,
  } as unknown as SessionInfo;
}

function newSessionClient() {
  const client = {
    connection: {
      agent: {
        request: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      },
    },
    goose: {
      sessionInfo_unstable: vi.fn().mockResolvedValue({ session: sessionInfo() }),
    },
  };
  vi.mocked(getAcpClient).mockResolvedValue(
    client as unknown as Awaited<ReturnType<typeof getAcpClient>>
  );
  return client;
}

describe('ACP sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores explicit browser scope from load response without treating cwd as a project', () => {
    const meta = parseLoadMeta({ _meta: { browserProjectRoot: '/selected/project' } } as Parameters<
      typeof parseLoadMeta
    >[0]);
    expect(sessionInfoToSession(sessionInfo(), meta).browser_project_root).toBe(
      '/selected/project'
    );
    expect(sessionInfoToSession(sessionInfo()).browser_project_root).toBeUndefined();
  });

  it('preserves session type from ACP session info metadata', () => {
    const session = sessionInfoToSession(sessionInfo());

    expect(session.session_type).toBe('scheduled');
  });

  it('does not synthesize a title when ACP omits one', () => {
    const session = sessionInfoToSession(sessionInfo({ title: undefined }));

    expect(session.name).toBe('');
  });

  it('only requests acp session types when explicitly included', async () => {
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({ sessions: [] }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await acpListSessions();
    expect(client.connection.agent.request).toHaveBeenLastCalledWith(methods.agent.session.list, {
      _meta: { types: ['user', 'scheduled'] },
    });

    await acpListSessions(undefined, { includeAcp: true });
    expect(client.connection.agent.request).toHaveBeenLastCalledWith(methods.agent.session.list, {
      _meta: { types: ['user', 'scheduled', 'acp'] },
    });
  });

  it('returns session info refreshed after loading the ACP session', async () => {
    const loadedSessionInfo = sessionInfo({
      _meta: {
        createdAt: '2026-01-01T00:00:00Z',
        messageCount: 0,
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    });
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({}),
        },
      },
      goose: {
        sessionInfo_unstable: vi
          .fn()
          .mockResolvedValueOnce({ session: sessionInfo() })
          .mockResolvedValueOnce({ session: loadedSessionInfo }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const result = await acpLoadSession('session-1');

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.load, {
      sessionId: 'session-1',
      cwd: '/tmp',
      mcpServers: [],
    });
    expect(client.goose.sessionInfo_unstable).toHaveBeenCalledTimes(2);
    expect(result.sessionInfo).toBe(loadedSessionInfo);
    expect(sessionInfoToSession(result.sessionInfo).provider_name).toBe('anthropic');
    expect(sessionInfoToSession(result.sessionInfo).model_config?.model_name).toBe(
      'claude-sonnet-4-5'
    );
  });

  it('sends an explicitly empty extension set as an empty list', async () => {
    const client = newSessionClient();

    await acpNewSession('/tmp', []);

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: '/tmp',
      mcpServers: [],
      _meta: {
        client: 'goose-desktop',
        enabledExtensions: [],
      },
    });
  });

  it('omits the extension key when the caller names no set', async () => {
    const client = newSessionClient();

    await acpNewSession('/tmp', undefined);

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: '/tmp',
      mcpServers: [],
      _meta: { client: 'goose-desktop' },
    });
  });

  it('carries the recipe parameter scope id in new-session metadata', async () => {
    const createdSessionInfo = sessionInfo();
    const client = {
      connection: {
        agent: {
          request: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
        },
      },
      goose: {
        sessionInfo_unstable: vi.fn().mockResolvedValue({ session: createdSessionInfo }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await acpNewSession('/tmp', undefined, {
      recipeDeeplink: 'goose://recipe?url=example',
      recipeParameterScopeId: 'scope-1',
    });

    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.new, {
      cwd: '/tmp',
      mcpServers: [],
      _meta: {
        client: 'goose-desktop',
        recipeDeeplink: 'goose://recipe?url=example',
        recipeParameterScopeId: 'scope-1',
      },
    });
  });

  it('returns a list item from ACP session info', async () => {
    const client = {
      goose: {
        sessionInfo_unstable: vi.fn().mockResolvedValue({
          session: sessionInfo({
            title: 'Subagent session',
            _meta: {
              createdAt: '2026-01-01T00:00:00Z',
              lastMessageAt: '2026-01-01T00:01:00Z',
              messageCount: 3,
              sessionType: 'sub_agent',
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5',
            },
          }),
        }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    const item = await acpGetSessionListItem('session-1');

    expect(client.goose.sessionInfo_unstable).toHaveBeenCalledWith({ sessionId: 'session-1' });
    expect(item).toMatchObject({
      id: 'session-1',
      name: 'Subagent session',
      workingDir: '/tmp',
      messageCount: 3,
      lastMessageAt: '2026-01-01T00:01:00Z',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('deletes one saved chat through ACP session/delete', async () => {
    const client = newSessionClient();

    await expect(acpDeleteSessionTree('session-1')).resolves.toEqual(['session-1']);
    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.delete, {
      sessionId: 'session-1',
    });
  });

  it('collects three subagent histories and deletes their parent tree once', async () => {
    const childIds = ['subagent-1', 'subagent-2', 'subagent-3'];
    const client = {
      connection: { agent: { request: vi.fn().mockResolvedValue({}) } },
      goose: {
        sessionInfo_unstable: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
          session: sessionInfo({
            sessionId,
            _meta:
              sessionId === 'parent'
                ? { children: childIds.map((id) => ({ sessionId: id })) }
                : { subagent: { status: 'completed' } },
          }),
        })),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await expect(acpDeleteSessionTree('parent')).resolves.toEqual(['parent', ...childIds]);
    expect(client.goose.sessionInfo_unstable).toHaveBeenCalledTimes(4);
    expect(client.connection.agent.request).toHaveBeenCalledTimes(1);
    expect(client.connection.agent.request).toHaveBeenCalledWith(methods.agent.session.delete, {
      sessionId: 'parent',
    });
  });

  it('refuses an active parent or subagent before sending session/delete', async () => {
    const client = newSessionClient();
    client.goose.sessionInfo_unstable.mockResolvedValue({
      session: sessionInfo({ _meta: { goose: { active: true } } }),
    });

    await expect(acpDeleteSessionTree('session-1')).rejects.toBeInstanceOf(
      ActiveSessionDeletionError
    );
    expect(client.connection.agent.request).not.toHaveBeenCalled();
  });

  it('refuses an active child found in the persisted session tree', async () => {
    const client = newSessionClient();
    client.goose.sessionInfo_unstable
      .mockResolvedValueOnce({
        session: sessionInfo({
          sessionId: 'parent',
          _meta: { children: [{ sessionId: 'subagent-1' }] },
        }),
      })
      .mockResolvedValueOnce({
        session: sessionInfo({
          sessionId: 'subagent-1',
          _meta: { subagent: { status: 'compacting' } },
        }),
      });

    await expect(acpDeleteSessionTree('parent')).rejects.toBeInstanceOf(ActiveSessionDeletionError);
    expect(client.connection.agent.request).not.toHaveBeenCalled();
  });

  it('paginates all chats and detects a repeated cursor instead of looping forever', async () => {
    const client = {
      connection: {
        agent: {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              sessions: [sessionInfo({ sessionId: 'first' })],
              nextCursor: 'p2',
            })
            .mockResolvedValueOnce({
              sessions: [sessionInfo({ sessionId: 'second' })],
              nextCursor: null,
            }),
        },
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await expect(acpListAllSessions({ includeAcp: true })).resolves.toMatchObject([
      { id: 'first' },
      { id: 'second' },
    ]);
    expect(client.connection.agent.request).toHaveBeenNthCalledWith(2, methods.agent.session.list, {
      cursor: 'p2',
      _meta: { types: ['user', 'scheduled', 'acp'] },
    });
  });

  it('handles missing and malformed child metadata idempotently', async () => {
    const client = {
      connection: {
        agent: { request: vi.fn().mockRejectedValue(new Error('Session not found')) },
      },
      goose: {
        sessionInfo_unstable: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          if (sessionId === 'missing-child') throw new Error('Session not found: missing-child');
          return {
            session: sessionInfo({
              sessionId,
              _meta: { children: [{ sessionId: 'missing-child' }, null, { sessionId: '' }] },
            }),
          };
        }),
      },
    };
    vi.mocked(getAcpClient).mockResolvedValue(
      client as unknown as Awaited<ReturnType<typeof getAcpClient>>
    );

    await expect(acpDeleteSessionTree('parent')).resolves.toEqual(['parent', 'missing-child']);
    expect(client.connection.agent.request).toHaveBeenCalledTimes(1);
  });
});
