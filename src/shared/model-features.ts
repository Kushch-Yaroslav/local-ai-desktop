import type { BrowserVisionMode } from './browser-qa';
import type { ChatMessage, Conversation, MtpMode, RuntimeConfiguration, RuntimeModelConfiguration } from './types';
export type FeatureState = 'supported' | 'unsupported' | 'unknown' | 'misconfigured' | 'backend-unavailable' | 'initialization-failed';
export type VisionCapability = { state: FeatureState; source?: 'projector' | 'embedded'; reason: string; detected: boolean; backendVerified: boolean; active: boolean };
export function visionPreference(chat: Pick<Conversation,'visionMode'> | undefined, config: Pick<RuntimeConfiguration,'browserVision'>): BrowserVisionMode { return chat?.visionMode ?? config.browserVision ?? 'off'; }
export function mtpPreference(chat: Pick<Conversation,'mtpMode'> | undefined, profile: RuntimeModelConfiguration): MtpMode { return chat?.mtpMode ?? profile.mtpMode ?? (profile.speculative === 'none' ? 'off' : 'auto'); }
export function permitsImages(mode: BrowserVisionMode, capability: Pick<VisionCapability,'active'>, needed: boolean): boolean { return mode !== 'off' && capability.active && needed; }

/** Image bytes are added only by the authorized attachment pipeline. Keep attachment identities/history intact. */
export function withoutImagePayloads(history: ChatMessage[]): ChatMessage[] { return history.map(message=>({...message,images:undefined})); }

export type VisionQuestion = { goal: string; temporal: boolean; purpose?: 'requested' | 'scoped' | 'passive' };
