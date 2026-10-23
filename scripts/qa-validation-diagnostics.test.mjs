import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{qaAssertion,qaScenarios,qaArgumentFailure,assertionSchema}=require('../dist/main/web/browser-scenarios.js');
for(const [assertion,category] of [[{source:'visible',operator:'equals',expected:true},'selector'],[{source:'diagnostic',operator:'equals',expected:true},'path'],[{source:'layout',selector:'.badge',operator:'equals',expected:0},'selector'],[{source:'visual_layout',operator:'equals',expected:0},'selector'],[{source:'text_fit',operator:'equals',expected:0},'selector']]){
 let error;try{qaAssertion(assertion);}catch(value){error=value;}assert(error,'Malformed assertion was accepted');const result=qaArgumentFailure(error,{scenarios:[{assertion}]});assert.equal(result.stage,'validation');assert.equal(result.category,category);assert.equal(result.retrySameArguments,false);assert(qaScenarios(result.example.scenarios).length===1,'Suggested example must pass the production parser');assert(result.guidance.includes('partial evidence'));assert(!result.error.includes('PRIVATE-'));
}
assert(assertionSchema.description.includes('layout'));
console.log('PASS actionable QA validation errors and production-validated examples for missing selector/path and malformed layout/text-fit assertions');
