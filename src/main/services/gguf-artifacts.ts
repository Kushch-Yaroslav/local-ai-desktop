import { accessSync, existsSync, closeSync, constants, openSync, readSync, statSync, readFileSync } from 'node:fs';

/** File readiness is independent of backend health and optional metadata capabilities. */
export type GgufAvailabilityReason='not-found'|'disk-unavailable'|'access-denied'|'io-error';
export const mediaStorageRoot=(path:string):string|undefined=>path.match(/^(\/(?:run\/)?media\/[^/]+\/[^/]+)(?:\/|$)/)?.[1];
function unavailableMediaRoot(root:string):boolean{
  if(!existsSync(root))return true;
  if(process.platform!=='linux')return false;
  try{return !readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>line.split(' ')[4]?.replace(/\\([0-7]{3})/g,(_match,octal:string)=>String.fromCharCode(parseInt(octal,8)))===root);}
  catch{return false;}
}
export function ggufAvailabilityError(path:string,error:unknown):{status:'unavailable';reason:GgufAvailabilityReason;issue:string}{
  const code=(error as NodeJS.ErrnoException)?.code;
  const storage=mediaStorageRoot(path);
  const reason:GgufAvailabilityReason=code==='ENOENT'?(storage&&unavailableMediaRoot(storage)?'disk-unavailable':'not-found'):code==='EACCES'||code==='EPERM'?'access-denied':'io-error';
  return {status:'unavailable',reason,issue:error instanceof Error?error.message:String(error)};
}
export function ggufFileAvailability(path: string): { status: 'ready' | 'unavailable' | 'invalid'; reason?:GgufAvailabilityReason; issue?: string } {
  try { verifyGgufArtifacts(path); }
  catch (error) { return ggufAvailabilityError(path,error); }
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(8);
    if (readSync(fd, header, 0, 8, 0) !== 8 || header.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4))) {
      return { status: 'invalid', issue: `Invalid GGUF v2/v3 header: ${path}` };
    }
    return { status: 'ready' };
  } catch (error) { return ggufAvailabilityError(path,error); }
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
