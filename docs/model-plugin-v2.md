# Model Plugin v2

QwenAudio Toolkits model plugins separate executable adapters from model weights.
The desktop application bundles the sherpa-onnx runtime and trusted adapters,
but it does not bundle model weights.

## Package

A store entry contains metadata and a `plugin.json` matching
`plugin-manifest.schema.json`. A local package can be:

- a standalone `plugin.json`;
- a `.cspkg` or `.zip` containing one `plugin.json`;
- a development directory containing one `plugin.json`.

The `models[].source` URL is fetched only when the user selects Install.
Downloaded data is written to a staging directory, optionally checked against
`sha256`, safely extracted, checked for all declared files, and then moved into
the installed plugin directory. A failed installation is removed.

Native adapters can reference a shared, versioned runtime package:

```json
{
  "runtime": {
    "kind": "native",
    "entry": "llama-funasr-cli",
    "package": "funasr-llamacpp-0.1.9"
  }
}
```

The hosted repository keeps model payloads in `models/` and runtime payloads
in `runtimes/`. At installation time the runtime is cached once per package and
platform, while each model installation remains independently removable.

## Adapter contract

Manifest v2 accepts only adapters registered by the desktop runtime. The first
registry includes:

| Adapter | Harness capability |
| --- | --- |
| `kokoro`, `vits`, `matcha`, `kitten`, `zipvoice`, `pocket-tts`, `supertonic`, `cosyvoice-local` | `speech.synthesize` |
| `streaming-zipformer`, `streaming-paraformer`, `funasr-nano`, `funasr-sensevoice-gguf`, `funasr-paraformer-gguf`, `wenet-ctc`, `fire-red-asr-ctc`, `fire-red-asr`, `moonshine-v2`, `nemo-parakeet`, `nemo-canary`, `qwen3-asr` | `speech.transcribe` |
| `silero-vad`, `funasr-fsmn-vad-gguf` | `speech.detect` |
| `dpdfnet2`, `gtcrn`, `deepfilternet`, `rnnoise` | `audio.enhance` |
| `web-audio` | `audio.live` |
| `audio-tagging` | `audio.classify` |
| `keyword-spotting` | `speech.keyword` |
| `language-id` | `speech.language` |
| `punctuation` | `text.punctuate` |
| `wetext` | `text.normalize` |
| `speaker-embedding` | `speaker.embed` |
| `speaker-diarization` | `speaker.diarize` |
| `source-separation` | `audio.separate` |

A model package cannot load arbitrary native code into the main process.
Additional sherpa-onnx model families should be added as reviewed adapters.
This keeps the common path small:

1. A model using an existing architecture only needs a manifest and weight URLs.
2. Its inputs, outputs, streaming modes, and controls are declared as data.
3. A genuinely new inference architecture adds one reviewed adapter; every
   compatible model can then reuse that adapter without frontend work.

## Declarative inputs, outputs, and parameters

Plugins may declare their Harness contract. QwenAudio Toolkits uses the contract
to create workflow ports, input controls, and parameter editors. Existing v1
and v2 packages without these fields continue to use the capability defaults.

```json
{
  "inputs": [
    {
      "name": "audio",
      "label": "音频",
      "type": "audio",
      "modes": ["batch", "stream"]
    }
  ],
  "outputs": [
    {
      "name": "transcript",
      "label": "识别结果",
      "type": "transcript",
      "modes": ["batch", "stream"]
    }
  ],
  "parameters": [
    {
      "name": "language",
      "label": "识别语言",
      "type": "enum",
      "default": "auto",
      "options": [
        { "label": "自动识别", "value": "auto" },
        { "label": "中文", "value": "zh" },
        { "label": "英文", "value": "en" }
      ]
    }
  ]
}
```

Port types are intentionally finite: `audio`, `text`, `transcript`,
`boolean`, `speech-segments`, `keyword-events`, `audio-tags`, `language`,
`speaker-embedding`, `speaker-segments`, and `audio-tracks`. Streaming is a
port mode, not a separate data type. Parameter controls support `string`,
`number`, `boolean`, and `enum`.

## Model packs and optional dependencies

A model can recommend other store plugins without bundling their weights. The
dependency must either exist in the same online catalog or be a built-in model
ID. Dependencies are installed only when the user keeps the binding selected;
optional dependencies can be changed to `None` in model details.

```json
{
  "recommendedDependencies": [
    {
      "role": "speech-segmentation",
      "label": "自动分段",
      "pluginId": "silero-vad",
      "capability": "speech.detect",
      "default": true,
      "optional": true
    }
  ]
}
```

`role` is the stable runtime binding key. ASR models use
`speech-segmentation`; voice-cloning models use `reference-transcription`.
The client also infers Silero VAD for legacy ASR manifests and SenseVoice
Small for legacy voice-cloning manifests.

## Store publishing

Catalog submissions must validate against the JSON Schema, declare upstream
and SPDX license metadata, include SHA-256 for fixed artifacts, and pass archive
path and required-file checks. The catalog publishes manifest and presentation
metadata; the client downloads model assets only during installation.

For development, add a v2 manifest to the catalog, run
`npm run catalog:export`, and test installation from an empty application data
directory. The Kokoro and SenseVoice manifests under `plugins/` are compact
manifest examples; [model-catalog.md](model-catalog.md) documents the complete
submission checklist.

The ModelScope catalog URL should return one envelope. Every dependency plugin
is a normal entry in `plugins`, so changing a pack does not require an
application release.

```json
{
  "schemaVersion": 1,
  "plugins": [
    { "schemaVersion": 2, "id": "silero-vad" },
    {
      "schemaVersion": 2,
      "id": "funaudio.example-asr",
      "recommendedDependencies": [
        {
          "role": "speech-segmentation",
          "label": "自动分段",
          "pluginId": "silero-vad",
          "capability": "speech.detect",
          "default": true,
          "optional": true
        }
      ]
    }
  ],
  "apiModels": []
}
```
