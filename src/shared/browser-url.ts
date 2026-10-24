/** Match browser routes without discarding query values or HashRouter state. */
export function canonicalBrowserUrl(raw: string, base?: string): string {
  const url = new URL(raw, base);
  // WHATWG URL keeps an empty `?` in href although search is empty.
  if (!url.search) url.search = '';
  if (!url.hash) url.hash = '';
  return url.href;
}
export function sameBrowserUrl(a: string, b: string): boolean {
  try { return canonicalBrowserUrl(a) === canonicalBrowserUrl(b); } catch { return false; }
}
