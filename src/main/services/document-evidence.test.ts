import assert from 'node:assert/strict';
import {prepareDocumentNotes,sourceQuoteEvidence} from './document-evidence';
const text='😀 Он сказал: «Да».\r\nЗатем — ушёл. И\u0306од найден.';
for(const quote of ['Он сказал: «Да».','Он сказал: “Да”.','Он сказал: "Да".\nЗатем - ушёл.','Йод найден.']) {
 const evidence=sourceQuoteEvidence(text,quote,24000);
 assert.notEqual(evidence.status,'unverified');
 assert.equal(text.slice(Number(evidence.start)-24000,Number(evidence.end)-24000),evidence.quote,'Evidence must always use the original UTF-16 range, never the normalized candidate');
}
assert.equal(sourceQuoteEvidence(text,'Он сказал: «Нет».').status,'unverified','Changed meaning must never be accepted through fuzzy matching');
assert.equal(sourceQuoteEvidence('first chunk','first chunk next chunk',24000).status,'unverified','Evidence must never extend beyond the submitted chunk');
assert.equal(sourceQuoteEvidence(text,'Он согласился и ушёл.').status,'unverified','Paraphrase is not a quotation');
assert.equal(sourceQuoteEvidence(text,'Он сказал ... ушёл.').status,'unverified','Abridged/noncontiguous excerpts are not exact evidence');
for(const quote of [null,42,'',undefined])assert.equal(sourceQuoteEvidence(text,quote).status,'unverified');
const notes=prepareDocumentNotes({events:[{fact:'Модель описывает согласие',quote:'Он согласился.'},{fact:'Реплика',source_quote:'Он сказал: “Да”.'},{fact:'No quote supplied'}],source_receipt:{start:999}},text,24000,'attachment','hash');
assert.equal(notes.source_receipt.start,24000);assert.equal(notes.source_receipt.end,24000+text.length);assert.equal(notes.source_receipt.notes_status,'model_claims_not_independently_verified');
assert.equal(notes.source_receipt.delivery_excerpt.text,text.slice(0,160));
const events=(notes as Record<string,unknown>).events as Array<Record<string,unknown>>;
assert(!Object.hasOwn(events[0],'quote'));assert.equal((events[0].source_evidence as Array<Record<string,unknown>>)[0].status,'unverified');
assert.equal((events[1].source_evidence as Array<Record<string,unknown>>)[0].status,'typography_normalized');assert.equal(events[2].fact,'No quote supplied');
console.log('PASS document evidence: typography, CRLF, Unicode composition, UTF-16, paraphrase, abridgement, absent/invalid quotes, application receipts, unverified claims retained without false quotation');
