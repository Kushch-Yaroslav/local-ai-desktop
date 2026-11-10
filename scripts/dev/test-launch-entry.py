#!/usr/bin/python3
"""Regression check for the installed Goose Dev Desktop Entry and active build."""
import configparser
import os
from pathlib import Path
import subprocess

entry = Path(os.environ.get('LAD_GOOSE_DESKTOP_ENTRY', Path.home() / '.local/share/applications/local-ai-desktop.desktop'))
assert entry.is_file(), f'Desktop Entry not found: {entry}'
config = configparser.ConfigParser(interpolation=None)
config.read(entry)
desktop = config['Desktop Entry']
assert desktop.get('Type') == 'Application'
entry_repo = Path(desktop['Path']).resolve(strict=True)
launcher = entry_repo / 'scripts/dev/launch-goose-dev.sh'
entry_installer = entry_repo / 'scripts/dev/install-ubuntu-menu-entry.sh'
activator = entry_repo / 'scripts/dev/activate-packaged-build.sh'
pointer = entry_repo / '.local-work/desktop-selected.path'
assert Path(desktop['Exec']).resolve(strict=True) == launcher.resolve(strict=True)
assert Path(desktop['TryExec']).resolve(strict=True) == launcher.resolve(strict=True)
assert os.access(launcher, os.X_OK) and os.access(activator, os.X_OK) and os.access(entry_installer, os.X_OK)
selected = Path(pointer.read_text().strip()).resolve(strict=True)
assert selected.name in {'Local AI Desktop', 'local-ai-desktop'}
approved_package_roots = [
    (entry_repo / '.local-work').resolve(),
    (Path.home() / '.local/opt/local-ai-desktop-goose-dev/packages').resolve(),
]
assert any(selected.is_relative_to(root) for root in approved_package_roots)
package = selected.parent
for relative in ('resources/bin/goose', 'resources/live-browser/bin/node', 'resources/live-browser/dist/live-browser.js', 'resources/live-browser/package.json', 'resources/app.asar'):
    path = package / relative
    assert path.is_file() and os.access(path, os.R_OK), f'Missing resource: {path}'
assert selected.is_file() and os.access(selected, os.X_OK), f'Not executable: {selected}'
for relative in ('resources/bin/goose', 'resources/live-browser/bin/node'):
    assert os.access(package / relative, os.X_OK), f'Not executable: {package / relative}'
subprocess.run(['bash', '-n', str(launcher), str(activator), str(entry_installer)], check=True)
assert desktop.get('Name') == 'Local AI Desktop'
assert desktop.get('StartupWMClass') == 'local-ai-desktop'
for alias in ('local-ai-desktop-ollama.desktop', 'local-ai-desktop-llama-cpp.desktop', 'local-ai-desktop-goose-dev.desktop'):
    alias_path = entry.parent / alias
    if alias_path.exists():
        alias_cfg = configparser.ConfigParser(interpolation=None); alias_cfg.read(alias_path)
        assert alias_cfg['Desktop Entry'].getboolean('Hidden', fallback=False), f'Conflicting menu entry remains visible: {alias}'
raw = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'favorite-apps'], text=True)
assert 'local-ai-desktop.desktop' in raw
subprocess.run([str(activator), '--check', str(package)], check=True)
print(f'PASS: canonical GNOME ID {entry.name} -> {launcher} -> {selected}')
