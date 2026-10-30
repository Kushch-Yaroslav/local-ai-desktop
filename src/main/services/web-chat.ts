import { modelLanguageGuidance } from '../../shared/model-language';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, StreamEvent } from '../../shared/types';
import { reasoningModeOf, type ReasoningInput } from '../../shared/reasoning-controls';
import type { LlmBackend, ToolCall, ToolCallingBackend, ToolMessage } from '../backends/types';
import { capabilitySystemContext, chatCompletionGuidance, chatMessagesWithSystemPrefix } from './capabilities';
import { WebBrowserService, activityForWebTool, webToolDefinitions, type WebBrowserSession } from '../web/web-tools';
import { ArtifactToolError, artifactFailure, artifactAcknowledgment, validateRichArtifact, visualArtifactTool, withAttachmentProvenance, richArtifactFingerprint, type RichArtifact, type ArtifactSource } from '../../shared/rich-artifacts';
import { attachmentDataTool } from './attachment-service';
import { log } from './logger';
import type { ChatSegmentRecord } from './chat-segments';
import { fitChatContext } from './chat-context';
import { chatProjectToolNames, chatReadonlyNames, type ChatReadonlyScope } from './chat-readonly-tools';
import {CHAT_OUTPUT_TOKEN_LIMIT,CHAT_CONTINUATION_REQUEST_LIMIT,ChatContinuationBoundary,chatContinuationInstruction} from './chat-continuation';
import { QwenContentBuffer } from './qwen-content-buffer';

const maxModelTurns = 12;
const maxToolActions = 16;
const supportedToolNames = new Set(['web_search', 'web_image_search', 'web_open', 'web_read', 'web_follow_link', 'web_back', 'create_visual_artifact', 'read_attachment_data', ...chatReadonlyNames, ...chatProjectToolNames]);
const isChatReadOnlyTool = (name:string) => chatReadonlyNames.has(name) || chatProjectToolNames.has(name);

type RoutedCall = { id: string; name: string; arguments: Record<string, unknown>; parseError?: string };
type ParsedToolText = { calls: RoutedCall[]; visibleContent: string };

function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try { const parsed: unknown = JSON.parse(raw); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
  catch { return null; }
}

