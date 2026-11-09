// Modified for Local AI Desktop: durable visual payload and audience-aware ACP messages.
import { methods, type ContentBlock, type PromptResponse } from '@agentclientprotocol/sdk';
import type {
  SteerSessionRequest_unstable,
  SteerSessionResponse_unstable,
} from '@aaif/goose-acp-client';
import { browserPayloads } from '../components/liveBrowser/attachments';
import type { Message } from '../types/message';
import { getAcpClient } from './acpConnection';

async function browserVisionPolicy(sessionId: string): Promise<'on' | 'off'> {
  try {
    const status = await window.electron.liveBrowserStatus();
    if (!status.endpoint) return 'off';
    const response = await fetch(
      `${status.endpoint.url}/control/state?conversation=${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${status.endpoint.token}` } }
    );
    if (!response.ok) return 'off';
    const value = await response.json();
    return value.workspace?.vision === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

export async function acpPromptSession(
  sessionId: string,
  message: Message
): Promise<PromptResponse> {
  await window.electron?.liveBrowserRegister?.(sessionId);
  const client = await getAcpClient();
  return client.connection.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: messageToAcpPromptContent(message),
    _meta: {
      liveBrowserAttachments: browserPayloads(message),
      liveBrowserVision: await browserVisionPolicy(sessionId),
    },
  });
}

export async function acpCancelPrompt(sessionId: string): Promise<void> {
  const client = await getAcpClient();
  await client.connection.agent.notify(methods.agent.session.cancel, { sessionId });
}

export async function acpSteerSession(
  sessionId: string,
  message: Message,
  expectedRunId: string
): Promise<SteerSessionResponse_unstable> {
  const client = await getAcpClient();
  const content = messageToAcpPromptContent(message);
  const first = content.find((c) => c.type === 'text');
  if (first)
    first._meta = { ...first._meta, liveBrowserVision: await browserVisionPolicy(sessionId) };
  return client.goose.sessionSteer_unstable({
    sessionId,
    expectedRunId,
    prompt: content as unknown as SteerSessionRequest_unstable['prompt'],
  });
}

export function messageToAcpPromptContent(message: Message): ContentBlock[] {
  const prompt: ContentBlock[] = [];

  for (const content of message.content) {
    switch (content.type) {
      case 'text':
        if (content.text.trim()) {
          prompt.push({
            type: 'text',
            text: content.text,
            ...(content._meta?.liveBrowserPayload
              ? { _meta: { liveBrowserPayload: content._meta.liveBrowserPayload } }
              : {}),
            ...(content.text.startsWith('lad-browser-attachment:v1:')
              ? { annotations: { audience: ['user' as const] } }
              : content.annotations
                ? {
                    annotations:
                      content.annotations as import('@agentclientprotocol/sdk').Annotations,
                  }
                : {}),
          });
        }
        break;
      case 'image':
        prompt.push({
          type: 'image',
          data: content.data,
          mimeType: content.mimeType,
          ...(content._meta ? { _meta: content._meta } : {}),
          ...(content.annotations ? { annotations: content.annotations } : {}),
        });
        break;
    }
  }

  return prompt;
}
