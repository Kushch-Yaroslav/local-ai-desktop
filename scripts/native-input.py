"""XTest input for the isolated native-browser E2E window only."""
import ctypes
import sys
import time
x11 = ctypes.CDLL('libX11.so.6')
xtest = ctypes.CDLL('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XKeysymToKeycode.restype = ctypes.c_uint
xtest.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtest.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtest.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError('X11 display unavailable for native input E2E')
try:
    if sys.argv[1] == 'click':
        xtest.XTestFakeMotionEvent(display, -1, int(float(sys.argv[2])), int(float(sys.argv[3])), 0)
        xtest.XTestFakeButtonEvent(display, 1, 1, 0)
        xtest.XTestFakeButtonEvent(display, 1, 0, 0)
    elif sys.argv[1] == 'wheel':
        xtest.XTestFakeMotionEvent(display, -1, int(float(sys.argv[2])), int(float(sys.argv[3])), 0)
        button = 5 if int(sys.argv[4]) > 0 else 4
        for _ in range(abs(int(sys.argv[4]))):
            xtest.XTestFakeButtonEvent(display, button, 1, 0)
            xtest.XTestFakeButtonEvent(display, button, 0, 0)
    elif sys.argv[1] == 'key':
        codes = [x11.XKeysymToKeycode(display, x11.XStringToKeysym(key.encode())) for key in sys.argv[2].split('+')]
        if not all(codes):
            raise ValueError('Unknown test key')
        for code in codes:
            xtest.XTestFakeKeyEvent(display, code, 1, 0)
        x11.XFlush(display)
        time.sleep(float(sys.argv[3]))
        for code in reversed(codes):
            xtest.XTestFakeKeyEvent(display, code, 0, 0)
    elif sys.argv[1] == 'latency':
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
        x11.XGetImage.restype = ctypes.c_void_p
        x11.XGetPixel.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
        x11.XGetPixel.restype = ctypes.c_ulong
        x11.XDestroyImage.argtypes = [ctypes.c_void_p]
        x, y = int(float(sys.argv[2])), int(float(sys.argv[3]))
        root = x11.XDefaultRootWindow(display)
        def pixel_at_marker():
            image = x11.XGetImage(display, root, x, y, 1, 1, ctypes.c_ulong(-1).value, 2)
            if not image:
                raise RuntimeError('XGetImage failed')
            pixel = x11.XGetPixel(image, 0, 0)
            x11.XDestroyImage(image)
            return ((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255)
        before = pixel_at_marker()
        was_red = before[0] > 180 and before[2] < 80
        was_blue = before[2] > 180 and before[0] < 80
        if not (was_red or was_blue):
            raise RuntimeError('Latency marker pixel was not red/blue: ' + str(before))
        code = x11.XKeysymToKeycode(display, x11.XStringToKeysym(b'Right'))
        started = time.perf_counter()
        xtest.XTestFakeKeyEvent(display, code, 1, 0)
        xtest.XTestFakeKeyEvent(display, code, 0, 0)
        x11.XFlush(display)
        while time.perf_counter() - started < 3:
            pixel = pixel_at_marker()
            if (was_red and pixel[2] > 180 and pixel[0] < 80) or (was_blue and pixel[0] > 180 and pixel[2] < 80):
                print((time.perf_counter() - started) * 1000)
                break
            time.sleep(.001)
        else:
            raise RuntimeError('Native input did not produce a visible marker change')
    elif sys.argv[1] == 'capture':
        from PIL import ImageGrab
        x, y, width, height = [int(float(value)) for value in sys.argv[2:6]]
        ImageGrab.grab(bbox=(x, y, x + width, y + height)).save(sys.argv[6])
    else:
        raise ValueError('Unknown test action')
    x11.XFlush(display)
finally:
    x11.XCloseDisplay(display)
