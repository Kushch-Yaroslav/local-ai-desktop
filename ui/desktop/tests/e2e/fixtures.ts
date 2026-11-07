import { test as base, Page, Browser, chromium } from '@playwright/test';
import { exec, ChildProcess } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { launchApp } from './app-launcher';
import { discoverLlamaServer, seedGooseBackend } from './goose-seed';

const execAsync = promisify(exec);

type GooseTestFixtures = {
  goosePage: Page;
};

/**
 * Test-scoped fixture that launches a fresh Electron app for EACH test.
 *
 * Isolation: ⚠️ Partial - each test gets a fresh app instance, but uses ambient user config
 * Speed: ⚠️ Slow - ~3s startup overhead per test
 *
 * This ensures each test starts with a fresh app instance, but the app uses the
 * user's existing Goose configuration (providers, models, etc.).
 *
 * Usage:
 *   import { test, expect } from './fixtures';
 *
 *   test('my test', async ({ goosePage }) => {
 *     await goosePage.waitForSelector('[data-testid="chat-input"]');
 *     // ... test code
 *   });
 */
export const test = base.extend<GooseTestFixtures>({
  // Test-scoped fixture: launches a fresh Electron app for each test
  goosePage: async ({ browserName }, providePage, testInfo) => {
    void browserName;
    console.log(`Launching fresh Electron app for test: ${testInfo.title}`);

    let appProcess: ChildProcess | null = null;
    let browser: Browser | null = null;

    try {
      // Assign a unique debug port for this test to enable parallel execution
      // Base port 9222, offset by worker index * 100 + parallel slot
      const debugPort = 9222 + (testInfo.parallelIndex * 10);
      console.log(`Using debug port ${debugPort} for parallel test execution`);

      // Isolated app instance (opt-in via LAD_E2E_ISOLATE=1, set by specs
      // that must not collide with an already-running Local AI Desktop):
      //   - LOCAL_AI_DESKTOP_DEV_ROOT: unique userData + GOOSE_PATH_ROOT,
      //     which also bypasses Electron's single-instance lock.
      //   - GOOSE_DISABLE_KEYRING: goose reads provider secrets from the
      //     seeded <devRoot>/goose-backend/config/secrets.yaml file.
      //   - the seeded goose config points at the ALREADY-RUNNING local
      //     llama-server (no second model load, server lifecycle untouched).
      const isolate = process.env.LAD_E2E_ISOLATE === '1';
      let isolatedEnv: Record<string, string> = {};
      if (isolate) {
        const devRoot = mkdtempSync(join(tmpdir(), 'lad-e2e-'));
        // Isolate XDG_CONFIG_HOME so desktopMain.ts's storage-config block
        // cannot find the global ~/.config/local-ai-desktop-storage.json
        // (which would otherwise point userData at the REAL app's directory
        // and clobber LOCAL_AI_DESKTOP_DEV_ROOT, causing the single-instance
        // lock to be denied by the already-running Local AI Desktop).
        const xdgHome = mkdtempSync(join(tmpdir(), 'lad-e2e-xdg-'));
        // Make <devRoot>/electron a non-empty legacy storage root so that
        // initializeDefaultStorage() (which auto-creates a default storage
        // config ONLY when no legacy root exists) bails out early and leaves
        // LOCAL_AI_DESKTOP_DEV_ROOT untouched. The dev-root block then sets
        // userData to the unique <devRoot>/electron, so the single-instance
        // lock is acquirable even with the real app running.
        const electronRoot = join(devRoot, 'electron');
        mkdirSync(electronRoot, { recursive: true });
        writeFileSync(join(electronRoot, '.e2e-isolated'), 'isolated E2E instance\n');
        const llama = discoverLlamaServer();
        if (llama) {
          seedGooseBackend(devRoot, llama);
          console.log(`E2E: seeded isolated goose config -> ${llama.baseUrl} (llama pid ${llama.pid})`);
        } else {
          console.log('E2E: llama-server not found; agent-dependent tests will skip');
        }
        isolatedEnv = {
          LOCAL_AI_DESKTOP_DEV_ROOT: devRoot,
          GOOSE_DISABLE_KEYRING: 'true',
          XDG_CONFIG_HOME: xdgHome,
          // Explicit goose config root (the dev-root block sets the same value);
          // kept explicit so the seeded config is always discovered.
          GOOSE_PATH_ROOT: join(devRoot, 'goose-backend'),
        };
      }

      // Start the electron-forge process with Playwright remote debugging enabled
      // Use detached mode on Unix to create a process group we can kill together.
      // launchApp() falls back to a direct-node chain when pnpm's engines
      // check rejects the local pnpm/Node pair (see app-launcher.ts).
      appProcess = launchApp(join(__dirname, '../..'), {
        ...process.env,
        PLAYWRIGHT_DEBUG_PORT: debugPort.toString(), // Unique port per test for parallel execution
        ...isolatedEnv,
      });

      // Log process output for debugging
      if (process.env.DEBUG_TESTS) {
        appProcess.stdout?.on('data', (data) => {
          console.log('App stdout:', data.toString());
        });

        appProcess.stderr?.on('data', (data) => {
          console.log('App stderr:', data.toString());
        });
      }

      // Wait for the app to start and remote debugging to be available
      // Retry connection until it succeeds (app is ready) or timeout
      console.log(`Waiting for Electron app to start on port ${debugPort}...`);
      const maxRetries = 360; // 360 retries * 500ms = up to 3 minutes (cold start)
      const retryDelay = 500; // 500ms between retries

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
          console.log(`Connected to Electron app on attempt ${attempt} (~${(attempt * retryDelay) / 1000}s)`);
          break;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (attempt === maxRetries) {
            throw Object.assign(
              new Error(
                `Failed to connect to Electron app after ${maxRetries} attempts (${(maxRetries * retryDelay) / 1000}s). Last error: ${errorMessage}`,
              ),
              { cause: error },
            );
          }
          // Wait before next retry
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }

      if (!browser) {
        throw new Error('Browser connection failed unexpectedly');
      }

      // Wait for Electron to create its first window after the CDP endpoint is up.
      let page: Page | null = null;
      for (let attempt = 1; attempt <= 100; attempt++) {
        const contexts = browser.contexts();
        page = contexts.flatMap((context) => context.pages())[0] ?? null;
        if (page) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!page) {
        throw new Error('No windows/pages found');
      }

      // Wait for page to be ready
      await page.waitForLoadState('domcontentloaded');

      // Try to wait for networkidle
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        console.log('NetworkIdle timeout (likely due to MCP activity), continuing...');
      }

      // Wait for React app to be ready
      await page.waitForFunction(() => {
        const root = document.getElementById('root');
        return root && root.children.length > 0;
      }, { timeout: 30000 });

      console.log('App ready, starting test...');

      // Provide the page to the test
      await providePage(page);

    } finally {
      console.log('Cleaning up Electron app for this test...');

      // Close the CDP connection
      if (browser) {
        await browser.close().catch(console.error);
      }

      // Kill the npm process tree
      if (appProcess && appProcess.pid) {
        try {
          if (process.platform === 'win32') {
            // On Windows, kill the entire process tree
            await execAsync(`taskkill /F /T /PID ${appProcess.pid}`);
          } else {
            // On Unix, kill the entire process group
            try {
              // First try SIGTERM for graceful shutdown
              process.kill(-appProcess.pid, 'SIGTERM');
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch {
              // Process might already be dead
            }
            // Then SIGKILL if still running
            try {
              process.kill(-appProcess.pid, 'SIGKILL');
            } catch {
              // Process already exited
            }
          }
          console.log('Cleaned up app process');
        } catch (error) {
          if (
            error instanceof Error &&
            !('code' in error && error.code === 'ESRCH') &&
            !error.message.includes('No such process')
          ) {
            console.error('Error killing app process:', error);
          }
        }
      }
    }
  },
});

export { expect } from '@playwright/test';
