import type { AgentPermissions, AutonomyMode, LoopAction, LoopNotice, LoopLifecycle, SessionGrant } from './autonomy';
import type { ContextDiscoveryResult, RuntimeContextEstimate } from './context-estimator';

export type ChatMode = 'chat' | 'agent';
export type WebMode = 'off' | 'auto';
export type MtpMode = 'auto' | 'on' | 'off';
export type MtpCapability = { supported: boolean; status: 'available' | 'unsupported' | 'requires-weights' | 'error'; reason: string; architecture?: string; heads?: number; backendSupported?: boolean };
export type MtpDiagnostics = { drafted: number; accepted: number; acceptanceRate?: number; source: 'llama-server metrics'; scope: 'server lifetime' };
export type MtpStatus = { modelId: string; requested: MtpMode; activeMode?: MtpMode; effective: 'unloaded' | 'available' | 'active' | 'disabled' | 'unsupported' | 'requires-weights' | 'reload-required' | 'error'; capability: MtpCapability; diagnostics?: MtpDiagnostics; error?: string };
export type BackendId = 'llama-cpp';
export type LlamaKvCacheType = 'f16' | 'q8_0';
/** A backend-native reasoning control. It never changes the output token budget. */
export type ReasoningMode = 'auto' | 'fast' | 'deep';
export type FinishReason = 'stop' | 'length' | 'cancelled' | 'error';
export type RiskCategory = 'git_commit' | 'git_push' | 'destructive_git' | 'package_install' | 'package_remove' | 'file_delete' | 'file_download' | 'chmod_chown' | 'shell_redirection' | 'shell_chaining' | 'system_command';
export type ApprovalDecision = 'reject' | 'once' | 'session';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'session-approved';
export type AttachmentKind = 'image' | 'text' | 'document' | 'spreadsheet' | 'pdf';
export type AttachmentStatus = 'pending' | 'processing' | 'ready' | 'error' | 'cancelled' | 'ocr_required';

