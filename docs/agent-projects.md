# Independent data-processing Agent projects

An Agent packages a model (or model bundle), its usage knowledge, resources and
Harness contract into one installable project. It does not need an LLM, a chat
persona or autonomous planning. 3D-Speaker is an Agent because its input
preparation, inference, result interpretation and model resources form one
usable voice-processing capability.

## Implemented in this version

- The extensions page is an Agent catalog with project usage, input/output,
  runtime and Harness information, plus a local project import action.
- `agent.json` v1 selects a reviewed `host-adapter` implementation. This selection
  is the actual execution adapter, not display-only metadata.
- Importing `agent.json` copies its containing project directory, including its
  README and local assets. ZIP and `.cspkg` project archives are also accepted.
  Each archive must contain exactly one `agent.json` or legacy `plugin.json`.
- Models download into the project's own installation directory. Declared shared
  runtime packages use the existing versioned runtime cache; they are not other
  Agents and uninstalling an Agent does not remove that cache.
- New Agent projects cannot declare or bind dependencies on other Agents.
  Legacy dependency inference is disabled for them, including UI-side VAD and
  reference-transcription selection.
- All 34 bundled local catalog definitions, the built-in Silero VAD and the
  configured cloud/custom API entries now have independent Agent contracts.
  A cloud Agent owns its model selection and request adapter; provider endpoint
  and credential storage remain host services, not another Agent.
- Known v1/v2 installations migrate on load when both project ID and adapter
  match and the selected bundle is known. IDs, model paths and history remain
  intact. Required files/assets are merged into validation; incomplete installs
  can be repaired from the catalog. Unknown third-party legacy packages retain
  their original contract and are not automatically certified as Agents.
- AISHELL3 owns its WeText FST rules and applies normalization inside its TTS
  invocation. Paraformer GGUF declares its bundled FSMN-VAD. Diarization owns
  segmentation and CAM++ weights in the same project directory.
- Voice-cloning Agents take reference audio directly. CosyVoice and ZipVoice
  also require its matching reference text; automatic transcription through
  another installed Agent is disabled. Other ASR Agents run their own adapter
  without external segmentation bindings.
- Unpublished Zipformer Chinese FP32 and Paraformer bilingual INT8 variants are
  removed from download choices; the published alternatives remain available.
- Silero VAD now has a direct catalog installation action. Resource availability
  and legacy protocol status have separate labels rather than “仅兼容”.

The current protocol uses reviewed host adapters. It **does not** execute
project-supplied Python/Rust scripts, create per-project virtual environments,
or interpret custom multi-step Harness programs. API Agents use the existing
provider configuration and request adapters; importing a new API protocol via
`agent.json` is not supported yet.

## Project layout

```text
3d-speaker/
  agent.json
  README.md
  models/                   # Optional prepackaged weights
    3dspeaker-campplus/
      ...onnx
  resources/                # Optional project-owned usage resources
```

Examples:

- `examples/agents/3d-speaker/agent.json`: extraction and pairwise comparison.
- `examples/agents/audio-to-text/agent.json`: SenseVoice GGUF transcription with
  its own FSMN-VAD resource and declared FunASR runtime package.

Open Agents → 导入 Agent and select the example project folder. The adjacent
ZIP import button accepts `.zip` / `.cspkg` packages. Selecting the entire folder
grants macOS access to the project resources, not only to its manifest file.
Import is a desktop feature. Browser preview displays project definitions but
cannot install or run models. If the same ID is installed already, installation
fails without replacing its files; remove the old installation first if you
intend to replace it.

## Manifest

See `agent-manifest.schema.json` for the machine-readable contract.

- `kind`: `data-processing-agent`.
- `schemaVersion`: `1` (separate from the legacy model schema).
- `id`, `name`, `version`, `publisher`: stable project identity.
- `task`: what this project does.
- `usage`: input requirements, limitations and concrete usage examples.
- `harness`: `{ kind: "host-adapter", adapter, capability }`.
- `runtime`: reviewed execution engine and optional versioned runtime package.
- `models`: exactly **one selected resource bundle** in a local Agent project.
  Additional required model files belong in that bundle's `files` / `assets`;
  multiple entries would mean model variants to the legacy installer, so project
  v1 rejects them rather than dropping resources silently. Catalog entries may
  still offer alternative precision bundles before installation.
- `inputs`, `outputs`: nonempty typed ports supported by the selected adapter.
- `parameters`: the existing typed parameter controls.

A resource bundle may use an HTTPS `source` with a SHA-256, individual HTTPS
`assets`, locally included files, or `repositoryHosted` resources in the official
model repository. Repository-hosted projects retain the published project/model
IDs because those IDs determine their download paths. Direct URLs allow an
independently named project to reuse upstream weight files without depending on
another installed Agent.

Ports describe the reviewed adapter's contract; this release does not interpret
arbitrary port names as code or dynamically wire custom graphs. For example,
`speaker.embed` accepts `audioDataUrl` and optional `comparisonAudioDataUrl` in
the existing Harness request, and returns embedding / similarity artifacts.

## Runtime integration

For a standalone desktop preview, build with:

```sh
npm run tauri -- build --debug --bundles app --config src-tauri/tauri.agent-preview.conf.json
```

This configuration uses a separate application identifier and data directory.
Its local HTTP API uses `127.0.0.1:3848`, leaving the production application's
`127.0.0.1:3847` available for an independently running copy.
Preview builds do not register the updater or check for production updates, so
a published release cannot overwrite the Agent preview.

`agents.rs` validates and normalizes the project into the resource installer.
`plugins.rs` retains the `agent` definition through installation, serialization
and catalog refresh, exposes it in the descriptor, and registers the selected
adapter with Harness. Existing `harness_start_run` calls continue to route by
`plugin.<project-id>` to the installed project's model directory.

Catalog refresh must not replace an installed standalone project's own contract.
Legacy remote catalog entries also cannot erase the definitions of the
migrated built-in Agents. UI labels distinguish remaining legacy
packages instead of implying that their cross-model bindings are independent.
