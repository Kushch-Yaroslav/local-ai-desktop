// Root metadata is simulated by fakeroot. All paths and external mutations are
// fixture-owned. This validates maintainer logic, NOT kernel AppArmor enforcement.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=await mkdtemp(join(tmpdir(),'lad-package-lifecycle-'));
try {
  const fixture=join(root,'fixture.sh');
  await writeFile(fixture,`set -euo pipefail
umask 022
source "$1/packaging/sandbox-lifecycle.sh"
app="$2/opt/local-ai-desktop"; assets="$app/resources/app/assets/apparmor"
private_dir="$2/usr/lib/local-ai-desktop"; helper="$private_dir/bwrap"
state_dir="$2/var/lib/local-ai-desktop"; stamp="$state_dir/helper.sha256"
policy="$2/etc/apparmor.d/local-ai-desktop-bwrap"; electron_policy="$2/etc/apparmor.d/local-ai-desktop"
profiles="$2/profiles"; distro="$2/usr/bin/bwrap"; parser="$2/parser"
export FIXTURE_EVENTS="$2/events" FIXTURE_FAIL="$2/fail"
mkdir -p "$assets" "$(dirname "$distro")" "$(dirname "$policy")" "$2/usr/lib" "$2/var/lib"
cp "$1/assets/apparmor/"* "$assets/"
cp "$assets/local-ai-desktop-bwrap" "$policy"; cp "$assets/local-ai-desktop" "$electron_policy"
printf 'distro fixture v1' > "$distro"; chmod 755 "$distro"
printf 'local_ai_desktop_bwrap (enforce)\\nlocal_ai_desktop_bwrap_child (enforce)\\n' > "$profiles"
touch "$app/chrome-sandbox"; chmod 755 "$app/chrome-sandbox"
cat > "$parser" <<'PARSER'
#!/bin/bash
printf 'parser %s\\n' "$*" >> "$FIXTURE_EVENTS"
[[ ! -f "$FIXTURE_FAIL" ]]
PARSER
chmod 755 "$parser"
group_fixture="$2/group-ready"
getent() { [[ -f "$group_fixture" ]] || return 2; printf 'local-ai-desktop:x:123:\\n'; }
addgroup() { touch "$group_fixture"; printf 'group %s\\n' "$*" >> "$FIXTURE_EVENTS"; }
update-alternatives() { printf 'alternatives %s\\n' "$*" >> "$FIXTURE_EVENTS"; }
case "$3" in
 success)
   configure; cmp "$distro" "$helper"; [[ $(stat -c %a "$helper") == 750 ]]; configure
   printf 'distro fixture v2' > "$distro"; configure; cmp "$distro" "$helper"
   touch "$FIXTURE_FAIL"
   # Subshell retains errexit and simulates a failed package configure.
   set +e; ( set -e; configure ); result=$?; set -e
   [[ "$result" != 0 && $(stat -c %a "$helper") == 0 ]]
   rm "$FIXTURE_FAIL"; configure; [[ $(stat -c %a "$helper") == 750 ]]
   printf 'keep' > "$2/user-data"
   remove_helper; [[ ! -e "$helper" && -f "$policy" && -f "$profiles" ]]
   purge_state; [[ -f "$2/user-data" && ! -e "$stamp" && -f "$profiles" && -f "$group_fixture" ]]
   [[ $(grep -c '^group ' "$FIXTURE_EVENTS") == 1 ]]
   ;;
 legacy|legacy-modified|legacy-mode|legacy-policy|legacy-stamp|legacy-failure|legacy-hardlink)
   mkdir -p "$private_dir"; chmod 755 "$private_dir"
   cp "$distro" "$helper"; chmod 750 "$helper"
   case "$3" in
     legacy-failure) touch "$FIXTURE_FAIL" ;;
     legacy-hardlink) ln "$helper" "$2/unrelated-copy" ;;
     legacy-modified) printf modified >> "$helper" ;;
     legacy-mode) chmod 775 "$helper" ;;
     legacy-policy) printf '# custom\\n' >> "$policy" ;;
     legacy-stamp) mkdir -p "$state_dir"; printf invalid > "$stamp" ;;
   esac
   if [[ "$3" == legacy-failure ]]; then
     set +e; (set -e; configure); result=$?; set -e
     [[ "$result" != 0 && $(stat -c %a "$helper") == 0 ]]
     exit 23 # assert simulated mode inside fakeroot, not from the outer Node process
   fi
   configure
   cmp "$distro" "$helper"
   [[ $(stat -c %a "$helper") == 750 ]]
   backups=("$state_dir"/legacy-bwrap.*)
   [[ -f "\${backups[0]}" && $(stat -c %a "\${backups[0]}") == 600 ]]
   cmp "$distro" "\${backups[0]}"
   configure # never migrate/overwrite the backup again
   remove_helper; purge_state
   [[ -f "\${backups[0]}" && -f "\${backups[0]}.metadata" && ! -e "$helper" ]]
   ;;
 unmanaged)
   mkdir -p "$private_dir"; printf 'manual' > "$helper"; chmod 750 "$helper"
   configure
   ;;
 custom-policy)
   printf '# custom admin policy\\n' >> "$policy"; configure
   ;;
 no-apparmor) rm "$profiles"; configure ;;
 complain) sed -i 's/(enforce)/(complain)/g' "$profiles"; configure ;;
 disabled) mkdir -p "$(dirname "$policy")/disable"; touch "$(dirname "$policy")/disable/local-ai-desktop-bwrap"; configure ;;
 invalid-policy) touch "$FIXTURE_FAIL"; configure ;;
 offline) export DPKG_ROOT="$2"; configure ;;
 symlink) mkdir -p "$2/elsewhere" "$(dirname "$private_dir")"; ln -s "$2/elsewhere" "$private_dir"; configure ;;
 *) exit 2 ;;
esac
`);
  for(const scenario of ['success','legacy','legacy-modified','legacy-mode','legacy-policy','legacy-stamp','legacy-failure','legacy-hardlink','unmanaged','custom-policy','no-apparmor','complain','disabled','invalid-policy','offline','symlink']) {
    const path=join(root,scenario);
    let code=0,output='';
    try {output=execFileSync('fakeroot',['bash',fixture,resolve('.'),path,scenario],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});}
    catch(error){code=error.status;output=String(error.stderr);}
    assert.equal(code===0,['success','legacy'].includes(scenario),`${scenario}: exit ${code}\n${output}`);
    if(scenario==='legacy-failure') assert.equal(code,23,'failed migration leaves its verified helper disabled');
    if(scenario==='legacy-hardlink') assert.equal(await readFile(join(path,'unrelated-copy'),'utf8'),'distro fixture v1','a hard-linked unrelated resource is never replaced');
    if(scenario==='unmanaged') assert.equal(await readFile(join(path,'usr/lib/local-ai-desktop/bwrap'),'utf8'),'manual');
    if(scenario==='custom-policy') assert.match(await readFile(join(path,'etc/apparmor.d/local-ai-desktop-bwrap'),'utf8'),/# custom admin policy/);
    console.log(`Package lifecycle fixture: ${scenario} passed`);
  }
  console.log('SIMULATED: configure/idempotence/distro refresh/failure recovery/remove/purge and fail-closed conflicts; no host provisioning or kernel enforcement tested.');
} finally {await rm(root,{recursive:true,force:true});}
