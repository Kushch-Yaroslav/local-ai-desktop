#!/usr/bin/python3
"""Bounded, allowlisted Goose Dev launch diagnostics; never record request text."""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

root = Path(os.environ['LOCAL_AI_DESKTOP_DEV_ROOT'])
logs = Path(os.environ.get('XDG_STATE_HOME') or str(Path.home() / '.local/state')) / 'local-ai-desktop-goose-dev'
logs.mkdir(parents=True, exist_ok=True)
started = time.time()
file = logs / ('launch-' + datetime.datetime.now().strftime('%Y%m%dT%H%M%S') + '-' + str(os.getpid()) + '.jsonl')
lock = threading.Lock()
size = 0

def record(event, **details):
    global size
    line = json.dumps(dict(at=datetime.datetime.now().astimezone().isoformat(), event=event, **details)) + '\n'
    with lock:
        if size + len(line) > 262144:
            return
        with file.open('a') as stream:
            stream.write(line)
        size += len(line)

record('launcher', pid=os.getpid(), executable=sys.argv[1], cwd=os.getcwd(),
       apparmor=Path('/proc/self/attr/current').read_text().strip(),
       session_type=os.environ.get('XDG_SESSION_TYPE'), display=os.environ.get('DISPLAY'),
       wayland=bool(os.environ.get('WAYLAND_DISPLAY')), runtime_dir=os.environ.get('XDG_RUNTIME_DIR'),
       session_bus=bool(os.environ.get('DBUS_SESSION_BUS_ADDRESS')),
       startup_notification=bool(os.environ.get('DESKTOP_STARTUP_ID')),
       gio_entry=os.path.basename(os.environ.get('GIO_LAUNCHED_DESKTOP_FILE', '')))
for old in sorted(logs.glob('launch-*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)[8:]:
    old.unlink(missing_ok=True)
try:
    child = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
except OSError as error:
    record('spawn_failed', errno=error.errno)
    sys.exit(1)
record('electron_started', pid=child.pid)

def readiness():
    seen = False
    deadline = time.monotonic() + 60
    while child.poll() is None and time.monotonic() < deadline:
        for trace in (root / 'electron/logs/startup').glob(f'goose-serve-startup-*-{child.pid}.json'):
            try:
                data = json.loads(trace.read_text())
                if trace.stat().st_mtime < started:
                    continue
                if data.get('pid') and not seen:
                    record('backend_started', pid=data['pid'])
                    seen = True
                if data.get('healthCheckSucceeded') is True:
                    record('backend_ready', pid=data.get('pid'))
                    return
            except (OSError, ValueError):
                pass
        time.sleep(0.5)
    if child.poll() is None:
        record('backend_readiness_not_confirmed', timeout_seconds=60)

threading.Thread(target=readiness, daemon=True).start()
# Only fixed error classifications are retained; raw application output is not.
errors = {
    b'No usable sandbox!': 'no_usable_sandbox',
    b'SUID sandbox helper binary was found': 'invalid_suid_sandbox_helper',
    b'globalShortcut cannot be used before the app is ready': 'global_shortcut_before_ready',
    b'Goose binary not found': 'bundled_goose_missing',
    b'error while loading shared libraries': 'shared_library_load_failed',
}
for line in iter(lambda: child.stdout.readline(8192), b''):
    for needle, code in errors.items():
        if needle in line:
            record('startup_error', code=code)
            break
status = child.wait()
record('electron_exit', pid=child.pid, status=status)
sys.exit(status if status >= 0 else 128 - status)
