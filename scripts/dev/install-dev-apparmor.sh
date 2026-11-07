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
/usr/sbin/apparmor_parser -Q -T "$source_file"
if [[ -e "$target" ]] && ! cmp -s "$source_file" "$target"; then
  echo "Refusing to overwrite a different existing rule: $target" >&2
  exit 1
fi
install -o root -g root -m 0644 "$source_file" "$target"
/usr/sbin/apparmor_parser -r "$target"
echo "Loaded $target. Global AppArmor and userns restrictions remain enabled."
