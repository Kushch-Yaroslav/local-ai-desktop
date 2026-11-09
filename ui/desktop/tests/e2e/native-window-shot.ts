/** Opt-in X11 capture: includes WebContentsView, unlike renderer screenshots. */
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';

export async function nativeWindowShot(page: Page, file: string): Promise<void> {
  if (process.env.LAD_E2E_VISUAL !== '1') return;
  const title = `LAD2-isolated-visual-${process.pid}`;
  await page.evaluate((title) => {
    document.title = title;
  }, title);
  await page.waitForTimeout(300);
  execFileSync(
    '/usr/bin/python3',
    [
      '-c',
      `
import gi,re,subprocess,sys
gi.require_version('Gdk','3.0')
from gi.repository import Gdk,GdkX11
tree=subprocess.check_output(['xwininfo','-root','-tree'],text=True)
matches=re.findall(r'(0x[0-9a-f]+) "'+re.escape(sys.argv[1])+r'": \\("local-ai-desktop',tree)
if len(matches)!=1: raise RuntimeError('Isolated test window not uniquely identified')
display=Gdk.Display.get_default()
window=GdkX11.X11Window.foreign_new_for_display(display,int(matches[0],16))
width,height=window.get_width(),window.get_height()
pixels=Gdk.pixbuf_get_from_window(window,0,0,width,height)
if not pixels: raise RuntimeError('Native window capture unavailable')
pixels.savev(sys.argv[2],'png',[],[])
`,
      title,
      file,
    ],
    { timeout: 10000 }
  );
}

export async function resizeNativeWindow(page: Page, width: number, height: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  await page.evaluate(({ width, height }) => window.electron.liveBrowserTestWindow(width, height), {
    width,
    height,
  });
  await page.waitForFunction(
    ({ width, height }) =>
      Math.abs(window.innerWidth - width) < 3 && Math.abs(window.innerHeight - height) < 32,
    { width, height }
  );
  await page.waitForTimeout(250);
}

/** OS pointer input on the uniquely titled isolated window; no user windows selected. */
export async function nativePointer(
  page: Page,
  points: { x: number; y: number }[],
  button = 1
): Promise<void> {
  if (process.env.LAD_E2E_VISUAL !== '1') return;
  const title = `LAD2-isolated-visual-${process.pid}`;
  await page.evaluate((title) => {
    document.title = title;
  }, title);
  const size = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  execFileSync(
    '/usr/bin/python3',
    [
      '-c',
      `
import gi,re,subprocess,sys,json,ctypes,time
from ctypes import c_int,c_uint,c_ulong,c_void_p,c_char_p
gi.require_version('Gdk','3.0')
from gi.repository import Gdk,GdkX11
matches=re.findall(r'(0x[0-9a-f]+) "'+re.escape(sys.argv[1])+r'": \\("local-ai-desktop',subprocess.check_output(['xwininfo','-root','-tree'],text=True))
if len(matches)!=1:raise RuntimeError('Isolated input window is not unique')
display=Gdk.Display.get_default();window=GdkX11.X11Window.foreign_new_for_display(display,int(matches[0],16))
origin=window.get_origin()[1:];size=json.loads(sys.argv[3]);points=json.loads(sys.argv[2]);offset=window.get_height()-size['height']
if window.get_width()!=size['width'] or offset<0 or offset>100:raise RuntimeError('Native input geometry mismatch')
old=display.get_default_seat().get_pointer().get_position()
x=ctypes.CDLL('libX11.so.6');xt=ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes=[c_char_p];x.XOpenDisplay.restype=c_void_p;connection=x.XOpenDisplay(None)
x.XFlush.argtypes=[c_void_p];x.XCloseDisplay.argtypes=[c_void_p]
xt.XTestFakeMotionEvent.argtypes=[c_void_p,c_int,c_int,c_int,c_ulong];xt.XTestFakeButtonEvent.argtypes=[c_void_p,c_uint,c_int,c_ulong]
def move(p):xt.XTestFakeMotionEvent(connection,-1,origin[0]+int(p['x']),origin[1]+offset+int(p['y']),0);x.XFlush(connection)
button=int(sys.argv[4])
try:
 move(points[0]);time.sleep(.1);xt.XTestFakeButtonEvent(connection,button,1,0);x.XFlush(connection)
 for p in points[1:]:move(p);time.sleep(.02)
 time.sleep(.1)
finally:
 xt.XTestFakeButtonEvent(connection,button,0,0);x.XFlush(connection);time.sleep(.1)
 xt.XTestFakeMotionEvent(connection,-1,old[1],old[2],0);x.XFlush(connection);x.XCloseDisplay(connection)
`,
      title,
      JSON.stringify(points),
      JSON.stringify(size),
      String(button),
    ],
    { timeout: 10000, stdio: 'inherit' }
  );
  await page.waitForTimeout(200);
}
