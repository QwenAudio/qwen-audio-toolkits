# QwenAudio Toolkits

[![CI](https://github.com/QwenAudio/qwen-audio-toolkits/actions/workflows/ci.yml/badge.svg)](https://github.com/QwenAudio/qwen-audio-toolkits/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/QwenAudio/qwen-audio-toolkits?include_prereleases&label=release)](https://github.com/QwenAudio/qwen-audio-toolkits/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![macOS](https://img.shields.io/badge/macOS-14.2%2B-black?logo=apple)](docs/getting-started.md)

QwenAudio Toolkits is a local-first desktop workspace for audio AI creation and
model execution. It starts from a new-task home page where you can describe
what you want to create, choose a skill such as video editing, AI podcast,
video translation, or meeting notes, and install the underlying models only
when they are needed.

The product goal is to become a conversational Agent-driven audio and video
creation IDE. The Agent understands user intent, plans workflows, orchestrates
models, and produces reviewable edits; dedicated editing surfaces provide
timeline, waveform, caption, dubbing, and preview controls; the model store
supplies local and cloud capabilities on demand.

Three product pillars guide this goal:

- **Conversational Agent workflow**: describe an audio or video goal in natural
  language, then let the Agent plan the workflow, choose tools and models,
  run long tasks, and return reviewable edits instead of opaque results.
- **On-demand open source model store**: install open-source local models, runtime
  packages, dependencies, and cloud model definitions only when a skill or
  project needs them.
- **Dedicated professional editing surfaces**: use purpose-built timeline,
  waveform, transcript, caption, dubbing, and preview interfaces for precise
  manual control, while the Agent operates the same project state.

The first public preview targets Apple Silicon Macs running macOS 14.2 or
later. Model weights and runtime packages are downloaded on demand, so they are
not bundled into the application installer.

![QwenAudio Toolkits](docs/assets/qwenaudio-toolkits-overview.png)

## What it supports

- Speech recognition, voice activity detection, and language-aware audio
  workflows
- Audio enhancement and noise suppression
- Text normalization, including TN / ITN processing
- Text-to-speech and reference-voice workflows where supported by the model
- Task-oriented skills for video editing, AI podcast generation, video
  translation, and meeting notes
- Local model runtimes and cloud API models behind one typed Harness contract
- A model store with variants, checksums, dependencies, and resumable downloads
- Shared input, streaming, preview, and result-detail interactions across model
  capabilities

The bundled catalog currently focuses on local VAD, ASR, enhancement, TTS, and
text-normalization models. Model entries are data-driven and can be refreshed
from the project's [ModelScope repository](https://www.modelscope.cn/models/funaudio_public/QwenAudio-Toolkits).

## Download and install

Application binaries are published through
[GitHub Releases](https://github.com/QwenAudio/qwen-audio-toolkits/releases).
Download the latest Apple Silicon `.dmg`, open it, and drag **QwenAudio
Toolkits** into **Applications**. The app downloads model weights and runtime
packages separately from ModelScope after you install a model in the app.

Current preview builds use ad-hoc macOS signing and are not Apple-notarized. If
macOS blocks the first launch, open **System Settings → Privacy & Security** and
approve the application. Only download installers from the official project
release page.

## Run from source

### Prerequisites

- Apple Silicon macOS 14.2 or later
- Node.js 20.19 or later and npm 10 or later
- A current stable Rust toolchain
- CMake and a C/C++ compiler
- Xcode Command Line Tools
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)

```bash
git clone https://github.com/QwenAudio/qwen-audio-toolkits.git
cd qwen-audio-toolkits
npm ci
npm run desktop:dev
```

`npm run dev` starts a browser-only frontend preview. Native model runtimes,
microphone access, system-audio capture, and the updater require the Tauri
desktop process.

The local development server can inspect installed ACP Agents and load their
model choices. This performs an ACP handshake without sending a prompt or
enabling tools. The inspection endpoint is restricted to same-origin loopback
requests and is not included in production builds. Agent conversations still
run through the desktop process.

For a local production-style build:

```bash
npm run desktop:build
```

This creates a DMG without updater artifacts, so contributors do not need the
project's private updater signing key. Maintainers use `npm run desktop:release`
inside the release workflow to create signed updater artifacts.

See the [getting started guide](docs/getting-started.md) for permissions,
model installation, cloud configuration, and local data locations.

## Start a task

1. Open **New Task**.
2. Describe what you want to create.
3. Choose a skill, such as **视频剪辑**, **AI 播客**, **视频配音**, or
   **会议纪要**.
4. Add source material when the selected skill needs a file.
5. Install or configure the required models if the skill asks for them.

Skills are workflow entry points. They orchestrate installed models, but model
weights, cloud API configuration, and model dependencies remain managed by the
model store.

Each skill keeps the conversation in the center and its manual editor on the
right. Ask AI to change editing parameters, mark cuts, edit podcast turns,
adjust dubbing settings, or inspect meeting notes. AI actions update the same
state as the editor controls, and replies report what actually happened. If you
edit the workspace while AI is planning, its pending changes are stopped so
you can send an updated request. Changed podcast or dubbing settings require
new audio before the updated result can be exported.

The suggested exact commands, such as **关闭字幕** and **配音风格设为轻松**,
work without a language model. Other requests use the selected ACP Agent,
such as Codex or Qoder. Choose the Agent and its advertised model beside the
Send button; Agents that do not advertise models use their own default.
Provider selection and model selection are saved with each task. Native
generation and recording still require the desktop app and the relevant models.

## Use a model directly

1. Open **Model Store**.
2. Choose an **Offline** model, a bundled cloud model, or configure a custom
   REST LLM, ASR, or TTS model.
3. Select a model variant when available and start the installation.
4. Open the installed model from the sidebar.
5. Upload or drag in audio, record from the microphone, or enter text according
   to the selected capability.

Local weights are downloaded only after installation. Interrupted downloads can
be paused, resumed, or canceled. Recommended dependencies, such as VAD or
reference transcription, remain separate models and can be selected from the
model details.

Cloud execution sends the selected input to the configured provider. Configure
provider credentials from the API model configuration flow in **Model Store**;
local models continue to run without access to those credentials.

## Updates, models, and privacy

Application updates and model assets use separate channels:

- **GitHub Releases**: desktop application installers and Tauri updater assets
- **ModelScope**: model catalog, model weights, and runtime packages

The application checks the GitHub updater manifest in the background and
downloads a signed update automatically when one is available. The app asks
you to restart before installing the downloaded update. On macOS, you can also
choose **QwenAudio Toolkits → 检查更新…** from the application menu at the
upper-left of the screen. Updating the application keeps installed models and
application data.

Local inference does not upload audio. Cloud models send the requested input to
their configured provider. The app does not include telemetry, advertising
analytics, or automatic crash reporting. Application data on macOS is stored
under:

```text
~/Library/Application Support/org.qwenaudio.toolkits/
```

This directory contains installed plugins and model assets, generated and
processed audio, recordings, run history, and provider configuration. Removing
the app does not remove this directory automatically. See [PRIVACY.md](PRIVACY.md)
for the complete storage and network boundaries.

Task conversations, drafts, and the four creation editors save automatically to
`workspace/workspace-v1.json` in this directory. Reopening the app restores the
selected task and saved edits; interrupted processing waits for an explicit
retry, and meeting recording stays stopped. The header shows save progress or
an error, and normal desktop closing waits for pending writes.

Snapshots keep media file references, not copies of source media or live meeting
audio. Keep those files in place; missing files leave the saved text and edits
available. Podcast audio is tied to its script and voice settings: editing them
requires an audio update before export, while unchanged speech segments can be
reused. Browser development uses local storage for the current origin; `?demo`
does not read or overwrite saved tasks. An unreadable or unsupported workspace
file is preserved and autosaving is paused. Back it up before repairing or
moving it aside, then restart the app.

## Skills and model projects

The desktop UI separates **Skills** from **Model Store**. Skills are
task-oriented workflows, while Model Store entries provide the concrete local
or cloud capabilities that those workflows call. Under the hood, imported skill
or model projects can still use the `agent.json` project manifest during the
current migration period. See [Skill and model projects](docs/agent-projects.md)
for examples and the current host-adapter execution boundary.

## Architecture

```text
React / TypeScript workspace
            │ Tauri commands + events
            ▼
Rust Harness runtime ─── local HTTP API (127.0.0.1:3847)
            │
            ├── reviewed local adapters ── on-demand model assets
            └── configured cloud providers
```

The Harness exposes a finite set of capabilities, ports, and parameter types.
Model plugins cannot inject arbitrary native code into the main process. New
runtime architectures require a reviewed adapter; compatible models can then
reuse it through declarative manifests.

- [Architecture](docs/architecture.md)
- [Model catalog](docs/model-catalog.md)
- [Model Plugin v2](docs/model-plugin-v2.md)
- [Plugin manifest schema](docs/plugin-manifest.schema.json)

## Development and validation

```bash
npm run lint
npm test
npm run build
npm run open-source:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
```

The local model smoke test requires a running desktop app and installed test
models:

```bash
npm run models:smoke
```

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before making a substantial
change. Report security issues privately according to [SECURITY.md](SECURITY.md).

## Release for maintainers

The release workflow is defined in
[`.github/workflows/release.yml`](.github/workflows/release.yml). It builds an
Apple Silicon DMG and creates a draft GitHub Release containing the installer,
signed updater artifacts, and `latest.json`.

Before the first release, configure these repository Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key is password-protected

Never commit or share the private key. Then update the version, run the checks,
and start **Release desktop app** from the Actions tab with a matching tag such
as `v0.1.0`. The workflow verifies that the tag matches `package.json`, so the
version and tag must be identical.

The complete process is documented in [docs/releasing.md](docs/releasing.md).

## License

The original project source is licensed under the
[Apache License 2.0](LICENSE). Third-party runtimes, libraries, model weights,
datasets, and hosted services retain their own licenses and terms. See
[NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
