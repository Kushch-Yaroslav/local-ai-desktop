import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs';

/** File readiness is independent of backend health and optional metadata capabilities. */
export function ggufFileAvailability(path: string): { status: 'ready' | 'unavailable' | 'invalid'; issue?: string } {
  try { verifyGgufArtifacts(path); }
  catch (error) { return { status: 'unavailable', issue: error instanceof Error ? error.message : String(error) }; }
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(8);
    if (readSync(fd, header, 0, 8, 0) !== 8 || header.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4))) {
      return { status: 'invalid', issue: `Invalid GGUF v2/v3 header: ${path}` };
    }
    return { status: 'ready' };
  } catch (error) { return { status: 'unavailable', issue: error instanceof Error ? error.message : String(error) }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** llama.cpp's conventional split GGUF naming; the first shard is the launch path. */
export function ggufArtifactPaths(path: string): string[] {
  const split = path.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!split) return [path];
  const count = Number(split[3]);
  if (split[2] !== '00001' || count < 1 || count > 1_024) throw new Error('Некорректный первый файл split GGUF.');
  return Array.from({ length: count }, (_, index) => `${split[1]}-${String(index + 1).padStart(5, '0')}-of-${split[3]}.gguf`);
}

export function verifyGgufArtifacts(path: string): void {
  for (const artifact of ggufArtifactPaths(path)) {
    if (!statSync(artifact).isFile()) throw new Error(`GGUF не является файлом: ${artifact}.`);
    accessSync(artifact, constants.R_OK);
  }
}

/** Preserve single-file keys exactly; a split model's key includes every required shard. */
export function ggufArtifactFingerprint(path: string, live = false): string {
  const parts = ggufArtifactPaths(path).map((artifact) => {
    const file = statSync(artifact);
    if (!file.isFile()) throw new Error(`GGUF не является файлом: ${artifact}.`);
    return `${live ? `${file.dev}:${file.ino}:` : ''}${file.size}:${file.mtimeMs}`;
  });
  return parts.length === 1 ? parts[0] : JSON.stringify(parts);
}
