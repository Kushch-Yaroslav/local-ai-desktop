import assert from 'node:assert/strict';
import {documentAnswerBlocks,applyDocumentAnswerEdits,trimUnrequestedInterpretations,unsupportedClosingQuantities} from './document-answer-review';
const candidate='Глава 1. Начало.\n\nГлава 22. Герой буквально превращается артефактом.\n\nИнтерпретация: такова магия.';
const blocks=documentAnswerBlocks(candidate);assert.equal(blocks.length,3);
const result=applyDocumentAnswerEdits(candidate,{edits:[{block_id:1,replacement:'Глава 22. Фикт реализует кошмар героя; физическое превращение не установлено.'},{block_id:2,replacement:'Интерпретация требует осторожности.'}]});
assert(result.content.includes('Глава 1. Начало.'));assert(!result.content.includes('буквально превращается'));assert.equal(result.editedBlocks,2);
assert.equal(applyDocumentAnswerEdits(candidate,{edits:[]}).content,candidate);
for(const edits of [[{block_id:3,replacement:'x'}],[{block_id:0,replacement:'x'},{block_id:0,replacement:'y'}],[{block_id:0.5,replacement:'x'}]])assert.throws(()=>applyDocumentAnswerEdits(candidate,{edits}));
assert.throws(()=>applyDocumentAnswerEdits(candidate,{answer:'unbound text'}));
console.log('PASS document answer review: application block IDs, bounded edits, untouched chapter preservation, invalid/duplicate IDs rejected');

assert.equal(trimUnrequestedInterpretations('**Глава 22** — Развязка.\n\n---\n\n### Главная идея\n\nНепрошенная интерпретация.','Глава 22'),'**Глава 22** — Развязка.');
assert.equal(trimUnrequestedInterpretations('Other answer','No chapter'),'Other answer');

assert.deepEqual(unsupportedClosingQuantities('Глава 22. Конец.',{edits:[{block_id:0,replacement:'Глава 22. Прошло две недели.'}]},'Глава 22','Срок — два месяца.'),['block 0: 2:week']);
assert.deepEqual(unsupportedClosingQuantities('Глава 22. Конец.',{edits:[{block_id:0,replacement:'Глава 22. Через 2 часа.'}]},'Глава 22','Через два часа.'),[]);
