#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
source_profile="$app_root/assets/apparmor/local-ai-desktop-bwrap"
target_profile=/etc/apparmor.d/local-ai-desktop-bwrap
helper_directory=/usr/lib/local-ai-desktop
helper="$helper_directory/bwrap"
parser=/usr/sbin/apparmor_parser
# Refuse a policy drift back to the system-wide executable attachment.
if ! grep -Fxq 'profile local_ai_desktop_bwrap /usr/lib/local-ai-desktop/bwrap flags=(attach_disconnected,mediate_deleted) {' "$source_profile" ||
   grep -Fq '/usr/bin/bwrap' "$source_profile"; then
  printf 'Policy must attach exclusively to the dedicated helper; review required.\n' >&2; exit 1
fi
case "${1:---check}" in
  --check)
    "$parser" --config-file /dev/null --skip-kernel-load --skip-cache "$source_profile"
    printf 'Candidate AppArmor profile parses; no helper or policy installed.\n'
    ;;
  --install)
    [[ "$EUID" == 0 ]] || { printf 'Administrator authentication is required.\n' >&2; exit 1; }
    [[ "${2:-}" == --group && -n "${3:-}" && $# == 3 ]] || {
      printf 'Specify the application account primary group: --install --group GROUP\n' >&2; exit 2;
    }
    group_entry="$(/usr/bin/getent group "$3")" || exit 1
    IFS=: read -r group_name ignored group_id ignored <<< "$group_entry"
    [[ "$group_id" =~ ^[0-9]+$ && "$group_id" != 0 ]] || { printf 'A non-root application group is required.\n' >&2; exit 1; }
    [[ -f /usr/bin/bwrap && ! -L /usr/bin/bwrap && "$(stat -Lc '%u:%a' /usr/bin/bwrap)" == 0:755 ]] || {
      printf 'Expected root-owned non-setuid distro /usr/bin/bwrap (0755).\n' >&2; exit 1;
    }
    [[ ! -L "$target_profile" && ! -L "$helper_directory" && ! -L "$helper" ]] || exit 1
    for mode_directory in disable force-complain; do
      mode_entry="/etc/apparmor.d/$mode_directory/local-ai-desktop-bwrap"
      if [[ -e "$mode_entry" || -L "$mode_entry" ]]; then
        printf 'Existing %s conflicts with enforcing deployment; manual review required.\n' "$mode_entry" >&2; exit 1
      fi
    done
    "$parser" --config-file /dev/null --skip-kernel-load --skip-cache "$source_profile"
    if [[ -e "$target_profile" ]] && ! cmp -s "$source_profile" "$target_profile"; then
      printf 'Existing %s differs; review/remove it manually before replacement.\n' "$target_profile" >&2; exit 1;
    fi
    if [[ -e "$helper_directory" && "$(stat -Lc '%u:%a' "$helper_directory")" != 0:755 ]]; then
      printf 'Helper directory must be root-owned 0755.\n' >&2; exit 1;
    fi
    if [[ -e "$helper" && "$(stat -Lc '%u:%a' "$helper")" != 0:750 ]]; then
      printf 'Existing helper is not a managed root-owned 0750 file.\n' >&2; exit 1;
    fi
    install --directory --owner=root --group=root --mode=0755 "$helper_directory"
    staged="$(mktemp "$helper_directory/.bwrap.XXXXXX")"
    trap 'rm -f -- "$staged"' EXIT
    install --owner=root --group="$group_id" --mode=0750 /usr/bin/bwrap "$staged"
    cmp -s /usr/bin/bwrap "$staged" || exit 1
    install --owner=root --group=root --mode=0644 "$source_profile" "$target_profile"
    "$parser" --config-file /dev/null --replace --skip-cache "$target_profile"
    # Publish the helper only after both kernel profiles are demonstrably enforcing.
    for profile in local_ai_desktop_bwrap local_ai_desktop_bwrap_child; do
      if ! grep -Fxq "$profile (enforce)" /sys/kernel/security/apparmor/profiles; then
        printf 'Profile %s is not enforcing; helper not published.\n' "$profile" >&2; exit 1
      fi
    done
    mv -f -- "$staged" "$helper"
    printf 'Installed account-group-scoped helper and candidate policy; /usr/bin/bwrap and global settings unchanged.\n'
    ;;
  *) printf 'Usage: %s --check | --install --group GROUP\n' "$0" >&2; exit 2 ;;
esac
