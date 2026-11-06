// Local AI Desktop: opt-in, bounded, memory-only structural diagnostics. Never retain text/keys/IDs.
export interface ProtocolSummary {
  roles: Record<string, number>;
  images: number;
  thinkingEnabled?: boolean;
  reasoningBudget?: number;
  nativeEffort?: string;
  tools: number;
  gooseInstructions: boolean;
  toolChoice: 'absent' | 'auto' | 'none' | 'required' | 'function' | 'other';
  requestReasoning: boolean;
  assistantToolCalls: boolean;
  toolResults: number;
  responseReasoning: boolean;
  responseToolCalls: boolean;
  finishReasons: string[];
  done: boolean;
  truncated: boolean;
}
export class ProtocolObservation {
  readonly summary: ProtocolSummary = {
    roles: {},
    images: 0,
    tools: 0,
    gooseInstructions: false,
    toolChoice: 'absent',
    requestReasoning: false,
    assistantToolCalls: false,
    toolResults: 0,
    responseReasoning: false,
    responseToolCalls: false,
    finishReasons: [],
    done: false,
    truncated: false,
  };
  private decoder = new TextDecoder();
  private pending = '';
  constructor(body: Buffer) {
    try {
      const value = JSON.parse(body.toString('utf8'));
      if (typeof value.chat_template_kwargs?.enable_thinking === 'boolean') this.summary.thinkingEnabled = value.chat_template_kwargs.enable_thinking;
      if (['low','medium','xhigh'].includes(value.chat_template_kwargs?.reasoning_effort)) this.summary.nativeEffort = value.chat_template_kwargs.reasoning_effort;
      if (Number.isInteger(value.reasoning_budget_tokens)) this.summary.reasoningBudget = value.reasoning_budget_tokens;
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const role = ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
          ? message.role
          : 'other';
        this.summary.roles[role] = (this.summary.roles[role] ?? 0) + 1;
        if (Array.isArray(message.content)) this.summary.images += message.content.filter((part: { type?: string }) => part.type === 'image_url').length;
        if (role === 'tool') this.summary.toolResults++;
        if ((role === 'system' || role === 'developer') && typeof message.content === 'string')
          this.summary.gooseInstructions ||=
            /general-purpose AI agent called goose|You are goose, an autonomous AI agent/.test(
              message.content
            );
        this.summary.requestReasoning ||=
          typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0;
        this.summary.assistantToolCalls ||=
          Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      }
      this.summary.tools = Array.isArray(value.tools) ? value.tools.length : 0;
      const choice = value.tool_choice;
      this.summary.toolChoice =
        choice === undefined
          ? 'absent'
          : ['auto', 'none', 'required'].includes(choice)
            ? choice
            : choice?.type === 'function'
              ? 'function'
              : 'other';
    } catch {
      this.summary.truncated = true;
    }
  }
  private response(value: unknown) {
    if (typeof value !== 'object' || value === null) return;
    const choices = (value as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue;
      const record = choice as { delta?: unknown; message?: unknown; finish_reason?: unknown };
      const message = record.delta ?? record.message;
      if (typeof message === 'object' && message !== null) {
        const fields = message as { reasoning_content?: unknown; tool_calls?: unknown };
        this.summary.responseReasoning ||= typeof fields.reasoning_content === 'string' && fields.reasoning_content.length > 0;
        this.summary.responseToolCalls ||= Array.isArray(fields.tool_calls) && fields.tool_calls.length > 0;
      }
      const rawReason = record.finish_reason;
      const reason = ['stop', 'tool_calls', 'length', 'content_filter', 'function_call'].includes(String(rawReason))
        ? String(rawReason)
        : 'other';
      if (rawReason && !this.summary.finishReasons.includes(reason)) this.summary.finishReasons.push(reason);
    }
  }
  private event(event: string) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data === '[DONE]') {
      this.summary.done = true;
      return;
    }
    try { this.response(JSON.parse(data)); }
    catch { /* Drop malformed or non-JSON event content. */ }
  }
  chunk(bytes: Uint8Array) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    // Only extract field-presence booleans and allow-listed finish enums; drop raw events immediately.
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const event = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.event(event);
    }
    if (this.pending.length > 65536) {
      this.pending = '';
      this.summary.truncated = true;
    }
  }
  finish() {
    this.pending += this.decoder.decode();
    const trailing = this.pending.trim();
    if (trailing.startsWith('{')) {
      try { this.response(JSON.parse(trailing)); }
      catch { /* Incomplete JSON responses remain unobserved. */ }
    } else if (trailing.startsWith('data:')) this.event(trailing);
    this.pending = '';
  }
}
