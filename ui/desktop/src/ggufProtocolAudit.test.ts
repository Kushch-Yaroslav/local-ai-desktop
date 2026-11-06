import { describe, expect, it } from 'vitest';
import { ProtocolObservation } from './ggufProtocolAudit';

describe('managed GGUF protocol audit', () => {
  it('records tool calls and finish_reason from non-streaming OpenAI-compatible JSON without retaining text', () => {
    const observation = new ProtocolObservation(Buffer.from(JSON.stringify({
      messages: [
        { role: 'system', content: 'Goose system instructions' },
        { role: 'user', content: 'private prompt text' },
      ],
      tools: [{ type: 'function', function: { name: 'safe_read' } }],
      tool_choice: 'required',
    })));
    observation.chunk(new TextEncoder().encode(JSON.stringify({
      choices: [{ message: {
        role: 'assistant',
        content: 'private response text',
        tool_calls: [{ id: 'private-id', type: 'function', function: { name: 'safe_read', arguments: '{}' } }],
      }, finish_reason: 'tool_calls' }],
    })));
    observation.finish();
    expect(observation.summary).toMatchObject({
      roles: { system: 1, user: 1 }, tools: 1, toolChoice: 'required',
      responseToolCalls: true, finishReasons: ['tool_calls'],
    });
    expect(JSON.stringify(observation.summary)).not.toMatch(/private prompt|private response|private-id|safe_read/);
  });

  it('records fragmented SSE tool-call deltas and preserves the allow-listed finish reason', () => {
    const observation = new ProtocolObservation(Buffer.from(JSON.stringify({
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call-1' }] }, { role: 'tool' }],
      tools: [{ type: 'function' }], tool_choice: { type: 'function', function: { name: 'safe_read' } },
    })));
    observation.chunk(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"safe_read"}}]},"finish_reason":null}]}\n\n'));
    observation.chunk(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'));
    observation.chunk(new TextEncoder().encode('data: [DONE]\n\n'));
    observation.finish();
    expect(observation.summary).toMatchObject({
      assistantToolCalls: true, toolResults: 1, tools: 1,
      toolChoice: 'function', responseToolCalls: true,
      finishReasons: ['tool_calls'], done: true,
    });
  });
});
