#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
entry_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
launcher="$repo/scripts/dev/launch-goose-dev.sh"
pointer="$repo/.local-work/desktop-selected.path"
[[ -x "$launcher" && -f "$pointer" ]] || { echo 'Activate and validate a package first.' >&2; exit 1; }
selected="$(realpath -e -- "$(head -n 1 "$pointer")")"
case "$selected" in "$repo"/.local-work/*/'Local AI Desktop') ;; *) echo 'Active package is outside this repository .local-work directory.' >&2; exit 1;; esac
package="$(dirname -- "$selected")"
for file in "$selected" "$package/resources/bin/goose" "$package/resources/live-browser/bin/node" "$package/resources/live-browser/dist/live-browser.js" "$package/resources/app.asar"; do
  [[ -r "$file" ]] || { echo "Missing active package resource: $file" >&2; exit 1; }
done
[[ -x "$selected" && -x "$package/resources/bin/goose" && -x "$package/resources/live-browser/bin/node" ]] || { echo 'Active package executable permissions are invalid.' >&2; exit 1; }
mkdir -p -- "$entry_dir"
canonical="$entry_dir/local-ai-desktop.desktop"
temp="$(mktemp -- "$entry_dir/.local-ai-desktop.XXXXXX")"
trap 'rm -f -- "$temp"' EXIT
cat > "$temp" <<EOF
[Desktop Entry]
Type=Application
Name=Local AI Desktop
Name[ru]=Local AI Desktop
Comment=Local AI Desktop with Goose runtime
Comment[ru]=Local AI Desktop с Goose runtime
Exec=$launcher
TryExec=$launcher
Path=$repo
Icon=$repo/ui/desktop/src/images/icon.png
Terminal=false
Categories=Development;
StartupNotify=true
DBusActivatable=false
StartupWMClass=local-ai-desktop-goose-dev
EOF
chmod 644 "$temp"
mv -f -- "$temp" "$canonical"
for id in local-ai-desktop-ollama.desktop local-ai-desktop-llama-cpp.desktop local-ai-desktop-goose-dev.desktop; do
  old="$entry_dir/$id"
  if [[ -f "$old" ]] && ! grep -q '^Hidden=true$' "$old"; then
    cp -p -- "$old" "$old.pre-goose-$(date +%Y%m%d%H%M%S).bak"
    name="$(sed -n 's/^Name=//p' "$old" | head -n 1)"
    cat > "$old" <<EOF
[Desktop Entry]
Type=Application
Name=${name:-Legacy Local AI Desktop}
Hidden=true
EOF
    chmod 644 "$old"
  fi
done
if command -v gsettings >/dev/null && gsettings writable org.gnome.shell favorite-apps >/dev/null 2>&1; then
  python3 - <<'PY' | xargs -0 gsettings set org.gnome.shell favorite-apps
import ast,subprocess,sys
raw=subprocess.check_output(['gsettings','get','org.gnome.shell','favorite-apps'],text=True)
items=ast.literal_eval(raw); out=[]
old={'local-ai-desktop.desktop','local-ai-desktop-ollama.desktop','local-ai-desktop-llama-cpp.desktop','local-ai-desktop-goose-dev.desktop'}
for value in items:
    if value in old:
        if 'local-ai-desktop.desktop' not in out: out.append('local-ai-desktop.desktop')
    else: out.append(value)
if 'local-ai-desktop.desktop' not in out: out.append('local-ai-desktop.desktop')
sys.stdout.buffer.write((repr(out)).encode()+b'\0')
PY
fi
command -v update-desktop-database >/dev/null && update-desktop-database "$entry_dir" || true
printf 'GNOME menu and Dock ID local-ai-desktop.desktop now uses %s\n' "$launcher"
printf 'Active packaged executable: %s\n' "$selected"
