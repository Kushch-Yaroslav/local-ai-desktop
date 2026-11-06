import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../types/session';
const { request, update } = vi.hoisted(() => ({ request: vi.fn(), update: vi.fn() }));
vi.mock('./acpConnection', () => ({ getAcpClient: async () => ({ connection: { agent: { request } } }) }));
vi.mock('./chatSessionStore', () => ({ acpChatSessionActions: { setSessionMetadata: update } }));
import { configureNewChatSession } from './newChatSettings';
const session = { id: 'new-session', model_config: { model_name: 'local-gguf', toolshim: false } } as Session;
describe('first-message session configuration barrier', () => {
  it('awaits permission mode before effort, then releases the configured session', async () => {
    const order: string[] = [];
    request.mockImplementation(async (method) => { order.push(String(method)); });
    const result = await configureNewChatSession(session, { mode: 'approve', effort: 'low' });
    expect(order).toEqual(['session/set_mode', 'session/set_config_option']);
    expect(request).toHaveBeenCalledWith('session/set_mode', { sessionId: session.id, modeId: 'approve' });
    expect(result.goose_mode).toBe('approve');
    expect(result.model_config?.request_params?.thinking_effort).toBe('low');
  });
  it('applies the separate request budget before releasing the first inference', async () => {
    request.mockReset().mockResolvedValue({});
    const result = await configureNewChatSession(session, {mode:'chat',effort:'low',budget:512});
    expect(request.mock.calls.map(call => call[1].configId ?? 'mode')).toEqual(['mode','thinking_effort','thinking_budget']);
    expect(result.model_config?.request_params?.reasoning_budget_tokens).toBe(512);
  });
  it('rejects configuration failure so the caller cannot release the first prompt', async () => {
    request.mockReset().mockRejectedValueOnce(new Error('ACP rejected mode'));
    await expect(configureNewChatSession(session, { mode: 'chat', effort: 'high' })).rejects.toThrow('ACP rejected mode');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it('does not send a local budget reset to a cloud session that never advertised it',async()=>{request.mockReset().mockResolvedValue({});const result=await configureNewChatSession({...session,id:'cloud-session'},{effort:'low',budget:-1});expect(request.mock.calls.map(c=>c[1].configId)).toEqual(['thinking_effort']);expect(result.model_config?.request_params?.reasoning_budget_tokens).toBeUndefined();});
