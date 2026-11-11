# Application Storage validation — 2026-11-07

The Linux dev package is installed at `ui/desktop/out/Local AI Desktop-linux-x64/`. The existing dev launcher and AppArmor configuration were not changed by the storage UI work. The previous package is retained locally at `.local-work/storage-ui/out-before-storage-settings/`.

## Checks

- TypeScript and whole-source ESLint: passed.
- Vitest: 155 files passed, 1172 tests passed; 10 optional integration/GPU files (20 tests) skipped. Real filesystem transaction tests have a 30-second per-test timeout because they fsync actual files/directories and inspect live process FDs. The final full run used two workers to avoid contention with packaging.
- Rust formatting and `cargo clippy -p goose -- -D warnings`: passed.
- Targeted Rust tool availability and two bounded/nonfatal request-log tests: passed.
- English extraction consistency and Russian ICU/catalog validation: passed (1897 messages). Other locales received English fallbacks for all 46 new storage messages. Their pre-existing missing-key sets are unchanged: 239 keys per locale. Consequently the all-locale completeness command still fails on that existing translation debt.

## Real application and disk checks

All migration tests used disposable application profiles and temporary directories, including a dedicated temporary directory on an actual NTFS3 volume.

- Actual Electron native directory picker: opened; directory selection and cancellation exercised.
- Default → custom and custom → existing default: copied state, restarted Electron, and reached transaction phase `verified` after Goose health checks.
- Applied custom choice survived restart; reopening settings discarded an unapplied checkbox change. Russian settings rendered in the actual installed dev package.
- Final package with file/directory fsync and full source revalidation: migration through real Electron IPC completed and reached `verified`.
- Actual ext4 filesystem probes: compatible. Actual NTFS3 probes: bulk-only classification; a real partial migration retained SQLite/profiles on ext4 and moved logs to NTFS3, with integrity/content checks passing.
- An ordinary directory standing in for an absent configured mount blocked real Electron backend startup. Neither configured data nor bulk roots were created, and bootstrap bytes stayed unchanged.
- Packaged Goose and llama-server executables, licenses and notices are present.

The existing two-volume bootstrap and five profile/Discovery JSON files retained their original SHA256 values. Existing user SQLite passed integrity checks and exposed 26 sessions and 1048 messages. No transfer of the user's live storage was performed for these UI tests; existing migration receipts and rollback archives remain in place.

## Local review artifacts and rollback

Private test logs, transaction reports and an RU settings screenshot are in `.local-work/storage-ui/`. These are not public source artifacts.

To roll back the application package, close the dev application, retain the current `ui/desktop/out` under a different local name, and restore `.local-work/storage-ui/out-before-storage-settings` to `ui/desktop/out`. The live user's bootstrap has not been changed. Storage transfers performed later can be reversed with **Return to previous storage** before cleanup; see [storage documentation](../storage.md).

No commit, push, tag or GitHub Release was created.
