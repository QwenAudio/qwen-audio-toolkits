# Model Catalog

The model store is data-driven. Its bundled fallback is
`catalog/model-catalog.json`; released apps refresh `model-catalog.json` from
the ModelScope model repository without an application update.

## Catalog envelope

```json
{
  "schemaVersion": 1,
  "plugins": [],
  "apiModels": []
}
```

`plugins` contains local model packages. `apiModels` contains models exposed by
an already supported cloud provider. Adding metadata or another model using a
reviewed adapter does not require frontend code.

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
