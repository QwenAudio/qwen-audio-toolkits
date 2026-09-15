# Bailian OpenCode Connection Design

## Goal

Allow bundled OpenCode to reuse the Bailian credential already saved in QwenAudio Toolkits, without asking users to duplicate the API key in a custom provider.

## Architecture

Treat the persisted `api.bailian` provider as an eligible OpenCode connection when it is enabled and configured. Keep the existing custom-provider eligibility rules unchanged.

When bundled OpenCode resolves `api.bailian`, Rust creates an `OpenCodeLaunchConfig` with:

- provider slug derived from the Bailian provider ID
- base URL `https://dashscope.aliyuncs.com/compatible-mode/v1`
- the existing Bailian access key as the launch credential

The launch config remains backend-only and non-serializable. The frontend receives only `OpenCodeConnection` metadata and discovered model IDs.

## Data Flow

1. The user saves a Bailian access key in API settings.
2. `harness_list_opencode_connections` reports Bailian as eligible.
3. The user selects Bailian for bundled OpenCode in Agent settings.
4. Model discovery calls the Bailian OpenAI-compatible `/models` endpoint through the existing bounded, no-redirect client.
5. Each ACP turn starts bundled OpenCode with the selected Bailian connection and model.

Existing Bailian LLM, ASR, TTS, and audio-processing execution paths remain unchanged.

## Security

- Do not copy the Bailian key into a custom-provider record.
- Do not expose the key through Tauri commands, frontend state, model caches, logs, errors, or trace recordings.
- Keep `OpenCodeLaunchConfig` backend-only and without `Serialize`.
- Preserve credential-safe model-discovery errors and redirect blocking.

## Error Handling

Bailian is ineligible when it is disabled, missing its access key, or otherwise not configured. The Agent settings connection entry should show the existing eligibility reason. Network and model-discovery failures continue through the existing sanitized error path.

## Tests

Add Rust coverage that verifies:

- configured Bailian is eligible for bundled OpenCode
- disabled or unconfigured Bailian is rejected
- launch configuration uses the compatible-mode base URL
- frontend connection metadata and errors never contain the access key
- existing custom-provider eligibility behavior remains unchanged

Run Rust unit tests, TypeScript checks, the Agent model-selection smoke, and the desktop UI verification.