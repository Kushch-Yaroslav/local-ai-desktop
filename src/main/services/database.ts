import { isLoopLifecycle } from '../../shared/autonomy';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AgentPlan, AnalysisRun, Attachment, AttachmentKind, AttachmentStatus, ChatMessage, ChatMode, Conversation, GenerationDiagnostics, GenerationStats, LlamaKvCacheType, ProjectReference, ProjectReferenceKind, ReasoningMode, ThinkingTimelineEvent, ToolActivity, WebMode } from '../../shared/types';
import { paths } from './paths';
import { isReasoningEffort } from '../../shared/reasoning-controls';
import { isPersistableDiscoveryOption, parseStoredDiscoveryOption } from './context-discovery-persistence';
import type { ContextDiscoveryOption } from '../../shared/context-estimator';
import { validatePersistedRichArtifact, type RichArtifact } from '../../shared/rich-artifacts';
import { extractAbsolutePaths } from './agent-workspace';
import { posix } from 'node:path';
import type { AgentTaskSummary } from '../../shared/types';

type ConversationRow = {
  id: string; title: string; model_id: string | null; mode: ChatMode; working_directory: string | null;
  primary_project_id: string | null; secondary_working_directory: string | null; secondary_project_id: string | null;
  context_window: number;
  llama_kv_cache_type: LlamaKvCacheType;
  llama_kv_offload: number;
  reasoning_mode: ReasoningMode;
  thinking_enabled: number | null; reasoning_effort: string | null;
  context_tokens: number | null; context_model_id: string | null;
  web_mode: WebMode;
  created_at: string; updated_at: string;
};
type MessageRow = { logical_task_id?: string | null; id: string; conversation_id: string; role: ChatMessage['role']; content: string; thinking: string | null; thinking_timeline: string | null; task_plan: string | null; generation_stats: string | null; rich_artifacts: string | null; created_at: string };
type ProjectReferenceRow = { id: string; message_id: string; position: number; project_id: string; project_slot: 1 | 2; project_path: string; project_label: string; relative_path: string; kind: ProjectReferenceKind };
type AttachmentRow = { id: string; message_id: string; position: number; kind: AttachmentKind; mime_type: string; filename: string; size: number; storage_ref: string; status: AttachmentStatus; extracted_text: string | null; structured_data: string | null; vision_analysis: string | null; error: string | null; metadata: string | null; created_at: string; updated_at: string };
type AnalysisRunRow = { logical_task_id?: string | null; generation_id?: string | null; triggering_message_id?: string | null; archived?: number; task_snapshot?: string | null; id: string; conversation_id: string; assistant_message_id: string | null; reasoning_mode: ReasoningMode; status: AnalysisRun['status']; action_count: number; created_at: string; completed_at: string | null; timeline?: string | null; partial_output?: string | null; error?: string | null; rich_artifacts?: string | null };
type AnalysisActionRow = { id: string; run_id: string; label: string; detail: string | null; data: string | null; position: number };
type AgentPlanRow = { plan: string };

const mapConversation = (row: ConversationRow): Conversation => ({
  id: row.id, title: row.title, modelId: row.model_id, mode: row.mode,
  workingDirectory: row.working_directory, primaryProjectId: row.primary_project_id ?? null, secondaryWorkingDirectory: row.secondary_working_directory ?? null, secondaryProjectId: row.secondary_project_id ?? null, contextWindow: row.context_window ?? 32_768, llamaKvCacheType: row.llama_kv_cache_type === 'q8_0' ? 'q8_0' : 'f16', llamaKvOffload: row.llama_kv_offload !== 0, reasoningMode: row.reasoning_mode === 'deep' ? 'deep' : 'fast', thinkingEnabled: row.thinking_enabled === null || row.thinking_enabled === undefined ? null : row.thinking_enabled !== 0, reasoningEffort: isReasoningEffort(row.reasoning_effort) ? row.reasoning_effort : null, contextTokens: row.context_tokens ?? null, contextModelId: row.context_model_id ?? null, webMode: row.web_mode ?? 'auto', createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id, messageId: row.message_id, index: row.position, kind: row.kind, mimeType: row.mime_type, filename: row.filename, size: row.size, storageRef: row.storage_ref, status: row.status,
  extractedText: row.extracted_text ?? undefined, structuredData: row.structured_data ?? undefined, visionAnalysis: row.vision_analysis ?? undefined, error: row.error ?? undefined,
  metadata: parseAttachmentMetadata(row.metadata), createdAt: row.created_at, updatedAt: row.updated_at,
});
function parseAttachmentMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}
const mapReference = (row: ProjectReferenceRow): ProjectReference => ({ id: row.id, projectId: row.project_id, projectSlot: row.project_slot, projectPath: row.project_path, projectLabel: row.project_label, relativePath: row.relative_path, kind: row.kind });
function parseGenerationStats(value: string | null): GenerationStats | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<GenerationStats>;
    if (!parsed || typeof parsed !== 'object' || !Number.isFinite(parsed.outputTokens) || parsed.outputTokens! < 0) return undefined;
    return {
      outputTokens: Math.round(parsed.outputTokens!),
      ...(Number.isFinite(parsed.tokensPerSecond) && parsed.tokensPerSecond! > 0 ? { tokensPerSecond: parsed.tokensPerSecond } : {}),
      ...(Number.isFinite(parsed.generationDurationMs) && parsed.generationDurationMs! >= 0 ? { generationDurationMs: parsed.generationDurationMs } : {}),
      ...(Number.isFinite(parsed.timeToFirstTokenMs) && parsed.timeToFirstTokenMs! >= 0 ? { timeToFirstTokenMs: parsed.timeToFirstTokenMs } : {}),
      ...(Number.isFinite(parsed.inputTokens) && parsed.inputTokens! >= 0 ? { inputTokens: Math.round(parsed.inputTokens!) } : {}),
    };
  } catch { return undefined; }
}
function parseRichArtifacts(value: string | null): RichArtifact[] | undefined {
  try {
    const parsed = value ? JSON.parse(value) as unknown : undefined;
    if (!Array.isArray(parsed) || parsed.length > 16) return undefined;
    const artifacts: RichArtifact[] = [];
    for (const candidate of parsed) {
      const result = validatePersistedRichArtifact(candidate);
      if (result.artifact) artifacts.push(result.artifact);
    }
    return artifacts.length ? artifacts : undefined;
  } catch { return undefined; }
}
/** Old or damaged timeline metadata remains optional; malformed entries are dropped. */
const parseTimeline = (value: string | null | undefined): ThinkingTimelineEvent[] | undefined => {
  try {
    const parsed = value ? JSON.parse(value) as unknown : undefined;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((item): item is ThinkingTimelineEvent => Boolean(item) && typeof item === 'object' && typeof item.id === 'string' && typeof item.position === 'number' && ((item.kind === 'reasoning' && typeof item.content === 'string' && (item.startedAt === undefined || typeof item.startedAt === 'string') && (item.completedAt === undefined || typeof item.completedAt === 'string')) || (item.kind === 'activity' && typeof item.activityId === 'string') || (item.kind === 'steering' && typeof item.messageId === 'string' && (item.status === 'accepted' || item.status === 'applied')) || item.kind === 'paused' || (item.kind === 'loop' && isLoopLifecycle(item.lifecycle))));
  } catch { return undefined; }
};
const mapMessage = (row: MessageRow, attachments?: Attachment[], projectReferences?: ProjectReference[]): ChatMessage => {
  const generationStats = parseGenerationStats(row.generation_stats);
  let taskPlan: import('../../shared/types').AgentPlan | undefined;
  const thinkingTimeline = parseTimeline(row.thinking_timeline);
  const richArtifacts = parseRichArtifacts(row.rich_artifacts);
  try {
    const parsed = row.task_plan ? JSON.parse(row.task_plan) as unknown : undefined;
    if (parsed && typeof parsed === 'object' && (Array.isArray((parsed as { milestones?: unknown }).milestones) || Array.isArray((parsed as { steps?: unknown }).steps))) {
      taskPlan = parsed as import('../../shared/types').AgentPlan;
    }
  } catch { /* Old snapshot remains optional. */ }
  return {
    ...(row.logical_task_id ? { logicalTaskId: row.logical_task_id } : {}),
    id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, createdAt: row.created_at,
    attachments,
    projectReferences,
    ...(row.thinking?.trim() ? { thinking: row.thinking } : {}),
    ...(thinkingTimeline?.length ? { thinkingTimeline } : {}),
    ...(taskPlan ? { taskPlan } : {}),
    ...(generationStats ? { generationStats } : {}),
    ...(richArtifacts ? { richArtifacts } : {}),
  };
};
const mapRun = (row: AnalysisRunRow, actions: AnalysisActionRow[]): AnalysisRun => ({ ...(row.logical_task_id ? { logicalTaskId: row.logical_task_id } : {}), ...(row.generation_id ? { generationId: row.generation_id } : {}), ...(row.triggering_message_id ? { triggeringMessageId: row.triggering_message_id } : {}), ...(row.archived ? { archived: true } : {}), ...(row.task_snapshot ? { taskPlan: JSON.parse(row.task_snapshot) as AgentPlan } : {}), id: row.id, conversationId: row.conversation_id, assistantMessageId: row.assistant_message_id, reasoningMode: row.reasoning_mode === 'deep' ? 'deep' : 'fast', status: row.status, actionCount: row.action_count, actions: actions.map((action) => {
  let stored: Partial<ToolActivity> = {};
  try { stored = action.data ? JSON.parse(action.data) as Partial<ToolActivity> : {}; } catch { /* Older or corrupt telemetry remains readable. */ }
  const visible = { ...stored };
  delete visible.rawOutput;
  // `analysis_actions.id` is a storage primary key. New rows scope that key by
  // run, while persisted activity data retains the stable per-run ID used by
  // timelines, approval events and the renderer.
  // Runs finalized before running actions were closed on Stop/failure must not show live work forever.
  const stale = visible.state === 'running' && row.status !== 'running' && row.status !== 'completed';
  return { ...visible, ...(stale ? { state: 'error' as const, ...(visible.terminal && !visible.terminal.finishedAt ? { terminal: { ...visible.terminal, status: row.status === 'error' ? 'error' as const : 'cancelled' as const } } : {}) } : {}), id: typeof stored.id === 'string' ? stored.id : action.id, label: action.label, detail: action.detail ?? undefined };
}), createdAt: row.created_at, completedAt: row.completed_at, ...runHistory(row) });
const runHistory = (row: AnalysisRunRow): Pick<AnalysisRun, 'timeline' | 'partialOutput' | 'error' | 'richArtifacts'> => {
  const timeline = parseTimeline(row.timeline);
  const richArtifacts = parseRichArtifacts(row.rich_artifacts ?? null);
  return { ...(timeline?.length ? { timeline } : {}), ...(richArtifacts ? { richArtifacts } : {}), ...(row.partial_output ? { partialOutput: row.partial_output } : {}), ...(row.error ? { error: row.error } : {}) };
};

