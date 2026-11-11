import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BrowserManager } from './browser';
import { ScreencastHub } from './screencast';
import { LadStore } from './store';
import { RegionService } from './regions';
import { LadControlServer } from './control';
import { log } from './util';

/**
 * Local AI Desktop — Live Browser runtime.
 *
 * Single process, loopback only:
 * - POST /mcp              MCP (streamable HTTP) for Goose browser tools
 * - /control/*             JSON control API for the Electron renderer
 * - GET  /control/events   SSE frame/event stream (auto-reconnecting)
 * - GET  /health           liveness (no auth)
 *
 * Env:
 *   LAD_LB_PORT          bind port (default: random 0 → printed)
 *   LAD_LB_TOKEN         bearer token (default: random; Electron must use the
 *                        same value it spawned us with)
 *   LAD_LB_DATA_DIR      region/area persistence dir (default: ./live-browser-data)
 *   LAD_LB_CHROME_PATH   Chrome executable (default: Playwright bundled or
 *                        system chrome auto-detect)
 *   LAD_LB_HEADLESS      "true" (default) or "false"
 */
async function main(): Promise<void> {
  const env = process.env;
  const port = Number(env.LAD_LB_PORT ?? 0) || 0;
  const token = env.LAD_LB_TOKEN?.trim() || randomBytes(24).toString('hex');
  const dataDir =
    env.LAD_LB_DATA_DIR?.trim() ||
    (typeof __dirname !== 'undefined' ? `${__dirname}/data` : './live-browser-data');
  const chromePath = env.LAD_LB_CHROME_PATH?.trim() || undefined;
  const headless = (env.LAD_LB_HEADLESS ?? 'true') !== 'false';

  const events = new EventEmitter();
  const manager = new BrowserManager({ chromePath, headless });
  const store = new LadStore(dataDir);
  const screencast = new ScreencastHub(manager);
  const regions = new RegionService(manager, store, {
    emit: (event) =>
      events.emit(event.type === 'select-region' ? 'region-selected' : 'state', event),
  });

  let activeConversation: string | null = null;
  const control = new LadControlServer({
    manager,
    regions,
    screencast,
    token,
    events,
    activeConversation: () => activeConversation,
    setActiveConversation: (id: string) => {
      activeConversation = id;
    },
  });

  const { port: boundPort } = await control.listen(port);

  const shutdown = async (signal: string) => {
    log(`shutting down (${signal})`);
    try {
      control.close();
      await screencast.shutdown();
      await manager.shutdown();
    } catch (error) {
      log('shutdown error:', error instanceof Error ? error.message : error);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    log('uncaughtException:', error.stack ?? error.message);
  });
  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
  });

  // Single JSON line for the Electron parent to parse.
  process.stdout.write(
    JSON.stringify({
      ok: true,
      service: 'local-ai-live-browser',
      port: boundPort,
      token: env.LAD_LB_TOKEN ? undefined : token,
      dataDir,
      headless,
      chrome: chromePath ?? 'auto',
    }) + '\n'
  );
  log(`ready: http://127.0.0.1:${boundPort} (mcp + control + sse)`);
}

main().catch((error) => {
  process.stderr.write(`[live-browser] fatal: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
