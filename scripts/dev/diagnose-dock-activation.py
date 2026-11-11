#!/usr/bin/python3
"""Run in the GNOME terminal, then click the Dock icon once when prompted."""
import json
import os
from pathlib import Path
import re
import subprocess
import time
repo = Path(__file__).resolve().parents[2]
def snapshot():
    result = []
    ids = subprocess.run(['xprop', '-root', '_NET_CLIENT_LIST'], capture_output=True, text=True).stdout
    for wid in re.findall(r'0x[0-9a-f]+', ids):
        props = subprocess.run(['xprop', '-id', wid, 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE', '_NET_WM_DESKTOP'], capture_output=True, text=True).stdout
        if 'local-ai-desktop' in props.lower():
            result.append({'id': wid, 'properties': props})
    return result
before = snapshot()
print('Click the Local AI Desktop Dock icon once now. Recording for 20 seconds.', flush=True)
time.sleep(20)
state = Path(os.environ.get('XDG_STATE_HOME', str(Path.home()/'.local/state'))) / 'local-ai-desktop-goose-dev'
root = Path(os.environ.get('XDG_DATA_HOME', str(Path.home()/'.local/share'))) / 'local-ai-desktop-goose-dev'
log = root/'electron/logs/main.log'
allowed = ('[activation]', 'single-instance lock:', 'React ready event received', 'runtime ready at')
lines = [l for l in log.read_text(errors='replace').splitlines()[-150:] if any(k in l for k in allowed)] if log.exists() else []
report = {'at': time.time(), 'before': before, 'after': snapshot(), 'favorites': subprocess.run(['gsettings','get','org.gnome.shell','favorite-apps'], capture_output=True,text=True).stdout.strip(), 'activationEvents': lines}
out = repo/'.local-work/dock-activation-diagnostic.json'
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(report, indent=2))
print(out)