export class Database {
  private readonly db: DatabaseSync;

  constructor(databasePath = paths.database) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, model_id TEXT, mode TEXT NOT NULL,
        working_directory TEXT, context_window INTEGER NOT NULL DEFAULT 32768, llama_kv_cache_type TEXT NOT NULL DEFAULT 'f16', llama_kv_offload INTEGER NOT NULL DEFAULT 1, reasoning_mode TEXT NOT NULL DEFAULT 'fast', context_tokens INTEGER, context_model_id TEXT, web_mode TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, thinking TEXT, thinking_timeline TEXT, task_plan TEXT, generation_stats TEXT, rich_artifacts TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_plans (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        plan TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_references (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, project_id TEXT NOT NULL, project_slot INTEGER NOT NULL,
        project_path TEXT NOT NULL, project_label TEXT NOT NULL, relative_path TEXT NOT NULL, kind TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_references_message_idx ON project_references(message_id, position);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL, filename TEXT NOT NULL,
        size INTEGER NOT NULL, storage_ref TEXT NOT NULL, status TEXT NOT NULL,
        extracted_text TEXT, structured_data TEXT, vision_analysis TEXT, error TEXT, metadata TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id, position);
      CREATE TABLE IF NOT EXISTS analysis_runs (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, assistant_message_id TEXT, reasoning_mode TEXT NOT NULL DEFAULT 'fast', status TEXT NOT NULL, action_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS analysis_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, label TEXT NOT NULL, detail TEXT, data TEXT, position INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS analysis_actions_run_idx ON analysis_actions(run_id, position);
      CREATE TABLE IF NOT EXISTS generation_diagnostics (
        generation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, reasoning_mode TEXT NOT NULL DEFAULT 'fast',
        requested_max_output_tokens INTEGER NOT NULL, effective_max_output_tokens INTEGER NOT NULL,
        context_limit INTEGER NOT NULL, input_tokens INTEGER NOT NULL, agent_step_count INTEGER NOT NULL,
        finish_reason TEXT NOT NULL, prompt_eval_count INTEGER, prompt_eval_duration INTEGER,
        eval_count INTEGER, eval_duration INTEGER, tokens_per_second REAL, prompt_tokens_per_second REAL,
        time_to_first_token_ms REAL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS context_discoveries (
        config_key TEXT NOT NULL, kv_cache_type TEXT NOT NULL, kv_offload INTEGER NOT NULL, model_id TEXT NOT NULL,
        context_window INTEGER NOT NULL, option TEXT NOT NULL, identity TEXT NOT NULL, saved_at TEXT NOT NULL,
        PRIMARY KEY (config_key, kv_cache_type, kv_offload)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS generation_diagnostics_conversation_idx ON generation_diagnostics(conversation_id, created_at DESC);
    `);
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN context_window INTEGER NOT NULL DEFAULT 32768'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec("ALTER TABLE conversations ADD COLUMN llama_kv_cache_type TEXT NOT NULL DEFAULT 'f16'"); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN llama_kv_offload INTEGER NOT NULL DEFAULT 1'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN reasoning_mode TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN thinking_enabled INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN context_tokens INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN context_model_id TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec("ALTER TABLE conversations ADD COLUMN web_mode TEXT NOT NULL DEFAULT 'auto'"); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN primary_project_id TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN secondary_working_directory TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE conversations ADD COLUMN secondary_project_id TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN thinking_timeline TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN task_plan TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN generation_stats TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE messages ADD COLUMN rich_artifacts TEXT'); } catch { /* Existing databases already have this column. */ }
    this.db.exec("UPDATE conversations SET primary_project_id=lower(hex(randomblob(16))) WHERE working_directory IS NOT NULL AND primary_project_id IS NULL");
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN prompt_eval_count INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN prompt_eval_duration INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN eval_count INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN eval_duration INTEGER'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN tokens_per_second REAL'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN prompt_tokens_per_second REAL'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN time_to_first_token_ms REAL'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE analysis_actions ADD COLUMN data TEXT'); } catch { /* Existing databases already have this column. */ }
    this.migrateAnalysisRuns();
    try { this.db.exec('ALTER TABLE analysis_runs ADD COLUMN timeline TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE analysis_runs ADD COLUMN partial_output TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE analysis_runs ADD COLUMN rich_artifacts TEXT'); } catch { /* Existing databases already have this column. */ }
    try { this.db.exec('ALTER TABLE analysis_runs ADD COLUMN error TEXT'); } catch { /* Existing databases already have this column. */ }
    for (const [table, column] of [['messages', 'logical_task_id TEXT'], ['analysis_runs', 'logical_task_id TEXT'], ['analysis_runs', 'generation_id TEXT'], ['analysis_runs', 'triggering_message_id TEXT'], ['analysis_runs', 'archived INTEGER NOT NULL DEFAULT 0']]) {
      const name = column.split(' ')[0];
      if (!(this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(item => item.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, checkpoint TEXT NOT NULL,
        scope TEXT, legacy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_tasks_conversation_idx ON agent_tasks(conversation_id);
      CREATE TABLE IF NOT EXISTS agent_task_snapshots (
        run_id TEXT PRIMARY KEY, logical_task_id TEXT NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS immutable_agent_task_snapshot BEFORE UPDATE ON agent_task_snapshots
        BEGIN SELECT RAISE(ABORT, 'Task snapshots are immutable'); END;
      INSERT OR IGNORE INTO agent_tasks (id, conversation_id, checkpoint, legacy, created_at, updated_at)
        SELECT 'legacy:' || conversation_id, conversation_id, plan, 1, updated_at, updated_at FROM agent_plans;
    `);

    try { this.db.exec('ALTER TABLE generation_diagnostics ADD COLUMN reasoning_mode TEXT'); } catch { /* Existing databases already have this column. */ }
    // Map values persisted by the removed four-level control once. The legacy
    // columns stay in place for old SQLite files but are never read again.
    try { this.db.exec("UPDATE conversations SET reasoning_mode=CASE analysis_depth WHEN 'enhanced' THEN 'deep' WHEN 'deep' THEN 'deep' ELSE 'fast' END WHERE reasoning_mode IS NULL"); } catch { /* Fresh databases have no legacy column. */ }
    try { this.db.exec("UPDATE generation_diagnostics SET reasoning_mode=CASE reasoning_preset WHEN 'enhanced' THEN 'deep' WHEN 'deep' THEN 'deep' ELSE 'fast' END WHERE reasoning_mode IS NULL"); } catch { /* Fresh databases have no legacy column. */ }
    this.db.exec("UPDATE conversations SET reasoning_mode='fast' WHERE reasoning_mode IS NULL OR reasoning_mode NOT IN ('fast', 'deep')");
    this.db.exec("UPDATE analysis_runs SET reasoning_mode='fast' WHERE reasoning_mode IS NULL OR reasoning_mode NOT IN ('fast', 'deep')");
    this.db.exec("UPDATE generation_diagnostics SET reasoning_mode='fast' WHERE reasoning_mode IS NULL OR reasoning_mode NOT IN ('fast', 'deep')");
    // A removed model must not remain selected in persisted chats.
    this.db.prepare("UPDATE conversations SET model_id=NULL WHERE model_id='qwen3-coder:30b'").run();
  }

  close(): void { this.db.close(); }

  /** Legacy conversation state has no reliable per-request owner. Display it
   * separately instead of guessing or authorizing old verification evidence. */
  getLegacyAgentPlan(conversationId: string): AgentPlan | null {
    const row = this.db.prepare('SELECT id, checkpoint FROM agent_tasks WHERE conversation_id=? AND legacy=1').get(conversationId) as { id: string; checkpoint: string } | undefined;
    try { return row ? { ...JSON.parse(row.checkpoint) as AgentPlan, logicalTaskId: row.id } : null; } catch { return null; }
  }

  /** Recent task picker metadata. Read-only; neither inferred ownership nor grants. */
  listAgentTasks(conversationId: string, includeTaskId?: string): AgentTaskSummary[] {
    const query = `SELECT t.id, t.scope, MAX(COALESCE(r.completed_at, r.created_at)) AS updated_at
      FROM agent_tasks t JOIN analysis_runs r ON r.logical_task_id=t.id
      WHERE t.conversation_id=? AND t.legacy=0`;
    type Row = { id: string; scope: string | null; updated_at: string };
    const rows = this.db.prepare(`${query} GROUP BY t.id ORDER BY updated_at DESC, t.rowid DESC LIMIT 12`).all(conversationId) as Row[];
    if (includeTaskId && !rows.some(row => row.id === includeTaskId)) {
      const selected = this.db.prepare(`${query} AND t.id=? GROUP BY t.id`).get(conversationId, includeTaskId) as Row | undefined;
      if (selected) rows.push(selected);
    }
    return rows.map(row => {
      const checkpoint = this.getAgentPlan(conversationId, row.id);
      const user = this.db.prepare("SELECT id, content FROM messages WHERE conversation_id=? AND logical_task_id=? AND role='user' ORDER BY rowid LIMIT 1").get(conversationId, row.id) as { id: string; content: string } | undefined;
      const paths = user ? extractAbsolutePaths(user.content) : [];
      let projects: AgentTaskSummary['projects'] = user ? this.listProjectReferences(user.id).map(ref => ({ path: ref.projectPath, id: ref.projectId })) : [];
      // Prefer the task's own declared target over the conversation's later cwd.
      if (!projects.length && paths.length) projects = paths.slice(0, 4).map(path => ({ path: /\.[a-z0-9]{1,8}$/i.test(posix.basename(path)) ? posix.dirname(path) : path.replace(/\/$/, '') }));
      if (!projects.length) {
        try { const scope = JSON.parse(row.scope ?? '{}') as { projects?: Array<{ id: string; root: string }> }; projects = (scope.projects ?? []).map(project => ({ path: project.root, id: project.id })); } catch { /* Optional old metadata. */ }
      }
      if (!projects.length && !user) projects = Object.keys(checkpoint?.taskMemory?.verification?.revisions ?? {}).filter(posix.isAbsolute).slice(0, 4).map(path => ({ path: posix.dirname(path) }));
      const firstLine = user?.content.trim().split('\n')[0] ?? '';
      const title = (paths.reduce((text, path) => text.replaceAll(path, posix.basename(path)), firstLine) || checkpoint?.taskMemory?.plan?.steps[0]?.text || '').replace(/[`\r\n]/g, '').slice(0, 80);
      return { logicalTaskId: row.id, title, projects: projects.filter((project, index) => projects.findIndex(other => other.path === project.path) === index), updatedAt: row.updated_at };
    });
  }

  /** SQLite cannot remove NOT NULL columns in place. Rebuild only legacy
   * analysis_runs tables, preserving every run and its referenced actions. */
  private migrateAnalysisRuns(): void {
    const columns = this.db.prepare('PRAGMA table_info(analysis_runs)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has('depth')) {
      if (!names.has('reasoning_mode')) this.db.exec("ALTER TABLE analysis_runs ADD COLUMN reasoning_mode TEXT NOT NULL DEFAULT 'fast'");
      this.db.exec('CREATE INDEX IF NOT EXISTS analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at)');
      return;
    }
    const reasoningMode = names.has('reasoning_mode')
      ? "CASE WHEN reasoning_mode='deep' OR depth IN ('enhanced', 'deep') THEN 'deep' ELSE 'fast' END"
      : "CASE WHEN depth IN ('enhanced', 'deep') THEN 'deep' ELSE 'fast' END";
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE analysis_runs_migrating (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, assistant_message_id TEXT,
        reasoning_mode TEXT NOT NULL DEFAULT 'fast', status TEXT NOT NULL,
        action_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT
      ) STRICT`);
      this.db.exec(`INSERT INTO analysis_runs_migrating
        (id, conversation_id, assistant_message_id, reasoning_mode, status, action_count, created_at, completed_at)
        SELECT id, conversation_id, assistant_message_id, ${reasoningMode}, status, action_count, created_at, completed_at
        FROM analysis_runs`);
      this.db.exec('DROP TABLE analysis_runs');
      this.db.exec('ALTER TABLE analysis_runs_migrating RENAME TO analysis_runs');
      this.db.exec('CREATE INDEX analysis_runs_conversation_idx ON analysis_runs(conversation_id, created_at)');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listConversations(): Conversation[] {
    return (this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as unknown as ConversationRow[]).map(mapConversation);
  }

  createConversation(modelId: string | null = null): Conversation {
    const id = randomUUID(); const now = new Date().toISOString();
    const title = 'Новый чат';
    this.db.prepare("INSERT INTO conversations (id, title, model_id, mode, working_directory, primary_project_id, secondary_working_directory, secondary_project_id, context_window, llama_kv_cache_type, llama_kv_offload, reasoning_mode, context_tokens, context_model_id, web_mode, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 'f16', 1, ?, NULL, NULL, 'auto', ?, ?)").run(id, title, modelId, 'chat', 32_768, 'fast', now, now);
    return { id, title, modelId, mode: 'chat', workingDirectory: null, primaryProjectId: null, secondaryWorkingDirectory: null, secondaryProjectId: null, contextWindow: 32_768, llamaKvCacheType: 'f16', llamaKvOffload: true, reasoningMode: 'fast', thinkingEnabled: null, reasoningEffort: null, contextTokens: null, contextModelId: null, webMode: 'auto', createdAt: now, updatedAt: now };
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'llamaKvCacheType' | 'llamaKvOffload' | 'reasoningMode' | 'thinkingEnabled' | 'reasoningEffort' | 'webMode'>>): Conversation {
    const current = this.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory) next.primaryProjectId = patch.workingDirectory ? randomUUID() : null;
    if (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== current.secondaryWorkingDirectory) next.secondaryProjectId = patch.secondaryWorkingDirectory ? randomUUID() : null;
    const contextWindow = Number.isSafeInteger(next.contextWindow) && next.contextWindow >= 4_096 && next.contextWindow <= 262_144 && next.contextWindow % 4_096 === 0 ? next.contextWindow : 32_768;
    const llamaKvCacheType: LlamaKvCacheType = next.llamaKvCacheType === 'q8_0' ? 'q8_0' : 'f16';
    const llamaKvOffload = next.llamaKvOffload !== false;
    const reasoningMode: ReasoningMode = next.reasoningMode === 'deep' ? 'deep' : 'fast';
    const thinkingEnabled = typeof next.thinkingEnabled === 'boolean' ? next.thinkingEnabled : null;
    const reasoningEffort = isReasoningEffort(next.reasoningEffort) ? next.reasoningEffort : null;
    const webMode: WebMode = next.webMode === 'off' ? 'off' : 'auto';
    this.db.prepare('UPDATE conversations SET title=?, model_id=?, mode=?, working_directory=?, primary_project_id=?, secondary_working_directory=?, secondary_project_id=?, context_window=?, llama_kv_cache_type=?, llama_kv_offload=?, reasoning_mode=?, thinking_enabled=?, reasoning_effort=?, web_mode=?, updated_at=? WHERE id=?')
      .run(next.title, next.modelId, next.mode, next.workingDirectory, next.primaryProjectId, next.secondaryWorkingDirectory, next.secondaryProjectId, contextWindow, llamaKvCacheType, llamaKvOffload ? 1 : 0, reasoningMode, thinkingEnabled === null ? null : thinkingEnabled ? 1 : 0, reasoningEffort, webMode, next.updatedAt, id);
    next.contextWindow = contextWindow;
    next.llamaKvCacheType = llamaKvCacheType;
    next.llamaKvOffload = llamaKvOffload;
    next.reasoningMode = reasoningMode;
    next.thinkingEnabled = thinkingEnabled;
    next.reasoningEffort = reasoningEffort;
    next.webMode = webMode;
    return next;
  }

  deleteConversation(id: string): Attachment[] {
    const attachments = this.listAttachmentsForConversation(id);
    const runs = this.db.prepare('SELECT id FROM analysis_runs WHERE conversation_id=?').all(id) as unknown as Array<{ id: string }>;
    for (const run of runs) this.db.prepare('DELETE FROM analysis_actions WHERE run_id=?').run(run.id);
    this.db.prepare('DELETE FROM agent_task_snapshots WHERE logical_task_id IN (SELECT id FROM agent_tasks WHERE conversation_id=?)').run(id);
    this.db.prepare('DELETE FROM agent_tasks WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM analysis_runs WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM generation_diagnostics WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM agent_plans WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(id);
    this.db.prepare('DELETE FROM project_references WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)').run(id);
    this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
    this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
    return attachments;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as ConversationRow | undefined;
    return row ? mapConversation(row) : null;
  }

  listMessages(conversationId: string): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC').all(conversationId) as unknown as MessageRow[]).map((row) => mapMessage(row, this.listAttachments(row.id), this.listProjectReferences(row.id)));
  }

  /** Durable canonical planning state. Message snapshots remain a readable
   * historical record; this row also survives an interrupted active run. */
  /** Without a selector, return the live projection (or the legacy API row).
   * New requests always use an explicit task ID, never the legacy fallback. */
  getAgentPlan(conversationId: string, logicalTaskId?: string): AgentPlan | null {
    const row = logicalTaskId
      ? this.db.prepare('SELECT checkpoint AS plan FROM agent_tasks WHERE id=? AND conversation_id=?').get(logicalTaskId, conversationId)
      : this.db.prepare("SELECT t.checkpoint AS plan FROM agent_tasks t JOIN analysis_runs r ON r.logical_task_id=t.id WHERE t.conversation_id=? AND r.status='running' AND r.archived=0 ORDER BY r.rowid DESC LIMIT 1").get(conversationId)
        ?? this.db.prepare('SELECT plan FROM agent_plans WHERE conversation_id=?').get(conversationId);
    if (!row) return null;
    try { return JSON.parse((row as AgentPlanRow).plan) as AgentPlan; } catch { return null; }
  }

  /** IDs are allocated by the trusted main process, not the model or renderer. */
  resolveLogicalTask(conversationId: string, continuation?: string, retryMessageId?: string): string {
    const retry = retryMessageId ? this.getMessage(retryMessageId) : null;
    if (retryMessageId && (!retry || retry.role !== 'user' || retry.conversationId !== conversationId)) throw new Error('Invalid task retry message');
    const id = continuation ?? retry?.logicalTaskId;
    if (id) {
      const task = this.db.prepare('SELECT id, legacy FROM agent_tasks WHERE id=? AND conversation_id=?').get(id, conversationId) as { id: string; legacy: number } | undefined;
      if (!task || task.legacy) throw new Error('Task continuation is unavailable: select a task in this conversation');
      if (continuation && retry?.logicalTaskId && continuation !== retry.logicalTaskId) throw new Error('Task retry ownership mismatch');
      return task.id;
    }
    if (!this.getConversation(conversationId)) throw new Error('Conversation not found');
    const createdAt = new Date().toISOString(); const logicalTaskId = randomUUID();
    this.db.prepare('INSERT INTO agent_tasks (id, conversation_id, checkpoint, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(logicalTaskId, conversationId, JSON.stringify({ logicalTaskId, milestones: [] }), createdAt, createdAt);
    return logicalTaskId;
  }

  saveAgentPlan(conversationId: string, plan: AgentPlan, logicalTaskId?: string): void {
    const updatedAt = new Date().toISOString();
    if (logicalTaskId) {
      const result = this.db.prepare('UPDATE agent_tasks SET checkpoint=?, updated_at=? WHERE id=? AND conversation_id=? AND legacy=0').run(JSON.stringify({ ...plan, logicalTaskId }), updatedAt, logicalTaskId, conversationId);
      if (!result.changes) throw new Error('Task checkpoint ownership mismatch');
    } else {
      // Compatibility for legacy callers; never consumed by new task routing.
      this.db.prepare('INSERT INTO agent_plans (conversation_id, plan, updated_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET plan=excluded.plan, updated_at=excluded.updated_at').run(conversationId, JSON.stringify(plan), updatedAt);
    }
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(updatedAt, conversationId);
  }

  bindMessageTask(messageId: string, conversationId: string, logicalTaskId: string): void {
    if (!this.getAgentPlan(conversationId, logicalTaskId)) throw new Error('Task message ownership mismatch');
    this.db.prepare('UPDATE messages SET logical_task_id=? WHERE id=? AND conversation_id=?').run(logicalTaskId, messageId, conversationId);
  }

  taskHistory(conversationId: string, logicalTaskId: string, messages: ChatMessage[]): ChatMessage[] {
    const owned = new Set((this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND logical_task_id=?').all(conversationId, logicalTaskId) as Array<{ id: string }>).map(row => row.id));
    // Use persisted ownership, never task IDs supplied in model/renderer text.
    return messages.filter(message => owned.has(message.id));
  }

  /** Trusted persisted ownership, never derived from model output or task findings. */
  getTaskScope(conversationId: string, logicalTaskId: string): { projects: Array<{ id: string; root: string }>; roots: string[] } | null {
    const row = this.db.prepare('SELECT scope FROM agent_tasks WHERE id=? AND conversation_id=? AND legacy=0').get(logicalTaskId, conversationId) as { scope: string | null } | undefined;
    if (!row?.scope) return null;
    try {
      const value = JSON.parse(row.scope) as { projects?: Array<{ id: string; root: string }>; roots?: string[] };
      if (!Array.isArray(value.projects) || !value.projects.every(p => typeof p.id === 'string' && typeof p.root === 'string') || !Array.isArray(value.roots) || !value.roots.every(root => typeof root === 'string')) return null;
      return { projects: value.projects, roots: value.roots };
    } catch { return null; }
  }

  /** Different roots must not carry readback/bindings or journal proofs forward. */
  setTaskScope(conversationId: string, logicalTaskId: string, scope: string): boolean {
    const row = this.db.prepare('SELECT scope FROM agent_tasks WHERE id=? AND conversation_id=? AND legacy=0').get(logicalTaskId, conversationId) as { scope: string | null } | undefined;
    if (!row) throw new Error('Task scope ownership mismatch');
    const changed = row.scope !== null && row.scope !== scope;
    if (changed) this.resetTaskEvidence(conversationId, logicalTaskId);
    this.db.prepare('UPDATE agent_tasks SET scope=? WHERE id=?').run(scope, logicalTaskId);
    return changed;
  }

  resetTaskEvidence(conversationId: string, logicalTaskId: string): void {
    const plan = this.getAgentPlan(conversationId, logicalTaskId);
    if (!plan) throw new Error('Task evidence ownership mismatch');
    if (plan.taskMemory) {
      const ledger = plan.taskMemory.verification;
      // Keep requirements, code/page-change classification, failing command
      // bindings and the evidence ID counter. A retry must not shed them.
      if (ledger) plan.taskMemory.verification = { ...ledger, epoch: (ledger.epoch ?? 0) + 1, records: [] };
      plan.taskMemory.entries = [];
      for (const item of plan.taskMemory.deliverables?.items ?? []) {
        if (item.status === 'verified') item.status = 'implemented';
        delete item.proof; delete item.evidence;
      }
    }
    this.saveAgentPlan(conversationId, plan, logicalTaskId);
  }

  /** Files can change between attempts, including through another task. Keep
   * the journal and planning state, but require fresh readback in this attempt.
   * Rust independently stales functional proof and demotes verified results. */
  prepareTaskAttempt(conversationId: string, logicalTaskId: string): void {
    const plan = this.getAgentPlan(conversationId, logicalTaskId);
    const ledger = plan?.taskMemory?.verification;
    if (!plan || !ledger) return;
    const nextEpoch = (ledger.epoch ?? 0) + 1;
    ledger.changed ??= {};
    for (const record of ledger.records) if (record.kind === 'readback') ledger.changed[record.check_key || record.subject] = nextEpoch;
    for (const item of plan.taskMemory?.deliverables?.items ?? []) if (item.status === 'verified') {
      item.status = 'implemented'; delete item.proof; delete item.evidence;
    }
    this.saveAgentPlan(conversationId, plan, logicalTaskId);
  }

  private freezeTaskSnapshot(runId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO agent_task_snapshots (run_id, logical_task_id, plan, created_at)
      SELECT r.id, t.id, t.checkpoint, ? FROM analysis_runs r JOIN agent_tasks t ON t.id=r.logical_task_id
      WHERE r.id=?`).run(new Date().toISOString(), runId);
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as MessageRow | undefined;
    return row ? mapMessage(row, this.listAttachments(row.id), this.listProjectReferences(row.id)) : null;
  }

  findUserMessage(conversationId: string, content: string): ChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='user' AND content=? ORDER BY rowid DESC LIMIT 1").get(conversationId, content) as unknown as MessageRow | undefined;
    return row ? mapMessage(row, this.listAttachments(row.id), this.listProjectReferences(row.id)) : null;
  }

  addMessage(conversationId: string, role: ChatMessage['role'], content: string, id: string = randomUUID(), projectReferences: ProjectReference[] = [], response?: Pick<ChatMessage, 'thinking' | 'thinkingTimeline' | 'taskPlan' | 'generationStats' | 'richArtifacts' | 'logicalTaskId'>): ChatMessage {
    const message: ChatMessage = { id, conversationId, role, content, createdAt: new Date().toISOString(), ...(response?.logicalTaskId ? { logicalTaskId: response.logicalTaskId } : {}), ...(response?.thinking?.trim() ? { thinking: response.thinking } : {}), ...(response?.thinkingTimeline?.length ? { thinkingTimeline: response.thinkingTimeline } : {}), ...(response?.taskPlan ? { taskPlan: response.taskPlan } : {}), ...(response?.generationStats ? { generationStats: response.generationStats } : {}), ...(response?.richArtifacts?.length ? { richArtifacts: response.richArtifacts } : {}) };
    this.db.prepare('INSERT INTO messages (id, conversation_id, role, content, thinking, thinking_timeline, task_plan, generation_stats, rich_artifacts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(message.id, message.conversationId, message.role, message.content, message.thinking ?? null, message.thinkingTimeline ? JSON.stringify(message.thinkingTimeline) : null, message.taskPlan ? JSON.stringify(message.taskPlan) : null, message.generationStats ? JSON.stringify(message.generationStats) : null, message.richArtifacts ? JSON.stringify(message.richArtifacts) : null, message.createdAt);
    if (message.logicalTaskId) this.bindMessageTask(message.id, conversationId, message.logicalTaskId);
    for (const [position, reference] of projectReferences.entries()) this.db.prepare('INSERT INTO project_references (id, message_id, position, project_id, project_slot, project_path, project_label, relative_path, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(reference.id, message.id, position, reference.projectId, reference.projectSlot, reference.projectPath, reference.projectLabel, reference.relativePath, reference.kind);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(message.createdAt, conversationId);
    return { ...message, projectReferences };
  }

  listProjectReferences(messageId: string): ProjectReference[] {
    return (this.db.prepare('SELECT * FROM project_references WHERE message_id=? ORDER BY position ASC').all(messageId) as unknown as ProjectReferenceRow[]).map(mapReference);
  }

  createAttachment(input: Omit<Attachment, 'createdAt' | 'updatedAt' | 'status'> & { status?: AttachmentStatus }): Attachment {
    const now = new Date().toISOString();
    const status = input.status ?? 'pending';
    this.db.prepare(`INSERT INTO attachments (id, message_id, position, kind, mime_type, filename, size, storage_ref, status, extracted_text, structured_data, vision_analysis, error, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.messageId, input.index, input.kind, input.mimeType, input.filename, input.size, input.storageRef, status, input.extractedText ?? null, input.structuredData ?? null, input.visionAnalysis ?? null, input.error ?? null, input.metadata ? JSON.stringify(input.metadata) : null, now, now);
    return this.getAttachment(input.id)!;
  }

  getAttachment(id: string): Attachment | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id) as unknown as AttachmentRow | undefined;
    return row ? mapAttachment(row) : null;
  }

  listAttachments(messageId: string): Attachment[] {
    return (this.db.prepare('SELECT * FROM attachments WHERE message_id=? ORDER BY position ASC').all(messageId) as unknown as AttachmentRow[]).map(mapAttachment);
  }

  listAttachmentsForConversation(conversationId: string): Attachment[] {
    return (this.db.prepare('SELECT attachments.* FROM attachments JOIN messages ON messages.id=attachments.message_id WHERE messages.conversation_id=? ORDER BY messages.rowid ASC, attachments.position ASC').all(conversationId) as unknown as AttachmentRow[]).map(mapAttachment);
  }

  updateAttachment(id: string, patch: Partial<Pick<Attachment, 'status' | 'extractedText' | 'structuredData' | 'visionAnalysis' | 'error' | 'metadata'>>): Attachment | null {
    const current = this.getAttachment(id); if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare('UPDATE attachments SET status=?, extracted_text=?, structured_data=?, vision_analysis=?, error=?, metadata=?, updated_at=? WHERE id=?')
      .run(next.status, next.extractedText ?? null, next.structuredData ?? null, next.visionAnalysis ?? null, next.error ?? null, next.metadata ? JSON.stringify(next.metadata) : null, new Date().toISOString(), id);
    return this.getAttachment(id);
  }

  editUserMessageAndTruncate(messageId: string, content: string): ChatMessage[] {
    const target = this.db.prepare("SELECT rowid, conversation_id, role, created_at FROM messages WHERE id=?").get(messageId) as { rowid: number; conversation_id: string; role: ChatMessage['role']; created_at: string } | undefined;
    if (!target || target.role !== 'user') throw new Error('Можно редактировать только существующее пользовательское сообщение');
    const text = content.trim(); if (!text) throw new Error('Сообщение не может быть пустым');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE messages SET content=? WHERE id=?').run(text, messageId);
      return this.truncateAfterUserMessage(target, true);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  regenerateUserMessageAndTruncate(messageId: string): ChatMessage[] {
    const target = this.db.prepare("SELECT rowid, conversation_id, role, created_at FROM messages WHERE id=?").get(messageId) as { rowid: number; conversation_id: string; role: ChatMessage['role']; created_at: string } | undefined;
    if (!target || target.role !== 'user') throw new Error('Можно перегенерировать ответ только для существующего сообщения пользователя');
    this.db.exec('BEGIN IMMEDIATE');
    try { return this.truncateAfterUserMessage(target, true); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private truncateAfterUserMessage(target: { rowid: number; conversation_id: string; created_at?: string }, commit: boolean): ChatMessage[] {
    const downstream = this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND rowid>?').all(target.conversation_id, target.rowid) as Array<{ id: string }>;
    const assistantIds = downstream.map((row) => row.id);
    const assistantPredicate = assistantIds.length ? `assistant_message_id IN (${assistantIds.map(() => '?').join(',')})` : '0';
    // Failed/cancelled Agent runs have no assistant_message_id. They still
    // belong to the downstream branch when they began after the regenerated
    // user turn, so remove their activities with that branch as well.
    const runIds = this.db.prepare(`SELECT id, logical_task_id FROM analysis_runs WHERE conversation_id=? AND archived=0 AND (${assistantPredicate} OR (assistant_message_id IS NULL AND (
      (logical_task_id IS NOT NULL AND triggering_message_id IN (SELECT id FROM messages WHERE conversation_id=? AND rowid>=?))
      OR (logical_task_id IS NULL AND created_at>=?))))`).all(target.conversation_id, ...assistantIds, target.conversation_id, target.rowid, target.created_at ?? '') as Array<{ id: string; logical_task_id: string | null }>;
    for (const run of runIds) {
      if (run.logical_task_id) {
        this.freezeTaskSnapshot(run.id);
        this.db.prepare('UPDATE analysis_runs SET archived=1, partial_output=COALESCE(partial_output, (SELECT content FROM messages WHERE id=assistant_message_id)) WHERE id=?').run(run.id);
      } else {
        this.db.prepare('DELETE FROM analysis_actions WHERE run_id=?').run(run.id);
        this.db.prepare('DELETE FROM analysis_runs WHERE id=?').run(run.id);
      }
    }
    this.db.prepare('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=? AND rowid>?)').run(target.conversation_id, target.rowid);
    this.db.prepare('DELETE FROM project_references WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=? AND rowid>?)').run(target.conversation_id, target.rowid);
    this.db.prepare('DELETE FROM messages WHERE conversation_id=? AND rowid>?').run(target.conversation_id, target.rowid);
    const targetTask = this.db.prepare('SELECT logical_task_id FROM messages WHERE conversation_id=? AND rowid=?').get(target.conversation_id, target.rowid) as { logical_task_id: string | null };
    const affectedTasks = new Set(runIds.flatMap(run => run.logical_task_id ? [run.logical_task_id] : []));
    if (targetTask?.logical_task_id) affectedTasks.add(targetTask.logical_task_id);
    // Dropping a chat branch also changes the history hash of later tasks.
    // Retain their plans/snapshots, but not dangling proofs/knowledge refs.
    for (const taskId of affectedTasks) this.resetTaskEvidence(target.conversation_id, taskId);
    // Task Memory and the context meter describe the dropped attempt. Their
    // evidence lives only in that attempt, so they are discarded with it.
    this.db.prepare('DELETE FROM agent_plans WHERE conversation_id=?').run(target.conversation_id);
    this.db.prepare('UPDATE conversations SET context_tokens=NULL, context_model_id=NULL, updated_at=? WHERE id=?').run(new Date().toISOString(), target.conversation_id);
    if (commit) this.db.exec('COMMIT');
    return this.listMessages(target.conversation_id);
  }

  setContextUsage(conversationId: string, modelId: string | null, tokens: number | null): Conversation | null {
    this.db.prepare('UPDATE conversations SET context_tokens=?, context_model_id=? WHERE id=?').run(tokens, modelId, conversationId);
    return this.getConversation(conversationId);
  }

  saveGenerationDiagnostics(diagnostics: GenerationDiagnostics): void {
    this.db.prepare(`INSERT OR REPLACE INTO generation_diagnostics
      (generation_id, conversation_id, reasoning_mode, requested_max_output_tokens, effective_max_output_tokens, context_limit, input_tokens, agent_step_count, finish_reason, prompt_eval_count, prompt_eval_duration, eval_count, eval_duration, tokens_per_second, prompt_tokens_per_second, time_to_first_token_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(diagnostics.generationId, diagnostics.conversationId, diagnostics.reasoningMode, diagnostics.requestedMaxOutputTokens, diagnostics.effectiveMaxOutputTokens, diagnostics.contextLimit, diagnostics.inputTokens, diagnostics.agentStepCount, diagnostics.finishReason, diagnostics.promptEvalCount ?? null, diagnostics.promptEvalDuration ?? null, diagnostics.evalCount ?? null, diagnostics.evalDuration ?? null, diagnostics.tokensPerSecond ?? null, diagnostics.promptTokensPerSecond ?? null, diagnostics.timeToFirstTokenMs ?? null, diagnostics.createdAt);
  }

  createAnalysisRun(conversationId: string, reasoningMode: ReasoningMode, ownership?: { logicalTaskId: string; generationId: string; triggeringMessageId: string }): AnalysisRun {
    if (ownership && !this.getAgentPlan(conversationId, ownership.logicalTaskId)) throw new Error('Run task ownership mismatch');
    const run = { ...ownership, id: randomUUID(), conversationId, assistantMessageId: null, reasoningMode, status: 'running' as const, actionCount: 0, actions: [], createdAt: new Date().toISOString(), completedAt: null };
    this.db.prepare('INSERT INTO analysis_runs (id, conversation_id, assistant_message_id, reasoning_mode, status, action_count, created_at, completed_at) VALUES (?, ?, NULL, ?, ?, 0, ?, NULL)').run(run.id, run.conversationId, run.reasoningMode, run.status, run.createdAt);
    if (ownership) {
      this.db.prepare('UPDATE analysis_runs SET logical_task_id=?, generation_id=?, triggering_message_id=? WHERE id=?').run(ownership.logicalTaskId, ownership.generationId, ownership.triggeringMessageId, run.id);
    }
    return run;
  }

  addAnalysisAction(runId: string, activity: ToolActivity): AnalysisRun {
    const priorRun = this.db.prepare('SELECT status FROM analysis_runs WHERE id=?').get(runId) as { status: AnalysisRun['status'] } | undefined;
    if (!priorRun) throw new Error('Run not found');
    if (priorRun.status !== 'running') return this.getAnalysisRun(runId)!;
    const storageId = `${runId}:${activity.id}`;
    const existing = this.db.prepare('SELECT id, data FROM analysis_actions WHERE run_id=? AND (id=? OR id=?)').get(runId, storageId, activity.id) as { id: string; data: string | null } | undefined;
    const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) AS position FROM analysis_actions WHERE run_id=?').get(runId) as { position: number }).position + 1;
    let prior: Partial<ToolActivity> = {};
    if (existing?.data) { try { prior = JSON.parse(existing.data) as Partial<ToolActivity>; } catch { /* Corrupt legacy activity remains replaceable. */ } }
    const terminal = prior.terminal || activity.terminal
      ? { ...prior.terminal, ...activity.terminal,
        // Stream deltas append to their own channel. They never overwrite
        // immutable process identity or the other output channel. A terminal
        // result contains the runner's complete final buffers, so it replaces
        // its streamed prefix rather than duplicating it.
        ...(activity.terminal?.stdout !== undefined ? { stdout: activity.terminal.finishedAt ? activity.terminal.stdout : `${prior.terminal?.stdout ?? ''}${activity.terminal.stdout}` } : {}),
        ...(activity.terminal?.stderr !== undefined ? { stderr: activity.terminal.finishedAt ? activity.terminal.stderr : `${prior.terminal?.stderr ?? ''}${activity.terminal.stderr}` } : {}),
      }
      : undefined;
    const data = JSON.stringify({ ...prior, ...activity, ...(terminal ? { terminal } : {}), approval: undefined, attachment: undefined });
    if (existing) this.db.prepare('UPDATE analysis_actions SET label=?, detail=?, data=? WHERE id=? AND run_id=?').run(activity.label, activity.detail ?? prior.detail ?? null, data, existing.id, runId);
    else {
      this.db.prepare('INSERT INTO analysis_actions (id, run_id, label, detail, data, position) VALUES (?, ?, ?, ?, ?, ?)').run(storageId, runId, activity.label, activity.detail ?? null, data, position);
      if (activity.kind !== 'progress') this.db.prepare('UPDATE analysis_runs SET action_count=action_count+1 WHERE id=?').run(runId);
    }
    return this.getAnalysisRun(runId)!;
  }

  /** A run still `running` when the process starts was killed mid-flight: no
   * live generation can own it. Marking it keeps it distinguishable from a
   * completed or cancelled run. Its Task Memory and evidence are retained. */
  recoverInterruptedRuns(): number {
    const runs = this.db.prepare("SELECT id FROM analysis_runs WHERE status='running'").all() as unknown as Array<{ id: string }>;
    for (const run of runs) this.finishAnalysisRun(run.id, 'interrupted', null);
    return runs.length;
  }

  /** The last successful Max Context result per stable configuration and KV mode. Only
   * complete, valid options are written, all-or-nothing, so a failed run never reaches here. */
  saveContextDiscoveryOptions(configKey: string, identity: string, options: readonly ContextDiscoveryOption[]): number {
    const valid = options.filter((option) => isPersistableDiscoveryOption(option));
    if (!valid.length) return 0;
    const statement = this.db.prepare('INSERT OR REPLACE INTO context_discoveries (config_key, kv_cache_type, kv_offload, model_id, context_window, option, identity, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const savedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const option of valid) {
        const persisted: Partial<ContextDiscoveryOption> = { ...option };
        delete persisted.restored;
        statement.run(configKey, option.kvCacheType, option.kvOffload ? 1 : 0, option.modelId, option.contextWindow, JSON.stringify(persisted), identity, savedAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return valid.length;
  }

  /** Rows that fail validation are ignored rather than trusted or thrown. */
  loadContextDiscoveryOptions(configKey: string, modelId: string, hardLimit?: number): ContextDiscoveryOption[] {
    const rows = this.db.prepare('SELECT kv_cache_type, kv_offload, option FROM context_discoveries WHERE config_key=? AND model_id=?').all(configKey, modelId) as unknown as Array<{ kv_cache_type: string; kv_offload: number; option: string }>;
    return rows.flatMap((row) => parseStoredDiscoveryOption(row.option, { modelId, kvCacheType: row.kv_cache_type, kvOffload: row.kv_offload === 1, hardLimit }) ?? []);
  }

  /** Display-only catalog while the model is unloaded. It never authorizes a
   * launch: selection must match the live configuration identity and memory. */
  loadLatestContextDiscoveryOptions(modelId: string, hardLimit?: number): ContextDiscoveryOption[] {
    const rows = this.db.prepare('SELECT config_key FROM context_discoveries WHERE model_id=? GROUP BY config_key ORDER BY MAX(saved_at) DESC, config_key LIMIT 16').all(modelId) as unknown as Array<{ config_key: string }>;
    for (const row of rows) {
      const options = this.loadContextDiscoveryOptions(row.config_key, modelId, hardLimit);
      if (options.length) return options;
    }
    return [];
  }

  /** Checkpoints the run's timeline at a stable event boundary (never per token). */
  saveAnalysisRunTimeline(runId: string, timeline: readonly ThinkingTimelineEvent[], richArtifacts?: readonly RichArtifact[]): void {
    this.db.prepare("UPDATE analysis_runs SET timeline=?, rich_artifacts=COALESCE(?, rich_artifacts) WHERE id=? AND status='running'").run(JSON.stringify(timeline), richArtifacts ? JSON.stringify(richArtifacts) : null, runId);
  }

  /** Ends a run. A run that ends without a final answer keeps its timeline,
   * any visible partial output and its failure text, and actions still shown
   * as running are closed so the reconstructed history never shows live work. */
  finishAnalysisRun(runId: string, status: AnalysisRun['status'], assistantMessageId: string | null, history: { timeline?: readonly ThinkingTimelineEvent[]; partialOutput?: string; error?: string; richArtifacts?: readonly RichArtifact[] } = {}): AnalysisRun {
    return this.finalizeAnalysisRun(runId, status, assistantMessageId, history, true);
  }

  /** The final response, frozen snapshot and attempt status commit together. */
  completeAnalysisRun(runId: string, content: string, response: Pick<ChatMessage, 'thinking' | 'thinkingTimeline' | 'generationStats' | 'richArtifacts'>): { run: AnalysisRun; assistant: ChatMessage | null } {
    const prior = this.getAnalysisRun(runId);
    if (!prior) throw new Error('Run not found');
    if (prior.status !== 'running') return { run: prior, assistant: prior.assistantMessageId ? this.getMessage(prior.assistantMessageId) : null };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const assistant = content || response.richArtifacts?.length ? this.addMessage(prior.conversationId, 'assistant', content, undefined, [], { ...response, ...(prior.logicalTaskId ? { logicalTaskId: prior.logicalTaskId, taskPlan: this.getAgentPlan(prior.conversationId, prior.logicalTaskId) ?? undefined } : {}) }) : null;
      const run = this.finalizeAnalysisRun(runId, 'completed', assistant?.id ?? null, { timeline: response.thinkingTimeline, richArtifacts: response.richArtifacts }, false);
      this.db.exec('COMMIT');
      return { run, assistant };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private finalizeAnalysisRun(runId: string, status: AnalysisRun['status'], assistantMessageId: string | null, history: { timeline?: readonly ThinkingTimelineEvent[]; partialOutput?: string; error?: string; richArtifacts?: readonly RichArtifact[] }, transaction: boolean): AnalysisRun {
    const prior = this.getAnalysisRun(runId);
    if (!prior) throw new Error('Run not found');
    if (prior.status !== 'running') return prior;
    const finishedAt = new Date().toISOString();
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      this.freezeTaskSnapshot(runId);
      this.db.prepare('UPDATE analysis_runs SET status=?, assistant_message_id=?, completed_at=?, timeline=COALESCE(?, timeline), partial_output=?, error=?, rich_artifacts=COALESCE(?, rich_artifacts) WHERE id=?')
        .run(status, assistantMessageId, finishedAt, history.timeline ? JSON.stringify(history.timeline) : null, history.partialOutput?.trim() ? history.partialOutput : null, history.error ?? null, history.richArtifacts ? JSON.stringify(history.richArtifacts) : null, runId);
      if (status !== 'completed') this.closeRunningActions(runId, status, finishedAt);
      if (transaction) this.db.exec('COMMIT');
    } catch (error) {
      if (transaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getAnalysisRun(runId)!;
  }

  private closeRunningActions(runId: string, status: AnalysisRun['status'], finishedAt: string): void {
    const rows = this.db.prepare('SELECT id, data FROM analysis_actions WHERE run_id=?').all(runId) as unknown as Array<{ id: string; data: string | null }>;
    for (const row of rows) {
      let data: Partial<ToolActivity>;
      try { data = row.data ? JSON.parse(row.data) as Partial<ToolActivity> : {}; } catch { continue; }
      if (data.state !== 'running') continue;
      const stopped = status !== 'error';
      const closed: Partial<ToolActivity> = { ...data, state: 'error', ...(data.terminal && !data.terminal.finishedAt ? { terminal: { ...data.terminal, finishedAt, ...(stopped ? { cancelled: true, status: 'cancelled' as const } : { status: 'error' as const }) } } : {}) };
      this.db.prepare('UPDATE analysis_actions SET data=? WHERE id=? AND run_id=?').run(JSON.stringify(closed), row.id, runId);
    }
  }

  listAnalysisRuns(conversationId: string): AnalysisRun[] { return (this.db.prepare('SELECT r.*, s.plan AS task_snapshot FROM analysis_runs r LEFT JOIN agent_task_snapshots s ON s.run_id=r.id WHERE r.conversation_id=? ORDER BY r.created_at ASC').all(conversationId) as unknown as AnalysisRunRow[]).map((row) => mapRun(row, this.db.prepare('SELECT * FROM analysis_actions WHERE run_id=? ORDER BY position ASC').all(row.id) as unknown as AnalysisActionRow[])); }

  private getAnalysisRun(runId: string): AnalysisRun | null { const row = this.db.prepare('SELECT r.*, s.plan AS task_snapshot FROM analysis_runs r LEFT JOIN agent_task_snapshots s ON s.run_id=r.id WHERE r.id=?').get(runId) as unknown as AnalysisRunRow | undefined; return row ? mapRun(row, this.db.prepare('SELECT * FROM analysis_actions WHERE run_id=? ORDER BY position ASC').all(runId) as unknown as AnalysisActionRow[]) : null; }
}
