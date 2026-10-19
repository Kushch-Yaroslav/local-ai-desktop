import { createHash } from 'node:crypto';
import { runScenarioQa } from './browser-scenario-runner';
import type { QaStep } from '../../shared/browser-qa';
export type { QaStep } from '../../shared/browser-qa';
import type { Page } from 'playwright-core';

/** Installed before project scripts. Counters observe real callbacks/draws; they do not invent frames. */
export async function installQaInstrumentation(page: Page) {
  await page.addInitScript(() => {
    const state = { frames: 0, draws: 0, invalidNumbers: 0, events: {} as Record<string, number>, rejections: [] as string[] };
    Object.defineProperty(window, '__localAiBrowserQa', { get: () => structuredClone(state), configurable: false });
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(time => { state.frames++; callback(time); });
    for (const name of ['keydown', 'keyup', 'pointermove', 'click', 'input']) window.addEventListener(name, () => { state.events[name] = (state.events[name] ?? 0) + 1; }, true);
    window.addEventListener('unhandledrejection', event => { if (state.rejections.length < 20) state.rejections.push(String(event.reason).slice(0, 500)); });
    const wrap = (prototype: object, name: string) => {
      const target = prototype as Record<string, unknown>, original = target[name]; if (typeof original !== 'function') return;
      target[name] = function(this: unknown, ...args: unknown[]) {
        state.draws++;
        if (args.some(arg => {
          if (typeof arg === 'number') return !Number.isFinite(arg);
          if (ArrayBuffer.isView(arg) && !(arg instanceof DataView)) {
            const values = arg as unknown as ArrayLike<number>;
            for (let i=0;i<Math.min(values.length,256);i++) if (!Number.isFinite(values[i])) return true;
          }
          return false;
        })) state.invalidNumbers++;
        return Reflect.apply(original, this, args);
      };
    };
    for (const name of ['fillRect', 'strokeRect', 'drawImage', 'fill', 'stroke', 'clearRect', 'setTransform', 'transform', 'translate', 'rotate', 'scale']) wrap(CanvasRenderingContext2D.prototype, name);
    for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (type) for (const name of ['drawArrays', 'drawElements', 'clear', 'uniformMatrix4fv']) wrap(type.prototype, name);
  });
}
type QaState = { frames: number; draws: number; invalidNumbers: number; events: Record<string, number>; rejections: string[] };
export const qaSnapshot = (page: Page) => page.evaluate(() => {
  const state = (window as unknown as { __localAiBrowserQa: QaState }).__localAiBrowserQa;
  const invalid: string[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid.push(path);
    else if (value && typeof value === 'object' && depth < 3) for (const key of Object.keys(value).slice(0,32)) visit((value as Record<string,unknown>)[key], path+'.'+key, depth+1);
  };
  visit((window as unknown as { __qaDiagnostics?: unknown }).__qaDiagnostics, '__qaDiagnostics', 0);
  return { ...state, diagnosticInvalid: invalid };
});
export const keyboardActions = new Set(['key','keydown','keyup','hold']);
const validKey = (key: unknown): key is string => typeof key === 'string' && key.split('+').length <= 4 && key.split('+').every(part => /^[a-z0-9]$/i.test(part) || ['Enter','Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Escape','Space','Shift','Control','Alt','Meta','Backspace','Delete','Home','End','PageUp','PageDown'].includes(part));
export async function keyboardStep(page: Page, step: QaStep, held: Set<string>) {
  const keys = step.key!.split('+');
  if (step.action === 'key') { for (let i=0;i<(step.repeat ?? 1);i++) await page.keyboard.press(step.key!); return; }
  if (step.action === 'keyup') { for (const key of [...keys].reverse()) { await page.keyboard.up(key); held.delete(key); } return; }
  for (const key of keys) { await page.keyboard.down(key); held.add(key); }
  if (step.action === 'hold') {
    try { await page.waitForTimeout(step.duration_ms ?? 300); }
    finally { for (const key of [...keys].reverse()) { await page.keyboard.up(key).catch(() => undefined); held.delete(key); } }
  }
}
export function qaSteps(input: unknown): QaStep[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8) throw new Error('QA supports at most 8 interaction steps');
  for (const step of input) {
    if (!step || !['click', 'fill', 'key', 'keydown', 'keyup', 'hold', 'scroll', 'focus','mousemove','drag','wait','pointer-lock'].includes(step.action)) throw new Error('Invalid QA action');
    for (const field of ['selector', 'value', 'key']) if (step[field] !== undefined && (typeof step[field] !== 'string' || step[field].length > 500)) throw new Error(`Invalid QA ${field}`);
    if (['click','fill','focus','pointer-lock'].includes(step.action) && (typeof step.selector !== 'string' || !step.selector.trim())) throw new Error('Click/fill requires a selector');
    if (step.action === 'fill' && typeof step.value !== 'string') throw new Error('Fill requires a value');
    if (keyboardActions.has(step.action) && !validKey(step.key)) throw new Error('Keyboard actions require a supported key or combination such as Shift+w. Use keyboard actions for Canvas, never fill(body) or hidden inputs.');
    if (step.duration_ms !== undefined && (!Number.isInteger(step.duration_ms) || step.duration_ms < 0 || step.duration_ms > 2000)) throw new Error('Keyboard hold must be 0..2000 ms');
    if (step.repeat !== undefined && (!Number.isInteger(step.repeat) || step.repeat < 1 || step.repeat > 8)) throw new Error('Keyboard repeat must be 1..8');
    for(const field of ['x','y','to_x','to_y','delta_y']) if(step[field]!==undefined&&(!Number.isFinite(step[field])||Math.abs(step[field])>4000))throw new Error('Pointer/scroll coordinates must be bounded');
    if (step.expect && step.expect.changed !== undefined && typeof step.expect.changed !== 'boolean') throw new Error('Invalid changed expectation');
    if (step.expect && ['text','value','changed'].filter(key=>step.expect[key]!==undefined).length>1) throw new Error('Choose one expected text, value or changed state');
    if (step.expect && (typeof step.expect.selector !== 'string' || step.expect.selector.length > 500 || ['text', 'value'].some(field => step.expect[field] !== undefined && (typeof step.expect[field] !== 'string' || step.expect[field].length > 1000)))) throw new Error('Invalid QA expectation');
  }
  return input.map(step => ({ action:step.action, ...(step.selector !== undefined ? {selector:step.selector} : {}), ...(step.value !== undefined ? {value:step.value} : {}), ...(step.key !== undefined ? {key:step.key} : {}), ...(step.duration_ms !== undefined ? {duration_ms:step.duration_ms} : {}), ...(step.repeat !== undefined ? {repeat:step.repeat} : {}), ...Object.fromEntries(['x','y','to_x','to_y','delta_y'].filter(key=>step[key]!==undefined).map(key=>[key,step[key]])), ...(step.expect ? {expect:{selector:step.expect.selector,...(step.expect.text !== undefined ? {text:step.expect.text} : {}),...(step.expect.value !== undefined ? {value:step.expect.value} : {}),...(step.expect.changed !== undefined ? {changed:step.expect.changed} : {})}} : {}) }));
}
export const runBrowserQa = runScenarioQa;
export const screenshotHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
