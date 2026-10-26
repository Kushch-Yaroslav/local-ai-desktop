import type { AppSettings, Conversation, ModelInfo } from './types';
import { defaultLlamaKv, normalContextForModel } from './context-options';

/** Saved conversation identity is history, not a process/session selection. */
export function activeConversationModel(chat: Pick<Conversation, 'modelId'> | undefined, runtime: AppSettings['llamaRuntime']): string | null {
  return runtime?.status === 'ready' && runtime.modelId === chat?.modelId ? runtime.modelId : null;
}

/** Runtime readiness for sending is a tuple match, not a model-name match. */
export function conversationRuntimeReady(chat:Conversation|undefined,runtime:AppSettings['llamaRuntime'],profile?:ModelInfo):boolean{
  if(!chat||runtime?.status!=='ready'||runtime.modelId!==chat.modelId||runtime.contextWindow!==chat.contextWindow||runtime.kvCacheType!==(chat.llamaKvCacheType??'f16')||runtime.kvOffload!==(chat.llamaKvOffload??true))return false;
  if(profile?.runtimeFingerprint&&runtime.profileFingerprint!==profile.runtimeFingerprint)return false;
  const desiredMtp=chat.mtpMode??profile?.preferredMtpMode??(profile?(profile.speculative?'auto':'off'):undefined);
  if(desiredMtp&&runtime.mtpMode!==desiredMtp)return false;
  if(chat.visionMode==='on'&&profile?.mmprojPath&&!runtime.launchArguments?.includes('--mmproj'))return false;
  return true;
}

/** A fresh explicit selection starts in normal mode, never a historical Max configuration.
 * Max is manual and may only be restored/validated against a running configuration.
 */
export function initialModelContext(presets: readonly number[], normal?: ModelInfo['normalContext']) {
  return { contextWindow: normalContextForModel(normal?.initialContextWindow ?? 32_768, presets), ...defaultLlamaKv, llamaKvCacheType: normal?.kvCacheType ?? defaultLlamaKv.llamaKvCacheType };
}
