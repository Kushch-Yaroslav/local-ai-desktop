import { userInfo } from 'node:os';

// These values are transported as JSON data, never inherited by the loader of
// Rust or Bubblewrap. They are restored only for the confined payload.
export const payloadEnvironmentKeys = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CARGO_HOME', 'RUSTUP_HOME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
] as const;
export const systemExecutablePath = '/usr/bin:/bin';

export function agentRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env, restrictedPath = false): NodeJS.ProcessEnv {
  const account = userInfo();
  const payload: Record<string, string> = {};
  for (const key of payloadEnvironmentKeys) {
    const value = source[key];
    if (value !== undefined) {
      if (value.includes('\0') || Buffer.byteLength(value) > 16_384) throw new Error(`Invalid agent environment value: ${key}`);
      payload[key] = value;
    }
  }
  payload.PATH = restrictedPath ? systemExecutablePath : payload.PATH || systemExecutablePath;
  payload.HOME ||= account.homedir;
  payload.USER ||= account.username;
  payload.LOGNAME ||= account.username;
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 65_536) throw new Error('Agent payload environment exceeds limit');
  // No spread of process.env: even the Rust ELF loader gets a closed allowlist.
  const runtime: NodeJS.ProcessEnv = {
    PATH: systemExecutablePath, LANG: 'C', LC_ALL: 'C',
    HOME: payload.HOME, USER: account.username, LOGNAME: account.username,
    LOCAL_AI_AGENT_PAYLOAD_ENV: encoded,
  };
  // Trusted diagnostic configuration, not a loader hook; never sent to setup.
  if (source.LOCAL_AI_AGENT_TRACE_PATH) runtime.LOCAL_AI_AGENT_TRACE_PATH = source.LOCAL_AI_AGENT_TRACE_PATH;
  return runtime;
}
