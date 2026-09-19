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

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Desktop release build (requires signing keys)
npm run desktop:release

# Set version across package.json + Cargo.toml + tauri.conf.json
npm run version:set -- <version>

# Export model catalog from catalog/model-catalog.json
npm run catalog:export

# Smoke-test local model adapters (requires running desktop app at :3847)
npm run models:smoke

# Standalone smoke scripts (run directly with node; not in package.json)
node scripts/workflow-smoke.mjs            # workflow DAG planner validation
node scripts/workflow-execution-smoke.mjs  # workflow runtime execution
node scripts/model-smoke.mjs               # openai-compatible /v1 model API
node scripts/result-normalization-smoke.mjs # result normalization
```

## Architecture

This is a Tauri 2 desktop app (React frontend + Rust backend) for running audio AI models locally and via cloud APIs.

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

- **HarnessCapability**: A typed audio/text operation (e.g. `speech.transcribe`, `audio.enhance`, `speech.synthesize`). Defined in `src/domain/capabilities.ts` and enforced in `src-tauri/src/harness.rs`.
- **Provider**: An implementation of one or more capabilities — either a local model (`local.*`), a cloud API (`api.bailian`), or a plugin.
- **ModelPlugin**: A package with a manifest declaring its capabilities, adapter, inputs/outputs, and parameter schema. Managed by `src-tauri/src/plugins.rs`. Plugin packages live in `plugins/`.
- **Workflow**: A user-composable DAG (rendered with @xyflow/react) that chains capabilities. Validated by `src/services/workflowPlanner.ts`, executed by `src/services/workflowRuntime.ts`. Supports both batch and real-time streaming topologies.
- **Adapter**: The string key (e.g. `sensevoice`, `bailian-funasr`, `deepfilternet`) that routes a harness run to the correct native implementation in Rust.

### Frontend (`src/`)

- `App.tsx` — main shell with view routing, global state, theme
- `views/` — per-view components: ModelWorkspaceView (model management), WorkflowsView (DAG editor), WorkflowChatView (chat-driven workflow UX), LiveView (real-time streaming), EditView (audio editing), BatchView, GenerateView, PluginsView, LibraryView, HomeView, CaptionOverlay.
- `services/harness.ts` — Tauri invoke wrappers for all backend commands; the single entry point for frontend→backend communication
- `services/workflowPlanner.ts` — validates workflow DAG topology (single input, linear chain, port-type compatibility, streaming constraints)
- `services/workflowRuntime.ts` — executes a validated workflow step-by-step, managing intermediate results between nodes
- `services/captionOutput.ts`, `realtimeSession.ts`, `audioCapture.ts`, `updater.ts` — caption rendering, realtime streaming sessions, mic capture, app updater
- `domain/capabilities.ts` — capability definitions, categories, default parameters, and parameter schemas
- `domain/results.ts`, `domain/voices.ts` — run result details and voice lists
- `types.ts` — shared TypeScript interfaces for all models, runs, artifacts, and streaming protocols
- `cloudModels.ts`, `modelDependencies.ts`, `data.ts` — cloud catalog mapping, recommended model dependency bindings, static demo/lookup data
- `components/` — reusable audio UI (waveforms, spectrograms, players, audio file drop zones)

### Backend (`src-tauri/src/`)

- `lib.rs` — Tauri app setup, all command registrations, local HTTP API routes (axum)
- `harness.rs` — the core runtime: run lifecycle, provider routing, capability dispatch, streaming sessions (FunASR, CosyVoice, VAD, enhancement)
- `plugins.rs` — plugin catalog management, staged installation, manifest validation, dependency bindings, and reference-safe removal
- `tts.rs` — TTS adapters (Kokoro/sherpa-onnx, CosyVoice streaming, Bailian API)
- `asr.rs` — ASR adapters (SenseVoice, streaming FunASR via WebSocket, Bailian API)
- `audio_processing.rs` — audio enhancement, VAD, denoise, normalize, fade, trim
- `advanced_models.rs` — audio tagging, keyword spotting, punctuation, speaker diarization, source separation (Spleeter/UVR)
- `audio_io.rs` — PCM audio handling, resampling, WAV encode/decode, data-URL helpers
- `vad.rs` — Silero VAD model loading and segment detection
- `downloads.rs` — model asset downloading with checksum verification
- `system_audio.rs` — macOS system audio capture (Process Tap)
- `wetext.rs` — text normalization (ITN/TN) via bundled native library
- `native/` — C/C++ dependencies (process_tap, wetext)

### Model Catalog

`catalog/model-catalog.json` defines the remote model registry. Each entry specifies adapter, harness capability, download URLs, checksums, variants, and recommended dependencies. The frontend fetches this at runtime for on-demand model installation.

## Important Patterns

- All frontend→backend calls go through `@tauri-apps/api/core` invoke or event listeners. The `src/services/harness.ts` file is the canonical wrapper layer.
- Streaming protocols (ASR, TTS, VAD, enhancement) use a start/push/finish pattern with Tauri events for async results.
- Saved workflows are serialized to localStorage while model dependency bindings are persisted by the Rust backend.
- The local HTTP API at `:3847` mirrors the Tauri command surface for external integration.
- Port types (`audio`, `transcript`, `text`, `speech-segments`, etc.) enforce type-safe connections between workflow nodes.

## Platform Notes

- Primary target: macOS 14.2+ on Apple Silicon. Windows/Linux support exists but is not production-ready.
- macOS uses transparent window with vibrancy effects and custom title bar (traffic light positioning).
- The app hides on close (macOS dock pattern) rather than quitting.
- System audio capture uses a native Process Tap implementation (`src-tauri/native/process_tap/`).
