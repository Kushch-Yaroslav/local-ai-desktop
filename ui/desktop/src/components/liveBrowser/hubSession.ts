/** A scratch browser belongs to one window, before a real Goose chat exists. */
let fallback: string | undefined;
export function browserHubId(): string {
  try {
    const stored = window.sessionStorage.getItem('lad.browser.hubId');
    if (stored && /^hub-[0-9a-f-]{36}$/.test(stored)) return stored;
    const id = `hub-${globalThis.crypto.randomUUID()}`;
    window.sessionStorage.setItem('lad.browser.hubId', id);
    return id;
  } catch {
    return (fallback ??= `hub-${globalThis.crypto.randomUUID()}`);
  }
}
