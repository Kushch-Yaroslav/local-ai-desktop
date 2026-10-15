# Agent sandbox security reference

[Documentation](README.md) · [Installation and acceptance](bwrap-installation-acceptance.md) · [Runtime architecture](runtime-self-protection.md)

This maintained reference consolidates the earlier AppArmor staging, pre-exec and loader investigations. It describes the current source boundary and retained deployment evidence, not a security certification or an instruction to install a historical policy. v0.2.0 is published as an Experimental Alpha. Enforcing acceptance passed on the tested developer installation; clean-OS installation and broad distribution validation remain unverified ([release limitations](releases/v0.2.0.md#limitations)).

## Layers and enforcement

Every Agent terminal, including approved code and Absolute Autopilot, uses the production Rust isolation executor. Legacy Electron terminal tools call the same executor. Approval cannot disable the boundary; failure never falls back to an unprotected host shell.

| Layer | Responsibility |
| --- | --- |
| User/PID/mount/IPC/UTS namespaces | Separate process addressing and filesystem layout; private `/proc`, `/run`, `/tmp` |
| Mounts and file-tool scope | Largely read-only host root, validated writable cwd, protected runtime/model overlays; canonical checks for file tools outside Bubblewrap |
| Capability drop and NoNewPrivs | Prevent retained payload capabilities and setuid privilege elevation |
| Linux x86_64 seccomp | Deny namespace/mount escape paths, tracing/process-memory APIs, io_uring, BPF and host-management socket families |
| Dedicated AppArmor helper | Reviewed Ubuntu namespace setup and mandatory stacked child transition |
| Protected-runtime registry | Identity/lifecycle diagnostics and protected paths; not the basis of PID isolation or authority to adopt arbitrary processes |

The seccomp bootstrap checks architecture, rejects namespace flags to `clone`, and returns ENOSYS for `clone3` so ordinary thread creation can fall back. It denies modern mount APIs as well as `mount`, `umount`, `pivot_root`, `setns` and `unshare`. AF_UNIX/NETLINK/PACKET socket creation is blocked; local `socketpair` IPC remains usable. Arbitrary Python/native code stays behind these kernel boundaries even when command classification cannot interpret it.

## Dedicated setup and child profiles

Only `/usr/lib/local-ai-desktop/bwrap` has the application attachment. `/usr/bin/bwrap` and its vendor policy are not replaced or globally attached. The helper is a regular non-setuid distro-binary copy, root-owned 0750 with an explicitly selected non-root group; ancestors must be root-owned and not group/world writable.

Runtime checks regular-file identity, ownership, mode, ancestors, absence of file capabilities, and SHA-256 equality with `/usr/bin/bwrap`. A stale or unsafe installed copy fails closed. Without the private helper the runtime selects the distro binary with mandatory namespace/seccomp isolation; restricted Ubuntu can deny UID/GID mapping. This does not demonstrate the dedicated enforcing deployment.

Bubblewrap sets `no_new_privs` before payload exec, so setup and child profiles remain stacked. Both must allow project executables, library mappings, owner writes and development networking. These broad dynamic-path permissions do not select the workspace; the independent mount layout supplies the write boundary.

Setup allows seven named capabilities for namespace initialization/dropping, with narrow staging mount/pivot rules. AppArmor allowances do not confer host-root capabilities. Historical enforcing denials required the exact `/tmp/newroot/` self-bind and old-root detach rules now in the shipped policy; they are setup-only permissions, not permission for the child to mount or unmount.

Setup exec uses a mandatory `px` transition into the stacked child without an `ix`/`ux` fallback. Child exec inherits confinement with `ix`, denies capabilities, namespaces, mounts, profile changes, D-Bus and tracing, and explicitly denies direct execution of the dedicated helper. File path rules alone are not a syscall boundary: the setup executable, loader and transition must remain trusted.

The bootstrap checks both enforcing label components before executing the payload, then checks NoNewPrivs=1, Seccomp=2 and zero permitted/effective/ambient capabilities. Profile parsing alone does not establish those effective conditions.

## Loader and environment boundary

The trusted starting point is an already running Electron main. A closed environment allowlist is used for Electron → Rust and legacy terminal spawning; inherited `process.env` is not forwarded wholesale. Bubblewrap and its Rust bootstrap receive only fixed PATH/LANG/LC_ALL values through `env_clear()`. Loader hooks such as LD_AUDIT/LD_PRELOAD, shell startup hooks and language-runtime injection variables are excluded from setup.

Allowed project PATH, HOME, proxy/certificate and selected developer settings are transported as validated payload data, not loader-visible setup environment or Bubblewrap argv. Rust sends them through a size-bounded sealed anonymous descriptor; the bootstrap validates seals, closes it and applies the data only after confinement and kernel checks. Bash uses an absolute path with `--noprofile --norc`. This is an allowlist boundary, not a blacklist of currently known LD_* keys.

A manually invoked unconfined same-user helper can still load a marker library under its setup label. Production environment clearing prevents that inherited path; it does not authenticate Electron as the only eligible group caller. Inside the child, direct helper exec is denied. A manual ELF loader can read/execute helper bytes under the already constrained child label without recovering setup privileges. Marker positive controls must use visible/writable fixture paths so missing output is not a false negative caused by private `/tmp`.

## Threat-model limits

- **Not confidentiality isolation:** host-readable files can remain visible through the read-only root. Read-only access is not secrecy.
- **Shared networking:** TCP/UDP access remains available for development. Destination restrictions, credentials and exposed local/remote TCP administration APIs need their own authorization.
- **No aggregate resource quotas:** CPU/RAM/GPU exhaustion, fork pressure and host OOM are not fully contained by this boundary.
- **Filesystem aliases:** protected-path bind mounts are not universal inode isolation from pre-existing hardlink/mount aliases. Do not supply a workspace with aliases to infrastructure.
- **Trusted host:** malicious unconfined same-user programs, root, compromised Electron main, OS loader/libraries, kernel/helper vulnerabilities and arbitrary inherited-descriptor trust are outside the demonstrated boundary.
- **Compatibility:** the seccomp bootstrap is Linux x86_64 only; socket/namespace-dependent developer tools may be incompatible. Group-scoped helper access is not exclusive caller authentication.

No universal sandbox-escape, kernel-security or availability guarantee is claimed.

## Evidence and revalidation

Retained enforcing fixture reports measured the stacked label, Seccomp=2, NoNewPrivs=1 and zero capabilities, exercised ordinary commands/project writes and owned HTTP lifecycle, and checked helper denial and fail-closed startup. Their model provider was scripted; OS checks were real. Loader-marker positive controls and absence checks are separate from real Qwen inference.

The [October 13 evidence record](noop-loader-validation-2026-10-13.md) preserves the later loader/no-op regression and real Qwen source run, including recovered rejected calls and cleanup. Those results were not independently rerun during documentation cleanup and do not certify a frozen package.

For a separately approved deployment, use the [installation reference](bwrap-installation-acceptance.md), then the production [sandbox fixture](../scripts/sandbox-startup-electron.test.mjs) and [loader regression](../scripts/sandbox-loader-injection.test.mjs). A complain/inherited-label run, parser check or fixture pass alone is not enforcing acceptance. No policy or system setting was changed by this documentation cleanup.

Background: [Bubblewrap 0.9.0](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c), [AppArmor stacking rationale](https://gitlab.com/apparmor/apparmor/-/blob/apparmor-4.0/profiles/apparmor/profiles/extras/bwrap-userns-restrict), [Linux PID namespaces](https://www.man7.org/linux/man-pages/man7/pid_namespaces.7.html).
