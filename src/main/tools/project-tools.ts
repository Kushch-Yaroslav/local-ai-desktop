import { projectPath, snapshotFile, atomicProjectWrite, PathPolicyError } from './project-path';
import { signalOwnedGroup } from './process-group';
import { agentRuntimePath } from '../services/paths';
import { protectedRuntime } from '../services/protected-runtime';
import { execFile, spawn } from 'node:child_process';
import { open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RiskCategory } from '../../shared/types';

const execFileAsync = promisify(execFile);
const ignoredDirectories = new Set(['.git', '.local-ai-backups', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage']);
const maxLineReadBytes = 8_000_000;
const defaultPageSize = 100;
const maxPageSize = 250;
const defaultChunkBytes = 64_000;
const maxChunkBytes = 128_000;

/** Kept outside tool schemas; it is protocol metadata, not a tool argument. */
export type ProjectToolCall = { name: string; arguments: Record<string, unknown>; toolCallId?: string };
export type ProjectToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ConfirmationRequest = { title: string; detail: string; category: RiskCategory; actionId: string; root?: string; preview?: {projectId:string;origin:string} };
export type ApprovalResult = { approved: boolean; reason: 'user_rejected' | 'cancelled' | 'once' | 'session' | 'ui_unavailable' | 'timeout' };
export type ConfirmAction = (request: ConfirmationRequest, signal: AbortSignal) => Promise<ApprovalResult>;
export type TerminalPolicy = { kind: 'allow' | 'confirm' | 'block'; category?: RiskCategory };

export class ReadonlyProjectTools {
  private constructor(private readonly root: string, private readonly confirm: ConfirmAction) {}

  static async open(root: string, confirm: ConfirmAction): Promise<ReadonlyProjectTools> {
    const resolved = await realpath(root); const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error('Рабочая папка не является каталогом');
    return new ReadonlyProjectTools(resolved, confirm);
  }

  /** Compact composer search. It exposes only paths below an already-authorized root. */
  static async findResources(root: string, query: string, limit = 40): Promise<Array<{ relativePath: string; kind: 'file' | 'folder' }>> {
    const resolved = await realpath(root); const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error('Рабочая папка не является каталогом');
    const needle = query.toLowerCase(); const results: Array<{ relativePath: string; kind: 'file' | 'folder' }> = [];
    const walk = async (directory: string, level: number): Promise<void> => {
      if (results.length >= limit || level > 8) return;
      const entries = await readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (results.length >= limit || entry.isSymbolicLink()) continue;
        const full = resolve(directory, entry.name); const kind = entry.isDirectory() ? 'folder' as const : 'file' as const;
        const relativePath = relative(resolved, full).replaceAll(sep, '/');
        if (!needle || entry.name.toLowerCase().includes(needle) || relativePath.toLowerCase().includes(needle)) results.push({ relativePath, kind });
        if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await walk(full, level + 1);
      }
    };
    await walk(resolved, 1);
    return results;
  }

  async execute(call: ProjectToolCall, signal: AbortSignal, actionId: string): Promise<string> {
    try {
      if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
      if (call.name === 'list_directory') return await this.listDirectory(this.text(call.arguments.path), this.number(call.arguments.depth, 2, 1, 4), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'find_files' || call.name === 'search_files') return await this.findFiles(this.requiredText(call.arguments.query, 'query'), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'search_text') return await this.searchText(this.requiredText(call.arguments.query, 'query'), this.text(call.arguments.path), this.number(call.arguments.offset, 0, 0, 100_000), this.pageSize(call.arguments));
      if (call.name === 'read_file') return await this.readTextFile(call);
      if (call.name === 'inspect_package_json') return await this.readTextFile({ name: 'read_file', arguments: { path: 'package.json', max_bytes: maxChunkBytes } });
      if (call.name === 'git_status') return await this.gitStatus();
      if (call.name === 'git_diff') return await this.gitDiff();
      if (call.name === 'apply_patch') return await this.applyPatch(this.requiredText(call.arguments.patch, 'patch'), signal, actionId);
      if (call.name === 'write_file' || call.name === 'create_file') return await this.createFile(this.requiredText(call.arguments.path, 'path'), this.requiredContent(call.arguments.content), signal);
      if (call.name === 'delete_file') return await this.deleteFile(this.requiredText(call.arguments.path, 'path'), signal, actionId);
      return JSON.stringify({ error: `Неизвестный инструмент проекта: ${call.name}` });
    } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : 'Ошибка чтения проекта', ...(error instanceof PathPolicyError ? { code: error.code, approved: false, retrySameArguments: false } : {}) }); }
  }

  private async listDirectory(path: string, depth: number, offset: number, limit: number): Promise<string> {
    const directory = await this.resolveExisting(path || '.'); const output: string[] = []; const collectionLimit = offset + limit + 1;
    const walk = async (current: string, level: number): Promise<void> => {
      if (output.length >= collectionLimit) return;
      const entries = await readdir(current, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (output.length >= collectionLimit) return;
        const display = relative(this.root, resolve(current, entry.name)) || '.';
        if (entry.isSymbolicLink()) { output.push(`${display} [symlink skipped]`); continue; }
        output.push(`${display}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory() && level < depth && !ignoredDirectories.has(entry.name)) await walk(resolve(current, entry.name), level + 1);
      }
    };
    await walk(directory, 1);
    const entries = output.slice(offset, offset + limit); const hasMore = output.length > offset + limit;
    return JSON.stringify({ root: path || '.', depth, offset, entries, has_more: hasMore, next_offset: hasMore ? offset + entries.length : null });
  }

  private async findFiles(query: string, offset: number, limit: number): Promise<string> {
    const matches: string[] = []; const needle = query.toLowerCase(); const collectionLimit = offset + limit + 1;
    const walk = async (directory: string, level: number): Promise<void> => {
      if (matches.length >= collectionLimit || level > 8) return;
      const entries = await readdir(directory, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (matches.length >= collectionLimit) return;
        if (entry.isSymbolicLink()) continue;
        const full = resolve(directory, entry.name); const display = relative(this.root, full);
        if (entry.name.toLowerCase().includes(needle)) matches.push(`${display}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await walk(full, level + 1);
      }
    };
    await walk(this.root, 1); const page = matches.slice(offset, offset + limit); const hasMore = matches.length > offset + limit;
    return JSON.stringify({ query, offset, matches: page, has_more: hasMore, next_offset: hasMore ? offset + page.length : null });
  }

  private async searchText(query: string, path: string, offset: number, limit: number): Promise<string> {
    const target = await this.resolveExisting(path || '.'); const matches: Array<{ path: string; line: number; text: string }> = []; const needle = query.toLowerCase(); const collectionLimit = offset + limit + 1;
    const inspect = async (file: string): Promise<void> => {
      if (matches.length >= collectionLimit) return;
      const info = await stat(file); if (!info.isFile() || info.size > maxLineReadBytes) return;
      const content = await readFile(file, 'utf8'); if (content.includes('\0')) return;
      content.split(/\r?\n/).forEach((line, index) => { if (matches.length < collectionLimit && line.toLowerCase().includes(needle)) matches.push({ path: relative(this.root, file), line: index + 1, text: line.slice(0, 300) }); });
    };
    const walk = async (current: string, level: number): Promise<void> => {
      const info = await stat(current);
      if (info.isFile()) { await inspect(current); return; }
      if (level > 8 || matches.length >= collectionLimit) return;
      const entries = await readdir(current, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (matches.length >= collectionLimit || entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        await walk(resolve(current, entry.name), level + 1);
      }
    };
    await walk(target, 1); const page = matches.slice(offset, offset + limit); const hasMore = matches.length > offset + limit;
    return JSON.stringify({ query, path: path || '.', offset, matches: page, has_more: hasMore, next_offset: hasMore ? offset + page.length : null });
  }

  private async readTextFile(call: ProjectToolCall): Promise<string> {
    const path = this.requiredText(call.arguments.path, 'path'); const file = await this.resolveExisting(path); const info = await stat(file);
    if (!info.isFile()) throw new Error('Указанный путь не является файлом');
    const startLine = typeof call.arguments.start_line === 'number' ? this.number(call.arguments.start_line, 1, 1, 10_000_000) : null;
    if (startLine !== null && info.size <= maxLineReadBytes) {
      const endLine = this.number(call.arguments.end_line, startLine + 399, startLine, startLine + 799);
      const content = await readFile(file, 'utf8'); if (content.includes('\0')) throw new Error('Двоичные файлы не читаются');
      const lines = content.split(/\r?\n/); const from = Math.min(startLine, Math.max(lines.length, 1)); const to = Math.min(endLine, lines.length);
      return JSON.stringify({ path: relative(this.root, file), size_bytes: info.size, fingerprint: `${info.size}:${Math.floor(info.mtimeMs)}`, start_line: from, end_line: to, content: lines.slice(from - 1, to).join('\n'), has_more: to < lines.length, next_start_line: to < lines.length ? to + 1 : null });
    }
    const offset = this.number(call.arguments.offset, 0, 0, info.size); const maxBytes = this.number(call.arguments.max_bytes, defaultChunkBytes, 1, maxChunkBytes);
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, info.size - offset)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const content = buffer.subarray(0, bytesRead).toString('utf8'); if (content.includes('\0')) throw new Error('Двоичные файлы не читаются');
      const end = offset + bytesRead;
      return JSON.stringify({ path: relative(this.root, file), size_bytes: info.size, fingerprint: `${info.size}:${Math.floor(info.mtimeMs)}`, byte_start: offset, byte_end: end, content, has_more: end < info.size, next_offset: end < info.size ? end : null });
    } finally { await handle.close(); }
  }

  private async gitStatus(): Promise<string> {
    try { const { stdout } = await execFileAsync('/usr/bin/git', ['-C', this.root, 'status', '--short', '--branch'], { timeout: 5_000, maxBuffer: 100_000 }); return JSON.stringify({ status: stdout || 'Рабочее дерево чистое' }); }
    catch { return JSON.stringify({ status: 'Git-репозиторий не обнаружен или статус недоступен' }); }
  }

  private async gitDiff(): Promise<string> {
    try { const { stdout } = await execFileAsync('/usr/bin/git', ['-C', this.root, 'diff', '--no-ext-diff', '--no-textconv'], { timeout: 5_000, maxBuffer: 200_000 }); return JSON.stringify({ diff: stdout || 'Нет незакоммиченных изменений' }); }
    catch { return JSON.stringify({ error: 'Git diff недоступен' }); }
  }

  private async createFile(path: string, content: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
    const candidate = await this.resolveWritePath(path); const exists = await stat(candidate).then(() => true).catch(() => false);
    if (exists) return JSON.stringify({ error: 'Файл уже существует. Для изменения существующего файла используй apply_patch.' });
    const backup = await snapshotFile(candidate);
    await atomicProjectWrite(candidate, content, true);
    return JSON.stringify({ path, created: true, backup, bytes: Buffer.byteLength(content) });
  }

  private async deleteFile(path: string, signal: AbortSignal, actionId: string): Promise<string> {
    const file = await this.resolveExisting(path); const info = await stat(file);
    if (!info.isFile()) return JSON.stringify({ error: 'Можно удалить только один файл, не каталог.' });
    const approval = await this.confirm({ title: 'Удалить файл?', detail: path, category: 'file_delete', actionId, root: this.root }, signal);
    if (!approval.approved) return JSON.stringify({ error: 'Operation was not authorized; do not bypass using another tool.', code: 'PERMISSION_DENIED', retrySameArguments: false, approved: false, reason: approval.reason });
    if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
    const backup = await snapshotFile(file);
    await this.resolveWritePath(path); await unlink(file); return JSON.stringify({ path, deleted: true, backup });
  }

  private async applyPatch(patch: string, signal: AbortSignal, actionId: string): Promise<string> {
    const lines = patch.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '*** Begin Patch' || !lines.includes('*** End Patch')) throw new Error('Expected *** Begin Patch ... *** End Patch');
    const staged = new Map<string, { path: string; original: string | null; next: string | null }>();
    const deletions: string[] = []; let index = 1;
    while (index < lines.length && lines[index] !== '*** End Patch') {
      const header = lines[index++];
      if (!header.trim()) continue;
      const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(header);
      if (!match) throw new Error(`Unknown patch section: ${header}`);
      const [, kind, path] = match;
      const target = await this.resolveWritePath(path);
      const body: string[] = [];
      while (index < lines.length && !lines[index].startsWith('*** ')) body.push(lines[index++]);
      let change = staged.get(target);
      if (!change) {
        const info = await stat(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
        if (info && info.size > maxLineReadBytes) throw new Error('Patch target exceeds the 8 MB text-edit limit; use an explicitly approved terminal migration for large/binary files');
        const original = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
        change = { path, original, next: original }; staged.set(target, change);
      }
      if (kind === 'Add') {
        if (change.next !== null) throw new Error(`File already exists: ${path}`);
        if (body.some(line => line && !line.startsWith('+'))) throw new Error(`Invalid added line: ${path}`);
        change.next = body.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
      } else if (kind === 'Delete') {
        if (change.next === null) throw new Error(`Missing file: ${path}`);
        change.next = null; deletions.push(path);
      } else {
        if (change.next === null) throw new Error(`Missing file: ${path}`);
        for (const raw of body.join('\n').split('\n@@\n')) {
          const hunk = raw.replace(/^@@[^\n]*\n?/, '').split('\n').filter(line => line !== '\\ No newline at end of file');
          const before = hunk.filter(line => line.startsWith(' ') || line.startsWith('-')).map(line => line.slice(1)).join('\n');
          const after = hunk.filter(line => line.startsWith(' ') || line.startsWith('+')).map(line => line.slice(1)).join('\n');
          if (!before || change.next.indexOf(before) < 0 || change.next.indexOf(before) !== change.next.lastIndexOf(before)) throw new Error(`Patch must match exactly one current snippet: ${path}`);
          change.next = change.next.replace(before, () => after);
        }
      }
    }
    if (deletions.length) {
      const decision = await this.confirm({ title: 'Delete files in patch?', detail: deletions.join('\n'), category: 'file_delete', actionId, root: this.root }, signal);
      if (!decision.approved) return JSON.stringify({ error: 'Patch deletion not authorized; no files changed', code: 'PERMISSION_DENIED', approved: false, reason: decision.reason, retrySameArguments: false });
    }
    const backups: string[] = [];
    for (const [target, change] of staged) {
      if (await this.resolveWritePath(change.path) !== target) throw new PathPolicyError('Patch destination changed');
      const current = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (current !== change.original) throw new Error(`File changed while staging patch: ${change.path}`);
      if (signal.aborted) return JSON.stringify({ error: 'Patch cancelled; no files changed', code: 'CANCELLED' });
      backups.push(await snapshotFile(target));
    }
    const applied: string[] = [];
    try {
      for (const [target, change] of staged) {
        if (signal.aborted) throw new Error('Patch cancelled');
        if (await this.resolveWritePath(change.path) !== target) throw new PathPolicyError('Patch destination changed');
        if (change.next === null) await unlink(target); else await atomicProjectWrite(target, change.next, change.original === null);
        applied.push(target);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const target of applied.reverse()) {
        const change = staged.get(target)!;
        try {
          if (await this.resolveWritePath(change.path) !== target) throw new PathPolicyError('Rollback path changed');
          if (change.original === null) await unlink(target); else await atomicProjectWrite(target, change.original);
        } catch (rollback) { rollbackErrors.push(String(rollback)); }
      }
      return JSON.stringify({ error: String(error), backups, rollbackErrors });
    }
    return JSON.stringify({ applied: true, files: [...staged.values()].map(change => change.path), backups });
  }

  private async resolveWritePath(input: string): Promise<string> {
    if (!input) throw new PathPolicyError('A workspace path is required');
    return projectPath(this.root, input, true);
  }
  private async resolveExisting(input: string): Promise<string> {
    return realpath(await projectPath(this.root, input || '.'));
  }
  private text(value: unknown): string { return typeof value === 'string' ? value : ''; }
  private requiredText(value: unknown, field: string): string { const text = this.text(value).trim(); if (!text) throw new Error(`Не указан обязательный параметр "${field}"`); return text; }
  private requiredContent(value: unknown): string { if (typeof value !== 'string') throw new Error('Не указан обязательный параметр "content"'); return value; }
  private number(value: unknown, fallback: number, min: number, max: number): number { const number = typeof value === 'number' ? Math.floor(value) : fallback; return Math.max(min, Math.min(max, number)); }
  private pageSize(argumentsObject: Record<string, unknown>): number { return this.number(argumentsObject.limit ?? argumentsObject.max_results, defaultPageSize, 1, maxPageSize); }
}

