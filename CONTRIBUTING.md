# Contributing to QwenAudio Toolkits

Thank you for helping improve QwenAudio Toolkits.

## Before you start

- Open an issue before a substantial UI, runtime, or plugin-contract change.
- Keep model adapters independent and route execution through the Harness
  capability contract.
- Reuse shared input, preview, and result-detail components instead of adding
  model-specific UI branches.
- Do not commit model weights, generated audio, credentials, signing material,
  application data, or private release configuration.
- Confirm that code, metadata, icons, and sample audio can legally be
  redistributed under their stated licenses.

## Development setup

Install Node.js 20.19+, Rust 1.77.2+, CMake, a C/C++ compiler, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run desktop:dev
```

On macOS, the desktop commands prefer `/Applications/Xcode.app` when it
provides SDK 26 or newer and the default Command Line Tools SDK is older.
This keeps native window controls consistent with current macOS Tahoe apps.
Explicit `DEVELOPER_DIR` and `SDKROOT` settings take precedence; the scripts
do not change the global `xcode-select` configuration. Without a newer SDK,
the existing toolchain remains in use and native controls may look different.

The browser preview (`npm run dev`) is suitable for frontend work but cannot
exercise native audio or inference.

## Required checks

```bash
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

Native adapter changes should include focused Rust tests and a real model run.
Shared input/output changes should be checked across every affected capability,
in light and dark themes and at compact window sizes.

Catalog changes must also run `npm run catalog:export` and include upstream,
license, checksum, installation, and inference verification.

## Pull requests

Describe the problem, the chosen behavior, affected models or capabilities,
verification commands, and compatibility or privacy impact. Keep unrelated
formatting and refactoring out of the same pull request. User-visible changes
should update `CHANGELOG.md` and the relevant documentation.

By contributing, you agree that your contribution is licensed under
Apache-2.0. Be respectful, constructive, and careful with user audio and
credentials. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Sidebar presentation

Keep full model names and taxonomy labels (such as `Audio-to-Text`) in the
sidebar. The default width is 260px; saved user widths take precedence. Model
rows use 30px height, or 26px in compact mode. Bottom utility buttons remain
icon-only with hover labels.

## macOS window lifecycle

The red close button hides the main window by default. With "quit on close"
enabled it must exit the entire application, including the hidden captions window.
Dock reopen must show and focus a hidden/minimized window and recover a missing
main window using its Tauri configuration.

For lifecycle changes, run the native regression check in a disposable debug
bundle with a separate identifier ending in `.windowtest`:

```bash
npm run tauri -- build --debug --bundles app --config '{"productName":"QwenAudio Window Test","identifier":"org.qwenaudio.toolkits.windowtest","bundle":{"createUpdaterArtifacts":false}}'
node scripts/macos-window-smoke.mjs "src-tauri/target/debug/bundle/macos/QwenAudio Window Test.app"
```

Adjust the bundle path if `CARGO_TARGET_DIR` is set. Use Xcode 26+ on Tahoe.
The smoke check sends actual close/minimize requests and Launch Services reopen
Apple events, tests missing-window recovery, and verifies full process exit with
the captions window present. It never runs against the normal app identifier or
its settings/model data. The in-app hook is excluded from release builds.

## Interface languages

The interface defaults to Simplified Chinese. Users can switch to English in
Settings → General; the preference is stored under
`qwen-audio-toolkits.language-v1`. Switching updates React subscribers without
remounting the app, and storage events synchronize other app windows. The main
window also updates the native macOS menu.

Use `t('中文文案')` from `src/i18n` for UI messages and add the English text to
`src/i18n/en.json`. For dynamic text use numbered placeholders, for example
`t('版本 {0} 已可用', [version])`. Components displaying translations subscribe
with `useLocale()`. Module-level display metadata uses getters so labels do not
freeze at the language selected during import. Keep identifiers, model names,
model-input language values, taxonomy labels such as `Audio-to-Text`, user text,
and model outputs unchanged. Bundled model notes have matching English files under `src/content/model-notes/en`.
Imported project documents and external error details retain
their source language unless an explicit translation is available.

`npm test` includes translation coverage, placeholder parity, default/fallback
behavior, persistence, cross-window updates, and model-parameter invariance.
When changing language-sensitive UI, also verify both languages visually and
confirm switching preserves unsaved input, selection, and playback/task state.
