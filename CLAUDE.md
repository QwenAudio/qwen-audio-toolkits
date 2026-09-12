# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies (locked)
npm ci

# Web UI dev server (http://127.0.0.1:1420, no native features)
npm run dev

# Full desktop app with native model/audio runtime
npm run desktop:dev

# Lint (oxlint)
npm run lint

# TypeScript + Vite production build
npm run build

# Rust formatting check
cargo fmt --manifest-path src-tauri/Cargo.toml --check

# Rust lint (required before PRs)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend smoke tests (workflow planner, result normalization, caption layout, install progress)
npm test

# Open-source compliance check (required files, forbidden patterns, catalog licenses, broken links)
npm run open-source:check

# Desktop release build (requires signing keys)
npm run desktop:release

# Set version across package.json + Cargo.toml + tauri.conf.json
npm run version:set -- <version>

# Export model catalog from catalog/model-catalog.json
npm run catalog:export

# Smoke-test local model adapters (requires running desktop app at :3847)
npm run models:smoke

# Workflow runtime execution smoke test
npm run workflow:smoke

# Custom provider (REST LLM/ASR/TTS) smoke test
npm run test:custom-provider

# Standalone smoke scripts (not in package.json)
node scripts/model-smoke.mjs               # openai-compatible /v1 model API
```

## Architecture

Tauri 2 desktop app: React frontend (Vite, TypeScript) + Rust backend. Runs audio AI models locally and via cloud APIs.

### Layered Architecture

```
React SPA (Vite, TypeScript)
    ↓ Tauri invoke / event system
Rust Tauri commands + local HTTP API (axum, 127.0.0.1:3847)
    ↓
Harness runtime (capability-based task orchestration)
    ↓
Native adapters: sherpa-onnx, DeepFilterNet, RNNoise, cloud WebSocket/REST
    ↓