/** Parse only known Qwen/tool protocol forms. Code spans remain literal prose. */
export function parseQwenToolText(content: string): ParsedToolText {
  const calls: RoutedCall[] = [];
  const protectedParts: Array<{ marker: string; literal: string }> = [];
  const protectedContent = content.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[^`]*?(?:\2|$)/g, (literal) => { const marker = `__RICH_CODE_${randomUUID()}__`; protectedParts.push({ marker, literal }); return marker; });
  let visibleContent = protectedContent;
  const qwenPattern = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/gi;
  visibleContent = visibleContent.replace(qwenPattern, (whole, body: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch {
      if (/^\s*<function=/i.test(body)) { const nested = parseQwenToolText(body); if (nested.calls.length) { calls.push(...nested.calls); return nested.visibleContent; } }
      const name = body.match(/["']name["']\s*:\s*["']([a-z_]+)["']/i)?.[1];
      if (name && supportedToolNames.has(name)) calls.push({ id: randomUUID(), name, arguments: {}, parseError: 'The JSON inside <tool_call> is malformed. Send a valid JSON object with name and arguments.' });
      return name && supportedToolNames.has(name) ? '' : whole;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return whole;
    const record = parsed as Record<string, unknown>; const name = record.name;
    if (typeof name !== 'string' || !supportedToolNames.has(name)) return whole;
    const args = parseArguments(record.arguments);
    if (!args) calls.push({ id: randomUUID(), name, arguments: {}, parseError: 'Tool arguments must be a JSON object. Expected {"name":"…","arguments":{…}}.' });
    else calls.push({ id: randomUUID(), name, arguments: args });
    return '';
  });
  const functionPattern = /<function=([a-z_]+)>([\s\S]*?)<\/function>/gi;
  visibleContent = visibleContent.replace(functionPattern, (whole, name: string, body: string) => {
    if (!supportedToolNames.has(name)) return whole;
    const args: Record<string, unknown> = {};
    for (const parameter of body.matchAll(/<parameter=([a-z_]+)>\s*([\s\S]*?)\s*<\/parameter>/gi)) {
      const raw = parameter[2].trim();
      try { args[parameter[1]] = JSON.parse(raw); } catch { args[parameter[1]] = raw; }
    }
    calls.push({ id: randomUUID(), name, arguments: args });
    return '';
  });
  for (const part of protectedParts) visibleContent = visibleContent.replace(part.marker, part.literal);
  return { calls, visibleContent: visibleContent.replace(/[ \t]{2,}/g, ' ').trim() };
}

const chatToolInstruction = `Answer the user directly. Tools remain available after every tool result until you answer or the host reports its execution limit. Use native function calls, not tool JSON in prose. Do not output routing sentinels or plan a separate final pass.
For requested interactive charts, dashboards or artifact diagrams, call create_visual_artifact; Markdown tables, ASCII charts and Mermaid code blocks do not create persisted interactive artifacts. Ordinary answers may still use Markdown tables and Mermaid when an artifact was not requested. Do not repeat a successfully created diagram as a Markdown code block or add a generic fallback diagram.
When read-only project tools are present, use them to inspect the selected project with relative paths and bounded file offsets; never assume a project root or mention a tool absent from the current schema. For a selected visual region, call inspect_region at most once and research the relevant sources before answering. Follow an exact source hint when available. With empty hints/anchors or no pixels, use the page URL as a file lookup candidate (project-preview.invalid/index.html#route means relative index.html, not absolute /index.html) and investigate its rendering code with available project read/search tools. This read access is already authorized: perform the tool calls in this turn instead of asking permission or ending with an offer/promise to investigate. Choose only the lookups needed, stop once evidence suffices or bounded lookup fails, and avoid repeated unchanged reads. Use read_browser only for an already-open approved page. Chat cannot edit project files, run commands, or navigate/interact with the Browser Workspace. State whether a visual claim comes from source, DOM, actual image input, or inference; source code alone cannot prove the exact selected pixels.
Use web tools when live research is needed and enabled. For real photographs use web_image_search then image_gallery with returned discovery_id values. Never invent URLs or source references. A successful tool result is evidence only for what it actually contains.
For analysis use one coherent dataset across metrics, charts and tables. Numeric JSON values must be numbers; unknown values are null. Clearly label fictional demo data, estimates and unverified values. User-authorized fictional demo data is allowed; do not present it as factual research. Correct invalid artifact arguments using the returned field diagnostics. Do not repeat rejected arguments unchanged.`;

/** One bounded conversation owns inference, native calls, results, and the final answer. */
export class WebChatService {
  constructor(private readonly backend: ToolCallingBackend & LlmBackend, private readonly web: WebBrowserService, private readonly validateDiagram?: (source: string, signal: AbortSignal) => Promise<void>) {}

  async *stream(model: string, history: ChatMessage[], signal: AbortSignal, contextWindow: number, reasoningMode: ReasoningInput, webEnabled = true, readAttachmentData?: (argumentsObject: Record<string, unknown>) => Promise<unknown>, validateDiagram = this.validateDiagram, generationId?: string, readonlyScope?: ChatReadonlyScope, onSegment?: (record: ChatSegmentRecord) => void): AsyncIterable<StreamEvent> {
    if (signal.aborted) return;
    const runId = generationId ?? randomUUID(); const started = performance.now();
    const trace = (stage: string, fields: Record<string, unknown> = {}) => { try { log('rich.chat.lifecycle', { runId, conversationId: history[0]?.conversationId, stage, elapsedMs: Math.round(performance.now() - started), ...fields }); } catch { /* diagnostics cannot fail inference */ } };
    trace('submitted');
    let segmentIndex=0;
    const recordSegment=(record:ChatSegmentRecord)=>{trace('inference_segment',record as unknown as Record<string,unknown>);try{onSegment?.(record);}catch{/* telemetry never fails inference */}};
    let answerText='',outputTokens=0,evalNanos=0,continuations=0,continuing=false;
    let session: WebBrowserSession | undefined; let sessionPromise: Promise<WebBrowserSession> | undefined;
    const ensureSession = () => sessionPromise ??= this.web.openSession().then((opened) => {
      if (signal.aborted) { void opened.close(); throw new Error('Web request cancelled'); }
      session = opened; return opened;
    });
    const closeOnAbort = () => { void session?.close(); };
    signal.addEventListener('abort', closeOnAbort, { once: true });
    let messages: ToolMessage[] = chatMessagesWithSystemPrefix(readonlyScope?.restoreHistory?.(history) ?? history, [
      capabilitySystemContext({ webAvailable: webEnabled }),
      chatCompletionGuidance(reasoningModeOf(reasoningMode) === 'deep' ? 'deep' : 'fast'),
      modelLanguageGuidance, chatToolInstruction, ...(readonlyScope ? [readonlyScope.context()] : []),
    ], history[0]?.conversationId ?? 'rich-chat', runId).map(({ role, content, images }) => ({ role, content, ...(images?.length ? { images } : {}) }));
    const baseSystemPrefix = messages[0]?.content ?? '';
    const attachmentTool = attachmentDataTool(history.flatMap((message) => message.attachments ?? []));
    const usedAttachmentSources = new Map<string, ArtifactSource>();
    const failures = new Map<string, number>(); const accepted = new Map<string, RichArtifact>(); const diagrams = new Set<string>();
    const callIds = new Set<string>();
    const readonlyRepeats = new Map<string,number>();
    const tools = [...(webEnabled ? webToolDefinitions : []), visualArtifactTool, ...(attachmentTool ? [attachmentTool] : []), ...(readonlyScope?.definitions ?? [])];
    const modelTurnLimit = readonlyScope ? 80 : maxModelTurns, toolActionLimit = readonlyScope ? 96 : maxToolActions;
    let toolActions = 0; let visibleStarted = false;
    const waiting = (turn: number): StreamEvent => ({ type: 'tool', activity: { id: `${runId}:model:${turn}`, label: 'Ожидаю ответ модели', kind: 'progress', state: 'running' } });
    try {
      const savedReading=await readonlyScope?.completedReading?.(history,signal)??[];
      for(const result of savedReading) {
        const id=`${runId}:saved-document:${messages.length}`;
        const attachmentId=(result as {attachment_id:string}).attachment_id;
        messages.push({role:'assistant',content:'',tool_calls:[{id,function:{name:'read_document',arguments:JSON.stringify({attachment_id:attachmentId})}}]},
          {role:'tool',tool_name:'read_document',tool_call_id:id,content:JSON.stringify(result)});
      }
      if(savedReading.length)trace('saved_document_evidence',{documents:savedReading.length});

      for (let turn = 0; !signal.aborted && turn <= modelTurnLimit; turn += 1) {
        const readingFailure=readonlyScope?.readingFailure?.();
        if(readingFailure) {
          // A failed whole-document pass must not turn into an unsupported plot summary.
          yield {type:'token',content:readingFailure};
          trace('reading_incomplete');
          yield {type:'done',finishReason:'stop'};
          return;
        }
        const exhausted = turn === modelTurnLimit || toolActions >= toolActionLimit;
        if (exhausted) messages[0].content += '\nThe host tool execution budget is exhausted. Answer from the recorded results; accurately disclose any missing visualization or information. Do not print tool protocol or invent successful artifacts.';
        const availableTools = exhausted ? undefined : tools;
        const fitted = await fitChatContext(this.backend, model, messages, availableTools, signal, contextWindow, reasoningMode, history.filter(m=>m.role==='user').at(-1)?.content??'', readonlyScope?.context(),baseSystemPrefix);
        if (fitted.compacted) {
          messages = fitted.messages;
          readonlyScope?.saveContextCheckpoint?.(history,`${fitted.summary}\nRetained historical conversation/tool data: ${JSON.stringify(messages.slice(1))}`);
          trace('context_compacted',{inputTokens:fitted.inputTokens,contextWindow});
          yield {type:'tool',activity:{id:`${runId}:context:${turn}:${continuations}`,label:'Сжатие контекста',kind:'context',state:'completed',detail:'Источники и прогресс чтения сохранены'}};
        }
        trace('model_started', { turn, toolCount: availableTools?.length ?? 0, toolNames: availableTools?.map(tool=>(tool as {function:{name:string}}).function.name) ?? [], toolActions });
        yield { type: 'model-state', state: 'waiting' };
        yield waiting(turn);
        const reviewing=Boolean(readonlyScope?.readingReviewReady?.()&&readonlyScope.reviewReadingAnswer);
        let response: ToolMessage | undefined; let rawContent = ''; let reasoningSeen = false;
        let outputStarted = false;let segmentVisible='';
        const boundary=new ChatContinuationBoundary(continuing?answerText:'');
        const buffer = new QwenContentBuffer(parseQwenToolText, diagrams);
        const stream = this.backend.streamWithTools
          ? this.backend.streamWithTools(model, messages, availableTools, signal, contextWindow, reasoningMode, { conversationId: history[0]?.conversationId, generationId: runId, agentStep: turn,maxOutputTokens:Math.min(32768,CHAT_OUTPUT_TOKEN_LIMIT-outputTokens), phase: turn === 0 ? 'initial' : exhausted ? 'final' : 'post_tool' })
          : (async function* (backend: ToolCallingBackend) { yield { type: 'response' as const, response: await backend.chatWithTools(model, messages, availableTools, signal, contextWindow, reasoningMode,{maxOutputTokens:Math.min(32768,CHAT_OUTPUT_TOKEN_LIMIT-outputTokens)}) }; })(this.backend);
        for await (const delta of stream) {
          if (signal.aborted) return;
          if (!outputStarted && (delta.type === 'token' || delta.type === 'thinking' || delta.type === 'tool_call_delta')) { outputStarted = true; yield { type: 'model-state', state: 'streaming' }; }
          if (delta.type === 'response') { response = delta.response; continue; }
          if (delta.type === 'thinking') {
            if (!reasoningSeen) { reasoningSeen = true; trace('first_reasoning', { turn }); }
            yield { type: 'thinking', content: delta.content };
          } else if (delta.type === 'token') {
            if (!rawContent) trace('first_token', { turn }); rawContent += delta.content;
            const content = boundary.push(buffer.push(delta.content));
            if (content) { if (!visibleStarted&&!reviewing) { trace('first_visible_content', { turn }); visibleStarted = true; } segmentVisible+=content;answerText+=content;if(!reviewing)yield { type: 'token', content }; }
          } else if (delta.type === 'tool_call_delta' && delta.name) trace('tool_detected', { turn, tool: delta.name });
        }
        if (signal.aborted) return;
        if (!response) throw new Error('The model stream ended without a completed response.');
        if (!rawContent) {
          if (response.thinking && !reasoningSeen) { trace('first_reasoning', { turn }); yield { type: 'thinking', content: response.thinking }; }
          const content = boundary.push(buffer.push(response.content ?? ''));
          if (content) { if (!visibleStarted&&!reviewing) { trace('first_visible_content', { turn }); visibleStarted = true; } segmentVisible+=content;answerText+=content;if(!reviewing)yield { type: 'token', content }; }
        }
        const tail=boundary.push(buffer.finish())+boundary.finish();if(tail){segmentVisible+=tail;answerText+=tail;if(!reviewing)yield {type:'token',content:tail};}
        outputTokens+=Math.max(1,response.inference?.evalCount??Math.ceil(((response.content??'').length+(response.thinking??'').length)/2));evalNanos+=response.inference?.evalDuration??0;
        yield { type: 'tool', activity: { id: `${runId}:model:${turn}`, label: 'Ожидаю ответ модели', kind: 'progress', state: 'completed' } };
        trace('model_completed', { turn, inputTokens: response.inference?.inputTokens, outputTokens: response.inference?.evalCount });
        const inline = parseQwenToolText(response.content ?? '');
        const native: RoutedCall[] = (response.tool_calls ?? []).flatMap((call: ToolCall) => {
          const args = parseArguments(call.function.arguments);
          return call.function.name ? [{ id: call.id ?? randomUUID(), name: call.function.name, arguments: args ?? {}, ...(args ? {} : { parseError: 'Tool arguments must be a valid JSON object.' }) }] : [];
        });
        const calls = [...native];
        for (const call of inline.calls) if (!calls.some((existing) => existing.name === call.name && canonicalArguments(existing.arguments) === canonicalArguments(call.arguments))) calls.push(call);
        for (const call of calls) trace('tool_detected', { turn, tool: call.name, callId: call.id });
        for (const call of calls) { if (callIds.has(call.id)) call.id = randomUUID(); callIds.add(call.id); }
        const shouldContinue = !calls.length&&!exhausted&&response.finish_reason==='length'&&outputTokens<CHAT_OUTPUT_TOKEN_LIMIT&&Boolean(segmentVisible.trim())&&continuations<CHAT_CONTINUATION_REQUEST_LIMIT;
        recordSegment({modelId:model,generationId:runId,conversationId:history[0]?.conversationId??'',segment:segmentIndex++,contextWindow,
          promptTokens:response.inference?.inputTokens,generatedTokens:response.inference?.evalCount,
          visibleTextTokens:onSegment?await this.backend.countTextTokens?.(segmentVisible,signal):undefined,reasoningTextTokens:onSegment?await this.backend.countTextTokens?.(response.thinking??'',signal):undefined,
          requestedMaxTokens:response.inference?.requestedMaxOutputTokens??Math.min(32768,CHAT_OUTPUT_TOKEN_LIMIT-outputTokens+(response.inference?.evalCount??0)),effectiveMaxTokens:response.inference?.effectiveMaxOutputTokens,
          contextHeadroom:response.inference?.inputTokens!==undefined?contextWindow-response.inference.inputTokens:undefined,finishReason:response.finish_reason,backendFinishReason:response.backend_finish_reason,
          aggregateGeneratedTokens:outputTokens,aggregateBudget:CHAT_OUTPUT_TOKEN_LIMIT,autoContinuation:shouldContinue,
          decision:exhausted?'tool_budget':calls.length?'tool_calls':outputTokens>=CHAT_OUTPUT_TOKEN_LIMIT?'aggregate_budget':shouldContinue?'continue_length':response.finish_reason!=='length'?'natural_eos':!segmentVisible.trim()?'no_progress':'continuation_budget'});
        if(shouldContinue){
          messages.push({role:'assistant',content:segmentVisible},{role:'user',content:chatContinuationInstruction});
          yield {type:'tool',activity:{id:`${runId}:continuation:${continuations}`,label:'Продолжение ответа',kind:'progress',state:'running'}};
          continuing=true;continuations++;turn--;trace('automatic_continuation',{outputTokens,continuations,remaining:CHAT_OUTPUT_TOKEN_LIMIT-outputTokens});continue;
        }
        if (!calls.length || exhausted) {
          if(reviewing&&answerText.trim()) {
            yield {type:'tool',activity:{id:`${runId}:reading-review`,kind:'file_read',label:'Проверка пересказа по источнику',state:'running'}};
            const checked=await readonlyScope!.reviewReadingAnswer!(answerText,signal);
            if(!visibleStarted){trace('first_visible_content',{turn,reviewed:true});visibleStarted=true;}
            yield {type:'token',content:checked};
            yield {type:'tool',activity:{id:`${runId}:reading-review`,kind:'file_read',label:'Проверка пересказа по источнику',state:'completed'}};
          }
          if (response.inference) yield { type: 'diagnostics', diagnostics: { ...response.inference,...(continuations?{evalCount:outputTokens,...(evalNanos?{evalDuration:evalNanos,tokensPerSecond:outputTokens/(evalNanos/1e9)}:{})}:{}), agentStepCount: toolActions, finishReason: response.finish_reason ?? 'stop' } };
          trace('final_completed', { turn, toolActions, exhausted });
          yield { type: 'done', finishReason: exhausted||outputTokens>=CHAT_OUTPUT_TOKEN_LIMIT ? 'length' : response.finish_reason ?? 'stop' }; return;
        }
        continuing=false;
        if(outputTokens>=CHAT_OUTPUT_TOKEN_LIMIT){yield {type:'done',finishReason:'length'};return;}
        messages.push({ role: 'assistant', content: inline.visibleContent, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
        for (const call of calls) {
          if (signal.aborted) return;
          const signature = `${call.name}:${canonicalArguments(call.arguments)}`;
          const activity = { id: call.id, toolName: call.name, ...(call.name === 'create_visual_artifact' ? { metadata: { artifactType: String((call.arguments.artifact as { type?: string })?.type ?? '') } } : {}), label: isChatReadOnlyTool(call.name) ? (call.name === 'read_document' || call.name === 'read_file' || call.name === 'read_project_file' ? 'Чтение файла' : call.name.startsWith('search_project_') ? 'Поиск в проекте' : call.name === 'list_project_files' ? 'Структура проекта' : call.name === 'inspect_region' || call.name === 'read_browser' ? 'Исследование области' : call.name === 'save_chat_note' ? 'Сохранение заметок' : 'Источники разговора') : call.name === 'create_visual_artifact' ? ((call.arguments.artifact as { type?: string })?.type === 'chart' ? 'Создаю график' : (call.arguments.artifact as { type?: string })?.type === 'diagram' ? 'Отрисовка диаграммы…' : 'Создаю визуализацию') : call.name === 'read_attachment_data' ? 'Подготавливаю данные' : activityForWebTool(call).label, kind: isChatReadOnlyTool(call.name) ? 'file_read' as const : call.name === 'create_visual_artifact' || call.name === 'read_attachment_data' ? 'other' as const : 'web' as const };
          let result: unknown; let failed = false; const toolStarted = performance.now();
          trace('tool_started', { turn, tool: call.name, callId: call.id });
          yield { type: 'tool', activity: { ...activity, state: 'running' } };
          try {
            if (toolActions >= toolActionLimit) throw new Error('The host tool execution budget is exhausted.');
            toolActions += 1;
            if (!isChatReadOnlyTool(call.name) && (failures.get(signature) ?? 0) >= ((call.arguments.artifact as { type?: string })?.type === 'image_gallery' ? 1 : 2)) throw new ArtifactToolError({ error: (call.arguments.artifact as { type?: string })?.type === 'image_gallery' ? 'This gallery request already failed. Correct the reported fields or image ID; repeating unchanged arguments is not useful.' : 'These identical arguments already failed twice. Change the invalid fields using the previous error; other valid tool calls remain available.', code: 'ARTIFACT_DUPLICATE', retrySameArguments: false });
            if (call.parseError) throw new Error(call.parseError);
            if (isChatReadOnlyTool(call.name)) {
              if (!readonlyScope || !readonlyScope.definitions.some(definition => (definition as {function?:{name?:string}}).function?.name === call.name)) throw new Error('Read-only capability unavailable.');
              const progressSignature=call.name==='read_document'?`${signature}:${readonlyScope.context()}`:signature;
              const repeats=(readonlyRepeats.get(progressSignature)??0)+1;readonlyRepeats.set(progressSignature,repeats);
              if(repeats>=4){if(repeats>=5)toolActions=toolActionLimit;throw new Error('Repeated identical read without new progress. Use the saved result, advance the offset, or answer. Memory IDs are not observation IDs.');}
              const execution = readonlyScope.execute(call.name, call.arguments, signal);
              while (true) {
                const item = await execution.next();
                if (item.done) { result = item.value; failed=Boolean(result && typeof result==='object' && (result as {error?:unknown}).error); break; }
                yield item.value;
              }
            } else if (call.name === 'create_visual_artifact') {
              const labels = new Set(history.flatMap((message) => message.attachments ?? []).map((attachment) => attachment.filename));
              const validated = validateRichArtifact(call.arguments.artifact, session?.getImageResults(), undefined, session?.getKnownSources() ?? new Set(), labels);
              if (!validated.artifact) throw new ArtifactToolError(artifactFailure(validated));
              const artifact = withAttachmentProvenance(validated.artifact, [...usedAttachmentSources.values()]);
              const fingerprint = richArtifactFingerprint(artifact); const previous = accepted.get(fingerprint);
              if (!previous) {
                if (artifact.type === 'image_gallery') await session?.verifyGalleryImages?.(artifact, signal);
                if (artifact.type === 'diagram' && validateDiagram) await validateDiagram(artifact.mermaid, signal);
                accepted.set(fingerprint, artifact);
                if (artifact.type === 'diagram') diagrams.add(artifact.mermaid.trim());
                trace('artifact_accepted', { type: artifact.type, artifactId: artifact.id }); yield { type: 'rich-artifact', artifact };
              }
              result = artifactAcknowledgment(previous ?? artifact, Boolean(previous));
            } else if (call.name === 'read_attachment_data') {
              if (!attachmentTool || !readAttachmentData) throw new Error('Attachment data is unavailable in this conversation.');
              const attachment = history.flatMap((message) => message.attachments ?? []).find((item) => item.id === call.arguments.attachment_id);
              if (!attachment) throw new Error('attachment_id must identify an attachment in this conversation.');
              result = await readAttachmentData(call.arguments);
              const sheet = result && typeof result === 'object' && typeof (result as { sheet?: unknown }).sheet === 'string' ? ` · ${(result as { sheet: string }).sheet}` : '';
              usedAttachmentSources.set(attachment.id, { label: attachment.filename, ...(sheet ? { detail: sheet } : {}) });
            } else {
              if (!webEnabled || !webToolDefinitions.some((definition) => definition.function.name === call.name)) throw new Error('Tool unavailable in this conversation.');
              result = JSON.parse(await (await ensureSession()).execute(call));
              if (result && typeof result === 'object') { const value = result as { error?: unknown; blocked_reason?: unknown; status?: string }; failed = Boolean(value.error || value.blocked_reason || call.name === 'web_image_search' && value.status !== 'ok'); }
            }
          } catch (error) { failed = true; result = error instanceof ArtifactToolError ? error.result : { error: error instanceof Error ? error.message : String(error) }; }
          if (signal.aborted) return;
          if (failed) failures.set(signature, (failures.get(signature) ?? 0) + 1); else failures.delete(signature);
          messages.push({ role: 'tool', tool_name: call.name, tool_call_id: call.id, content: JSON.stringify(result) });
          trace('tool_completed', { turn, tool: call.name, callId: call.id, failed, ...(failed && result && typeof result === 'object' ? { code: (result as { code?: string }).code } : {}), durationMs: Math.round(performance.now() - toolStarted) });
          yield { type: 'tool', activity: { ...activity, state: failed ? 'error' : 'completed', ...(failed&&isChatReadOnlyTool(call.name)?{metadata:{chatSource:true},detail:String((result as {error?:unknown})?.error??'Source processing failed.')}:{}) } };
        }
      }
    } catch (error) {
      if(!signal.aborted)recordSegment({modelId:model,generationId:runId,conversationId:history[0]?.conversationId??'',segment:segmentIndex++,contextWindow,requestedMaxTokens:0,aggregateGeneratedTokens:outputTokens,aggregateBudget:CHAT_OUTPUT_TOKEN_LIMIT,autoContinuation:false,decision:'error',error:error instanceof Error?error.message:String(error)});
      if (!signal.aborted) { trace('failed', { error: error instanceof Error ? error.message : String(error) }); yield { type: 'error', message: 'Не удалось выполнить запрос', details: error instanceof Error ? error.message : String(error) }; }
    } finally { if(signal.aborted)recordSegment({modelId:model,generationId:runId,conversationId:history[0]?.conversationId??'',segment:segmentIndex++,contextWindow,requestedMaxTokens:0,aggregateGeneratedTokens:outputTokens,aggregateBudget:CHAT_OUTPUT_TOKEN_LIMIT,autoContinuation:false,decision:'user_stop'}); signal.removeEventListener('abort', closeOnAbort); if (session) await session.close(); trace(signal.aborted ? 'cancelled' : 'closed'); }
  }
}

/** Property order must not turn identical calls into a retry bypass. */
export function canonicalArguments(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
