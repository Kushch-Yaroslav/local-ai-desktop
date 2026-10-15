#!/bin/bash
# Embedded verbatim as DEB postinst, prerm and postrm. No user data is accessed.
set -euo pipefail
umask 022
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
app=/opt/local-ai-desktop
assets=$app/resources/app/assets/apparmor
private_dir=/usr/lib/local-ai-desktop
helper=$private_dir/bwrap
state_dir=/var/lib/local-ai-desktop
stamp=$state_dir/helper.sha256
policy=/etc/apparmor.d/local-ai-desktop-bwrap
electron_policy=/etc/apparmor.d/local-ai-desktop
profiles=/sys/kernel/security/apparmor/profiles
parser=/usr/sbin/apparmor_parser
distro=/usr/bin/bwrap
group=local-ai-desktop
staged_helper=

fail() { printf 'Local AI Desktop sandbox: %s\n' "$*" >&2; return 1; }
secure_directory() {
  [[ ! -L "$1" && -d "$1" && $(stat -c %u "$1") == 0 ]] || { fail "Unsafe directory: $1."; return 1; }
  local mode; mode=$(stat -c %a "$1")
  (( (8#$mode & 0022) == 0 )) || { fail "Directory is writable by group/others: $1."; return 1; }
}
secure_file() {
  [[ ! -L "$1" && -f "$1" && $(stat -c %u "$1") == 0 ]] || { fail "Unsafe file: $1 (root-owned regular file required)."; return 1; }
  local mode; mode=$(stat -c %a "$1")
  (( (8#$mode & 06022) == 0 )) || { fail "Unsafe permissions: $1."; return 1; }
  local caps; caps=$(getcap "$1") || { fail "Cannot inspect file capabilities: $1."; return 1; }
  [[ -z "$caps" ]] || { fail "File capabilities are forbidden: $1."; return 1; }
}
managed_helper() {
  [[ -f "$stamp" && ! -L "$stamp" && -f "$helper" && ! -L "$helper" ]] || return 1
  secure_directory "$private_dir" && secure_directory "$state_dir" || return 1
  secure_file "$stamp" && secure_file "$helper" || return 1
  [[ $(stat -c %h "$helper") == 1 ]] || return 1
  local hash; read -r hash < "$stamp"
  [[ "$hash" =~ ^[a-f0-9]{64}$ && $(sha256sum "$helper" | cut -d' ' -f1) == "$hash" ]]
}
verified_legacy_helper() {
  # The source installer predates the package stamp. Recognize its *contents
  # and security properties*, never a filename alone. Unknown files stay intact.
  [[ ! -e "$stamp" && ! -L "$stamp" ]] || return 1
  secure_directory "$private_dir" && secure_file "$helper" && secure_file "$distro" && secure_file "$policy" || return 1
  [[ $(stat -c %a "$private_dir") == 755 && $(stat -c %a "$helper") == 750 && $(stat -c %a "$distro") == 755 && $(stat -c %h "$helper") == 1 ]] || return 1
  cmp -s "$helper" "$distro" && cmp -s "$policy" "$assets/local-ai-desktop-bwrap"
}
migrate_legacy_helper() {
  secure_directory "$(dirname "$state_dir")"
  [[ ! -L "$state_dir" ]] || { fail 'Legacy migration state directory cannot be a symlink.'; return 1; }
  [[ ! -e "$state_dir" ]] || secure_directory "$state_dir"
  install -d -o root -g root -m 0755 "$state_dir"
  # Unique root-only, non-executable backup; retain original metadata separately.
  local backup; backup=$(mktemp "$state_dir/legacy-bwrap.XXXXXX")
  install -o root -g root -m 0600 "$helper" "$backup"
  cmp -s "$helper" "$backup"
  stat -c 'uid=%u gid=%g mode=%a' "$helper" > "$backup.metadata"
  sha256sum "$backup" >> "$backup.metadata"
  chmod 0644 "$backup.metadata"
  chmod 000 "$helper"
  sha256sum "$helper" | cut -d' ' -f1 > "$stamp"
  chmod 0644 "$stamp"
  printf 'Verified legacy distro-identical helper preserved at %s; migrating to package ownership.\n' "$backup"
}
configure() {
  # Unknown/modified files are never adopted; only verified legacy copies migrate.
  if [[ -e "$helper" || -L "$helper" ]]; then
    if ! managed_helper; then
      verified_legacy_helper || { fail "Existing helper is unknown/modified. It must be a root-owned non-setuid 0750 distro-identical legacy copy with the exact reviewed policy; preserve it and review migration before dpkg --configure local-ai-desktop."; return 1; }
      migrate_legacy_helper
    fi
    chmod 000 "$helper" # existing payloads are untouched; no stale helper on failure
  fi
  [[ -z "${DPKG_ROOT:-}" ]] || { fail 'Offline/chroot provisioning cannot attest enforcing profiles. Configure on the booted target host.'; return 1; }
  [[ -x "$parser" ]] || { fail "AppArmor parser is missing; install the declared apparmor (>= 4.0.0) dependency before configuring."; return 1; }
  [[ -r "$profiles" ]] || { fail 'AppArmor securityfs is unavailable. Configure on an AppArmor-enabled Ubuntu 24.04 host; isolation is not bypassed.'; return 1; }
  for entry in "$policy" "$electron_policy"; do
    for mode_directory in disable force-complain; do
      local override; override="$(dirname "$entry")/$mode_directory/$(basename "$entry")"
      [[ ! -e "$override" && ! -L "$override" ]] || { fail "Disabled/complain override for $entry; administrator review required."; return 1; }
    done
  done
  secure_file "$distro"
  [[ $(stat -c %a "$distro") == 755 ]] || { fail 'Distro Bubblewrap must be non-setuid 0755.'; return 1; }
  for entry in "$policy" "$electron_policy"; do
    secure_file "$entry"
    cmp -s "$entry" "$assets/$(basename "$entry")" || { fail "Locally modified conffile preserved: $entry. Review it against $assets before reconfiguring; it is never overwritten here."; return 1; }
    "$parser" --config-file /dev/null --skip-kernel-load --skip-cache "$entry"
  done
  secure_directory "$(dirname "$private_dir")"
  secure_directory "$(dirname "$state_dir")"
  secure_directory "$(dirname "$policy")"
  [[ ! -L "$private_dir" && ! -L "$state_dir" ]] || { fail 'Managed directories cannot be symlinks.'; return 1; }
  [[ ! -e "$private_dir" ]] || secure_directory "$private_dir"
  [[ ! -e "$state_dir" ]] || secure_directory "$state_dir"
  install -d -o root -g root -m 0755 "$private_dir" "$state_dir"
  if ! getent group "$group" >/dev/null; then addgroup --system "$group"; fi
  local gid; gid=$(getent group "$group" | cut -d: -f3)
  [[ "$gid" =~ ^[0-9]+$ && "$gid" != 0 ]] || { fail 'Dedicated group must have a non-root GID.'; return 1; }
  # Load only this application's profiles. No service restart/sysctl/global policy.
  "$parser" --config-file /dev/null --replace --skip-cache "$electron_policy"
  "$parser" --config-file /dev/null --replace --skip-cache "$policy"
  for name in local_ai_desktop_bwrap local_ai_desktop_bwrap_child; do
    grep -Fxq "$name (enforce)" "$profiles" || { fail "Profile $name is not enforcing; helper remains disabled."; return 1; }
  done
  [[ ! -L "$stamp" && ! -L "$state_dir/helper.sha256.new" ]] || { fail "State files cannot be symlinks."; return 1; }
  local staged; staged=$(mktemp "$private_dir/.bwrap.XXXXXX")
  staged_helper=$staged
  trap 'if [[ -n "${staged_helper:-}" ]]; then rm -f -- "$staged_helper"; fi' EXIT
  install -o root -g "$gid" -m 0750 "$distro" "$staged"
  cmp -s "$distro" "$staged"
  sha256sum "$staged" | cut -d' ' -f1 > "$state_dir/helper.sha256.new"
  chmod 0644 "$state_dir/helper.sha256.new"
  # Remove the positively identified disabled old copy before recording the new hash.
  # Interruption leaves either no helper or the complete verified new copy.
  rm -f -- "$helper"
  mv -f "$state_dir/helper.sha256.new" "$stamp"
  mv -f "$staged" "$helper"
  staged_helper=
  trap - EXIT
  # Use the existing vendor Chromium sandbox with user namespaces, not a new SUID helper.
  chmod 0755 "$app/chrome-sandbox"
  update-alternatives --install /usr/bin/local-ai-desktop local-ai-desktop "$app/local-ai-desktop" 100
  printf 'Sandbox provisioned. To authorize a desktop account, an administrator must run: adduser ACCOUNT local-ai-desktop; then log out and back in.\n'
}
remove_helper() {
  if [[ -e "$helper" || -L "$helper" ]]; then
    if managed_helper; then rm -f -- "$helper"; else printf 'Preserving unmanaged/modified helper: %s\n' "$helper" >&2; fi
  fi
  # Unloading profiles would unconfine live payloads. Retain them until reboot.
  # Dpkg owns the conffiles: remove preserves them, purge removes them normally.
  update-alternatives --remove local-ai-desktop "$app/local-ai-desktop" || true
}
purge_state() {
  remove_helper
  if [[ -f "$stamp" && ! -L "$stamp" ]]; then secure_file "$stamp" && rm -f -- "$stamp"; fi
  rmdir "$state_dir" "$private_dir" 2>/dev/null || true
  # Retain the dedicated system group: avoid GID reuse and implicit membership changes.
}
main() {
  [[ "$EUID" == 0 ]] || { fail 'Administrator installation through apt/dpkg is required.'; return 1; }
  case "${1:-}" in
    configure|triggered) configure ;;
    remove|deconfigure|disappear) remove_helper ;;
    purge) purge_state ;;
    upgrade|failed-upgrade|abort-install|abort-upgrade) : ;;
    abort-remove|abort-deconfigure) printf 'Sandbox remains fail-closed after aborted removal; run dpkg --configure local-ai-desktop before further Agent use.\n' >&2 ;;
    *) fail "Unsupported maintainer action: ${1:-missing}" ;;
  esac
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
