#!/usr/bin/env bash
# Applies only the two rules explicitly approved in this security review.
set -euo pipefail
app_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
candidate="$app_root/assets/apparmor/local-ai-desktop-bwrap"
installed=/etc/apparmor.d/local-ai-desktop-bwrap
parser=/usr/sbin/apparmor_parser
validate() {
  /usr/bin/python3 - "$installed" "$1" <<'PY'
import pathlib, sys
old, new = [pathlib.Path(p).read_text() for p in sys.argv[1:]]
rules = {'umount /,', 'audit deny /usr/lib/local-ai-desktop/bwrap x,'}
def lines(text):
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith('#')]
old_lines, new_lines = lines(old), lines(new)
assert [line for line in old_lines if line not in rules] == [line for line in new_lines if line not in rules], 'Unapproved policy difference'
setup, child = new.split('profile local_ai_desktop_bwrap_child ', 1)
assert lines(setup).count('umount /,') == 1 and 'umount /,' not in lines(child), 'Setup-only umount required'
assert lines(child).count('audit deny /usr/lib/local-ai-desktop/bwrap x,') == 1, 'Child-only helper exec deny required'
assert sum(line.startswith('profile ') for line in new_lines) == 2, 'Exactly two dedicated profiles required'
assert 'profile local_ai_desktop_bwrap /usr/lib/local-ai-desktop/bwrap ' in setup, 'Private attachment required'
assert '/usr/bin/bwrap' not in new, 'System-wide attachment forbidden'
print('Verified: only the two explicitly approved rules differ.')
PY
  "$parser" --config-file /dev/null --skip-kernel-load --skip-cache "$1"
}
case "${1:---check}" in
  --check) validate "$candidate"; exit 0 ;;
  --apply) [[ "$EUID" == 0 ]] || { printf 'Run --apply with sudo in your terminal.\n' >&2; exit 1; } ;;
  *) printf 'Usage: bash %s --check | --apply\n' "$0" >&2; exit 2 ;;
esac
validate "$candidate"
backup_directory=/var/backups/local-ai-desktop-apparmor
install -d -o root -g root -m 0700 "$backup_directory"
staged="$(mktemp "$backup_directory/candidate.XXXXXX")"
trap 'rm -f -- "$staged"' EXIT
install -o root -g root -m 0600 "$candidate" "$staged"
validate "$staged"
backup="$backup_directory/local-ai-desktop-bwrap.$(date -u +%Y%m%dT%H%M%SZ).$$"
cp --preserve=all -- "$installed" "$backup"
printf 'Backup: %s\n' "$backup"
install -o root -g root -m 0644 "$staged" "$installed"
if ! "$parser" --config-file /dev/null --replace --skip-cache "$installed"; then
  printf 'Reload failed; restoring the backed-up dedicated policy.\n' >&2
  cp --preserve=all -- "$backup" "$installed"
  "$parser" --config-file /dev/null --replace --skip-cache "$installed"
  exit 1
fi
for profile in local_ai_desktop_bwrap local_ai_desktop_bwrap_child; do
  /usr/bin/grep -Fxq "$profile (enforce)" /sys/kernel/security/apparmor/profiles || {
    printf 'Profile %s is not enforcing. Stop acceptance.\n' "$profile" >&2; exit 1;
  }
done
printf 'Both dedicated profiles are enforcing; helper and global settings were not changed.\n'
