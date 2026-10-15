import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './database';
import type { AgentPlan } from '../../shared/types';
import { agentStatus } from '../../shared/agent-status';
import { withRunHistory } from '../../shared/run-history';
import { agentEvidenceDir } from './agent-evidence';

const verifiedPlan = (text: string): AgentPlan => ({ milestones: [], taskMemory: {
  entries: [], plan: { steps: [{ id: 'p1', text, status: 'completed' }] },
  deliverables: { items: [{ id: 'd1', text, status: 'verified', proof: ['ev-001'] }] },
  verification: { epoch: 2, next: 1, code_changed: true, page_changed: true, revisions: { 'app.txt': 'known-revision' }, bindings: { 'npm test': ['d1'] }, records: [{ id: 'ev-001', kind: 'readback', class: 'readback', subject: 'app.txt', pass: true, epoch: 2, turn: 1 }] },
} });

async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'lad-logical-task-'));
  const file = join(directory, 'history.db'); let db = new Database(file);
  try {
    const chat = db.createConversation(); const other = db.createConversation();
    const metadataChat = db.createConversation(); const metadataTask = db.resolveLogicalTask(metadataChat.id);
    const metadataUser = db.addMessage(metadataChat.id, 'user', 'Create calculator in `/tmp/task-a-test`.', undefined, [], { logicalTaskId: metadataTask });
    db.createAnalysisRun(metadataChat.id, 'fast', { logicalTaskId: metadataTask, generationId: 'metadata', triggeringMessageId: metadataUser.id });
    db.setTaskScope(metadataChat.id, metadataTask, JSON.stringify({ projects: [], roots: ['/tmp/task-b-test', '/tmp/task-a-test'] }));
    const summary = db.listAgentTasks(metadataChat.id)[0];
    assert.equal(summary.title, 'Create calculator in task-a-test.');
    assert.deepEqual(summary.projects, [{ path: '/tmp/task-a-test' }], 'identity comes from task user request, not later conversation cwd');
    assert.equal(db.listAgentTasks(other.id, metadataTask).length, 0, 'task picker cannot expose another conversation');
    db.finishAnalysisRun(db.listAnalysisRuns(metadataChat.id)[0].id, 'completed', null);
    const taskA = db.resolveLogicalTask(chat.id);
    const user = db.addMessage(chat.id, 'user', 'Task A', undefined, [], { logicalTaskId: taskA });
    const first = db.createAnalysisRun(chat.id, 'fast', { logicalTaskId: taskA, generationId: 'generation-A', triggeringMessageId: user.id });
    assert.notEqual(taskA, first.id); assert.notEqual(taskA, first.generationId); assert.notEqual(taskA, chat.id);
    db.saveAgentPlan(chat.id, verifiedPlan('A'), taskA);
    db.setTaskScope(chat.id, taskA, '/project-a');
    const result = db.completeAnalysisRun(first.id, 'Task A complete', {});
    const frozen = JSON.stringify(result.run.taskPlan);
    assert.equal(result.assistant?.logicalTaskId, taskA);
    assert.deepEqual(result.assistant?.taskPlan, result.run.taskPlan);
    assert.equal(db.getAgentPlan(chat.id), null, 'completed task must not be the active projection');
    const taskB = db.resolveLogicalTask(chat.id);
    assert.notEqual(taskA, taskB);
    assert.equal(db.getAgentPlan(chat.id, taskB)?.taskMemory, undefined, 'new task cannot inherit evidence or deliverables');
    const userB = db.addMessage(chat.id, 'user', 'Task B', undefined, [], { logicalTaskId: taskB });
    assert.deepEqual(db.taskHistory(chat.id, taskA, db.listMessages(chat.id)).map(message => message.id), [user.id, result.assistant!.id], 'independent messages cannot break task A journal continuity');
    assert.deepEqual(db.taskHistory(chat.id, taskB, [{ ...user, logicalTaskId: taskB }, userB]).map(message => message.id), [userB.id], 'forged task metadata cannot choose ownership');
    assert.notEqual(agentEvidenceDir(directory, chat.id, taskA), agentEvidenceDir(directory, chat.id, taskB));
    assert.notEqual(agentEvidenceDir(directory, chat.id, taskA), agentEvidenceDir(directory, other.id, taskA));
    assert.throws(() => db.resolveLogicalTask(other.id, taskA), /continuation/);
    assert.throws(() => db.saveAgentPlan(other.id, verifiedPlan('injected'), taskA), /ownership/);
    assert.equal(db.resolveLogicalTask(chat.id, taskA), taskA, 'explicit continuation reuses logical ownership');
    db.prepareTaskAttempt(chat.id, taskA);
    assert.equal(agentStatus(db.getAgentPlan(chat.id, taskA)).checks.length, 0, 'readback between attempts cannot vouch for files changed by another task');
    assert.equal(db.getAgentPlan(chat.id, taskA)?.taskMemory?.deliverables?.items[0].status, 'implemented');
    assert.equal(JSON.stringify(db.listAnalysisRuns(chat.id)[0].taskPlan), frozen, 'continuation cannot rewrite old snapshot');
    const followup = db.addMessage(chat.id, 'user', 'Continue A', undefined, [], { logicalTaskId: taskA });
    const stopped = db.createAnalysisRun(chat.id, 'fast', { logicalTaskId: taskA, generationId: 'generation-stop', triggeringMessageId: followup.id });
    db.finishAnalysisRun(stopped.id, 'cancelled', null, { partialOutput: 'Working' });
    const stoppedSnapshot = db.listAnalysisRuns(chat.id).find(run => run.id === stopped.id)!.taskPlan;
    db.saveAgentPlan(chat.id, verifiedPlan('Resumed A'), taskA);
    assert.deepEqual(db.finishAnalysisRun(stopped.id, 'error', null).taskPlan, stoppedSnapshot, 'late finalization is idempotent');
    assert.equal(db.finishAnalysisRun(stopped.id, 'error', null).status, 'cancelled');
    const crashed = db.createAnalysisRun(chat.id, 'fast', { logicalTaskId: taskA, generationId: 'generation-crash', triggeringMessageId: followup.id });
    db.close(); db = new Database(file);
    assert.equal(db.resolveLogicalTask(chat.id, taskA), taskA);
    assert.equal(db.recoverInterruptedRuns(), 1);
    const recovered = db.listAnalysisRuns(chat.id).find(run => run.id === crashed.id)!;
    assert.equal(recovered.status, 'interrupted'); assert(recovered.taskPlan);
    assert.equal(db.getAgentPlan(chat.id, taskA)?.taskMemory?.plan?.steps[0].text, 'Resumed A');
    assert.equal(db.resolveLogicalTask(chat.id, undefined, user.id), taskA, 'Regenerate uses persisted user ownership');
    db.regenerateUserMessageAndTruncate(user.id);
    const archived = db.listAnalysisRuns(chat.id).find(run => run.id === first.id)!;
    assert.equal(archived.archived, true); assert.equal(JSON.stringify(archived.taskPlan), frozen);
    assert.deepEqual(db.getAgentPlan(chat.id, taskA)?.taskMemory?.verification?.records, []);
    assert.equal(db.getAgentPlan(chat.id, taskA)?.taskMemory?.verification?.code_changed, true, 'retry preserves mandatory functional checks');
    assert.equal(db.getAgentPlan(chat.id, taskA)?.taskMemory?.verification?.page_changed, true, 'retry preserves mandatory browser checks');
    assert.equal(db.getAgentPlan(chat.id, taskA)?.taskMemory?.verification?.next, 1, 'retry does not reuse prior evidence IDs');
    assert.deepEqual(db.getAgentPlan(chat.id, taskA)?.taskMemory?.verification?.revisions, { 'app.txt': 'known-revision' });
    assert.deepEqual(db.getAgentPlan(chat.id, taskA)?.taskMemory?.verification?.bindings, { 'npm test': ['d1'] }, 'retry cannot shed failing command relationships');
    const rendered = withRunHistory(db.listMessages(chat.id), db.listAnalysisRuns(chat.id));
    assert.equal(rendered.filter(message => message.archivedAttempt).length, 3, 'Regenerate retains previous attempt history');
    assert.equal(rendered.find(message => message.content === 'Task A complete')?.taskPlan?.taskMemory?.deliverables?.items[0].status, 'verified');
    const raw = new DatabaseSync(file);
    assert.throws(() => raw.prepare('UPDATE agent_task_snapshots SET plan=? WHERE run_id=?').run('{}', first.id), /immutable/);
    raw.close();
    assert.equal(db.setTaskScope(chat.id, taskA, '/project-b'), true);
    assert.equal(db.getAgentPlan(chat.id, taskA)?.taskMemory?.verification?.code_changed, true);
    assert.equal(JSON.stringify(db.listAnalysisRuns(chat.id)[0].taskPlan), frozen, 'scope changes cannot rewrite history');
    // Wall-clock timestamps can coincide. Task-owned branch selection must use
    // the triggering message identity, not archive an earlier orphan by time.
    const branch = db.createConversation(); const earlierId = db.resolveLogicalTask(branch.id);
    const earlierUser = db.addMessage(branch.id, 'user', 'Earlier', undefined, [], { logicalTaskId: earlierId });
    const earlierRun = db.createAnalysisRun(branch.id, 'fast', { logicalTaskId: earlierId, generationId: 'earlier', triggeringMessageId: earlierUser.id });
    db.finishAnalysisRun(earlierRun.id, 'cancelled', null);
    const laterId = db.resolveLogicalTask(branch.id);
    const laterUser = db.addMessage(branch.id, 'user', 'Later', undefined, [], { logicalTaskId: laterId });
    const laterRun = db.createAnalysisRun(branch.id, 'fast', { logicalTaskId: laterId, generationId: 'later', triggeringMessageId: laterUser.id });
    db.finishAnalysisRun(laterRun.id, 'cancelled', null);
    const sameTime = new DatabaseSync(file);
    sameTime.prepare('UPDATE analysis_runs SET created_at=? WHERE id=?').run(laterUser.createdAt, earlierRun.id); sameTime.close();
    db.regenerateUserMessageAndTruncate(laterUser.id);
    assert(!db.listAnalysisRuns(branch.id).find(run => run.id === earlierRun.id)?.archived, 'equal timestamps cannot archive another task');
    assert(db.listAnalysisRuns(branch.id).find(run => run.id === laterRun.id)?.archived);
    // Legacy conversation-scoped data is copied once, retained verbatim and never adopted as trusted task evidence.
    const legacy = db.createConversation(); const plan = verifiedPlan('Unscoped legacy');
    db.saveAgentPlan(legacy.id, plan); db.addMessage(legacy.id, 'assistant', 'Old reply');
    db.close(); db = new Database(file);
    assert.deepEqual(db.getLegacyAgentPlan(legacy.id), { ...plan, logicalTaskId: `legacy:${legacy.id}` });
    const newLegacyTask = db.resolveLogicalTask(legacy.id);
    assert.equal(db.getAgentPlan(legacy.id, newLegacyTask)?.taskMemory, undefined);
    assert.throws(() => db.resolveLogicalTask(legacy.id, `legacy:${legacy.id}`), /continuation/);
    assert.equal(db.listMessages(legacy.id)[0].content, 'Old reply');
    db.close(); db = new Database(file);
    assert.equal(db.getLegacyAgentPlan(legacy.id)?.taskMemory?.plan?.steps[0].text, 'Unscoped legacy');
    console.log('logical tasks: independent / explicit continuation / Stop / restart / immutable Regenerate / scope / legacy / evidence isolation passed');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
