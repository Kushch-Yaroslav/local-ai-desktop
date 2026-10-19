import { createHash, randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { BrowserQaReport, BrowserQaStatus, BrowserQaCheck, BrowserCapture, BrowserVisualResult } from '../../shared/browser-qa';

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
const snapshot = (page: Page) => page.evaluate(() => {
  const state = (window as unknown as { __localAiBrowserQa: QaState }).__localAiBrowserQa;
  const invalid: string[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (typeof value === 'number' && !Number.isFinite(value)) invalid.push(path);
    else if (value && typeof value === 'object' && depth < 3) for (const key of Object.keys(value).slice(0,32)) visit((value as Record<string,unknown>)[key], path+'.'+key, depth+1);
  };
  visit((window as unknown as { __qaDiagnostics?: unknown }).__qaDiagnostics, '__qaDiagnostics', 0);
  return { ...state, diagnosticInvalid: invalid };
});
export interface QaStep { action: 'click' | 'fill' | 'key' | 'keydown' | 'keyup' | 'hold' | 'scroll'; selector?: string; value?: string; key?: string; duration_ms?: number; repeat?: number; expect?: { selector: string; text?: string; value?: string; changed?: boolean }; }
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
    if (!step || !['click', 'fill', 'key', 'keydown', 'keyup', 'hold', 'scroll'].includes(step.action)) throw new Error('Invalid QA action');
    for (const field of ['selector', 'value', 'key']) if (step[field] !== undefined && (typeof step[field] !== 'string' || step[field].length > 500)) throw new Error(`Invalid QA ${field}`);
    if (['click','fill'].includes(step.action) && (typeof step.selector !== 'string' || !step.selector.trim())) throw new Error('Click/fill requires a selector');
    if (step.action === 'fill' && typeof step.value !== 'string') throw new Error('Fill requires a value');
    if (keyboardActions.has(step.action) && !validKey(step.key)) throw new Error('Keyboard actions require a supported key or combination such as Shift+w. Use keyboard actions for Canvas, never fill(body) or hidden inputs.');
    if (step.duration_ms !== undefined && (!Number.isInteger(step.duration_ms) || step.duration_ms < 0 || step.duration_ms > 2000)) throw new Error('Keyboard hold must be 0..2000 ms');
    if (step.repeat !== undefined && (!Number.isInteger(step.repeat) || step.repeat < 1 || step.repeat > 8)) throw new Error('Keyboard repeat must be 1..8');
    if (step.expect && step.expect.changed !== undefined && typeof step.expect.changed !== 'boolean') throw new Error('Invalid changed expectation');
    if (step.expect && ['text','value','changed'].filter(key=>step.expect[key]!==undefined).length>1) throw new Error('Choose one expected text, value or changed state');
    if (step.expect && (typeof step.expect.selector !== 'string' || step.expect.selector.length > 500 || ['text', 'value'].some(field => step.expect[field] !== undefined && (typeof step.expect[field] !== 'string' || step.expect[field].length > 1000)))) throw new Error('Invalid QA expectation');
  }
  return input.map(step => ({ action:step.action, ...(step.selector !== undefined ? {selector:step.selector} : {}), ...(step.value !== undefined ? {value:step.value} : {}), ...(step.key !== undefined ? {key:step.key} : {}), ...(step.duration_ms !== undefined ? {duration_ms:step.duration_ms} : {}), ...(step.repeat !== undefined ? {repeat:step.repeat} : {}), ...(step.expect ? {expect:{selector:step.expect.selector,...(step.expect.text !== undefined ? {text:step.expect.text} : {}),...(step.expect.value !== undefined ? {value:step.expect.value} : {}),...(step.expect.changed !== undefined ? {changed:step.expect.changed} : {})}} : {}) }));
}
export async function runBrowserQa(options: { page: Page; signal: AbortSignal; steps: QaStep[]; errors(): string[]; capture(): Promise<BrowserCapture>; analyze?: (capture: BrowserCapture, before?: BrowserCapture) => Promise<BrowserVisualResult>; status?(status: BrowserQaStatus): void }): Promise<BrowserQaReport> {
  const { page, signal } = options, started = performance.now(), checks: BrowserQaCheck[] = [], captures: BrowserCapture[] = [], held = new Set<string>();
  const status = (phase: BrowserQaStatus['phase']) => options.status?.({ phase });
  const check = (action: string, expected: string, actual: string, pass: boolean) => checks.push({ action, expected, actual, status: pass ? 'Verified' : 'Failed' });
  const boundary = () => { if (signal.aborted) throw new Error('QA paused, cancelled or timed out'); if (performance.now()-started > 30000) throw new DOMException('Functional QA exceeded 30 second operation deadline', 'TimeoutError'); };
  status('started');
  let visual: BrowserVisualResult = { analyzed: false, status: 'Not Verified', reason: 'Browser Vision Off or unavailable; functional evidence only' };
  let operationFailure: 'QA_TIMEOUT' | 'QA_TOOL_ERROR' | undefined;
  try {
    boundary(); status('capturing'); captures.push(await options.capture());
    const before = await snapshot(page); await page.waitForTimeout(200); const initial = await snapshot(page);
    check('load', 'Document loaded and rendered body exists', await page.title(), await page.locator('body').isVisible());
    const layout = await page.evaluate(() => Array.from(document.querySelectorAll('button,input,[role="button"]')).slice(0, 100).filter(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && (rect.right < 0 || rect.left > innerWidth);
    }).map(element => element.id || element.tagName));
    check('layout', 'Interactive controls are not entirely outside horizontal viewport', layout.length ? layout.join(', ') : 'No offscreen controls observed', !layout.length);
    status('interacting');
    const canvas = page.locator('canvas').first();
    const hasCanvas = await canvas.count() > 0; let canvasStateVerified = !hasCanvas;
    if (await canvas.count() && await canvas.isVisible()) {
      let box = await canvas.boundingBox();
      if (box) {
        await canvas.click({ position: { x: Math.min(20, box.width / 2), y: Math.min(20, box.height / 2) }, timeout: 3000 });
        box = await canvas.boundingBox() ?? box;
        for (const key of ['w', 'a', 's', 'd']) { boundary(); await page.keyboard.down(key); try { await page.waitForTimeout(100); } finally { await page.keyboard.up(key); } }
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
        try { await page.mouse.move(box.x + Math.min(box.width - 1, box.width / 2 + 90), box.y + Math.min(box.height - 1, box.height / 2 + 30), { steps: 8 }); } finally { await page.mouse.up(); }
        const interactionEnd = await snapshot(page); await page.waitForTimeout(220); const after = await snapshot(page);
        check('canvas input delivery', 'Real keyboard and pointer events arrive', JSON.stringify(after.events), (after.events.keydown ?? 0) >= (initial.events.keydown ?? 0) + 4 && (after.events.pointermove ?? 0) > (initial.events.pointermove ?? 0));
        if (initial.frames > before.frames) check('canvas animation', 'Previously active RAF callbacks continue after camera/keyboard actions', `${interactionEnd.frames} → ${after.frames}`, after.frames > interactionEnd.frames);
        if (initial.draws > before.draws) check('canvas render', 'Previously active draw calls continue after interaction', `${interactionEnd.draws} → ${after.draws}`, after.draws > interactionEnd.draws);
        check('canvas finite values', 'No observed NaN/Infinity canvas draw arguments', String(after.invalidNumbers), after.invalidNumbers === 0);
      }
    }
    let expectations = 0;
    for (const step of options.steps) {
      boundary(); const target = step.selector ? page.locator(step.selector).first() : undefined;
      try {
        const beforeText = step.expect?.changed !== undefined ? (await page.locator(step.expect.selector).first().textContent({timeout:3000}) ?? '').trim() : undefined;
        if (step.action === 'click') { if (!target) throw new Error('Click requires selector'); await target.click({ timeout: 3000 }); }
        if (step.action === 'fill') { if (!target || typeof step.value !== 'string') throw new Error('Fill requires selector/value'); await target.fill(step.value, { timeout: 3000 }); }
        if (keyboardActions.has(step.action)) { await target?.focus({ timeout: 3000 }); await keyboardStep(page, step, held); }
        if (step.action === 'scroll') await page.mouse.wheel(0, 500);
        await page.waitForTimeout(100);
        if (step.expect) {
          expectations++; const expected = page.locator(step.expect.selector).first(); await expected.waitFor({ state: 'visible', timeout: 3000 });
          const actual = step.expect.value !== undefined ? await expected.inputValue() : (await expected.textContent() ?? '').trim();
          const wanted = step.expect.value ?? step.expect.text;
          if(step.expect.changed === true && actual !== beforeText && (keyboardActions.has(step.action) || step.action==='click' && target && await target.evaluate(element=>element instanceof HTMLCanvasElement || Boolean(element.querySelector('canvas'))))) canvasStateVerified=true;
          const changed = step.expect.changed;
          check(`${step.action} ${step.selector ?? step.key ?? ''}`, changed === undefined ? wanted ?? 'Visible expected element' : changed ? 'Application state changes after input' : 'Application state stays unchanged', (changed === undefined ? actual : `${beforeText} → ${actual}`).slice(0,1000), changed === undefined ? wanted === undefined || actual === wanted : (actual !== beforeText) === changed);
        } else checks.push({ action: step.action, expected: 'Application-specific expectation not supplied', actual: 'Action delivered; handling not established', status: 'Partially Verified' });
      } catch (error) {
        operationFailure = error instanceof Error && error.name === 'TimeoutError' ? 'QA_TIMEOUT' : 'QA_TOOL_ERROR';
        checks.push({ action: step.action, expected: JSON.stringify(step.expect ?? {}), actual: String(error).slice(0,500), status: 'Blocked' });
      }
    }
    for (const key of [...held].reverse()) await page.keyboard.up(key).catch(() => undefined); held.clear();
    boundary(); status('capturing'); captures.push(await options.capture());
    const state = await snapshot(page), errors = [...options.errors(), ...state.rejections];
    check('exposed numeric diagnostics', 'No NaN/Infinity in optional window.__qaDiagnostics (bounded depth)', state.diagnosticInvalid.join(', ') || 'None observed', state.diagnosticInvalid.length === 0);
    check('runtime errors', 'No uncaught errors, console errors or unhandled rejections', errors.length ? errors.join('\n').slice(0, 3000) : 'None observed', errors.length === 0);
    if (options.analyze) { status('analyzing'); visual = await options.analyze(captures[captures.length - 1], captures[0]); }
    if (signal.aborted) throw new Error('QA paused, cancelled or timed out');
    const functionalStatus = checks.some(c=>c.status==='Failed') ? 'Failed' : operationFailure ? 'Blocked' : expectations>0 && canvasStateVerified && checks.every(c=>c.status==='Verified') ? 'Verified' : 'Partially Verified';
    const failed = functionalStatus === 'Failed';
    const result: BrowserQaReport = { scope: 'interaction', ...(operationFailure ? {reasonCode:operationFailure} : {}), functionalStatus, id: randomUUID(), url: page.url(), capturedAt: new Date().toISOString(), checks, errors, captures, visual, elapsedMs: performance.now() - started, status: failed ? 'Failed' : operationFailure ? 'Blocked' : functionalStatus === 'Verified' && (!options.analyze || visual.status === 'Verified') ? 'Verified' : 'Partially Verified', ...(!expectations || !canvasStateVerified ? { reason: 'Smoke tests establish observed execution, not application-specific correctness. Supply interaction expectations for stronger evidence, including changed application state after Canvas input.' } : {}) };
    if (captures.length === 2 && captures[0].sha256 !== captures[1].sha256) checks.push({ action: 'frame comparison', expected: 'Record pixel change without inferring correctness', actual: 'Captured pixels differ after interaction', status: 'Verified' });
    if (failed) status('issue'); options.status?.({ phase: 'complete', report: result }); return result;
  } catch (error) {
    const report: BrowserQaReport = { scope: 'interaction', id: randomUUID(), reasonCode: signal.reason?.name === 'TimeoutError' || error instanceof Error && error.name === 'TimeoutError' ? 'QA_TIMEOUT' : 'QA_TOOL_ERROR', status: signal.aborted || error instanceof Error && error.name === 'TimeoutError' ? 'Blocked' : 'Not Verified', url: page.isClosed() ? '' : page.url(), capturedAt: new Date().toISOString(), checks, errors: [...options.errors(), String(error).slice(0, 500)], captures, visual, elapsedMs: performance.now() - started, reason: String(error) };
    options.status?.({ phase: 'complete', report }); return report;
  } finally { for (const key of [...held].reverse()) await page.keyboard.up(key).catch(() => undefined); }
}
export const screenshotHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
