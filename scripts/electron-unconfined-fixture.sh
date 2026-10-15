#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source "$app_root/scripts/electron-sandbox.sh"
select_electron_sandbox "$app_root/node_modules/electron/dist/electron"
# Match a normal desktop launch rather than inheriting WebStorm's complain label.
if [[ "${LOCAL_AI_TEST_INHERIT_APPARMOR_LABEL:-}" == 1 ]]; then
  # Test-only comparison: this does not validate the candidate AppArmor policy.
  exec "$app_root/node_modules/electron/dist/electron" "$@"
fi
exec /usr/bin/aa-exec -p unconfined -- "$app_root/node_modules/electron/dist/electron" "$@"
