import type { QaAssertion, QaScenario } from '../../shared/browser-qa';
import { qaSteps } from './browser-qa';
import { qaViewport } from './responsive-qa';

const sources = ['text','value','visible','url','diagnostic','pixels','runtime_errors','raf','draws','viewport','layout'];
export function qaAssertion(value: unknown): QaAssertion {
  if (!value || typeof value !== 'object') throw new Error('A declarative assertion is required');
  const a = value as QaAssertion;
  if (!sources.includes(a.source) || !['equals','changed','increased','decreased'].includes(a.operator)) throw new Error('Unsupported assertion method');
  if(a.source==='layout'&&(a.operator!=='equals'||a.expected!==0||a.sample_ms||a.path!==undefined||a.selector!==undefined||a.tolerance!==undefined))throw new Error('Layout asserts zero confirmed DOM geometry defects with no ignored selector/path/tolerance; use separate scenarios for interaction or animation');
  if (['text','value','visible','viewport'].includes(a.source) && (typeof a.selector !== 'string' || !a.selector.trim() || a.selector.length > 500)) throw new Error('Assertion requires a bounded selector');
  if (a.source === 'diagnostic' && (typeof a.path !== 'string' || !/^[a-zA-Z_][\w]*(\.[a-zA-Z_0-9]+){0,5}$/.test(a.path) || a.path.split('.').some(p=>['__proto__','constructor','prototype'].includes(p)))) throw new Error('Diagnostic path must name bounded data in window.__qaDiagnostics');
  if (a.operator === 'equals' && !['string','number','boolean'].includes(typeof a.expected)) throw new Error('Equals requires expected scalar data');
  if (typeof a.expected === 'string' && a.expected.length > 1000 || typeof a.expected === 'number' && !Number.isFinite(a.expected)) throw new Error('Invalid expected value');
  if (a.tolerance !== undefined && (!Number.isFinite(a.tolerance) || a.tolerance < 0)) throw new Error('Invalid observation tolerance');
  if (a.sample_ms && (!Array.isArray(a.sample_ms) || a.sample_ms.length < 3 || a.sample_ms.length > 4 || a.sample_ms[0] !== 0 || a.sample_ms.some((n,i)=>!Number.isInteger(n)||n<0||n>3000||i>0&&n<=a.sample_ms![i-1]))) throw new Error('Temporal observations need 3..4 increasing sample times, starting at 0, ending within 3000 ms');
  return { source:a.source,operator:a.operator,...(a.selector?{selector:a.selector}:{}),...(a.path?{path:a.path}:{}),...(a.expected!==undefined?{expected:a.expected}:{}),...(a.tolerance!==undefined?{tolerance:a.tolerance}:{}),...(a.sample_ms?{sample_ms:[...a.sample_ms]}:{}) };
}
export function qaScenarios(value: unknown): QaScenario[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 6) throw new Error('QA supports at most 6 scenarios per operation');
  const ids = new Set<string>();
  return value.map(raw=>{
    if (!raw || typeof raw !== 'object') throw new Error('Invalid scenario');
    for(const field of ['id','goal','target']) if(typeof raw[field]!=='string'||!raw[field].trim()||raw[field].length>(field==='id'?80:1000))throw new Error(`Scenario ${field} is required`);
    if(ids.has(raw.id))throw new Error('Scenario IDs must be unique');ids.add(raw.id);
    for(const field of ['deliverable_id','criterion_id'])if(raw[field]!==undefined&&(typeof raw[field]!=='string'||!raw[field].trim()||raw[field].length>80))throw new Error(`Invalid ${field}`);
    if(Boolean(raw.deliverable_id)!==Boolean(raw.criterion_id))throw new Error('Provide deliverable_id and criterion_id together');
    if(!Array.isArray(raw.steps))throw new Error('Scenario steps must be an array');
    const conditions=(field:string)=>{if(!Array.isArray(raw[field])||raw[field].length>6)throw new Error(`${field} must be a bounded array`);return raw[field].map(qaAssertion);};
    if(!Number.isInteger(raw.timeout_ms)||raw.timeout_ms<500||raw.timeout_ms>15000)throw new Error('Scenario timeout must be 500..15000 ms');
    if(raw.assertion?.source==='layout'&&raw.viewport===undefined)throw new Error('Layout scenarios require an explicit viewport');
    return {id:raw.id,goal:raw.goal,target:raw.target,...(raw.viewport!==undefined?{viewport:qaViewport(raw.viewport)}:{}),deliverable_id:raw.deliverable_id,criterion_id:raw.criterion_id,preconditions:conditions('preconditions'),required_state:conditions('required_state'),steps:qaSteps(raw.steps),assertion:qaAssertion(raw.assertion),timeout_ms:raw.timeout_ms};
  });
}
export const assertionSchema = {type:'object',properties:{source:{type:'string',enum:sources},selector:{type:'string',maxLength:500},path:{type:'string',description:'Read-only scalar path inside window.__qaDiagnostics; no JavaScript expressions.'},operator:{type:'string',enum:['equals','changed','increased','decreased']},expected:{type:['string','number','boolean']},tolerance:{type:'number',minimum:0},sample_ms:{type:'array',minItems:3,maxItems:4,items:{type:'integer',minimum:0,maximum:3000}}},required:['source','operator'],additionalProperties:false};
