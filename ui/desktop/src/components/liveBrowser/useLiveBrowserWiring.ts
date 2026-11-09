/**
 * useLiveBrowserWiring — panel-independent wiring of the Live Browser
 * runtime and its Goose MCP extension.
 *
 * Guarantees:
 * - the runtime (Playwright attached to native Electron pages) starts once per app;
 * - the Goose agent sees the browser_* MCP tools even when the panel is
 *   closed (hiding the panel never stops the browser or the agent);
 * - re-registration happens automatically if the runtime endpoint changes.
 *
 * All failures are non-fatal: the chat must keep working without the browser.
 */
import { useEffect, useState } from 'react';
import { LiveBrowserClient } from './liveBrowserClient';
import { ensureLiveBrowserExtension } from './liveBrowserExtension';

interface RuntimeEndpoint {
  url: string;
  token: string;
}

async function getEndpoint(): Promise<RuntimeEndpoint | null> {
  const api = typeof window !== 'undefined' ? window.electron : undefined;
  if (!api) return null;
  const status = await api.liveBrowserStatus();
  if (status.running && status.endpoint) {
    return { url: status.endpoint.url, token: status.endpoint.token };
  }
  const result = await api.liveBrowserStart();
  if (result.ok && result.endpoint) {
    return { url: result.endpoint.url, token: result.endpoint.token };
  }
  return null;
}

// Module-level guards: the wiring is global (one runtime, one extension),
// so concurrent BaseChat instances must not race each other.
let inFlight: Promise<boolean> | null = null;
let registeredEndpointKey: string | null = null;

function ensureWired(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const endpoint = await getEndpoint();
    if (!endpoint) {
      throw new Error('live-browser runtime is not available');
    }
    const key = `${endpoint.url}|${endpoint.token}`;
    if (registeredEndpointKey !== key) {
      await ensureLiveBrowserExtension(endpoint);
      registeredEndpointKey = key;
    }
    return true;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function useLiveBrowserWiring(
  enabled: boolean,
  conversationId?: string,
  agentActive = false
): {
  extensionRegistered: boolean;
  wiringError: string | null;
} {
  const [extensionRegistered, setExtensionRegistered] = useState(registeredEndpointKey !== null);
  const [wiringError, setWiringError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const run = async () => {
      try {
        const ok = await ensureWired();
        if (!cancelled) {
          setExtensionRegistered(ok);
          setWiringError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setExtensionRegistered(false);
          setWiringError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void run();

    // The ACP connection can come up later (reconnect); retry until the
    // extension lands.
    const timer = setInterval(() => {
      void run();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !conversationId) return;
    void window.electron.liveBrowserRegister(conversationId);
    void getEndpoint()
      .then((endpoint) => {
        return endpoint
          ? new LiveBrowserClient(endpoint).setOwnership(
              conversationId,
              agentActive ? 'agent' : 'user'
            )
          : undefined;
      })
      .catch(() => undefined);
  }, [enabled, conversationId, agentActive]);
  return { extensionRegistered, wiringError };
}
