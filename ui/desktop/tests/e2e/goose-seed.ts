import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Seeds an isolated goose-backend (GOOSE_PATH_ROOT) for E2E app instances.
 *
 * The test app must not touch the user's live configuration. Instead we give
 * it a fresh goose config whose single provider points at the ALREADY-RUNNING
 * local llama-server (the same inference endpoint the user's app uses). No
 * second model is loaded and the server lifecycle is never touched:
 *
 *   test app goose → openai-compatible provider → http://127.0.0.1:<port>
 *
 * The API key is read from the llama-server process environment
 * (LLAMA_API_KEY); it stays local to the machine and never enters the repo.
 *
 * Secret handling: goose stores provider keys in the system keyring by
 * default. The test app runs with GOOSE_DISABLE_KEYRING=true (see fixtures),
 * so goose reads/writes secrets from <config_dir>/secrets.yaml, which we
 * pre-seed here.
 */
export interface LlamaServerEndpoint {
  pid: number;
  port: number;
  apiKey: string;
  modelAlias: string;
  baseUrl: string;
}

const PROVIDER_NAME = 'custom_e2e_local_qwen';
const SECRET_KEY = 'CUSTOM_E2E_LOCAL_QWEN_API_KEY';

function splitNul(raw: string): string[] {
  return raw.split('\0').filter((part) => part.length > 0);
}

/** Finds the running llama-server and its loopback OpenAI endpoint. */
export function discoverLlamaServer(): LlamaServerEndpoint | null {
  if (process.platform === 'win32') {
    return null;
  }
  // Inspect executable names; pgrep -f can select the invoking shell or IDE prompt.
  const pid = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .find((id) => {
      try {
        return /(?:^|\/)llama-server$/.test(
          splitNul(readFileSync(`/proc/${id}/cmdline`, 'utf8'))[0] ?? ''
        );
      } catch {
        return false;
      }
    });
  if (!pid) return null;

  let cmdline: string;
  let environ: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
  } catch {
    return null;
  }

  const args = splitNul(cmdline);
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : NaN;
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const aliasIndex = args.indexOf('--alias');
  const modelAlias = aliasIndex >= 0 && args[aliasIndex + 1] ? args[aliasIndex + 1] : 'local-gguf';

  const env = new Map<string, string>();
  for (const entry of splitNul(environ)) {
    const eq = entry.indexOf('=');
    if (eq > 0) {
      env.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
  }
  const apiKey = env.get('LLAMA_API_KEY');
  if (!apiKey) {
    return null;
  }

  return {
    pid,
    port,
    apiKey,
    modelAlias,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

/**
 * Writes a minimal goose config under <devRoot>/goose-backend with the
 * shared local provider enabled and active. Safe to call repeatedly.
 */
export function seedGooseBackend(devRoot: string, endpoint: LlamaServerEndpoint): void {
  const configDir = join(devRoot, 'goose-backend', 'config');
  const providersDir = join(configDir, 'custom_providers');
  mkdirSync(providersDir, { recursive: true });

  const provider = {
    name: PROVIDER_NAME,
    engine: 'openai',
    display_name: 'E2E local Qwen (shared llama-server)',
    description:
      'E2E test provider for the already-running local llama-server. No second model is loaded.',
    api_key_env: SECRET_KEY,
    base_url: endpoint.baseUrl,
    models: [
      {
        name: endpoint.modelAlias,
        context_limit: null,
        input_token_cost: null,
        output_token_cost: null,
        currency: null,
        supports_cache_control: null,
        reasoning: false,
      },
    ],
    headers: {},
    session_id_header_override: null,
    timeout_seconds: null,
    supports_streaming: true,
    requires_auth: true,
    catalog_provider_id: null,
    base_path: null,
    env_vars: null,
    auth: null,
    dynamic_models: null,
    skip_canonical_filtering: false,
    model_doc_link: null,
    setup_steps: [],
    toolshim: false,
    preserves_thinking: true,
    emit_clear_thinking: false,
    setup: null,
  };
  writeFileSync(
    join(providersDir, `${PROVIDER_NAME}.json`),
    `${JSON.stringify(provider, null, 2)}\n`,
    'utf8'
  );

  const configYaml = [
    'providers:',
    `  ${PROVIDER_NAME}:`,
    '    enabled: true',
    `    model: ${endpoint.modelAlias}`,
    '    configured: true',
    `active_provider: ${PROVIDER_NAME}`,
    'GOOSE_MODE: chat',
    'GOOSE_TELEMETRY_ENABLED: false',
    'GOOSE_AUTO_EFFORT_ENABLED: false',
    '',
  ].join('\n');
  writeFileSync(join(configDir, 'config.yaml'), configYaml, 'utf8');

  // GOOSE_DISABLE_KEYRING=true in the test env makes goose use this file.
  const secretsPath = join(configDir, 'secrets.yaml');
  writeFileSync(secretsPath, `${SECRET_KEY}: ${endpoint.apiKey}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(secretsPath, 0o600);
}
