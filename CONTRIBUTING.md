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
