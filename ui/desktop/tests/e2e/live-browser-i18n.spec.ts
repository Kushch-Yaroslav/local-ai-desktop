import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import { nativeWindowShot } from './native-window-shot';

process.env.LAD_E2E_ISOLATE = '1';
process.env.LAD_E2E_LANGUAGE = 'ru';

async function evaluateNative(page: import('@playwright/test').Page, expression: string) {
  return page.evaluate(async (expression) => {
    const result = (await window.electron.liveBrowserNativeTest(
      window.sessionStorage.getItem('lad.browser.hubId')!,
      'Runtime.evaluate',
      { expression, returnByValue: true }
    )) as { result: { value: unknown } };
    return result.result.value;
  }, expression);
}

test('Live Browser Russian labels, empty action and area name are localized', async ({ goosePage }) => {
  test.setTimeout(90000);
  const page = goosePage;
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><title>Каталог</title><style>body{margin:0;padding:24px;font:16px system-ui}#item{width:280px;height:120px;padding:16px;border:2px solid #7292b7;border-radius:8px;background:#fff}</style><main><h1>Каталог товаров</h1><section id="item">Карточка товара</section></main>'
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await page.getByTestId('browser-toggle').click();
    await expect(page.getByTestId('live-browser-panel')).toBeVisible();
    await page.getByTestId('live-browser-tools-toggle').click();
    await expect(page.getByTestId('live-browser-areas')).toContainText('Области');
    const emptyAction = page.getByTestId('live-browser-empty-select');
    await expect(emptyAction).toHaveAccessibleName('Откройте страницу для выделения');
    await emptyAction.click();
    await expect(page.getByTestId('live-browser-url-input')).toBeFocused();

    await page.getByTestId('live-browser-url-input').fill(url);
    await page.getByTestId('live-browser-open').click();
    await expect.poll(() => evaluateNative(page, 'document.title')).toBe('Каталог');
    await expect(emptyAction).toHaveAccessibleName('Выделить область');
    await emptyAction.click();
    await expect.poll(() => evaluateNative(page, 'Boolean(document.getElementById("__lad-selection"))')).toBe(true);
    await page.evaluate(async () => {
      const hub = window.sessionStorage.getItem('lad.browser.hubId')!;
      for (const event of [
        { type: 'mousePressed', button: 'left', clickCount: 1, x: 28, y: 32 },
        { type: 'mouseMoved', buttons: 1, x: 310, y: 170 },
        { type: 'mouseReleased', button: 'left', clickCount: 1, x: 310, y: 170 },
      ])
        await window.electron.liveBrowserNativeTest(hub, 'Input.dispatchMouseEvent', event);
    });
    await expect(page.getByTestId('live-browser-area-row')).toContainText('Область 1');
    await expect(page.getByTestId('live-browser-area')).toContainText('Обнаружено');
    await expect(page.getByTestId('live-browser-area')).toContainText(
      'Описание проблемы / что нужно исправить'
    );
    await expect(page.getByTestId('live-browser-tools-toggle')).toContainText(/Области\s*1/u);
    await expect
      .poll(() => evaluateNative(page, 'document.getElementById("__lad-live-regions")?.dataset.visibleRegionCount'))
      .toBe('1');
    await nativeWindowShot(page, test.info().outputPath('native-ru-region.png'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.LAD_E2E_LANGUAGE;
  }
});
