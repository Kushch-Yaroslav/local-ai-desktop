// Opt-in bounded host matrix: generated images only, temporary profiles and owned processes.
import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import { ManagedGguf } from './managedGguf';
const execute = promisify(execFile);
function crc(data: Buffer) {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function image(red: boolean) {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      n = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    n.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([n, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(128, 0);
  header.writeUInt32BE(128, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(128 * (128 * 3 + 1));
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) pixels[y * 385 + 1 + x * 3 + (red ? 0 : 2)] = 255;
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
it.skipIf(process.env.LAD_VISION_GPU_SMOKE !== '1' || !process.env.LAD_GGUF_TEST_MODEL || !process.env.LAD_GGUF_TEST_PROJECTOR || !process.env.LAD_RUNTIME_TEST_PATH)(
  'runs A/B/C/D with text, genuinely image-dependent inference and gateway forwarding',
  async () => {
    expect(
      await execute('pgrep', ['-x', 'llama-server']).then(
        (r) => r.stdout.trim(),
        () => ''
      )
    ).toBe('');
    expect(
      Number(
        (
          await execute('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'])
        ).stdout.trim()
      )
    ).toBeGreaterThan(22500);
    const dir = await mkdtemp(join(tmpdir(), 'lad-vision-'));
    const service = new ManagedGguf(dir);
    const report: Record<string, unknown> = {};
    try {
      for (const [name, vision, mtp] of [
        ['A', false, false],
        ['B', false, true],
        ['C', true, false],
        ['D', true, true],
        ['E', true, true],
      ] as const) {
        if ((process.env.LAD_VISION_CPU_ONLY === '1') !== (name === 'E')) continue;
        const profile = await service.save({
          name: 'temporary vision probe',
          model: process.env.LAD_GGUF_TEST_MODEL!,
          projectorCpu: name === 'E' || undefined,
          projector: vision
            ? process.env.LAD_GGUF_TEST_PROJECTOR!
            : undefined,
          executable: process.env.LAD_RUNTIME_TEST_PATH!,
          gpuLayers: 999,
          context: 8192,
          cacheK: 'q8_0',
          cacheV: 'q8_0',
          flashAttention: 'on',
          speculativeMode: mtp ? 'mtp-embedded' : 'off',
          draftTokens: 2,
          threads: 8,
          batch: 256,
          ubatch: 128,
        });
        const endpoint = await service.activate(profile.id!);
        const gateway = await service.prepare(profile.id!);
        const ask = async (target: typeof endpoint, content: unknown, max = 16) => {
          const response = await fetch(target.url + '/v1/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + target.key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'local-gguf',
              messages: [{ role: 'user', content }],
              max_tokens: max,
              temperature: 0,
              stream: false,
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: AbortSignal.timeout(45000),
          });
          expect(response.ok).toBe(true);
          return (await response.json()).choices[0].message.content as string;
        };
        await ask(endpoint, 'Reply OK.');
        const colors: string[] = [];
        if (vision)
          for (const target of [endpoint, gateway])
            for (const red of [true, false]) {
              const answer = await ask(target, [
                {
                  type: 'text',
                  text: 'What is the dominant colour in this image? Answer only RED or BLUE.',
                },
                { type: 'image_url', image_url: { url: image(red) } },
              ]);
              expect(answer.toUpperCase()).toContain(red ? 'RED' : 'BLUE');
            expect(answer.toUpperCase()).not.toContain(red ? 'BLUE' : 'RED');
              colors.push(red ? 'red-confirmed' : 'blue-confirmed');
            }
        await ask(gateway, 'Reply OK.');
        const memory = (
          await execute('nvidia-smi', [
            '--query-gpu=memory.used,memory.total',
            '--format=csv,noheader,nounits',
          ])
        ).stdout.trim();
        report[name] = {
          startup: true,
          health: true,
          text: true,
          colors,
          memoryMiB: memory,
          args: service.state.args,
        };
        const log = await readFile(join(dir, `gguf-${profile.id}.log`), 'utf8');
        expect(log).not.toContain('GGML_ASSERT');
        await service.unload();
      }
    } finally {
      await service.shutdown();
      await writeFile(
        process.env.LAD_VISION_CPU_ONLY === '1'
          ? '/tmp/lad-vision-cpu.json'
          : '/tmp/lad-vision-matrix.json',
        JSON.stringify(report, null, 2)
      );
      await rm(dir, { recursive: true, force: true });
    }
  },
  240000
);