/** Terminal access is deliberately independent of the project filesystem scope. */
export class TerminalTools {
  private constructor(public readonly cwd: string, private readonly confirm: ConfirmAction) {}

  static async open(initialCwd: string, confirm: ConfirmAction): Promise<TerminalTools> {
    const cwd = await realpath(initialCwd); const details = await stat(cwd);
    if (!details.isDirectory()) throw new Error('Начальная папка terminal не является каталогом');
    return new TerminalTools(cwd, confirm);
  }

  async execute(call: ProjectToolCall, signal: AbortSignal, actionId: string): Promise<string> {
    try {
      if (call.name !== 'run_terminal') return JSON.stringify({ error: `Неизвестный terminal-инструмент: ${call.name}` });
      const command = typeof call.arguments.command === 'string' ? call.arguments.command.trim() : '';
      if (!command) return JSON.stringify({ error: 'Не указан обязательный параметр "command"' });
      if (command.split(/[^\w-]+/).some(token => ['kill', 'pkill', 'killall', 'fuser', 'killpg', 'pidfd_send_signal', 'systemctl', 'service', 'reboot', 'shutdown'].includes(token))) {
        return JSON.stringify({ code: 'PROTECTED_RUNTIME_PROCESS', retrySameArguments: false, error: 'Operation blocked: application infrastructure is required for agent execution. Use the Rust agent owned-task controls for process cleanup.' });
      }
      const timeout = typeof call.arguments.timeout_ms === 'number' ? Math.max(1_000, Math.min(120_000, Math.floor(call.arguments.timeout_ms))) : 60_000;
      const policy = terminalPolicy(command);
      if (policy.kind === 'allow') {
        for (const stage of splitPipeline(command) ?? []) for (const token of (words(stage) ?? []).slice(1)) {
          const path = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
          if (/[~*?[]/.test(path)) { policy.kind = 'confirm'; policy.category = 'system_command'; break; }
          if (!path.startsWith('-') && (path.includes('/') || await stat(resolve(this.cwd, path)).then(() => true, () => false))) {
            try { await projectPath(this.cwd, path); } catch { policy.kind = 'confirm'; policy.category = 'system_command'; break; }
          }
        }
      }
      if (policy.kind === 'block') return JSON.stringify({ error: 'Команда заблокирована terminal policy.' });
      if (policy.kind === 'confirm') {
        const approval = await this.confirm({ title: 'Разрешить terminal command?', detail: command, category: policy.category!, actionId, root: this.cwd }, signal);
        if (!approval.approved) return JSON.stringify({ error: 'Operation was not authorized; do not bypass using another tool.', code: 'PERMISSION_DENIED', retrySameArguments: false, approved: false, reason: approval.reason });
      }
      if (signal.aborted) return JSON.stringify({ error: 'Generation cancelled' });
      return await runTerminal(command, timeout, this.cwd, signal, policy.kind !== 'allow');
    } catch (error) { return JSON.stringify({ error: error instanceof Error ? error.message : 'Ошибка terminal' }); }
  }
}

/**
 * Safety policy is intentionally separate from project path validation. The
 * terminal may work in a user's home directory and elsewhere, while commands
 * that can change the system still require explicit confirmation.
 */
export function terminalPolicy(command: string): TerminalPolicy {
  const value = command.trim();
  if (!value || value.includes('\0')) return { kind: 'block' };
  if (/[`$][(]|`|\n|;|&&|\|\||[<>]|(?:^|[^&])&(?!&)/.test(value)) return { kind: 'confirm', category: /[<>]/.test(value) ? 'shell_redirection' : 'shell_chaining' };
  const stages = splitPipeline(value);
  if (!stages) return { kind: 'confirm', category: 'shell_chaining' };
  const classifications = stages.map(classifyTerminalStage);
  if (!stages.length || classifications.some((classification) => !classification) || (stages.length > 1 && classifications.includes('trusted_project_execution'))) return { kind: 'confirm', category: 'system_command' };
  return { kind: 'allow' };
}

/** Split only unquoted pipe stages. Anything shell-like we cannot classify is rejected. */
function splitPipeline(command: string): string[] | null {
  const stages: string[] = []; let value = ''; let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) { value += char; if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"') { quote = char; value += char; continue; }
    if (char === '\\') { const next = command[++index]; if (next === undefined) return null; value += `\\${next}`; continue; }
    if (char === '|') { stages.push(value.trim()); value = ''; continue; }
    value += char;
  }
  if (quote) return null;
  stages.push(value.trim());
  return stages;
}

function words(stage: string): string[] | null {
  const tokens: string[] = []; let value = ''; let quote = '';
  for (let index = 0; index < stage.length; index += 1) { const char = stage[index]; if (quote) { if (char === quote) quote = ''; else value += char; continue; } if (char === "'" || char === '"') { quote = char; continue; } if (/\s/.test(char)) { if (value) { tokens.push(value); value = ''; } continue; } if (char === '\\') { const next = stage[++index]; if (next === undefined) return null; value += next; continue; } value += char; }
  if (quote) return null; if (value) tokens.push(value); return tokens;
}
type TerminalStageClassification = 'read_only' | 'trusted_project_execution' | null;
function classifyTerminalStage(stage: string): TerminalStageClassification {
  return readOnlyStage(stage) ? 'read_only' : null;
}
function readOnlyGitBranch(args: string[]): boolean {
  if (!args.length) return true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--show-current' || argument === '--list' || argument === '-l' || argument.startsWith('--list=')) continue;
    if (argument === '--contains' || argument === '--merged' || argument === '--no-merged') { if (args[index + 1] && !args[index + 1].startsWith('-')) index += 1; continue; }
    if (argument.startsWith('--contains=') || argument.startsWith('--merged=') || argument.startsWith('--no-merged=')) continue;
    return false;
  }
  return true;
}
function readOnlyStage(stage: string): boolean {
  const tokens = words(stage); if (!tokens?.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
  const [bin, ...args] = tokens; const command = bin.replace(/^.*\//, '');
  if (![command, `/usr/bin/${command}`, `/bin/${command}`].includes(bin) || args.some(arg => arg === '--pre' || arg.startsWith('--pre=') || arg === '--output' || arg.startsWith('--output=') || command === 'sort' && arg.startsWith('-o'))) return false;
  if (args.some(arg => arg.startsWith('--files0-from') || command === 'rg' && (arg === '--follow' || /^-[^-]*L/.test(arg)) || command === 'grep' && (arg.startsWith('--dereference-recursive') || /^-[^-]*R/.test(arg)) || command === 'du' && (arg.startsWith('--dereference') || /^-[^-]*[LH]/.test(arg)))) return false;
  if (['pwd', 'whoami', 'uname', 'echo', 'printf', 'ls', 'grep', 'rg', 'cat', 'head', 'tail', 'wc', 'stat', 'du'].includes(command)) return command !== 'find' || !args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg));
  if (command === 'git') {
    const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'));
    const subcommand = args[subcommandIndex];
    if (args.some(arg => arg === '-c' || arg.startsWith('--output') || arg === '--ext-diff' || arg === '--textconv' || arg === '--paginate') || args[0] !== subcommand) return false;
    const displaysDiff = ['diff', 'show'].includes(subcommand ?? '') || subcommand === 'log' && args.some(arg => arg.startsWith('--patch') || arg === '-p' || arg === '-u');
    if (displaysDiff && !(args.includes('--no-ext-diff') && args.includes('--no-textconv'))) return false;
    if (['status', 'diff', 'log', 'show', 'rev-parse'].includes(subcommand ?? '')) return true;
    return subcommand === 'branch' && readOnlyGitBranch(args.slice(subcommandIndex + 1));
  }
  if (command === 'gsettings' && args[0] === 'get') return true;
  if (command === 'systemctl' && args[0] === '--user' && ['status', 'is-active', 'is-enabled', 'show'].includes(args[1] ?? '')) return true;
  return false;
}
function runTerminal(command: string, timeout: number, cwd: string, signal: AbortSignal, authorized = true): Promise<string> {
  return new Promise((resolve) => {
    // The assistant call already retains the full command. Repeating a large
    // heredoc in the tool result can consume the entire Agent context without
    // retaining a large heredoc adds little value, so keep only a bounded diagnostic echo here.
    const commandDiagnostic = command.length > 1_200 ? `${command.slice(0, 1_200)}\n[command diagnostic truncated]` : command;
    const child = spawn(agentRuntimePath(), ['--terminal-exec', cwd, command, String(timeout)], { cwd, env: protectedRuntime.environment(!authorized), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let stdoutTruncated = false; let stderrTruncated = false; let finished = false;
    const append = (current: string, chunk: string, limit: number): string => { if (current.length >= limit) return current; const next = `${current}${chunk}`; return next.length > limit ? next.slice(0, limit) : next; };
    const finish = (result: Record<string, unknown>) => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); clearTimeout(timer); resolve(JSON.stringify(result)); };
    const terminate = () => { if (signalOwnedGroup(child, 'SIGTERM')) setTimeout(() => { signalOwnedGroup(child, 'SIGKILL'); }, 2_000).unref(); };
    const abort = () => { terminate(); finish({ cancelled: true, reason: 'Generation cancelled' }); };
    const timer = setTimeout(() => { terminate(); finish({ timed_out: true, error: `Terminal command exceeded timeout of ${timeout}ms`, command: commandDiagnostic, cwd, stdout: stdoutTruncated ? `${stdout}\n[diagnostic output truncated]` : stdout, stderr: stderrTruncated ? `${stderr}\n[diagnostic output truncated]` : stderr }); }, timeout);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdoutTruncated ||= stdout.length + text.length > 800_000; stdout = append(stdout, text, 800_000); }); child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString(); stderrTruncated ||= stderr.length + text.length > 20_000; stderr = append(stderr, text, 20_000); });
    child.on('error', (error) => finish({ error: error.message, code: 'PROTECTED_RUNTIME_PROCESS', retrySameArguments: false, cwd }));
    child.on('close', (code, signalName) => {
      try { const result = JSON.parse(stdout); finish(result); }
      catch { finish({ command: commandDiagnostic, cwd, exit_code: code, signal: signalName, code: 'PROTECTED_RUNTIME_PROCESS', retrySameArguments: false, error: 'Isolated terminal unavailable; unprotected execution is forbidden.', stdout, stderr }); }
    });
  });
}
