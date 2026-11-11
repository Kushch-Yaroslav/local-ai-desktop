/** Isolated real native-window acceptance for bounded findings at low heights. */
import { test, expect } from './fixtures';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resizeNativeWindow, nativeWindowShot } from './native-window-shot';
process.env.LAD_E2E_ISOLATE = '1';
for (const count of [0, 1, 3, 7, 15]) {
  test(`findings ${count}: bounded inspector across window sizes`, async ({ goosePage: page }) => {
    test.setTimeout(120000);
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<title>Inspector fixture</title><style>body{margin:12px;font:14px sans-serif;background:#edf2f7}.card{width:100px;height:20px;overflow:hidden;white-space:nowrap;margin:2px;background:white}</style><main><h2>Rinnova Pro catalog</h2>${Array.from({ length: count }, (_, i) => `<div class="card" id="product-${i}">Product ${i + 1} with a deliberately overflowing product title and details</div>`).join('')}</main>`
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await resizeNativeWindow(page, 1600, 1000);
      await page.getByTestId('browser-toggle').click();
      await page
        .getByTestId('live-browser-url-input')
        .fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      await page.getByTestId('live-browser-open').click();
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const result = (await window.electron.liveBrowserNativeTest(
              window.sessionStorage.getItem('lad.browser.hubId')!,
              'Runtime.evaluate',
              { expression: 'document.title', returnByValue: true }
            )) as { result: { value: string } };
            return result.result.value;
          })
        )
        .toBe('Inspector fixture');
      await page.getByRole('button', { name: 'Find layout candidates', exact: true }).click();
      await expect(page.getByTestId('live-browser-finding')).toHaveCount(count);
      for (const [width, height] of [
        [1600, 1000],
        [1280, 720],
        [1100, 650],
        [940, 600],
      ]) {
        await resizeNativeWindow(page, width, height);
        if (count) {
          const list = page.getByTestId('live-browser-all-findings');
          await expect(list).toBeVisible();
          const bounds = (await list.boundingBox())!;
          expect(bounds.y + bounds.height).toBeLessThan(height + 1);
          expect(bounds.height).toBeGreaterThan(30);
          await list.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
          });
          await expect(page.getByTestId('live-browser-finding').last()).toBeInViewport();
        }
        await nativeWindowShot(
          page,
          test.info().outputPath(`findings-${count}-${width}x${height}.png`)
        );
      }
      if (count) {
        await page.getByTestId('live-browser-finding').last().click();
        await expect(page.getByTestId('live-browser-area')).toBeVisible();
        await nativeWindowShot(page, test.info().outputPath(`selected-${count}-940x600.png`));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
