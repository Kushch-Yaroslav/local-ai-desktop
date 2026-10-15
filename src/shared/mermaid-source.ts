/** One bounded formatting repair candidate. Preserve source separately and
 * always try parsing the original before using this candidate. */
export function mermaidFormattingCandidate(source: string): string {
  let text = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  // Some models serialize an entire diagram onto one line. Decode only
  // separators outside labels/quotes; quoted Windows paths remain literal.
  if (!text.includes('\n') && /\\n/.test(text)) {
    let quoted = false; let brackets = 0; let edgeLabel = false; let decoded = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"' && text[index - 1] !== '\\') quoted = !quoted;
      if (!quoted) {
        if (char === '[') brackets += 1;
        if (char === ']') brackets = Math.max(0, brackets - 1);
        if (char === '|') edgeLabel = !edgeLabel;
      }
      if (!quoted && brackets === 0 && !edgeLabel && char === '\\' && text[index + 1] === 'n') { decoded += '\n'; index += 1; }
      else decoded += char;
    }
    text = decoded;
  }
  if (!/^\s*(?:flowchart|graph)\s+(?:TB|TD|BT|LR|RL)\b/.test(text)) return text;
  // Only plain rectangular node labels. Leave shape delimiters, nested
  // brackets, existing quoted labels, directives and other diagram types alone.
  const quotedAt: boolean[] = []; let quoted = false;
  for (let index = 0; index < text.length; index++) { quotedAt[index] = quoted; if (text[index] === '"' && text[index - 1] !== '\\') quoted = !quoted; }
  return text.replace(/\b([\p{L}\d_]+)\[([^[\]"\r\n]*)\]/gu, (match, id: string, label: string, offset: number) => {
    if (quotedAt[offset]) return match;
    if (label.startsWith('(') || label.startsWith('{') || label.startsWith('/') && label.endsWith('/')) return match;
    const formatted = /[A-Za-z]:\\/.test(label) ? label : label.replaceAll('\\n', '<br/>');
    return `${id}["${formatted.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"]`;
  });
}

export async function parseMermaidWithFormatting(source: string, parse: (source: string) => Promise<unknown>): Promise<string> {
  if (source.length > 16_000) throw new Error('Diagram exceeds the 16,000 character size limit.');
  try { await parse(source); return source; }
  catch (originalError) {
    const candidate = mermaidFormattingCandidate(source);
    if (candidate !== source) {
      try { await parse(candidate); return candidate; } catch { /* retain the original parser diagnostic */ }
    }
    throw originalError;
  }
}
