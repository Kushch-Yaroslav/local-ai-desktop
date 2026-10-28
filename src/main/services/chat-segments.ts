import type { FinishReason } from '../../shared/types';
/** Backend completion accounting includes reasoning/tool protocol; text tokenization is reported separately. */
export interface ChatSegmentRecord {
  modelId: string;
  generationId: string;
  conversationId: string;
  segment: number;
  contextWindow: number;
  promptTokens?: number;
  visibleTextTokens?: number;
  reasoningTextTokens?: number;
  generatedTokens?: number;
  requestedMaxTokens: number;
  effectiveMaxTokens?: number;
  contextHeadroom?: number;
  finishReason?: FinishReason;
  backendFinishReason?: string;
  aggregateGeneratedTokens: number;
  aggregateBudget: number;
  autoContinuation: boolean;
  decision: 'tool_calls' | 'natural_eos' | 'continue_length' | 'aggregate_budget' | 'no_progress' | 'continuation_budget' | 'tool_budget' | 'user_stop' | 'error';
  error?: string;
}
