#!/usr/bin/env bash
# Local AI Desktop development launcher; never builds on click.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
export LOCAL_AI_DESKTOP_DEV_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/local-ai-desktop-goose-dev"
export GOOSE_PATH_ROOT="$LOCAL_AI_DESKTOP_DEV_ROOT/goose-backend"
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/local-ai-desktop-goose-dev"
mkdir -p "$log_dir" "$LOCAL_AI_DESKTOP_DEV_ROOT/electron" "$GOOSE_PATH_ROOT"
# Record the original GNOME invocation before detaching. Keep at most two 1 MiB files.
(
  flock 9
  if [[ -f "$log_dir/launcher.log" ]] && (( $(stat -c %s "$log_dir/launcher.log") > 1048576 )); then
    mv -f "$log_dir/launcher.log" "$log_dir/launcher.log.1"
  fi
  printf '%s launcher_pid=%s detached=%s\n' "$(date --iso-8601=seconds)" "$$" "${LOCAL_AI_DESKTOP_DEV_DETACHED:-0}" >>"$log_dir/launcher.log"
) 9>"$log_dir/launcher.lock"
if [[ "${LOCAL_AI_DESKTOP_DEV_DETACHED:-0}" != 1 ]] && command -v setsid >/dev/null; then
  exec setsid --fork env LOCAL_AI_DESKTOP_DEV_DETACHED=1 "$repo/scripts/dev/launch-goose-dev.sh" "$@" >>"$log_dir/launcher.log" 2>&1
fi
cd "$repo"
executable="$repo/ui/desktop/out/Local AI Desktop-linux-x64/Local AI Desktop"
if [[ ! -x "$executable" || ! -x "$(dirname "$executable")/resources/bin/goose" ]]; then
  echo "Missing packaged development app: $executable. See docs/development/advanced-local-inference.md for one-time build instructions."
  command -v notify-send >/dev/null && notify-send 'Local AI Desktop — Goose Dev' 'Build output missing. See development launcher log.' || true
  exit 1
fi
unset ELECTRON_RUN_AS_NODE GOOSE_EXTERNAL_BACKEND
# The user-local Forge package cannot own a root SUID chrome-sandbox helper.
# This keeps Chromium's user-namespace sandbox enabled while avoiding the
# invalid packaged SUID helper that aborts before Electron can create a window.
exec /usr/bin/python3 "$repo/scripts/dev/launch-diagnostics.py" "$executable" --disable-setuid-sandbox "$@"
