import { getSessionConfiguration, rememberSessionConfiguration } from './sessionConfiguration';
// Local AI Desktop: configure a newly created session before releasing its first prompt.
import { methods } from '@agentclientprotocol/sdk';
import { getAcpClient } from './acpConnection';
import type { GooseMode, Session } from '../types/session';
import type { ThinkingEffort } from '../types/providers';
import { acpChatSessionActions } from './chatSessionStore';
export interface NewChatSettings { mode?: GooseMode; effort?: ThinkingEffort; budget?: number }
export async function configureNewChatSession(session: Session, settings: NewChatSettings): Promise<Session> {
  if (!settings.mode && !settings.effort && settings.budget === undefined) return session;
  const advertised = getSessionConfiguration(session.id)?.efforts;
  if (settings.effort && advertised && !advertised.includes(settings.effort)) throw new Error(`Unsupported thinking effort: ${settings.effort}`);
  // A local-only default reset must not leak into a cloud session after changing models.
  const budget = settings.budget === -1 && getSessionConfiguration(session.id)?.budget === undefined ? undefined : settings.budget;
  const client = await getAcpClient();
  if (settings.mode) {
    await client.connection.agent.request(methods.agent.session.setMode, { sessionId: session.id, modeId: settings.mode });
    rememberSessionConfiguration(session.id, { modes: { currentModeId: settings.mode } });
  }
  if (settings.effort) rememberSessionConfiguration(session.id, await client.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: session.id, configId: 'thinking_effort', value: settings.effort }));
  if (settings.effort) rememberSessionConfiguration(session.id, { configOptions: [{ id: 'thinking_effort', currentValue: settings.effort }] });
  if (budget !== undefined) {
    rememberSessionConfiguration(session.id, await client.connection.agent.request(methods.agent.session.setConfigOption, {sessionId: session.id, configId: 'thinking_budget', value: String(budget)}));
  }
  const configured = { ...session, ...(settings.mode ? { goose_mode: settings.mode } : {}),
    model_config: session.model_config && settings.effort ? { ...session.model_config, request_params: { ...session.model_config.request_params, thinking_effort: settings.effort } } : session.model_config };
  if (configured.model_config && budget !== undefined) configured.model_config = {...configured.model_config, request_params:{...configured.model_config.request_params, reasoning_budget_tokens: budget}};
  acpChatSessionActions.setSessionMetadata(session.id, configured);
  return configured;
}
