#!/usr/bin/env bash
# Run isolated packaged QA from a host GUI terminal; never starts an inference server.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ $# -ge 1 && $# -le 2 ]] || { echo 'Usage: check-live-browser.sh /package/directory [--all|--qwen|--desktop-entry]'; exit 2; }
package="$(realpath -e -- "$1")"
node="$package/resources/live-browser/bin/node"
[[ -x "$package/Local AI Desktop" && -x "$node" ]] || { echo 'Packaged Electron or bundled Node missing'; exit 1; }
[[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]] || { echo 'Run from the host GUI session, not a headless or isolated PID/network namespace.'; exit 2; }
mode="${2:---all}"
specs=()
export LAD_E2E_ISOLATE=1 LAD_E2E_REQUIRE_BUNDLED_NODE=1
export LAD_E2E_PACKAGED_EXECUTABLE="$package/Local AI Desktop"
export LAD_E2E_VISUAL="${LAD_E2E_VISUAL:-1}"
case "$mode" in
 --qwen) specs=(tests/e2e/live-browser-qwen-fix.spec.ts);export LAD_E2E_REQUIRE_QWEN=1;;
 --desktop-entry) specs=(tests/e2e/live-browser.spec.ts --grep 'panel, navigation');export LAD_E2E_DESKTOP_LAUNCH=1;;
 --all) specs=(tests/e2e/live-browser-context.spec.ts tests/e2e/live-browser-input.spec.ts tests/e2e/live-browser2.spec.ts tests/e2e/live-browser.spec.ts tests/e2e/live-browser-qwen-fix.spec.ts);export LAD_E2E_SOAK_SECONDS="${LAD_E2E_SOAK_SECONDS:-120}";;
 *) echo 'Unknown check mode';exit 2;;
esac
cd "$repo/ui/desktop"
exec "$node" ../node_modules/@playwright/test/cli.js test "${specs[@]}" --workers=1 --reporter=list
