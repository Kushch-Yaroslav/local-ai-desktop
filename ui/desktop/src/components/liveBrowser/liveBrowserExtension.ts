/**
 * Live Browser ↔ Goose wiring.
 *
 * Registers the Live Browser runtime's MCP endpoint (streamable HTTP,
 * loopback-only, bearer-token authorized) as a Goose extension so the agent
 * gets the browser_* tools. The SAME Playwright Page the user watches in the
 * panel is the one these tools drive:
 *
 *   Goose agent → MCP browser_* → runtime → Playwright Page → CDP screencast → panel
 *
 * Registration is idempotent: if the extension already exists with the same
 * URI we do nothing; if the runtime restarted on a new port we replace the
 * stale entry.
 */
import {
  addConfigExtension,
  getConfiguredExtensions,
  removeConfigExtension,
  setConfigExtensionEnabled,
} from '../../acp/extensions';

export const LIVE_BROWSER_EXTENSION_NAME = 'local-ai-live-browser';

const LIVE_BROWSER_EXTENSION_DESCRIPTION =
  'Local AI Desktop Live Browser: the same Chromium page the user watches in the Live Browser panel. ' +
  'Tools: browser_open (navigate to URL), browser_back/browser_forward/browser_reload, browser_state (url/title/ownership), ' +
  'browser_read (page text), browser_inspect (element info incl. CSS/selector/a11y), browser_click, browser_fill, browser_scroll, ' +
  'browser_set_viewport, browser_screenshot (full or region crop), browser_list_areas, browser_describe_area (bounded context of a user selection), ' +
  'browser_ground_region, browser_set_area_status, browser_check_area, browser_take_control, browser_release_input. ' +
  'Coordinates are CSS pixels; region geometry is document-space CSS px.';

function mcpUri(endpoint: { url: string }): string {
  return `${endpoint.url.replace(/\/+$/, '')}/mcp`;
}

/**
 * Make sure the Live Browser MCP extension is registered and enabled for the
 * given runtime endpoint. Safe to call repeatedly.
 */
export async function ensureLiveBrowserExtension(endpoint: { url: string; token: string }): Promise<void> {
  const uri = mcpUri(endpoint);
  const { extensions } = await getConfiguredExtensions();
  const entry = extensions.find((e) => e.name === LIVE_BROWSER_EXTENSION_NAME);
  if (entry) {
    if (entry.type === 'streamable_http' && entry.uri === uri) {
      if (!entry.enabled && entry.configKey) {
        await setConfigExtensionEnabled(entry.configKey, true);
      }
      return; // already registered for this endpoint
    }
    // Runtime restarted with a new port (or replaced by another type):
    // drop the stale registration and re-add below.
    if (entry.configKey) {
      await removeConfigExtension(entry.configKey);
    }
  }
  await addConfigExtension(
    {
      type: 'streamable_http',
      name: LIVE_BROWSER_EXTENSION_NAME,
      description: LIVE_BROWSER_EXTENSION_DESCRIPTION,
      uri,
      headers: { authorization: `Bearer ${endpoint.token}` },
      env_keys: [],
      timeout: 60_000,
    },
    true,
  );
}
