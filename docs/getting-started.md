# Getting Started

## Desktop installation

The public preview currently ships an Apple Silicon DMG for macOS 14.2+.
Download it from the latest
[GitHub Release](https://github.com/QwenAudio/qwen-audio-toolkits/releases), open the
DMG, and drag QwenAudio Toolkits into Applications. Model weights and runtime
packages are downloaded later from the project's
[ModelScope model repository](https://www.modelscope.cn/models/funaudio_public/QwenAudio-Toolkits).

The app requests microphone access only when recording begins. System-audio
capture uses the macOS Core Audio Process Tap API and may require additional
system permission. Current builds are not Apple-notarized; macOS may require
manual approval under **System Settings → Privacy & Security**.

The app checks the GitHub Release updater manifest in the background and
automatically downloads signed updates. You can restart from **Settings** to
install a downloaded update; installed models and application data are
preserved during an app update. On macOS, choose **QwenAudio Toolkits →
检查更新…** from the application menu at the upper-left of the screen to check
manually.

## Run from source

Prerequisites:

- Node.js 20.19 or later and npm 10 or later
- Rust 1.77.2 or later
- CMake and a C/C++ compiler
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)
- Xcode Command Line Tools on macOS

```bash
git clone https://github.com/QwenAudio/qwen-audio-toolkits.git
cd qwen-audio-toolkits
npm ci
npm run desktop:dev
```

The Vite preview is useful for frontend work but does not expose native audio
or model runtimes:

```bash
npm run dev
```

To create a local production-style app and DMG without the maintainers' private
updater key, run:

```bash
npm run desktop:build
```

Signed updater artifacts are created separately by the GitHub release workflow.

## Install and run a local model

1. Open **模型商店 / Model Store**.
2. Select **离线 / Offline** and choose a model.
3. Select a precision variant when available, then install it.
4. Return to the model in the left sidebar.
5. Upload or drag in audio, record from the microphone, or enter text according
   to the model capability.

Weights are downloaded after step 3. Interrupted downloads can be paused,
resumed, or canceled. Recommended dependencies such as VAD or reference ASR
remain separate models and can be changed in model details.

## Configure a cloud model

QwenAudio Toolkits currently exposes Alibaba Cloud Model Studio models. Open
**Settings**, enter the provider API key, then add individual cloud models from
the store. The key configures the provider only; voice, language, speed, and
other model parameters are selected in the model conversation.

Cloud execution sends the selected input to the configured provider. Local
models continue to run without reading cloud credentials.

## Local data

On macOS, application data is stored under:

```text
~/Library/Application Support/org.qwenaudio.toolkits/
```

This includes installed plugins and model assets, generated and processed
audio, recordings, run history, and provider configuration. Uninstalling the
application does not automatically remove this directory.

## Common commands

```bash
npm run lint
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/workflow-smoke.mjs
```

`npm run models:smoke` requires a running desktop app and locally installed
test models.
