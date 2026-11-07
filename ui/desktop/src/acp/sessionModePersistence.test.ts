// Local AI Desktop: per-session persistence must survive renderer recreation and model notifications.
import { describe, it, expect, vi } from 'vitest';
import { rememberSessionConfiguration, getSessionConfiguration, getSessionModeRevision } from './sessionConfiguration';
import { sessionInfoToSession } from './sessions';
import type { SessionInfo } from '@agentclientprotocol/sdk';
vi.mock('./acpConnection', () => ({ getAcpClient: vi.fn() }));
describe('persisted session modes', () => {
  it('restores modes from backend metadata on app restart, independently for each chat', () => {
    for (const [id, mode] of [['restart-auto','auto'],['restart-chat','chat']] as const) {
      const session = sessionInfoToSession({sessionId:id,cwd:'/project',_meta:{gooseMode:mode}} as SessionInfo);
      expect(session.goose_mode).toBe(mode);
    }
  });
  it('retains both chats while model, thinking, context and budget notifications arrive', () => {
    rememberSessionConfiguration('mode-auto', {modes:{currentModeId:'auto'}});
    rememberSessionConfiguration('mode-chat', {modes:{currentModeId:'chat'}});
    for (const id of ['mode-auto','mode-chat']) {
      for (const key of ['model','thinking_effort','thinking_budget','context','vision','mtp','kv'])
        rememberSessionConfiguration(id,{configOptions:[{id:key,currentValue:'low'}]});
    }
    expect(getSessionConfiguration('mode-auto')?.mode).toBe('auto');
    expect(getSessionConfiguration('mode-chat')?.mode).toBe('chat');
  });
});

it('ignores delayed load and model capability snapshots after an explicit mode change', () => {
  rememberSessionConfiguration('late-load', {modes:{currentModeId:'chat'}});
  const revision = getSessionModeRevision('late-load');
  rememberSessionConfiguration('late-load', {modes:{currentModeId:'auto'}});
  rememberSessionConfiguration('late-load', {modes:{currentModeId:'chat'}}, revision);
  rememberSessionConfiguration('late-load', {configOptions:[{id:'mode',currentValue:'chat'}]});
  expect(getSessionConfiguration('late-load')?.mode).toBe('auto');
});
