/** Stored independently of inference history. Ranges use UTF-16 character offsets, [start,end). */
export interface DocumentChunkNote {
  attachmentId: string;
  contentHash: string;
  start: number;
  end: number;
  observationId: string;
  summary: string;
  processed: boolean;
  createdAt: string;
}
export function readingProgress(notes: DocumentChunkNote[], total: number) {
  const ranges: Array<[number, number]> = [];
  for (const note of notes.filter(n => n.processed && Number.isSafeInteger(n.start) && Number.isSafeInteger(n.end) && n.start >= 0 && n.end > n.start && n.end <= total).sort((a,b) => a.start-b.start)) {
    const prior = ranges.at(-1);
    if (prior && note.start <= prior[1]) prior[1] = Math.max(prior[1], note.end);
    else ranges.push([note.start, note.end]);
  }
  const offset = ranges[0]?.[0] === 0 ? ranges[0][1] : 0;
  return { current_offset: offset, total_characters: total, covered_ranges: ranges, processed_characters: ranges.reduce((n,[a,b])=>n+b-a,0), completed: offset === total, last_processed_chunk: notes.filter(n=>n.processed).at(-1) ?? null };
}

/** Ignore navigation-only TOC entries: a heading must have prose before the next heading. */
export function documentSections(text: string) {
  const headings = [...text.matchAll(/^(?:#{1,6}[^\S\n]+[^\n]+|(?:Глава|Часть|Chapter|Part)[^\S\n]+[^\n]{1,140})/gim)];
  return headings.filter((match, i) => text.slice(match.index! + match[0].length, headings[i + 1]?.index ?? text.length).trim().length > 160)
    .map(match => ({ title: match[0].trim(), offset_chars: match.index! }));
}
