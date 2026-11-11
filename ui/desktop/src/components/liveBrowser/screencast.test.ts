/** Local AI Desktop: regressions in frame recovery and resource release. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ScreencastHub } from '../../../live-browser/runtime/screencast';
import type { BrowserManager } from '../../../live-browser/runtime/browser';

function fixture() {
  const cdp = Object.assign(new EventEmitter(), { send: vi.fn().mockResolvedValue({}) });
  const session = {cdp, viewport: {width: 800, height: 600}, dpr: 1, zoom: 1};
  const manager = Object.assign(new EventEmitter(), {
    get: vi.fn().mockResolvedValue(session), sessionOf: () => session,
    captureFrame: vi.fn().mockResolvedValue({data:'frame', width:800, height:600}),
  });
  const hub = new ScreencastHub(manager as unknown as BrowserManager);
  return {hub, manager, cdp};
}
afterEach(() => vi.useRealTimers());
describe('screencast recovery', () => {
  it('keeps polling after one failed screenshot and releases frames on unsubscribe', async () => {
    vi.useFakeTimers();
    const {hub, manager, cdp} = fixture();
    manager.captureFrame.mockResolvedValueOnce({error: 'temporary capture failure'});
    const frame = vi.fn();
    const unsubscribe = hub.subscribe('chat-a', frame);
    await vi.advanceTimersByTimeAsync(3500);
    expect(manager.captureFrame.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(frame).toHaveBeenCalled();
    unsubscribe();
    expect(hub.lastFrame('chat-a')).toBeNull();
    expect(cdp.listenerCount('Page.screencastFrame')).toBe(0);
    const count = manager.captureFrame.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(manager.captureFrame).toHaveBeenCalledTimes(count);
    await hub.shutdown();
  });
  it('does not start a stream when the last viewer leaves during initialization', async () => {
    const {hub, manager, cdp} = fixture();
    let ready!: (value: unknown) => void;
    manager.get.mockReturnValueOnce(new Promise(resolve => {ready = resolve;}));
    const unsubscribe = hub.subscribe('chat-b', vi.fn());
    unsubscribe(); ready(manager.sessionOf());
    await Promise.resolve(); await Promise.resolve();
    expect(cdp.send).not.toHaveBeenCalledWith('Page.startScreencast', expect.anything());
    await hub.shutdown();
  });
});
