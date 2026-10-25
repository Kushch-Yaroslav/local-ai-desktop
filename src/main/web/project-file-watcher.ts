import { watch, type FSWatcher } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const ignored = new Set(['node_modules', 'vendor', 'coverage', 'tmp', 'temp', '__pycache__']);
const webExtensions = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.jsx', '.tsx', '.ts', '.scss', '.sass', '.less']);
/** Directory watches survive atomic file saves. Rescan metadata only after a quiet period.
 * No recursive native watch (which can follow symlinks), polling, or file content reads. */
export class ProjectFileWatcher {
  private readonly watches = new Map<string, { handle: FSWatcher; inode: string }>();
  private files = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private scanning?: Promise<void>;
  private closed = false;
  private base = '';
  constructor(private readonly root: string, private readonly changed: (at:number) => void, private readonly failed: (error: unknown) => void, private outputDirectories: readonly string[] = []) {}
  async start() {
    try { this.base = await realpath(this.root); await this.scan(true); }
    catch (error) { this.fail(error); }
  }
  private isOutput(directory:string){return this.outputDirectories.some(output=>{const path=resolve(this.base,output);return path!==this.base&&path.startsWith(this.base+sep)&&(directory===path||directory.startsWith(path+sep));});}
  async ignoreOutputs(outputs:readonly string[]){
    await this.scanning;if(this.closed)return;this.outputDirectories=outputs;
    // Removing generated files from the baseline is not a new source change.
    for(const path of this.files.keys())if(this.isOutput(path))this.files.delete(path);
    for(const [path,item] of this.watches)if(this.isOutput(path)){item.handle.close();this.watches.delete(path);}
  }
  get settled() { return !this.timer && !this.scanning; }
  async flush() {
    clearTimeout(this.timer); this.timer = undefined;
    try { await this.scanning; await this.scan(false); } catch (error) { this.fail(error); }
  }
  private schedule() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // A directory mutation during an in-flight scan gets a fresh pass afterwards.
      void (this.scanning ?? Promise.resolve()).then(() => this.scan(false)).catch(error => this.fail(error));
    }, 400);
    this.timer.unref();
  }
  private async scan(initial: boolean) {
    if (this.closed) return;
    const run = async () => {
      const files = new Map<string, string>(), directories = new Set<string>();
      let entries = 0;
      const visit = async (directory: string) => {
        if (this.closed) return;
        if(this.isOutput(directory))return;
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) return;
        if (directories.size >= 512) throw new Error('Auto-reload directory limit exceeded (512)');
        directories.add(directory);
        const inode = `${info.dev}:${info.ino}`, old = this.watches.get(directory);
        if (old?.inode !== inode) {
          old?.handle.close();
          if (this.closed) return;
          const handle = watch(directory, { persistent: false }, (event, filename) => {
            if (!filename) { this.schedule(); return; }
            const name = String(filename);
            if (name.startsWith('.') || ignored.has(name)) return;
            if (webExtensions.has(extname(name).toLowerCase())) { this.schedule(); return; }
            if (event === 'rename') {
              const child = join(directory, name);
              if (this.watches.has(child)) this.schedule();
              else void lstat(child).then(info => { if (info.isDirectory() && !info.isSymbolicLink()) this.schedule(); }, () => undefined);
            }
          });
          handle.on('error', error => this.fail(error));
          this.watches.set(directory, { handle, inode });
        }
        const listing = await opendir(directory);
        for await (const entry of listing) {
          if (this.closed) break;
          if (++entries > 50000) throw new Error('Auto-reload entry limit exceeded (50000)');
          if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          try {
            if (entry.isDirectory()) await visit(path);
            else if (entry.isFile() && webExtensions.has(extname(entry.name).toLowerCase())) {
              const file = await lstat(path);
              if (file.isFile() && !file.isSymbolicLink()) files.set(path, `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`);
            }
          } catch (error) {
            // Atomic rename/delete while enumerating is normal; its directory event reschedules.
            if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          }
        }
      };
      await visit(this.base);
      if (this.closed) return;
      for (const [directory, item] of this.watches) if (!directories.has(directory)) { item.handle.close(); this.watches.delete(directory); }
      const changed = files.size !== this.files.size || [...files].some(([path, stamp]) => this.files.get(path) !== stamp);
      this.files = files;
      if (!initial && changed) this.changed(Math.max(Date.now()-1000,...[...files.values()].map(stamp=>Number(stamp.split(':')[3]))));
    };
    this.scanning = run();
    try { await this.scanning; } finally { this.scanning = undefined; }
  }
  private fail(error: unknown) { if (!this.closed) { this.close(); this.failed(error); } }
  close() {
    this.closed = true; clearTimeout(this.timer); this.timer = undefined;
    for (const item of this.watches.values()) item.handle.close();
    this.watches.clear(); this.files.clear();
  }
}
