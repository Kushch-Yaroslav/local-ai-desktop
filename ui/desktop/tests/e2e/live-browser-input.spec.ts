/** Native HTML input through the actual WebContentsView; no canvas event proxy. */
import { test, expect } from './fixtures';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeNativeWindow, nativePointer, nativeWindowShot } from './native-window-shot';
process.env.LAD_E2E_ISOLATE = '1';
test('native file chooser and HTML drag-and-drop reach the same Page', async ({
  goosePage: page,
}) => {
  test.setTimeout(90000);
  const directory = mkdtempSync(join(tmpdir(), 'lad-owned-upload-')),
    file = join(directory, 'fixture.txt');
  writeFileSync(file, 'owned-upload-content');
  const server = createServer((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<!doctype html><title>Native input fixture</title><style>body{margin:32px;font:16px system-ui}#drag{margin-top:30px;width:100px;height:60px;background:#cde}#drop{position:absolute;left:240px;top:100px;width:180px;height:100px;border:2px dashed #789}</style><input id="upload" type="file"><p id="uploaded"></p><div id="drag" draggable="true">Drag product</div><div id="drop">Drop here</div><script>upload.onchange=async()=>uploaded.textContent=upload.files[0].name+':'+await upload.files[0].text();drag.ondragstart=e=>e.dataTransfer.setData('text/plain','product');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();drop.textContent='Dropped '+e.dataTransfer.getData('text/plain')}</script>`
      )
  );
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    await resizeNativeWindow(page, 1600, 1000);
    await page.getByTestId('browser-toggle').click();
    await page.getByTestId('live-browser-url-input').fill(url);
    await page.getByTestId('live-browser-open').click();
    await expect
      .poll(() =>
        page
          .context()
          .pages()
          .some((p) => p.url() === url)
      )
      .toBe(true);
    const native = page
      .context()
      .pages()
      .find((p) => p.url() === url)!;
    await expect(native.locator('#upload')).toBeVisible();
    // This exercises Chromium's file chooser event and a deliberately approved fixture file.
    // It does not certify every platform's graphical OS chooser dialog.
    const choosing = native.waitForEvent('filechooser');
    await native.locator('#upload').click();
    const chooser = await choosing;
    await chooser.setFiles(file);
    await expect(native.locator('#uploaded')).toHaveText('fixture.txt:owned-upload-content');
    await native.evaluate(() => {
      (window as unknown as { events: unknown[] }).events = [];
      for (const type of ['pointerdown', 'dragstart', 'dragenter', 'drop'])
        document.addEventListener(type, (e) =>
          (window as unknown as { events: unknown[] }).events.push({
            type: e.type,
            target: (e.target as HTMLElement)?.id,
          })
        );
    });
    if (process.env.LAD_E2E_VISUAL === '1') {
      const surface = (await page.getByTestId('live-browser-surface').boundingBox())!,
        from = (await native.locator('#drag').boundingBox())!,
        to = (await native.locator('#drop').boundingBox())!;
      const start = {
          x: surface.x + from.x + from.width / 2,
          y: surface.y + from.y + from.height / 2,
        },
        end = { x: surface.x + to.x + to.width / 2, y: surface.y + to.y + to.height / 2 };
      await nativePointer(
        page,
        Array.from({ length: 35 }, (_, i) => ({
          x: start.x + ((end.x - start.x) * i) / 34,
          y: start.y + ((end.y - start.y) * i) / 34,
        }))
      );
    } else await native.locator('#drag').dragTo(native.locator('#drop'));
    console.log(
      'native-drag-events',
      await native.evaluate(() => (window as unknown as { events: unknown[] }).events)
    );
    await nativeWindowShot(page, test.info().outputPath('native-input-debug.png'));
    await expect(native.locator('#drop')).toHaveText('Dropped product');
    await nativeWindowShot(page, test.info().outputPath('native-upload-drag.png'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
