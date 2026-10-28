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
  for (const note of notes.filter(n => n.processed).sort((a,b) => a.start-b.start)) {
    const prior = ranges.at(-1);
    if (prior && note.start <= prior[1]) prior[1] = Math.max(prior[1], note.end);
    else ranges.push([note.start, note.end]);
  }
  const offset = ranges[0]?.[0] === 0 ? ranges[0][1] : 0;
  return { current_offset: offset, total_characters: total, covered_ranges: ranges, processed_characters: ranges.reduce((n,[a,b])=>n+b-a,0), completed: offset === total, last_processed_chunk: notes.filter(n=>n.processed).at(-1) ?? null };
}
