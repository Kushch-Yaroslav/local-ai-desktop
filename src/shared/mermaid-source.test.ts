import assert from 'node:assert/strict';
import { mermaidFormattingCandidate, parseMermaidWithFormatting } from './mermaid-source';

async function main() {
  const source = 'flowchart LR\n A[sharp (npm)\\nserver/src/image.js] --> B[.venv-aya\\nAya Expanse 8B]';
  const repaired = mermaidFormattingCandidate(source);
  assert(repaired.includes('A["sharp (npm)<br/>server/src/image.js"]'));
  assert(repaired.includes('B[".venv-aya<br/>Aya Expanse 8B"]'));
  const windows = 'flowchart LR\\n A["C:\\new\\node"] --> B[OK]';
  const normalized = mermaidFormattingCandidate(windows);
  assert(normalized.startsWith('flowchart LR\n')); assert(normalized.includes('"C:\\new\\node"'));
  assert.equal(mermaidFormattingCandidate('sequenceDiagram\n Alice->>Bob: C:\\new'), 'sequenceDiagram\n Alice->>Bob: C:\\new');
  let calls = 0;
  const valid = 'flowchart LR\n A[valid] --> B[valid]';
  assert.equal(await parseMermaidWithFormatting(valid, async () => { calls++; }), valid); assert.equal(calls, 1);
  const diagnostic = new Error('Parse error line 2'); calls = 0;
  await assert.rejects(parseMermaidWithFormatting(source, async () => { calls++; throw diagnostic; }), /Parse error line 2/); assert.equal(calls, 2);
  assert.equal(await parseMermaidWithFormatting(source, async value => { if (value === source) throw diagnostic; }), repaired);
  await assert.rejects(parseMermaidWithFormatting('x'.repeat(16001), async () => {}), /size limit/);
  console.log('Mermaid formatting: original-first, one repair, scoped escaped newlines, technical labels, Windows paths and retained diagnostics passed.');
}
void main();
