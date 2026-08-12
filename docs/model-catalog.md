# Model Catalog

The model store is data-driven. Its bundled fallback is
`catalog/model-catalog.json`; released apps refresh `model-catalog.json` from
the `model-catalog-v1` GitHub prerelease without an application update. The
catalog and its detached `.sig` file are published by
`.github/workflows/model-catalog.yml` and verified with the updater Minisign
public key before replacing the local cache. Model payloads and native runtime
packages continue to download from the ModelScope model repository.

The publishing workflow merges the complete ModelScope plugin catalog with
`catalog/api-models.json`, then signs the combined envelope. It runs whenever
API metadata changes, on manual dispatch, and every six hours so ModelScope
plugin updates can reach clients without a desktop release.

## Catalog envelope

```json
{
  "schemaVersion": 1,
  "plugins": [],
  "apiModels": []
}
```

`plugins` contains local model packages. `apiModels` contains models exposed by
an already supported cloud provider. Bundled API metadata is maintained in
`catalog/api-models.json`; a validated remote entry with the same stable `id`
overrides it. Adding metadata or another model using a reviewed adapter does
not require frontend code.

Users can configure multiple custom REST providers in Settings and attach custom
LLM, ASR, and TTS definitions to them from the model store. Provider connection,
authentication, capability paths, request profiles, and response decoding are
persisted separately from model capability/display name/ID. The generic adapter
supports Chat Completions; multipart, binary, or Base64 JSON ASR; configurable
headers and JSON request templates; and common JSON TTS shapes with raw
WAV/PCM16, JSON Hex/Base64, or streamed NDJSON/SSE Base64 responses. Changing
these settings does not require a catalog or desktop release.

An API model entry uses `name` as its canonical display name, `modelId` as the
preferred service identifier, and `aliases` for service identifiers retained
for compatibility and search. Keep the stable catalog `id` unchanged when a
provider renames a model so installed state, pins, and saved workflows remain
valid. Set `visible` to `false` to remotely hide an entry without deleting user
state. Aliases are declarative metadata only and may select only a reviewed
adapter already bundled with the application.

The app refreshes the catalog at startup and every six hours. A failed network,
schema, adapter, or signature check leaves the last verified cache in place;
when no verified cache exists, the bundled catalog remains available.

## Local model entry

Each entry follows [plugin-manifest.schema.json](plugin-manifest.schema.json)
and declares:

- stable plugin ID, name, version, publisher, description, and license;
- one reviewed adapter and one or more Harness capabilities;
- downloadable variants with precision, source, required files, estimated
  size, and preferably SHA-256;
- typed inputs, outputs, and parameters when capability defaults are not
  sufficient;
- optional recommended dependencies.

Native runtimes may declare a versioned `runtime.package`. ModelScope stores
weights under `models/<plugin-id>/<variant-id>/` and platform runtimes under
`runtimes/<package>/<platform>/`. The installer keeps runtime packages in the
application runtime cache and lets compatible models reuse them.

Generate the repository catalog after changing model manifests:

```bash
npm run catalog:repository -- /path/to/QwenAudio-Toolkits
```

Model variants should represent interchangeable quantizations of the same
architecture. They belong in one store entry rather than separate cards.

## Publishing a model

1. Confirm that the model and its metadata may be redistributed or linked.
2. Reuse an existing adapter whenever the runtime architecture is compatible.
3. Add a v2 manifest with an SPDX license identifier and upstream source.
4. Include SHA-256 for every fixed remote artifact.
5. Run:

```bash
npm run catalog:export
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

6. Test installation from an empty application data directory and run a real
   inference sample.

Catalog changes should not point to mutable private URLs, authenticated
intranet hosts, or files whose redistribution terms are unclear.

## Dependencies

Recommended dependencies remain independently installable models. A binding has
a stable role, such as `speech-segmentation` or `reference-transcription`, and
may be optional. The Rust backend persists selected bindings and prevents the
last referenced weight directory from being deleted.

## Runtime adapters

Runtime package IDs must include a version whenever their ABI or bundled
libraries may change, for example `funasr-llamacpp-0.1.9`. Updating a runtime
publishes a new package ID instead of mutating an installed package in place.

The current registry includes sherpa-onnx model families, FunASR llama.cpp,
CosyVoice.cpp, DeepFilterNet, RNNoise, and WeText/kaldifst. A new native runtime
requires code review, tests, license review, and an application release. A new
model using an existing adapter usually requires only catalog metadata.

See [Model Plugin v2](model-plugin-v2.md) for the full contract.
