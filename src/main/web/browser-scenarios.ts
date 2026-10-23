import type { QaAssertion, QaScenario } from '../../shared/browser-qa';
import { qaSteps } from './browser-qa';
import { visualLayoutOptions } from './visual-layout-qa';
import { qaViewport } from './responsive-qa';

const sources = ['text','value','visible','url','diagnostic','pixels','runtime_errors','raf','draws','viewport','layout','visual_layout','text_fit'];
export function qaAssertion(value: unknown): QaAssertion {
  if (!value || typeof value !== 'object') throw new Error('A declarative assertion is required');
  const a = value as QaAssertion;
  if (!sources.includes(a.source) || !['equals','changed','increased','decreased'].includes(a.operator)) throw new Error('Unsupported assertion method');
  if(a.selector!==undefined&&(typeof a.selector!=='string'||!a.selector.trim()||a.selector.length>500))throw new Error('Invalid bounded assertion selector');
  if(a.source==='visual_layout'&&(a.operator!=='equals'||a.expected!==0||!['coverage','backing','seams'].includes(a.path??'')||a.sample_ms||a.tolerance!==undefined||(['coverage','backing'].includes(a.path??'')&&(!a.selector||a.selector.length>500))))throw new Error('Visual layout requires equals 0, path coverage/backing/seams; coverage/backing need a target selector. No ignored tolerance/sample fields.');
  if(a.source==='text_fit'&&(a.operator!=='equals'||a.expected!==0||!a.selector||a.sample_ms||a.path!==undefined||a.tolerance!==undefined))throw new Error('Text fit requires a unique selector and equals 0 without ignored options');
  if(a.source==='layout'&&(a.operator!=='equals'||a.expected!==0||a.sample_ms||a.path!==undefined||a.selector!==undefined||a.tolerance!==undefined))throw new Error('Layout asserts zero confirmed DOM geometry defects with no ignored selector/path/tolerance; use separate scenarios for interaction or animation');
  if (['text','value','visible','viewport','text_fit'].includes(a.source) && (typeof a.selector !== 'string' || !a.selector.trim() || a.selector.length > 500)) throw new Error('Assertion requires a bounded selector');
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
    if(['layout','visual_layout','text_fit'].includes(raw.assertion?.source)&&raw.viewport===undefined)throw new Error('Layout scenarios require an explicit viewport');
    if(raw.visual_layout!==undefined&&raw.assertion?.source!=='visual_layout')throw new Error('visual_layout options require a visual_layout assertion');
    if([...raw.preconditions??[],...raw.required_state??[]].some((a:{source?:string})=>a.source==='visual_layout'))throw new Error('Visual layout is a scenario assertion, not a precondition');
    return {visual_layout:visualLayoutOptions(raw.visual_layout),id:raw.id,goal:raw.goal,target:raw.target,...(raw.viewport!==undefined?{viewport:qaViewport(raw.viewport)}:{}),deliverable_id:raw.deliverable_id,criterion_id:raw.criterion_id,preconditions:conditions('preconditions'),required_state:conditions('required_state'),steps:qaSteps(raw.steps),assertion:qaAssertion(raw.assertion),timeout_ms:raw.timeout_ms};
  }).map((s,_,all)=>{if(all.filter(s=>s.assertion.source==='visual_layout').length>1)throw new Error('One Visual Layout scenario per checkpoint (up to 2 resize transitions, 6 frames)');return s;});
}
export const assertionSchema = {type:'object',description:'Declarative observation. text/value/visible/viewport/text_fit require selector. diagnostic requires path in window.__qaDiagnostics. layout: {source:layout,operator:equals,expected:0}, no selector/path. visual_layout: equals 0 and path coverage/backing/seams (coverage/backing require selector). text_fit: unique selector, equals 0. layout/visual_layout/text_fit require scenario.viewport. No JavaScript expressions.',properties:{source:{type:'string',enum:sources},selector:{type:'string',maxLength:500},path:{type:'string',description:'For diagnostic: read-only scalar path in window.__qaDiagnostics. For visual_layout: coverage, backing, or seams. No JavaScript expressions.'},operator:{type:'string',enum:['equals','changed','increased','decreased']},expected:{type:['string','number','boolean']},tolerance:{type:'number',minimum:0},sample_ms:{type:'array',minItems:3,maxItems:4,items:{type:'integer',minimum:0,maximum:3000}}},required:['source','operator'],additionalProperties:false};

/** Schema failures are diagnostics, never a failed visual assertion. */
export function qaArgumentFailure(error: unknown, args: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : String(error);
  const category = /selector/i.test(message) ? 'selector' : /path/i.test(message) ? 'path' : /viewport/i.test(message) ? 'viewport' : /assert|layout|expected|operator|method|fit/i.test(message) ? 'assertion' : 'scenario';
  const raw = Array.isArray(args.scenarios) ? args.scenarios[0] : undefined;
  const source = raw?.assertion?.source;
  const examples: Record<string, unknown> = {
    layout: {source:'layout',operator:'equals',expected:0},
    visual_layout: {source:'visual_layout',path:'backing',selector:'#target',operator:'equals',expected:0},
    diagnostic: {source:'diagnostic',path:'ready',operator:'equals',expected:true},
    text_fit: {source:'text_fit',selector:'#target',operator:'equals',expected:0},
  };
  const assertion = examples[String(source)] ?? {source:'visible',selector:'#target',operator:'equals',expected:true};
  return {error:message,code:'INVALID_QA_ARGUMENTS',stage:'validation',category,retrySameArguments:false,
    guidance:'Correct the assertion using a real inspected selector (CSS Modules: use the actual rendered class or a stable data/id attribute). layout takes neither selector nor path; visual_layout requires path. Invalid arguments do not prove a defect. DOM read/geometry are partial evidence only; report verification incomplete if a valid check cannot run.',
    example:{action:'qa',scenarios:[{id:'check',goal:'Verify the original defect',target:'<approved original URL including query/hash>',viewport:{width:1920,height:1080},preconditions:[],required_state:[],steps:[],assertion,timeout_ms:5000}]}};
}
