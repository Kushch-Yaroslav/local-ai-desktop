#!/usr/bin/env bash
# Local AI Desktop: select a validated side-by-side build for the next menu launch.
# Never stops an application, changes a profile, or overwrites a running executable.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --activate ]] || { echo 'Usage: activate-packaged-build.sh --check|--activate /absolute/package-directory'; exit 2; }
[[ $# == 2 ]] || { echo 'Specify the packaged application directory containing Local AI Desktop and resources/'; exit 2; }
target="$(realpath -e -- "$2")"
case "$target" in "$repo"/.local-work/*) ;; *) echo 'Select a side-by-side build under this repository .local-work/'; exit 2;; esac
for file in 'Local AI Desktop' resources/bin/goose resources/live-browser/bin/node resources/live-browser/dist/live-browser.js resources/live-browser/package.json resources/app.asar; do
  [[ -f "$target/$file" && -r "$target/$file" ]] || { echo "Required resource missing: $file"; exit 1; }
done
for file in 'Local AI Desktop' resources/bin/goose resources/live-browser/bin/node; do
  [[ -x "$target/$file" ]] || { echo "Executable permission missing: $file"; exit 1; }
done
"$target/resources/live-browser/bin/node" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
[[ "$target" != *$'\n'* ]] || exit 2
printf 'Validated packaged application: %s\n' "$target/Local AI Desktop"
if [[ "$mode" == --check ]]; then
  echo 'No installation/profile changes. Close the old application yourself before switching.'
  exit 0
fi
if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || true)" == 1 ]] &&
   ! grep -Fq "\"$target/Local AI Desktop\"" /etc/apparmor.d/local-ai-desktop-goose-dev 2>/dev/null; then
  echo 'This build is outside the installed AppArmor userns rule. Dock launch will fail.' >&2
  printf 'Run: sudo %q %q\n' "$repo/scripts/dev/install-dev-apparmor.sh" "$target/Local AI Desktop" >&2
  exit 1
fi
mkdir -p -- "$repo/.local-work"
pointer="$repo/.local-work/desktop-selected.path"
temp="$(mktemp -- "$repo/.local-work/desktop-selected.XXXXXX")"
trap 'rm -f -- "$temp"' EXIT
printf '%s\n' "$target/Local AI Desktop" > "$temp"
chmod 600 "$temp"
mv -f -- "$temp" "$pointer"
echo 'Selected for the next Goose Dev Ubuntu menu launch. Existing processes were left running.'
echo 'Close the previous application normally, then open Local AI Desktop — Goose Dev.'