Audio devices, model assets on disk, cloud providers (Bailian)
```

### Key Concepts

- **HarnessCapability**: A typed audio/text operation (e.g. `speech.transcribe`, `audio.enhance`, `speech.synthesize`). Defined in `src/domain/capabilities.ts` and enforced in `src-tauri/src/harness.rs`. Currently 14 capabilities across four categories: 音频处理, 音频理解, 文本智能, 音频生成.
- **Provider**: An implementation of one or more capabilities — either a local model (`local.*`), a cloud API (`api.bailian`), a custom REST provider, or a plugin.
- **ModelPlugin**: A package with a manifest declaring its capabilities, adapter, inputs/outputs, and parameter schema. Managed by `src-tauri/src/plugins.rs`. Bundled plugin examples live in `plugins/`.
- **Workflow**: A capability DAG validated by `src/services/workflowPlanner.ts` and executed by `src/services/workflowRuntime.ts`. The unused visual editor and standalone workflow chat pages have been removed; runtime services remain available to agents.
- **Adapter**: The string key (e.g. `sensevoice`, `bailian-funasr`, `deepfilternet`) that routes a harness run to the correct native implementation in Rust.
- **WorkflowPortType**: Type-safe connections between workflow nodes (`audio`, `transcript`, `text`, `speech-segments`, etc.).

### Frontend (`src/`)

- `App.tsx` — main shell (75 KB): view routing, global state, theme, model sidebar, settings. This is a large monolith.
- `views/` — per-view components. `ModelWorkspaceView.tsx` (160 KB) is the primary workspace for running models. `PluginsView.tsx` handles the model store. `AgentHomeView.tsx` provides the unified task conversation, with task-specific result editors shown alongside it.
- `services/harness.ts` — the single typed boundary for all frontend→backend Tauri invoke calls. Every backend command is wrapped here.
- `services/workflowPlanner.ts` — validates workflow DAG topology (single input, linear chain, port-type compatibility, streaming constraints).
- `services/workflowRuntime.ts` — executes a validated workflow step-by-step, managing intermediate results between nodes.
- `domain/capabilities.ts` — capability definitions, categories, default parameters, and parameter schemas. The source of truth for what capabilities exist and their port types.
- `components/` — reusable audio UI (waveforms, spectrograms, players, audio file drop zones, recording visualizations, voice selector).
- `utils/` — audio helpers (duration/format), caption layout engine, transcript formatting, audio file type detection.
- `types.ts` — shared TypeScript interfaces for models, runs, artifacts, streaming protocols, plugin manifests, and provider settings.

### Backend (`src-tauri/src/`)

- `lib.rs` — Tauri app setup, all command registrations, local HTTP API routes (axum).
- `harness.rs` (290 KB) — the core runtime: run lifecycle, provider routing, capability dispatch, streaming sessions (FunASR, CosyVoice, VAD, enhancement). The largest file in the codebase.
- `plugins.rs` (229 KB) — plugin catalog management, staged installation, manifest validation, dependency bindings, variant management, adapter allowlist, and reference-safe removal.
- `tts.rs` — TTS adapters (Kokoro/sherpa-onnx, CosyVoice streaming, Bailian API).
- `asr.rs` — ASR adapters (SenseVoice, streaming FunASR via WebSocket, Bailian API).
- `audio_processing.rs` — audio enhancement, VAD, denoise, normalize, fade, trim.
- `onnx_audio.rs` — ONNX-based audio model inference (audio tagging, embeddings).
- `advanced_models.rs` — audio tagging, keyword spotting, punctuation, speaker diarization, source separation (Spleeter/UVR).
- `audio_io.rs` — PCM audio handling, resampling, WAV encode/decode, data-URL helpers.
- `vad.rs` — Silero VAD model loading and segment detection.
- `downloads.rs` — model asset downloading with checksum verification and resume.
- `system_audio.rs` — macOS system audio capture (Process Tap).
- `wetext.rs` — text normalization (ITN/TN) via bundled native library.
- `native/` — C/C++ dependencies (process_tap, wetext).

### Model Catalog

`catalog/model-catalog.json` defines the remote model registry. Each entry specifies adapter, harness capability, download URLs, checksums, variants, and recommended dependencies. The frontend fetches this at runtime for on-demand model installation. Changes require running `npm run catalog:export` and including upstream license/checksum verification.

## Important Patterns

- All frontend→backend calls go through `@tauri-apps/api/core` invoke or event listeners. The `src/services/harness.ts` file is the canonical wrapper layer — never call `invoke()` directly from views.
- Streaming protocols (ASR, TTS, VAD, enhancement) use a start/push/finish pattern with Tauri events for async results.
- Saved workflows are serialized to localStorage while model dependency bindings are persisted by the Rust backend.
- The local HTTP API at `:3847` mirrors the Tauri command surface for external integration and smoke testing.
- Port types enforce type-safe connections between workflow nodes.
- UI labels are in Chinese (e.g. `'语音识别'`, `'音频增强'`). Maintain Chinese for user-facing strings.
- Dev-mode Cargo profiles optimize specific heavy crates (sha2, deep_filter, tract-*) at `opt-level = 3` to keep local inference usable during development.

## Platform Notes

- Primary target: macOS 14.2+ on Apple Silicon. Windows/Linux support exists but is not production-ready.
- Minimum toolchain: Node.js 20.19+, Rust 1.77.2+, CMake, Xcode CLI tools.
- macOS uses transparent window with vibrancy effects and custom title bar (traffic light positioning).
- The app hides on close (macOS dock pattern) rather than quitting.
- System audio capture uses a native Process Tap implementation (`src-tauri/native/process_tap/`).
- `npm run dev` (browser-only) cannot exercise native audio or inference — use `npm run desktop:dev` for full testing.

## PR Checklist

Before submitting, run the full required-checks suite from CONTRIBUTING.md:
```bash
npm run lint && npm run build && npm test && npm run open-source:check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml
```
User-visible changes should update `CHANGELOG.md`. Catalog changes must also run `npm run catalog:export`.
