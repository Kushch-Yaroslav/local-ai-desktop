# Local AI Desktop development notes

This repository contains the Goose-derived Local AI Desktop application. Goose source is licensed under Apache-2.0; see `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `PROJECT_UPSTREAM.md`. Preserve upstream copyright notices and mark modified Apache-licensed files. Product issues, branches, PRs and releases belong to `Kushch-Yaroslav/local-ai-desktop`.

## Source and updates

The initial snapshot is Goose commit `cfb67d72f6129ba3c9f68d4c225d8dfcaba18a87`. Do not import upstream `.git`, tags, release workflows, or publishing configuration. Follow `PROJECT_UPSTREAM.md` for reviewed manual snapshot updates.

## Desktop

The Electron/React application is in `ui/desktop/`; shared ACP client code is in the workspace. Use the repository's pinned Node/pnpm toolchain and existing `Justfile`/Hermit instructions. Keep desktop product metadata, Linux desktop entry and links branded Local AI Desktop.

## Rust

The Rust workspace is rooted at `Cargo.toml`. Preserve workspace and crate version relationships unless a reviewed product change requires otherwise. Run formatting, targeted tests and clippy for Rust changes when implementation work is authorized.

## Releases and updates

Automatic release/publishing workflows are intentionally disabled. Do not create product releases or tags without explicit release authorization. Auto-updates remain disabled until a separately reviewed Local AI Desktop feed is implemented.