export interface Attachment {
  id: string;
  messageId: string;
  index: number;
  kind: AttachmentKind;
  mimeType: string;
  filename: string;
  size: number;
  storageRef: string;
  status: AttachmentStatus;
  extractedText?: string;
  structuredData?: string;
  visionAnalysis?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentInput {
  id?: string;
  messageId: string;
  index: number;
  filename: string;
  mimeType: string;
  /** Bytes are copied to application-managed storage in Electron main, never executed. */
  data: Uint8Array;
}
export interface RemoteImageData { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataUrl: string }

export interface ActionApproval {
  approvalId: string;
  category: RiskCategory;
  status: ApprovalStatus;
  title?: string;
  detail?: string;
  root?: string;
}

export interface GenerationDiagnostics {
  generationId: string;
  conversationId: string;
  reasoningMode: ReasoningMode;
  requestedMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  contextLimit: number;
  inputTokens: number;
  agentStepCount: number;
  finishReason: FinishReason;
  /** All duration values are whole nanoseconds. llama.cpp milliseconds are converted and rounded. evalCount contains generated completion tokens only. */
  promptEvalCount?: number;
  promptEvalDuration?: number;
  evalCount?: number;
  evalDuration?: number;
  tokensPerSecond?: number;
  promptTokensPerSecond?: number;
  timeToFirstTokenMs?: number;
  /** Agent-only runtime diagnostics; persisted logs retain the full per-attempt detail. */
  toolResultContextSize?: number;
  toolResultContextBudget?: number;
  toolResultCompacted?: number;
  createdAt: string;
}

/** Message-owned subset of backend-authoritative completion metrics. */
export interface GenerationStats {
  /** Completion tokens reported by the backend. Reasoning runtimes may count visible and thinking tokens together. */
  outputTokens: number;
  tokensPerSecond?: number;
  generationDurationMs?: number;
  timeToFirstTokenMs?: number;
  inputTokens?: number;
}

export interface WorkBudget {
  used: number; limit: number; maximum: number; extensions: number; decision: string; reason: string; basis?: string;
}
export interface AgentTelemetry {
  loopObservations?: number;
  loopGuidance?: number;
  loopWarnings?: number;
  loopPauses?: number;
  turn: number;
  contextUsed?: number;
  contextLimit?: number;
  inputTokens: number;
  outputTokens: number;
  tokensPerSecond?: number;
  actions: number;
  compactions?: number;
  /** Provider-reported prompt/KV cache reads, never a synthetic estimate. */
  cachedTokens?: number;
  /** Provider-reported prompt/KV cache writes. */
  cacheWriteTokens?: number;
  /** `.ai-framework` diagnostics; content remains on disk and is not exposed here. */
  knowledgeCacheFiles?: number;
  knowledgeCacheBytes?: number;
  knowledgeCacheHits?: number;
  knowledgeCacheStale?: number;
  knowledgeCacheInjectedBytes?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface ModelInfo {
  inspection?: import('./model-profiles').ModelInspection;
  profileDefaults?: import('./model-profiles').ModelProfileDefaults;
  supportedKvCacheTypes?: LlamaKvCacheType[];
  /** Validated normal startup configuration, independent of measured/manual Max options. */
  normalContext?: { initialContextWindow: number; kvCacheType: LlamaKvCacheType };
  /** A configured, supported mechanism, not a claim that an offline runtime is active. */
  speculative?: { mechanism: 'mtp' | 'eagle3'; draftSource: 'embedded' | 'external' };
  id: string;
  name: string;
  size?: number;
  backend: BackendId;
  installed: boolean;
  quantization: string;
  maxContext: number;
  supportedContextPresets: number[];
  supportsTools: boolean;
  supportsReasoning: boolean;
  /** What the user can control about the model's reasoning; absent when it has no configurable reasoning. */
  reasoning?: import('./reasoning-controls').ReasoningCapability;
  shortName: string;
}

export interface Conversation {
  id: string;
  title: string;
  modelId: string | null;
  mode: ChatMode;
  workingDirectory: string | null;
  /** Stable identity for the primary project. workingDirectory remains for old chats. */
  primaryProjectId: string | null;
  /** Optional second project. Its identity is independent of its slot. */
  secondaryWorkingDirectory: string | null;
  secondaryProjectId: string | null;
  contextWindow: number;
  llamaKvCacheType?: LlamaKvCacheType;
  llamaKvOffload?: boolean;
  /** Agent strategy (Fast/Deep) and chat guidance. It does not decide whether the model thinks or how hard. */
  reasoningMode: ReasoningMode;
  /** Explicit thinking toggle. null = never chosen: the model's default applies (legacy conversations). */
  thinkingEnabled: boolean | null;
  /** Explicit reasoning depth. null = never chosen: derived from the strategy for legacy conversations. */
  reasoningEffort: import('./reasoning-controls').ReasoningEffort | null;
  contextTokens: number | null;
  contextModelId: string | null;
  webMode: WebMode;
  createdAt: string;
  updatedAt: string;
}

export type ProjectReferenceKind = 'file' | 'folder';

/** A message-owned resource locator. projectPath is retained so changing a slot never retargets history. */
export interface ProjectReference {
  id: string;
  projectId: string;
  projectSlot: 1 | 2;
  projectPath: string;
  projectLabel: string;
  relativePath: string;
  kind: ProjectReferenceKind;
}

export type ProjectSuggestion = ProjectReference;

export interface ChatMessage {
  logicalTaskId?: string;
  /** Previous generation retained for immutable task history, excluded from provider context. */
  archivedAttempt?: boolean;
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  attachments?: Attachment[];
  projectReferences?: ProjectReference[];
  /** Native model reasoning, when the backend exposes it. It is never inferred from tool activity. */
  thinking?: string;
  /** Ordered reasoning/activity references for Agent turns. Older messages omit this. */
  thinkingTimeline?: ThinkingTimelineEvent[];
  taskPlan?: AgentPlan;
  /** Optional for conversations written before per-message generation statistics existed. */
  generationStats?: GenerationStats;
  /** Validated, versioned data-only visual elements generated for this answer. */
  richArtifacts?: import('./rich-artifacts').RichArtifact[];
  /** V2 Agent terminal state kept in the flat activity timeline. It is never
   * sent back to a model or persisted as a normal assistant completion. */
  agentError?: string;
  agentCancelled?: boolean;
  agentFinishedAt?: string;
  /** Ephemeral base64 image inputs, rebuilt from managed attachment storage and never persisted in SQLite. */
  images?: string[];
}

export interface HardwareStats {
  ramUsedBytes: number;
  ramTotalBytes: number;
  vramUsedBytes: number | null;
  vramTotalBytes: number | null;
  vramAvailableBytes: number | null;
  gpuUtilization: number | null;
  available: boolean;
}

export type ExecutableValidation = { status: 'not-configured' | 'valid' | 'missing' | 'not-executable' | 'unsupported' | 'failed'; path?: string };
export type RuntimeDraftAvailability = { folderExists: boolean; models: Array<{ id: string; installed: boolean; projectorMissing: boolean; inspection?:import('./model-profiles').ModelInspection }> };
export type ExecutableResolution = { status: ExecutableValidation['status'] | 'multiple' | 'not-found' | 'incomplete' | 'cancelled'; path?: string; candidates: string[]; kind?: 'file' | 'directory'; incomplete?: boolean; selectedMissing?: boolean; reasons?: string[] };

export interface RuntimeConfiguration {
  browserVision?: import('./browser-qa').BrowserVisionMode;
  autonomousBrowserQa?: boolean;
  searchProvider?: import('./search-settings').SearchPreference;
  allowBingFallback?: boolean;
  language?: 'ru' | 'en';
  /** Explicit global menu selection overrides legacy per-model placement. */
  imageProcessingDevice?: 'cpu' | 'gpu';
  schemaVersion: 2;
  llamaServerPath: string | null;
  /** User-entered file/folder; llamaServerPath always stores the resolved executable. */
  llamaServerInput?: string;
  modelsPath: string;
  gpuLayers: number;
  setupDismissed: boolean;
  models: RuntimeModelConfiguration[];
}
export interface RuntimeModelConfiguration {
  family?: import('./model-profiles').ModelFamily;
  advanced?: import('./model-profiles').AdvancedModelParameters;
  defaults?: import('./model-profiles').ModelProfileDefaults;
  id: string;
  displayName: string;
  modelPath: string;
  mmprojPath: string;
  projectorDevice?: 'auto' | 'gpu' | 'cpu';
  gpuLayers: number | null;
  supportsTools: boolean;
  mtpMode?: MtpMode;
  speculative: 'mtp' | 'none';
  /** Null inherits the global GPU layer count; a number overrides it for this model. */
  builtin: boolean;
}
export type RuntimeActivation = { conversationId: string; modelId: string; contextWindow: number; kvCacheType: LlamaKvCacheType; kvOffload: boolean; phase: 'validating' | 'failed'; warning?: string; error?: string };
export interface AppSettings {
  setup?: { backendFeatures?:import('./model-profiles').BackendFeatureProbe; config: RuntimeConfiguration; server: string | null; ready: boolean; autoOpen: boolean; models: Array<{ id: string; name: string; modelPath: string; mmprojPath?: string; installed: boolean; status: 'ready' | 'missing-model' | 'missing-server' | 'invalid-projector'; issue?: string; builtin: boolean; inspection?:import('./model-profiles').ModelInspection }>; issues: string[]; configPath: string; dataDirectory: string };
  llamaServerPath: string | null;
  llamaRuntimeModelId?: string;
  /** Live state of the launcher-managed llama-server; the authority on what is running. */
  llamaRuntime?: { placement?:{offloadedLayers?:number;reportedLayers?:number;modelMiB:Record<string,number>;kvMiB:Record<string,number>;computeMiB:Record<string,number>;source:'owned-server-log';observedAt:string}; profileFingerprint?:string; desiredProfileFingerprint?:string; profileConfiguration?:RuntimeModelConfiguration; launchArguments?:string[]; diagnosticsHistory?:Array<{at:string;message:string}>; status: 'idle' | 'starting' | 'ready' | 'switching' | 'offline' | 'stopped'; modelId: string | null; contextWindow: number | null; kvCacheType?: LlamaKvCacheType; kvOffload?: boolean; speculativeMode?: 'mtp' | 'eagle3' | 'none'; mtpMode?: MtpMode; mtpFallbackReason?: string; projectorDevice?: 'cpu' | 'gpu'; pendingProjectorDevice?: 'cpu' | 'gpu'; deviceError?: string; activation?: RuntimeActivation; error?: string; rolledBack?: boolean };
  modelsPath: string;
}

export interface ChatRequest {
  conversationId: string;
  /** Explicit first-party continuation selector; main validates conversation ownership. */
  continueLogicalTaskId?: string;
  model: string;
  /** Renderer mode snapshot for this logical generation, including Regenerate. */
  mode?: ChatMode;
  messages: ChatMessage[];
  generationId: string;
  persistUserMessage: boolean;
  attachmentIds?: string[];
  attachments?: AttachmentInput[];
}

export interface ToolActivity {
  id: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  progress?: { bytes: number; total?: number };
  label: string;
  detail?: string;
  /** User-visible execution category. Missing means a record saved by an older app version. */
  kind?: 'progress' | 'planning' | 'notes' | 'context' | 'file_read' | 'search' | 'directory' | 'terminal' | 'mutation' | 'git' | 'web' | 'other';
  /** Lifecycle of an action. Progress events are informational and never consume the Agent action budget. */
  state?: 'running' | 'completed' | 'error';
  /** Compact, user-facing fields shown only when this activity is expanded. */
  metadata?: Record<string, string | number | boolean | null>;
  /** Bounded command output or error text, rendered lazily when details are expanded. */
  output?: string;
  /** Full raw tool result for SQLite run history. It is stripped before IPC/UI rendering. */
  rawOutput?: string;
  /** Immutable execution identity plus streamed/final terminal diagnostics.
   * Kept separately from generic tool output so a stdout delta can never erase
   * the command that produced it. */
  terminal?: TerminalExecution;
  approval?: ActionApproval;
  status?: AttachmentStatus;
  attachment?: Attachment;
  /** Ephemeral current-run plan snapshot. Database persistence deliberately strips this field. */
  plan?: AgentPlan;
  /** Monotonic event order within an Agent turn; assigned by the stream coordinator. */
  timelinePosition?: number;
}

export interface TerminalExecution {
  command?: string;
  cwd?: string;
  pid?: number;
  pgid?: number;
  sessionId?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  status?: 'running' | 'completed' | 'partial_success' | 'error' | 'cancelled' | 'timed_out';
  stdout?: string;
  stderr?: string;
}

/** `pause` is chosen by an explicit UI control; a free-text clarification never pauses the run by itself. */
export type SteeringIntent = 'pause';

export type ThinkingTimelineEvent =
  | { id: string; kind: 'loop'; position: number; lifecycle: LoopLifecycle }
  | { id: string; kind: 'reasoning'; content: string; position: number; startedAt?: string; completedAt?: string }
  | { id: string; kind: 'activity'; activityId: string; position: number }
  | { id: string; kind: 'steering'; messageId: string; position: number; status: 'accepted' | 'applied' }
  | { id: string; kind: 'paused'; position: number };

export type AgentPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';
/** Kept optional for reading messages saved by the pre-milestone renderer. */
export interface AgentPlanStep { id: string; label: string; status: AgentPlanStepStatus; }
export interface AgentWorkTask { id: string; label: string; status: AgentPlanStepStatus; revision?: number; }
export interface AgentMilestone {
  id: string;
  label: string;
  status: AgentPlanStepStatus;
  revision?: number;
  workPlan: { tasks: AgentWorkTask[]; revision?: number };
}
/** Canonical model-facing plan persisted alongside the renderer projection.
 * IDs are stable for storage but are intentionally omitted from the provider
 * prompt, which receives only concise status/content lines. */
export interface ModelTodoItem { id: string; content: string; status: AgentPlanStepStatus; memoryId?: string | null; }
export interface ModelTodoPhase { name: string; items: ModelTodoItem[]; }
export interface ModelTodo { phases: ModelTodoPhase[]; revision?: number; }
/** `done` is the legacy spelling of `implemented`; only `verified` means a runtime-recorded check passed. */
export type DeliverableStatus = 'pending' | 'implemented' | 'verified' | 'done' | 'blocked' | 'dropped';
export interface AcceptanceCriterion { id: string; description: string; kind: import('./browser-qa').QaEvidenceKind; scenario?: Omit<import('./browser-qa').QaScenario,'id'|'goal'|'deliverable_id'|'criterion_id'>; }
export interface DeliverableItem { criteria?: AcceptanceCriterion[]; id: string; text: string; status: DeliverableStatus; task?: string; evidence?: string; reason?: string; check?: 'integrity' | 'readback' | 'static' | 'build' | 'test' | 'runtime' | 'browser'; proof?: string[]; failing?: string; verification_scope?: 'project' | 'acceptance'; paths?: string[]; }
export interface PlanStepItem { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked'; note?: string; }
export interface VerificationRecord { coverage?: Array<{deliverable_id:string;criterion_id:string;kind:import('./browser-qa').QaEvidenceKind;qualified?:boolean}>; source_revisions?: Record<string,string>; run_serial?: number; unknown_epoch?: number; outcome?: 'passed'|'failed'|'inconclusive'; id: string; kind: string; class: 'readback' | 'static' | 'functional'; subject: string; pass: boolean; epoch: number; turn: number; detail?: string; check_key?: string; deliverable_ids?: string[]; baseline?: boolean; outcome_hash?: string; baseline_failure?: string; checked_paths?: string[]; }
export interface VerificationState { run_serial?: number; unknown_epoch?: number;
  epoch?: number;
  next?: number;
  records: VerificationRecord[];
  changed?: Record<string, number>;
  code_changed?: boolean;
  page_changed?: boolean;
  revisions?: Record<string, string>;
  bindings?: Record<string, string[]>;
}
export interface TaskMemoryEntry { id: string; finding: string; evidence?: string; implication?: string; next?: string; todoId?: string | null; invalidated?: boolean; }
/** Persistent agent planning state: stable milestones plus only the active
 * milestone's adaptive Work Plan in the primary UI. */
export interface AgentPlan {
  logicalTaskId?: string;
  /** Runtime-owned projection; authority remains in the canonical journal. */
  workBudget?: WorkBudget;
  milestones?: AgentMilestone[];
  activeMilestoneId?: string | null;
  revision?: number;
  modelTodo?: ModelTodo;
  taskMemory?: { browser_qa?: import('./browser-qa').BrowserQaReport; entries: TaskMemoryEntry[]; revision?: number; deliverables?: { items: DeliverableItem[]; revision?: number }; plan?: { steps: PlanStepItem[]; revision?: number }; verification?: VerificationState };
  /** Legacy persisted snapshots are normalized at the Electron boundary. */
  steps?: AgentPlanStep[];
}

export interface AnalysisRun {
  id: string;
  logicalTaskId?: string;
  generationId?: string;
  triggeringMessageId?: string;
  /** Frozen at finalization; never a reference to the task's live checkpoint. */
  taskPlan?: AgentPlan;
  archived?: boolean;
  conversationId: string;
  assistantMessageId: string | null;
  reasoningMode: ReasoningMode;
  status: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted';
  actionCount: number;
  actions: ToolActivity[];
  createdAt: string;
  completedAt: string | null;
  /** Durable timeline checkpoint (reasoning blocks, steering, pauses, activity
   * positions). Saved at stable event boundaries so a Stop, failure or restart
   * reconstructs the same history the live view showed. */
  timeline?: ThinkingTimelineEvent[];
  /** Visible output received before a run ended without a final answer. */
  partialOutput?: string;
  /** Accepted artifacts checkpointed before completion, scoped to this run. */
  richArtifacts?: import('./rich-artifacts').RichArtifact[];
  /** Failure text for a run that ended in `error`. */
  error?: string;
}

/** Display metadata only: selecting a task grants no workspace permission. */
export interface AgentTaskSummary {
  logicalTaskId: string;
  title: string;
  projects: Array<{ path: string; id?: string }>;
  updatedAt: string;
}

export interface AnalysisProgress {
  stage: 'reconnaissance' | 'project-map' | 'prioritization' | 'investigation' | 'coverage' | 'synthesis';
  status: 'active' | 'complete';
}

export type StreamEvent =
  | { type: 'reasoning-applied'; configuration: import('./conversation-settings').EffectiveModeState }
  | { type: 'pause-state'; phase: 'pause_requested' | 'saving_checkpoint' }
  | { type: 'loop-event'; lifecycle: LoopLifecycle; timelinePosition?: number }
  | { type: 'model-state'; state: 'waiting' | 'streaming' }
  | { type: 'work-budget'; budget: WorkBudget }
  | { type: 'loop-state'; notice: LoopNotice | null; paused: boolean }
  | { type: 'token'; content: string }
  | { type: 'thinking'; content: string; timelinePosition?: number }
  | { type: 'rich-artifact'; artifact: import('./rich-artifacts').RichArtifact }
  | { type: 'task-memory'; memory: NonNullable<AgentPlan['taskMemory']> }
  | { type: 'steering'; userMessage: ChatMessage; status: 'accepted' | 'applied'; timelinePosition?: number }
  | { type: 'paused'; timelinePosition?: number }
  | { type: 'browser-qa'; qaStatus: import('./browser-qa').BrowserQaStatus }
  | { type: 'tool'; activity: ToolActivity; runId?: string }
  | { type: 'attachment'; activity: ToolActivity }
  | { type: 'approval-request'; actionId: string; approval: ActionApproval }
  | { type: 'approval-resolved'; actionId: string; approvalId: string; status: Exclude<ApprovalStatus, 'pending'> }
  | { type: 'analysis-run'; run: AnalysisRun }
  | { type: 'analysis'; progress: AnalysisProgress }
  | { type: 'context'; requested: number; active: number; supported?: number }
  | { type: 'context-usage'; used: number; maximum: number }
  | { type: 'agent-telemetry'; telemetry: Partial<AgentTelemetry> }
  | { type: 'diagnostics'; diagnostics: Omit<GenerationDiagnostics, 'generationId' | 'conversationId' | 'createdAt'> }
  | { type: 'done'; assistant?: ChatMessage | null; finishReason?: FinishReason; paused?: boolean }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; details?: string };

export interface LocalAiApi {
  liveBrowser?: import('./live-browser').LiveBrowserApi;
  conversations: {
    list(): Promise<Conversation[]>;
    create(modelId?: string): Promise<Conversation>;
    update(id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'llamaKvCacheType' | 'llamaKvOffload' | 'reasoningMode' | 'webMode'>>): Promise<Conversation>;
    delete(id: string): Promise<void>;
  };
  messages: { list(conversationId: string): Promise<ChatMessage[]>; edit(id: string, content: string, fallback?: Pick<ChatMessage, 'conversationId' | 'content'>): Promise<ChatMessage[]>; regenerate(id: string): Promise<ChatMessage[]> };
  agentPlans: { get(conversationId: string): Promise<AgentPlan | null>; legacy(conversationId: string): Promise<AgentPlan | null> };
  agentTasks: { list(conversationId: string, includeTaskId?: string): Promise<AgentTaskSummary[]> };
  projects: { search(conversationId: string, query: string): Promise<ProjectSuggestion[]> };
  attachments: {
    import(input: AttachmentInput): Promise<Attachment>;
    list(messageId: string): Promise<Attachment[]>;
    dataUrl(id: string): Promise<string | null>;
  };
  webImages: { load(url: string): Promise<RemoteImageData>; openSource(url: string): Promise<void> };
  analysis: { list(conversationId: string): Promise<AnalysisRun[]> };
  models: { list(): Promise<ModelInfo[]> };
  browserQa: { status(): Promise<{ mode: import('./browser-qa').BrowserVisionMode; autonomous: boolean; available: boolean; pending?: boolean; reason: string }>; configure(mode: import('./browser-qa').BrowserVisionMode, autonomous: boolean, confirmed: boolean): Promise<void> };
  mtp: { status(modelId: string): Promise<MtpStatus>; apply(modelId: string, mode: MtpMode, confirmed: boolean): Promise<MtpStatus> };
  runtime: { state(): Promise<NonNullable<AppSettings['llamaRuntime']>>; control(request:{action:'unload'|'restart';conversationId:string;modelId?:string}):Promise<AppSettings> };
  settings: { setLanguage(language: 'en' | 'ru'): Promise<void>; validateDraft(config: Pick<RuntimeConfiguration, 'modelsPath' | 'models'>): Promise<RuntimeDraftAvailability>; resolveExecutable(path: string, selected?: string): Promise<ExecutableResolution>; cancelResolution(): Promise<void>; onLanguageChanged(listener: (language: 'ru' | 'en') => void): () => void; get(): Promise<AppSettings>; save(config: RuntimeConfiguration): Promise<AppSettings>; dismissSetup(): Promise<AppSettings> };
  hardware: { get(): Promise<HardwareStats> };
  contextEstimate(modelId: string): Promise<RuntimeContextEstimate>;
  contextDiscover(modelId: string): Promise<ContextDiscoveryResult>;
  contextDiscoveryStatus(modelId?: string | null): Promise<import('./context-estimator').ContextDiscoveryProgress>;
  dialog: { chooseDirectory(initialDirectory?: string | null): Promise<string | null>; chooseFile(): Promise<string | null> };
  chat: {
    send(request: ChatRequest): Promise<void>;
    steer(conversationId: string, generationId: string, content: string, intent?: SteeringIntent): Promise<ChatMessage>;
    stop(conversationId: string, generationId?: string): Promise<void>;
    revokeApprovals(conversationId: string, generationId: string, grantId?: string): Promise<boolean>;
    grants(conversationId: string, generationId: string): Promise<SessionGrant[]>;
    permissions(conversationId: string): Promise<AgentPermissions>;
    setPermissions(conversationId: string, mode: AutonomyMode, trust: boolean): Promise<AgentPermissions>;
    loopControl(conversationId: string, generationId: string, signature: string, action: LoopAction): Promise<void>;
    approve(request: { conversationId: string; generationId: string; approvalId: string; decision: ApprovalDecision }): Promise<boolean>;
    onDiagramValidation(listener: (request: { id: string; source: string }) => void): () => void;
    diagramValidationResult(id: string, error?: string): void;
    onStream(listener: (event: StreamEvent & { conversationId: string; generationId: string; modelId?: string }) => void): () => void;
  };
}
