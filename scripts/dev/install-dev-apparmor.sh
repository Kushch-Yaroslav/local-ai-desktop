#!/usr/bin/env bash
# Install only the dedicated Goose Dev rule. Invoke explicitly with sudo.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source_file="$repo/scripts/dev/apparmor/local-ai-desktop-goose-dev"
target=/etc/apparmor.d/local-ai-desktop-goose-dev
if [[ $EUID != 0 ]]; then
  echo 'Run this script with sudo to install the dedicated Goose Dev AppArmor rule.' >&2
  exit 1
fi
selected="${1:-$(cat "$repo/.local-work/desktop-selected.path")}"
selected="$(realpath -e -- "$selected")"
case "$selected" in "$repo"/.local-work/*/'Local AI Desktop') ;; *) echo 'Invalid active executable' >&2; exit 1;; esac
# AppArmor attachment syntax must never accept an injected pattern.
[[ "$selected" != *['"{}*?\\']* && "$selected" != *$'\n'* ]] || exit 1
temp="$(mktemp)"
trap 'rm -f -- "$temp"' EXIT
cat "$source_file" > "$temp"
printf '\nprofile local-ai-desktop-goose-selected "%s" flags=(unconfined) {\n  userns,\n}\n' "$selected" >> "$temp"
/usr/sbin/apparmor_parser -Q -T "$temp"
if [[ -e "$target" ]]; then
  # Only replace our known dedicated file, preserving the prior version.
  grep -q '^profile local-ai-desktop-goose-dev ' "$target" || { echo "Unknown existing rule: $target" >&2; exit 1; }
  cp -p -- "$target" "$target.before-selected-build"
fi
install -o root -g root -m 0644 "$temp" "$target"
/usr/sbin/apparmor_parser -r "$target"
echo "Loaded exact active-build userns rule: $selected"
