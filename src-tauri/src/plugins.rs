use crate::downloads::{
    begin_download_task, cancel_download, download_cached, set_download_paused,
    DownloadProgressRange,
};
use crate::harness::{
    CAPABILITY_ASR, CAPABILITY_AUDIO_TAGGING, CAPABILITY_DIARIZATION, CAPABILITY_ENHANCE,
    CAPABILITY_KWS, CAPABILITY_LANGUAGE_ID, CAPABILITY_LIVE, CAPABILITY_PUNCTUATION,
    CAPABILITY_SOURCE_SEPARATION, CAPABILITY_SPEAKER_EMBED, CAPABILITY_TEXT,
    CAPABILITY_TEXT_NORMALIZE, CAPABILITY_TTS, CAPABILITY_VAD,
};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    env, fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const PLUGIN_SCHEMA_VERSION: u32 = 2;
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_CATALOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CATALOG_PLUGINS: usize = 1_000;
const MAX_CATALOG_VARIANTS: usize = 32;
const MAX_CATALOG_API_MODELS: usize = 256;
const MAX_API_MODEL_ALIASES: usize = 16;
const MAX_CATALOG_SIGNATURE_BYTES: u64 = 16 * 1024;
const CATALOG_PUBLIC_KEY: &str = "RWQBgqf6blQyyS5iZtY8jghQsvoA1CpEUXbZOwwxuipkYCCsR/kHQ5tO";
const DEFAULT_CATALOG_URL: &str = "https://github.com/QwenAudio/qwen-audio-toolkits/releases/download/model-catalog-v1/model-catalog.json";
const DEFAULT_MODEL_REPOSITORY_RESOLVE: &str =
    "https://www.modelscope.cn/models/funaudio_public/QwenAudio-Toolkits/resolve/master";
const DEFAULT_MODEL_REPOSITORY_FILES_API: &str =
    "https://www.modelscope.cn/api/v1/models/funaudio_public/QwenAudio-Toolkits/repo/files?Revision=master&Recursive=true";
const RUNTIME_POINTER_FILE: &str = ".runtime-path";
const RUNTIME_COMPLETE_FILE: &str = ".complete";
const SHARED_RUNTIME_PROGRESS_BASE: u8 = 18;
const SHARED_RUNTIME_PROGRESS_SPAN: u8 = 20;
const MODEL_PROGRESS_BASE: u8 = 38;
const MODEL_PROGRESS_SPAN: u8 = 28;
const ASSET_PROGRESS_BASE: u8 = 70;
const ASSET_PROGRESS_SPAN: u8 = 4;
const FINAL_INSTALL_PROGRESS: u8 = 94;
const MODELSCOPE_FILE_CONCURRENCY: usize = 4;
const SHARED_RUNTIME_PROGRESS: DownloadProgressRange = DownloadProgressRange {
    base: SHARED_RUNTIME_PROGRESS_BASE,
    span: SHARED_RUNTIME_PROGRESS_SPAN,
};
const MODEL_PROGRESS: DownloadProgressRange = DownloadProgressRange {
    base: MODEL_PROGRESS_BASE,
    span: MODEL_PROGRESS_SPAN,
};
const ASSET_PROGRESS: DownloadProgressRange = DownloadProgressRange {
    base: ASSET_PROGRESS_BASE,
    span: ASSET_PROGRESS_SPAN,
};
static PLUGIN_INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const GTCRN_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.gtcrn-simple",
  "name": "GTCRN Speech Enhancement",
  "version": "1.0.0",
  "publisher": "Xiaobin Rong et al.",
  "description": "通过 sherpa-onnx 在本地执行语音降噪，支持文件处理并可扩展到实时流。",
  "adapter": "gtcrn",
  "capabilities": ["audio.enhance"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "gtcrn-simple",
    "name": "GTCRN Simple",
    "precision": "FP32",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx",
    "files": ["gtcrn_simple.onnx"],
    "estimatedSizeMb": 1
  }],
  "acceleration": ["CPU"],
  "tone": "green"
}"#;
const DEEPFILTERNET_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "rikorose.deepfilternet3",
  "name": "DeepFilterNet3",
  "version": "3.0",
  "publisher": "Rikorose",
  "license": "MIT OR Apache-2.0",
  "description": "面向全频带语音的本地深度降噪，安装时下载当前平台的官方运行时，适合录音清理和语音前处理。",
  "adapter": "deepfilternet",
  "capabilities": ["audio.enhance"],
  "runtime": {"kind": "native", "entry": "deep-filter", "package": "deepfilter-0.5.6"},
  "models": [{
    "id": "deepfilternet3-onnx",
    "name": "DeepFilterNet3",
    "precision": "FP32",
    "source": "",
    "sha256": "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616",
    "files": ["DeepFilterNet3_onnx.tar.gz"],
    "estimatedSizeMb": 36,
    "repositoryHosted": true
  }],
  "acceleration": ["CPU"],
  "tone": "green"
}"#;
const RNNOISE_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "xiph.rnnoise",
  "name": "RNNoise",
  "version": "0.5.2",
  "publisher": "Xiph.Org",
  "license": "BSD-3-Clause",
  "description": "轻量实时语音降噪，使用纯 Rust RNNoise 推理，适合通话、麦克风和低延迟语音前处理。",
  "adapter": "rnnoise",
  "capabilities": ["audio.enhance"],
  "runtime": {"kind": "native", "entry": "nnnoiseless"},
  "models": [{
    "id": "rnnoise-default",
    "name": "RNNoise Default",
    "precision": "FP32",
    "source": "",
    "files": [],
    "estimatedSizeMb": 1
  }],
  "acceleration": ["CPU"],
  "tone": "green"
}"#;
const AISHELL3_VITS_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.vits-aishell3",
  "name": "VITS AISHELL3 中文",
  "version": "1.0.0",
  "publisher": "k2-fsa",
  "description": "本地中文多说话人语音合成，提供 174 个 AISHELL3 说话人。",
  "adapter": "vits",
  "capabilities": ["speech.tts"],
  "recommendedDependencies": [{
    "role": "text-normalization",
    "label": "文本归一化",
    "pluginId": "wetext.text-normalization",
    "capability": "text.normalize",
    "default": true,
    "optional": false
  }],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "vits-icefall-zh-aishell3",
    "name": "VITS AISHELL3",
    "precision": "FP32",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2",
    "files": ["model.onnx", "lexicon.txt", "tokens.txt"],
    "estimatedSizeMb": 35
  }],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const STREAMING_ZIPFORMER_ZH_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.streaming-zipformer-zh",
  "name": "Streaming Zipformer 中文",
  "version": "2025.06.30",
  "publisher": "k2-fsa",
  "description": "中文流式语音识别模型，支持麦克风连续输入、增量结果和时间戳。",
  "adapter": "streaming-zipformer",
  "capabilities": ["speech.asr"],
  "displayCapabilities": ["语音识别", "流式", "时间戳"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [
    {
      "id": "streaming-zipformer-zh-int8-2025-06-30",
      "name": "Streaming Zipformer 中文",
      "precision": "INT8",
      "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30.tar.bz2",
      "files": ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"],
      "estimatedSizeMb": 127
    },
    {
      "id": "streaming-zipformer-zh-fp32-2025-06-30",
      "name": "Streaming Zipformer 中文",
      "precision": "FP32",
      "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-2025-06-30.tar.bz2",
      "files": ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
      "estimatedSizeMb": 567
    }
  ],
  "acceleration": ["CPU"],
  "tone": "blue"
}"#;
const SENSEVOICE_GGUF_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "funaudiollm.sensevoice-small-gguf",
  "name": "SenseVoice Small GGUF",
  "version": "official-0.1.9",
  "publisher": "FunAudioLLM",
  "license": "Apache-2.0",
  "description": "SenseVoice Small 官方 GGUF 运行时，支持中英日韩粤识别以及语种、情感和音频事件标签。",
  "adapter": "funasr-sensevoice-gguf",
  "capabilities": ["speech.asr"],
  "displayCapabilities": ["语音识别", "语种与情感", "GGUF"],
  "runtime": {"kind": "native", "entry": "llama-funasr-sensevoice", "package": "funasr-llamacpp-0.1.10"},
  "models": [
    {"id":"sensevoice-small-gguf-q8","name":"SenseVoice Small","precision":"Q8","source":"","sha256":"4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5","files":["sensevoice-small-q8.gguf"],"repositoryHosted":true,"estimatedSizeMb":243},
    {"id":"sensevoice-small-gguf-f16","name":"SenseVoice Small","precision":"F16","source":"","sha256":"2389039651f4574dbd674f1f1e296b8b1147b2e19a5fd9c2cd69e82669c78d8e","files":["sensevoice-small-f16.gguf"],"repositoryHosted":true,"estimatedSizeMb":449},
    {"id":"sensevoice-small-gguf-f32","name":"SenseVoice Small","precision":"F32","source":"","sha256":"62bbbd6bc97bdb55a53957c768f9e7f38e6b818fb720ba46d6ff52d4cc200ff0","files":["sensevoice-small.gguf"],"repositoryHosted":true,"estimatedSizeMb":893}
  ],
  "acceleration": ["CPU"],
  "tone": "blue"
}"#;
const PARAFORMER_GGUF_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "funaudiollm.paraformer-gguf",
  "name": "Paraformer GGUF",
  "version": "official-0.1.9",
  "publisher": "FunAudioLLM",
  "license": "Apache-2.0",
  "description": "Paraformer 官方 GGUF 本地识别模型，面向中英文音频与高吞吐离线转写。",
  "adapter": "funasr-paraformer-gguf",
  "capabilities": ["speech.asr"],
  "displayCapabilities": ["语音识别", "中英文", "GGUF"],
  "runtime": {"kind": "native", "entry": "llama-funasr-paraformer", "package": "funasr-llamacpp-0.1.10"},
  "models": [
    {"id":"paraformer-gguf-q8","name":"Paraformer","precision":"Q8","source":"","sha256":"42bf76ea1575a336aaca4c1b7c01a82b79113e6d04d0d6b799561bfcf07ee011","files":["paraformer-q8.gguf"],"repositoryHosted":true,"estimatedSizeMb":226},
    {"id":"paraformer-gguf-f16","name":"Paraformer","precision":"F16","source":"","sha256":"5d1fda4e132f003faeb3a0e34dd19601fb6d0a82b3fe8292326b86ac35eba803","files":["paraformer-f16.gguf"],"repositoryHosted":true,"estimatedSizeMb":415},
    {"id":"paraformer-gguf-f32","name":"Paraformer","precision":"F32","source":"","sha256":"f81e32c3541fa274e456a8954b9e6d786b3fa8bcd532a8287bfeb04c4b4307ce","files":["paraformer.gguf"],"repositoryHosted":true,"estimatedSizeMb":824}
  ],
  "acceleration": ["CPU"],
  "tone": "blue"
}"#;
const FSMN_VAD_GGUF_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "funaudiollm.fsmn-vad-gguf",
  "name": "FSMN-VAD GGUF",
  "version": "official-0.1.9",
  "publisher": "FunAudioLLM",
  "license": "Apache-2.0",
  "description": "FunASR 官方 GGUF 语音活动检测模型，输出毫秒级语音区间，可独立运行。",
  "adapter": "funasr-fsmn-vad-gguf",
  "capabilities": ["speech.vad"],
  "displayCapabilities": ["VAD", "长音频", "GGUF"],
  "runtime": {"kind": "native", "entry": "llama-funasr-vad", "package": "funasr-llamacpp-0.1.10"},
  "models": [{"id":"fsmn-vad-gguf","name":"FSMN-VAD","precision":"F32","source":"","sha256":"1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479","files":["fsmn-vad.gguf"],"repositoryHosted":true,"estimatedSizeMb":2}],
  "acceleration": ["CPU"],
  "tone": "yellow"
}"#;
const STREAMING_PARAFORMER_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.streaming-paraformer",
  "name": "Streaming Paraformer",
  "version": "2024.01",
  "publisher": "k2-fsa",
  "description": "中英及粤语流式识别，适合实时字幕、会议和语音对话。",
  "adapter": "streaming-paraformer",
  "capabilities": ["speech.asr"],
  "displayCapabilities": ["语音识别", "流式", "时间戳"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [
    {
      "id": "streaming-paraformer-trilingual-int8",
      "name": "中英粤三语",
      "precision": "INT8",
      "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-trilingual-zh-cantonese-en.tar.bz2",
      "files": ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
      "estimatedSizeMb": 230
    },
    {
      "id": "streaming-paraformer-bilingual-int8",
      "name": "中英双语",
      "precision": "INT8",
      "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2",
      "files": ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"],
      "estimatedSizeMb": 230
    }
  ],
  "acceleration": ["CPU"],
  "tone": "blue"
}"#;
const WENET_CTC_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "wenet-e2e.wenetspeech-yue-u2pp-ctc",
  "name": "WeNetSpeech Yue U2++ CTC",
  "version": "2025.09.10",
  "publisher": "WeNet",
  "license": "Apache-2.0",
  "description": "基于 WeNet U2++ Conformer 的中英粤本地识别模型。使用 sherpa-onnx 运行，适合粤语内容、离线转写和 VAD 分段后的准实时识别。",
  "adapter": "wenet-ctc",
  "capabilities": ["speech.asr"],
  "displayCapabilities": ["语音识别", "中英粤", "时间戳"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "wenetspeech-yue-u2pp-conformer-ctc-int8-2025-09-10",
    "name": "WeNetSpeech Yue U2++ CTC",
    "precision": "INT8",
    "source": "",
    "sha256": "8636295785a43538a1b4620f167bcb89c10ce5ebdcee61c72a388738b783f992",
    "files": ["model.int8.onnx", "tokens.txt"],
    "estimatedSizeMb": 112,
    "repositoryHosted": true
  }],
  "acceleration": ["CPU"],
  "tone": "blue"
}"#;
const FUNASR_NANO_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.funasr-nano",
  "name": "FunASR Nano",
  "version": "2512-official-0.1.9",
  "publisher": "FunAudioLLM",
  "license": "Apache-2.0",
  "description": "QwenAudio/Fun-ASR 官方本地运行时，面向中文、英文、日文及中文方言识别。使用模型包内置 FSMN-VAD 分段，以官方 GGUF 推理链路获得稳定的长音频识别效果。",
  "adapter": "funasr-nano",
  "capabilities": ["speech.asr"],
  "displayCapabilities": ["语音识别", "中英日方言", "内置 VAD"],
  "runtime": {"kind": "native", "entry": "llama-funasr-cli", "package": "funasr-llamacpp-0.1.10"},
  "models": [{
    "id": "funasr-nano-2512-official-q4km",
    "name": "Fun-ASR-Nano-2512",
    "precision": "Q4_K_M",
    "source": "",
    "files": ["funasr-encoder-f16.gguf", "qwen3-0.6b-q4km.gguf", "fsmn-vad.gguf"],
    "repositoryHosted": true,
    "estimatedSizeMb": 928
  }, {
    "id": "funasr-nano-2512-official-q5km",
    "name": "Fun-ASR-Nano-2512",
    "precision": "Q5_K_M",
    "source": "",
    "files": ["funasr-encoder-f16.gguf", "qwen3-0.6b-q5km.gguf", "fsmn-vad.gguf"],
    "repositoryHosted": true,
    "estimatedSizeMb": 993
  }, {
    "id": "funasr-nano-2512-official-q8",
    "name": "Fun-ASR-Nano-2512",
    "precision": "Q8",
    "source": "",
    "files": ["funasr-encoder-f16.gguf", "qwen3-0.6b-q8_0.gguf", "fsmn-vad.gguf"],
    "repositoryHosted": true,
    "estimatedSizeMb": 1218
  }],
  "acceleration": ["CPU"],
  "tone": "blue"
}"#;
const COSYVOICE_LOCAL_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "lourdle.fun-cosyvoice3-local",
  "name": "Fun-CosyVoice3-0.5B-2512",
  "version": "2512",
  "publisher": "FunAudioLLM",
  "license": "Apache-2.0",
  "description": "本地多语言零样本语音合成与音色克隆。使用 CosyVoice.cpp 和 GGUF 在 CPU 上运行，不需要 Python 或云端接口。",
  "adapter": "cosyvoice-local",
  "capabilities": ["speech.tts"],
  "displayCapabilities": ["音频生成", "音色克隆", "本地"],
  "recommendedDependencies": [{
    "role": "reference-transcription",
    "label": "参考文本识别",
    "pluginId": "funaudiollm.sensevoice-small-gguf",
    "capability": "speech.transcribe",
    "default": true,
    "optional": true
  }],
  "runtime": {"kind": "native", "entry": "cosyvoice.cpp", "package": "cosyvoice-cpp-0aaa9ef-b9837"},
  "models": [
    {
      "id": "fun-cosyvoice3-q5-k-m",
      "name": "Fun-CosyVoice3-0.5B-2512",
      "precision": "Q5_K_M",
      "source": "",
      "sha256": "702b54d4e5d2d6c8d855081a5a2dc1acf046544291899f674295dc17a4f89f16",
      "files": ["CosyVoice3-2512_Q5_K_M.gguf", "frontend-onnx/speech_tokenizer_v3.int8.onnx", "frontend-onnx/campplus.int8.onnx"],
      "assets": [],
      "estimatedSizeMb": 970,
      "repositoryHosted": true
    },
    {
      "id": "fun-cosyvoice3-q8-0",
      "name": "Fun-CosyVoice3-0.5B-2512",
      "precision": "Q8_0",
      "source": "",
      "sha256": "be133cb6154ca73cd1d213b1c9496def99ba9c1f7c14cd99f6b350af2eb7963d",
      "files": ["CosyVoice3-2512_Q8_0.gguf", "frontend-onnx/speech_tokenizer_v3.int8.onnx", "frontend-onnx/campplus.int8.onnx"],
      "assets": [],
      "estimatedSizeMb": 1230,
      "repositoryHosted": true
    }
  ],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const MELO_TTS_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.vits-melo-zh-en",
  "name": "MeloTTS 中英双语",
  "version": "1.0.0",
  "publisher": "MyShell.ai",
  "description": "本地中英文语音合成模型，适合旁白、播客和对话回复。",
  "adapter": "vits",
  "capabilities": ["speech.tts"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "vits-melo-tts-zh-en",
    "name": "MeloTTS 中英双语",
    "precision": "FP32",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2",
    "files": ["model.onnx", "lexicon.txt", "tokens.txt"],
    "estimatedSizeMb": 160
  }],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const ZIPVOICE_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.zipvoice-zh-en",
  "name": "ZipVoice 中英音色克隆",
  "version": "2026.01",
  "publisher": "k2-fsa",
  "description": "本地零样本音色克隆。上传参考音频及其准确文本，即可合成相同音色的中英文语音。",
  "adapter": "zipvoice",
  "capabilities": ["speech.tts"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "zipvoice-distill-int8-zh-en-emilia",
    "name": "ZipVoice Distill 中英",
    "precision": "INT8",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2",
    "files": ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt", "lexicon.txt", "espeak-ng-data", "vocos_24khz.onnx"],
    "assets": [{
      "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx",
      "path": "vocos_24khz.onnx"
    }],
    "estimatedSizeMb": 450
  }],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const POCKET_TTS_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.pocket-tts-en",
  "name": "PocketTTS 英文音色克隆",
  "version": "2026.01.26",
  "publisher": "Kyutai",
  "description": "轻量本地零样本英文语音合成，只需一段参考音频，无需填写参考文本。",
  "adapter": "pocket-tts",
  "capabilities": ["speech.tts"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "pocket-tts-int8-2026-01-26",
    "name": "PocketTTS INT8",
    "precision": "INT8",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2",
    "files": ["lm_flow.int8.onnx", "lm_main.int8.onnx", "encoder.onnx", "decoder.int8.onnx", "text_conditioner.onnx", "vocab.json", "token_scores.json"],
    "estimatedSizeMb": 400
  }],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const SUPERTONIC_TTS_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.supertonic-3",
  "name": "SupertonicTTS 3 多语言",
  "version": "2026.05.11",
  "publisher": "Supertone",
  "description": "本地多说话人、多语言语音合成，支持英文、日文、韩文、法文等 31 种语言。",
  "adapter": "supertonic",
  "capabilities": ["speech.tts"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "supertonic-3-tts-int8-2026-05-11",
    "name": "SupertonicTTS 3",
    "precision": "INT8",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2",
    "files": ["duration_predictor.int8.onnx", "text_encoder.int8.onnx", "vector_estimator.int8.onnx", "vocoder.int8.onnx", "tts.json", "unicode_indexer.bin", "voice.bin"],
    "estimatedSizeMb": 250
  }],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const KITTEN_TTS_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.kitten-nano-en",
  "name": "KittenTTS Nano 英文",
  "version": "0.8",
  "publisher": "KittenML",
  "description": "紧凑的本地英文多音色语音合成模型，无需参考音频。",
  "adapter": "kitten",
  "capabilities": ["speech.tts"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "kitten-nano-en-v0_8-int8",
    "name": "Kitten Nano v0.8",
    "precision": "INT8",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-nano-en-v0_8-int8.tar.bz2",
    "files": ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"],
    "estimatedSizeMb": 30
  }],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const MATCHA_TTS_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "k2-fsa.matcha-zh-en",
  "name": "MatchaTTS 中英双语",
  "version": "2025.10",
  "publisher": "k2-fsa",
  "description": "本地中英文流匹配语音合成，使用独立 Vocos 声码器生成 16 kHz 音频。",
  "adapter": "matcha",
  "capabilities": ["speech.tts"],
  "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
  "models": [{
    "id": "matcha-icefall-zh-en",
    "name": "MatchaTTS 中英双语",
    "precision": "FP32",
    "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-en.tar.bz2",
    "files": ["model-steps-3.onnx", "tokens.txt", "lexicon.txt", "espeak-ng-data", "vocos-16khz-univ.onnx"],
    "assets": [{
      "source": "https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-16khz-univ.onnx",
      "path": "vocos-16khz-univ.onnx"
    }],
    "estimatedSizeMb": 160
  }],
  "acceleration": ["CPU"],
  "tone": "coral"
}"#;
const AUDIO_TAGGING_MANIFEST: &str = r#"{"schemaVersion":2,"id":"k2-fsa.audio-tagging","name":"CED Audio Tagging","version":"2024.04","publisher":"k2-fsa","description":"识别音频中的环境声、事件与场景标签。","adapter":"audio-tagging","capabilities":["audio.classify"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"ced-tiny-int8","name":"CED Tiny","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2","files":[],"estimatedSizeMb":27},{"id":"ced-small","name":"CED Small","precision":"FP32","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-small-audio-tagging-2024-04-19.tar.bz2","files":[],"estimatedSizeMb":96}],"acceleration":["CPU"],"tone":"green"}"#;
const KEYWORD_SPOTTING_MANIFEST: &str = r#"{"schemaVersion":2,"id":"k2-fsa.keyword-spotting","name":"Zipformer Keyword Spotting","version":"2025.12","publisher":"k2-fsa","description":"本地流式关键词和唤醒词检测。","adapter":"keyword-spotting","capabilities":["speech.keyword"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"kws-zh-en-int8","name":"中英关键词","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2","files":[],"estimatedSizeMb":31}],"acceleration":["CPU"],"tone":"yellow"}"#;
const LANGUAGE_ID_MANIFEST: &str = r#"{"schemaVersion":2,"id":"k2-fsa.whisper-language-id","name":"Whisper Tiny 语言识别","version":"1.0","publisher":"k2-fsa","description":"离线判断音频所使用的语言。","adapter":"language-id","capabilities":["speech.language"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"whisper-tiny","name":"Whisper Tiny","precision":"FP32","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2","files":[],"estimatedSizeMb":150}],"acceleration":["CPU"],"tone":"blue"}"#;
const SOURCE_SEPARATION_MANIFEST: &str = r#"{"schemaVersion":2,"id":"k2-fsa.spleeter-2stems","name":"Spleeter 2 Stems","version":"1.0","publisher":"k2-fsa","description":"将混合音频分离为人声与伴奏。","adapter":"source-separation","capabilities":["audio.separate"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"spleeter-int8","name":"Spleeter 2 Stems","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-int8.tar.bz2","files":[],"estimatedSizeMb":50},{"id":"spleeter-fp16","name":"Spleeter 2 Stems","precision":"FP16","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2","files":[],"estimatedSizeMb":90},{"id":"spleeter-fp32","name":"Spleeter 2 Stems","precision":"FP32","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems.tar.bz2","files":[],"estimatedSizeMb":180}],"acceleration":["CPU"],"tone":"violet"}"#;
const ZIPENHANCER_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "modelscope.zipenhancer-16k",
  "name": "ZipEnhancer 16 kHz",
  "version": "1.0",
  "publisher": "Alibaba DAMO Academy",
  "license": "Apache-2.0",
  "description": "面向单声道语音的本地深度降噪，保留原始时长并支持长音频分段处理。",
  "adapter": "zipenhancer",
  "capabilities": ["audio.enhance"],
  "displayCapabilities": ["语音降噪", "16 kHz", "本地推理"],
  "runtime": {"kind": "native", "entry": "onnxruntime", "package": "onnxruntime-1.27.0"},
  "models": [{
    "id": "zipenhancer-16k",
    "name": "ZipEnhancer 16 kHz",
    "precision": "FP32",
    "source": "",
    "files": ["zipenhancer.onnx"],
    "estimatedSizeMb": 10,
    "repositoryHosted": true
  }],
  "acceleration": ["CPU"],
  "tone": "green"
}"#;
const MOSSFORMER2_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "modelscope.mossformer2-separation-8k",
  "name": "MossFormer2 两人声分离",
  "version": "1.0",
  "publisher": "Alibaba DAMO Academy",
  "license": "Apache-2.0",
  "description": "将 8 kHz 单声道双人混音分离为说话人 1 与说话人 2，不用于人声与伴奏分离。",
  "adapter": "mossformer2-separation",
  "capabilities": ["audio.separate"],
  "displayCapabilities": ["双人声分离", "8 kHz", "本地推理"],
  "runtime": {"kind": "native", "entry": "onnxruntime", "package": "onnxruntime-1.27.0"},
  "models": [{
    "id": "mossformer2-separation-8k",
    "name": "MossFormer2 2 Speakers",
    "precision": "FP32",
    "source": "",
    "files": ["mossformer2.onnx"],
    "estimatedSizeMb": 219,
    "repositoryHosted": true
  }],
  "acceleration": ["CPU"],
  "tone": "violet"
}"#;
const PUNCTUATION_MANIFEST: &str = r#"{"schemaVersion":2,"id":"k2-fsa.punctuation-zh-en","name":"中英文标点恢复","version":"2024.04","publisher":"k2-fsa","description":"为识别文本离线补充中英文标点。","adapter":"punctuation","capabilities":["text.punctuate"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"punctuation-int8","name":"CT Transformer","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2","files":[],"estimatedSizeMb":100},{"id":"punctuation-fp32","name":"CT Transformer","precision":"FP32","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12.tar.bz2","files":[],"estimatedSizeMb":400}],"acceleration":["CPU"],"tone":"violet"}"#;
const WETEXT_REQUIRED_FILES: &[&str] = &[
    "wetext/fsts/zh/tn/tagger.fst",
    "wetext/fsts/zh/tn/verbalizer.fst",
    "wetext/fsts/zh/itn/tagger.fst",
    "wetext/fsts/zh/itn/tagger_enable_0_to_9.fst",
    "wetext/fsts/zh/itn/verbalizer.fst",
    "wetext/fsts/zh/tn/verbalizer_remove_erhua.fst",
    "wetext/fsts/en/tn/tagger.fst",
    "wetext/fsts/en/tn/verbalizer.fst",
    "wetext/fsts/en/itn/tagger.fst",
    "wetext/fsts/en/itn/verbalizer.fst",
    "wetext/fsts/ja/tn/tagger.fst",
    "wetext/fsts/ja/tn/verbalizer.fst",
    "wetext/fsts/ja/itn/tagger.fst",
    "wetext/fsts/ja/itn/tagger_enable_0_to_9.fst",
    "wetext/fsts/ja/itn/verbalizer.fst",
    "wetext/fsts/full_to_half.fst",
    "wetext/fsts/remove_interjections.fst",
    "wetext/fsts/remove_puncts.fst",
    "wetext/fsts/tag_oov.fst",
    "wetext/fsts/traditional_to_simple.fst",
];

const WETEXT_MANIFEST: &str = r#"{
  "schemaVersion": 2,
  "id": "wetext.text-normalization",
  "name": "WeText TN / ITN",
  "version": "0.1.6",
  "publisher": "WeNet",
  "license": "Apache-2.0",
  "description": "基于 WFST 的中英日文本归一化与逆文本归一化。本地运行，适合 TTS 前处理和 ASR 数字、日期、金额后处理。",
  "adapter": "wetext",
  "capabilities": ["text.normalize"],
  "runtime": {"kind": "native", "entry": "kaldifst"},
  "models": [{
    "id": "wetext-fsts-0.1.6",
    "name": "WeText 中英日规则",
    "precision": "WFST",
    "source": "",
    "files": ["wetext/fsts/zh/tn/tagger.fst", "wetext/fsts/zh/tn/verbalizer.fst", "wetext/fsts/zh/itn/tagger.fst", "wetext/fsts/zh/itn/tagger_enable_0_to_9.fst", "wetext/fsts/zh/itn/verbalizer.fst", "wetext/fsts/zh/tn/verbalizer_remove_erhua.fst", "wetext/fsts/en/tn/tagger.fst", "wetext/fsts/en/tn/verbalizer.fst", "wetext/fsts/en/itn/tagger.fst", "wetext/fsts/en/itn/verbalizer.fst", "wetext/fsts/ja/tn/tagger.fst", "wetext/fsts/ja/tn/verbalizer.fst", "wetext/fsts/ja/itn/tagger.fst", "wetext/fsts/ja/itn/tagger_enable_0_to_9.fst", "wetext/fsts/ja/itn/verbalizer.fst", "wetext/fsts/full_to_half.fst", "wetext/fsts/remove_interjections.fst", "wetext/fsts/remove_puncts.fst", "wetext/fsts/tag_oov.fst", "wetext/fsts/traditional_to_simple.fst"],
    "assets": [
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/en/itn/tagger.fst","path":"wetext/fsts/en/itn/tagger.fst","sha256":"d33019ac11e5ce41f0bdec16d50696823105e0882da92c2c75c44c980eb9c2ae"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/en/itn/verbalizer.fst","path":"wetext/fsts/en/itn/verbalizer.fst","sha256":"89db991f319cd1e5f27e3b33dc69642e97c83bc5df0333e6a53cafeae806e121"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/en/tn/tagger.fst","path":"wetext/fsts/en/tn/tagger.fst","sha256":"245e2dc9174cdd007a8e9e50f3339773d1adbbc7535b71cf67478dc1683cc3ec"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/en/tn/verbalizer.fst","path":"wetext/fsts/en/tn/verbalizer.fst","sha256":"03155c88f317b2795969e264c19f87faf98b9853d5ac631e419bacdc3b3ee15a"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/ja/itn/tagger.fst","path":"wetext/fsts/ja/itn/tagger.fst","sha256":"cb0ec2a70b5e9c61d6532b5146ea5676ed9cdd808c8c737be8e5b3abe7002b23"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/ja/itn/tagger_enable_0_to_9.fst","path":"wetext/fsts/ja/itn/tagger_enable_0_to_9.fst","sha256":"e6c63f48e7156ec99bd6080f682945ddb67bd4d89c69df354c6af86aa603abab"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/ja/itn/verbalizer.fst","path":"wetext/fsts/ja/itn/verbalizer.fst","sha256":"4f4deac5ce1c5af61ca359dfb13289aed506eba22979c4a9ceaae238d9c86acc"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/ja/tn/tagger.fst","path":"wetext/fsts/ja/tn/tagger.fst","sha256":"4e07b61a391df366ed8e2d249a36fa16fdbed9cbb505c186e12352429187aa88"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/ja/tn/verbalizer.fst","path":"wetext/fsts/ja/tn/verbalizer.fst","sha256":"34d9cc3a219f23052273e00e2f8810f6f24614f291794914d2ba52ecc39a6cfc"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/zh/itn/tagger.fst","path":"wetext/fsts/zh/itn/tagger.fst","sha256":"1b57d35fa33030b50f2699d77b3c2cf2c3d5961c45d450322f5cf9aa729b810c"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/zh/itn/tagger_enable_0_to_9.fst","path":"wetext/fsts/zh/itn/tagger_enable_0_to_9.fst","sha256":"a29dad112b1725e79f96f5a84e8b7f2ceb9dc3d88ffc785ebf994899701ccc9f"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/zh/itn/verbalizer.fst","path":"wetext/fsts/zh/itn/verbalizer.fst","sha256":"440ac75aaeda3dd81f91b42abec4c08e84b7b0186462cc536a3a74d3ad1f13c4"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/zh/tn/tagger.fst","path":"wetext/fsts/zh/tn/tagger.fst","sha256":"cf341314c51f7ce59049f3b2c42f0ce8fd71e6d08d4d6969613aad384a5e2ae8"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/zh/tn/verbalizer.fst","path":"wetext/fsts/zh/tn/verbalizer.fst","sha256":"5a13cd679dd54637d12d2bd1bd33ee2165d91c867e14468c93195af02256e5da"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/zh/tn/verbalizer_remove_erhua.fst","path":"wetext/fsts/zh/tn/verbalizer_remove_erhua.fst","sha256":"4ecdea636b97cb7dff2637499713815836ec703d29cf044f17106d428f258ee5"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/full_to_half.fst","path":"wetext/fsts/full_to_half.fst","sha256":"3ac164703b7e83133a8864c8d5dd3cd44ea398c74f49480258e6d986c73b21ad"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/remove_interjections.fst","path":"wetext/fsts/remove_interjections.fst","sha256":"70f36aa8071968f72278fb8db9f17a060e8f8ac73a5e4161a009e33c688fedc1"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/remove_puncts.fst","path":"wetext/fsts/remove_puncts.fst","sha256":"0d69853648848ddad69e0b7a6398e5bc15be39b5559aa0119938aa6e60632538"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/tag_oov.fst","path":"wetext/fsts/tag_oov.fst","sha256":"7d58b861760f691b24f095ca17dcac6ccb79de1871282847895380249f2b034b"},
      {"source":"https://modelscope.cn/models/pengzhendong/wetext/resolve/master/traditional_to_simple.fst","path":"wetext/fsts/traditional_to_simple.fst","sha256":"01ff345b2416ac19b20bbc46236ed6a6923cf2a430a96411ae3b4f60ea9bf01d"}
    ],
    "estimatedSizeMb": 3
  }],
  "acceleration": ["CPU"],
  "tone": "violet"
}"#;
const SPEAKER_ID_MANIFEST: &str = r#"{"schemaVersion":2,"id":"k2-fsa.speaker-embedding","name":"3D-Speaker 声纹","version":"1.0","publisher":"k2-fsa","description":"比较两段人声的声纹向量与余弦相似度，用于说话人验证。","adapter":"speaker-embedding","capabilities":["speaker.embed"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"3dspeaker-campplus","name":"CAM++ 中英","precision":"FP32","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx","files":[],"estimatedSizeMb":30}],"acceleration":["CPU"],"tone":"blue"}"#;
const DIARIZATION_MANIFEST: &str = r#"{"schemaVersion":2,"id":"k2-fsa.speaker-diarization","name":"Pyannote Speaker Diarization","version":"3.0","publisher":"k2-fsa","description":"检测多人音频中的说话人切换与时间区间。","adapter":"speaker-diarization","capabilities":["speaker.diarize"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"pyannote-segmentation-3","name":"Pyannote Segmentation 3.0","precision":"FP32","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2","files":[],"estimatedSizeMb":7}],"acceleration":["CPU"],"tone":"yellow"}"#;
const QWEN3_ASR_MANIFEST: &str = r#"{"schemaVersion":2,"id":"qwen.qwen3-asr-0.6b","name":"Qwen3-ASR 0.6B","version":"2026.03.25","publisher":"Qwen","description":"高质量多语言离线识别，支持通过热词增强专有名词识别。","adapter":"qwen3-asr","capabilities":["speech.asr"],"displayCapabilities":["语音识别","多语言","热词"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"qwen3-asr-0.6b-int8","name":"Qwen3-ASR 0.6B","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2","files":["conv_frontend.onnx","encoder.int8.onnx","decoder.int8.onnx","tokenizer"],"estimatedSizeMb":950}],"acceleration":["CPU"],"tone":"blue"}"#;
const FIRE_RED_ASR2_CTC_MANIFEST: &str = r#"{"schemaVersion":2,"id":"firered.fire-red-asr2-ctc","name":"FireRedASR2 CTC","version":"2026.02.25","publisher":"FireRedTeam","description":"中英文及二十多种中文方言识别，CTC 解码速度快，适合长音频和字幕。","adapter":"fire-red-asr-ctc","capabilities":["speech.asr"],"displayCapabilities":["语音识别","中英方言","长音频"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"fire-red-asr2-ctc-int8","name":"FireRedASR2 CTC","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2","files":["model.int8.onnx","tokens.txt"],"estimatedSizeMb":741}],"acceleration":["CPU"],"tone":"blue"}"#;
const FIRE_RED_ASR_V1_MANIFEST: &str = r#"{"schemaVersion":2,"id":"firered.fire-red-asr-v1","name":"FireRedASR AED","version":"2025.02.16","publisher":"FireRedTeam","description":"FireRedASR 第一代中英文 AED 模型，支持普通话、英语及部分中文方言。模型较大，CPU 推理较慢。","adapter":"fire-red-asr","capabilities":["speech.asr"],"displayCapabilities":["语音识别","中英方言","AED"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"fire-red-asr-large-int8","name":"FireRedASR AED Large","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16.tar.bz2","files":["encoder.int8.onnx","decoder.int8.onnx","tokens.txt"],"estimatedSizeMb":1750}],"acceleration":["CPU"],"tone":"blue"}"#;
const MOONSHINE_V2_MANIFEST: &str = r#"{"schemaVersion":2,"id":"usefulsensors.moonshine-v2-tiny-en","name":"Moonshine v2 Tiny English","version":"2026.02.27","publisher":"Useful Sensors","description":"轻量英文离线识别模型，适合低资源设备、短语音和快速本地转写。","adapter":"moonshine-v2","capabilities":["speech.asr"],"displayCapabilities":["语音识别","英文","轻量"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"moonshine-v2-tiny-en-quantized","name":"Moonshine v2 Tiny English","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2","files":["encoder_model.ort","decoder_model_merged.ort","tokens.txt"],"estimatedSizeMb":120}],"acceleration":["CPU"],"tone":"blue"}"#;
const PARAKEET_TDT_MANIFEST: &str = r#"{"schemaVersion":2,"id":"nvidia.parakeet-tdt-0.6b-v3","name":"Parakeet TDT 0.6B v3","version":"3","publisher":"NVIDIA","description":"高质量多语言离线识别模型，覆盖 25 种欧洲语言并提供词级时间信息。","adapter":"nemo-parakeet","capabilities":["speech.asr"],"displayCapabilities":["语音识别","25 种语言","时间戳"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"parakeet-tdt-0.6b-v3-int8","name":"Parakeet TDT 0.6B v3","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2","files":["encoder.int8.onnx","decoder.int8.onnx","joiner.int8.onnx","tokens.txt"],"estimatedSizeMb":650}],"acceleration":["CPU"],"tone":"blue"}"#;
const CANARY_FLASH_MANIFEST: &str = r#"{"schemaVersion":2,"id":"nvidia.canary-180m-flash","name":"Canary 180M Flash","version":"180M","publisher":"NVIDIA","description":"英语、西班牙语、德语和法语离线识别与双向语音翻译。","adapter":"nemo-canary","capabilities":["speech.asr"],"displayCapabilities":["语音识别","四语","语音翻译"],"runtime":{"kind":"onnx","entry":"sherpa-onnx"},"models":[{"id":"canary-180m-flash-int8","name":"Canary 180M Flash","precision":"INT8","source":"https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2","files":["encoder.int8.onnx","decoder.int8.onnx","tokens.txt"],"estimatedSizeMb":210}],"acceleration":["CPU"],"tone":"blue"}"#;
const CATALOG_MANIFESTS: &[&str] = &[
    GTCRN_MANIFEST,
    DEEPFILTERNET_MANIFEST,
    RNNOISE_MANIFEST,
    AISHELL3_VITS_MANIFEST,
    STREAMING_ZIPFORMER_ZH_MANIFEST,
    STREAMING_PARAFORMER_MANIFEST,
    WENET_CTC_MANIFEST,
    QWEN3_ASR_MANIFEST,
    FIRE_RED_ASR2_CTC_MANIFEST,
    FIRE_RED_ASR_V1_MANIFEST,
    MOONSHINE_V2_MANIFEST,
    PARAKEET_TDT_MANIFEST,
    CANARY_FLASH_MANIFEST,
    FUNASR_NANO_MANIFEST,
    SENSEVOICE_GGUF_MANIFEST,
    PARAFORMER_GGUF_MANIFEST,
    FSMN_VAD_GGUF_MANIFEST,
    COSYVOICE_LOCAL_MANIFEST,
    MELO_TTS_MANIFEST,
    ZIPVOICE_MANIFEST,
    POCKET_TTS_MANIFEST,
    SUPERTONIC_TTS_MANIFEST,
    KITTEN_TTS_MANIFEST,
    MATCHA_TTS_MANIFEST,
    AUDIO_TAGGING_MANIFEST,
    KEYWORD_SPOTTING_MANIFEST,
    LANGUAGE_ID_MANIFEST,
    SOURCE_SEPARATION_MANIFEST,
    ZIPENHANCER_MANIFEST,
    MOSSFORMER2_MANIFEST,
    PUNCTUATION_MANIFEST,
    WETEXT_MANIFEST,
    SPEAKER_ID_MANIFEST,
    DIARIZATION_MANIFEST,
];

fn builtin_catalog_values() -> Result<Vec<serde_json::Value>, String> {
    CATALOG_MANIFESTS
        .iter()
        .map(|raw| {
            let mut value: serde_json::Value =
                serde_json::from_str(raw).map_err(|error| format!("内置模型目录无效: {error}"))?;
            mark_catalog_payloads_modelscope_hosted(&mut value);
            Ok(value)
        })
        .collect()
}

fn mark_catalog_payloads_modelscope_hosted(value: &mut serde_json::Value) {
    let Some(models) = value
        .get_mut("models")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for model in models {
        let has_payload = model
            .get("files")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|files| !files.is_empty())
            || model
                .get("assets")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|assets| !assets.is_empty())
            || model
                .get("source")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|source| !source.trim().is_empty());
        if !has_payload {
            continue;
        }
        model["repositoryHosted"] = serde_json::Value::Bool(true);
        model["source"] = serde_json::Value::String(String::new());
        model["assets"] = serde_json::Value::Array(Vec::new());
    }
}

fn catalog_values(app: &AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let mut entries = BTreeMap::new();
    for value in builtin_catalog_values()? {
        let id = catalog_entry_id(&value)?;
        entries.insert(id, value);
    }
    if catalog_source_url(app)?.is_some() {
        if let Some(bytes) = read_verified_catalog_cache(app)? {
            let remote = parse_remote_catalog(&bytes)?;
            for value in remote.plugins {
                let id = catalog_entry_id(&value)?;
                let value = entries
                    .get(&id)
                    .map(|builtin| merge_catalog_entry_payload(builtin, value.clone()))
                    .unwrap_or(value);
                entries.insert(id, value);
            }
        }
    }
    Ok(entries.into_values().collect())
}

fn merge_catalog_entry_payload(
    builtin: &serde_json::Value,
    mut remote: serde_json::Value,
) -> serde_json::Value {
    if builtin.get("id").and_then(serde_json::Value::as_str) == Some("k2-fsa.speaker-embedding") {
        if let Some(description) = builtin
            .get("description")
            .and_then(serde_json::Value::as_str)
            .filter(|description| !description.trim().is_empty())
        {
            remote["description"] = serde_json::Value::String(description.to_string());
        }
    }
    let Some(builtin_models) = builtin.get("models").and_then(serde_json::Value::as_array) else {
        return remote;
    };
    let Some(remote_models) = remote
        .get_mut("models")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return remote;
    };

    for builtin_model in builtin_models {
        let Some(model_id) = builtin_model.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(remote_model) = remote_models
            .iter_mut()
            .find(|model| model.get("id").and_then(serde_json::Value::as_str) == Some(model_id))
        else {
            continue;
        };
        merge_catalog_string_array(remote_model, builtin_model, "files");
        if builtin_model
            .get("repositoryHosted")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        {
            remote_model["repositoryHosted"] = serde_json::Value::Bool(true);
            // A ModelScope-hosted model must not retain an old external
            // source or asset list from a stale cached catalog.
            remote_model["source"] = serde_json::Value::String(String::new());
            remote_model["assets"] = serde_json::Value::Array(Vec::new());
            merge_catalog_asset_array(remote_model, builtin_model);
        } else {
            merge_catalog_asset_array(remote_model, builtin_model);
        }
    }
    remote
}

fn merge_catalog_string_array(
    target: &mut serde_json::Value,
    source: &serde_json::Value,
    key: &str,
) {
    let source_values = source
        .get(key)
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let target_values = target_object
        .entry(key.to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    let Some(target_values) = target_values.as_array_mut() else {
        return;
    };
    for value in source_values {
        if !target_values.iter().any(|existing| existing == &value) {
            target_values.push(value);
        }
    }
}

fn merge_catalog_asset_array(target: &mut serde_json::Value, source: &serde_json::Value) {
    let source_assets = source
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let target_assets = target_object
        .entry("assets".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    let Some(target_assets) = target_assets.as_array_mut() else {
        return;
    };
    for asset in source_assets {
        let path = asset.get("path").and_then(serde_json::Value::as_str);
        if path.is_some_and(|path| {
            target_assets.iter().any(|existing| {
                existing.get("path").and_then(serde_json::Value::as_str) == Some(path)
            })
        }) {
            continue;
        }
        target_assets.push(asset);
    }
}

fn catalog_manifest_value(
    app: &AppHandle,
    plugin_id: &str,
) -> Result<Option<serde_json::Value>, String> {
    Ok(catalog_values(app)?
        .into_iter()
        .find(|value| value.get("id").and_then(serde_json::Value::as_str) == Some(plugin_id)))
}

fn catalog_entry_id(value: &serde_json::Value) -> Result<String, String> {
    value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "模型目录条目缺少 id".to_string())
}

fn catalog_source_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("catalog-source.json"))
        .map_err(|error| format!("无法定位模型目录配置: {error}"))
}

fn catalog_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("catalog-cache.json"))
        .map_err(|error| format!("无法定位模型目录缓存: {error}"))
}

fn catalog_cache_signature_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("catalog-cache.json.sig"))
        .map_err(|error| format!("无法定位模型目录签名缓存: {error}"))
}

fn verify_catalog_signature(bytes: &[u8], signature_bytes: &[u8]) -> Result<(), String> {
    let signature_text = std::str::from_utf8(signature_bytes)
        .map_err(|error| format!("在线模型目录签名不是有效文本: {error}"))?;
    let public_key = PublicKey::from_base64(CATALOG_PUBLIC_KEY)
        .map_err(|error| format!("无法读取模型目录公钥: {error}"))?;
    let signature = Signature::decode(signature_text)
        .map_err(|error| format!("在线模型目录签名无效: {error}"))?;
    public_key
        .verify(bytes, &signature, false)
        .map_err(|error| format!("在线模型目录签名校验失败: {error}"))
}

fn read_verified_catalog_cache(app: &AppHandle) -> Result<Option<Vec<u8>>, String> {
    let bytes = match fs::read(catalog_cache_path(app)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取模型目录缓存: {error}")),
    };
    let signature = match fs::read(catalog_cache_signature_path(app)?) {
        Ok(signature) => signature,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取模型目录签名缓存: {error}")),
    };
    if verify_catalog_signature(&bytes, &signature).is_err() {
        return Ok(None);
    }
    Ok(Some(bytes))
}

fn catalog_source_url(app: &AppHandle) -> Result<Option<String>, String> {
    if let Ok(url) = env::var("QWEN_AUDIO_CATALOG_URL") {
        return validate_catalog_url(&url).map(Some);
    }
    let path = catalog_source_path(app)?;
    let update = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<CatalogSourceUpdate>(&bytes)
            .map_err(|error| format!("无法读取模型目录配置: {error}"))?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Some(DEFAULT_CATALOG_URL.to_string()));
        }
        Err(error) => return Err(format!("无法读取模型目录配置: {error}")),
    };
    update.url.as_deref().map(validate_catalog_url).transpose()
}

fn write_catalog_source(app: &AppHandle, url: Option<&str>) -> Result<(), String> {
    let url = url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_catalog_url)
        .transpose()?;
    let path = catalog_source_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建应用目录: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&CatalogSourceUpdate { url })
        .map_err(|error| format!("无法保存模型目录配置: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("无法保存模型目录配置: {error}"))
}

fn validate_catalog_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("模型目录 URL 无效: {error}"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("模型目录 URL 必须是有效的 HTTPS 地址".to_string());
    }
    Ok(parsed.to_string())
}

fn refresh_remote_catalog(app: &AppHandle) -> Result<(), String> {
    let Some(url) = catalog_source_url(app)? else {
        return Ok(());
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" || attempt.previous().len() >= 5 {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("无法创建模型目录连接: {error}"))?;
    let mut response = client
        .get(&url)
        .send()
        .map_err(|error| format!("无法读取在线模型目录: {error}"))?
        .error_for_status()
        .map_err(|error| format!("在线模型目录请求失败: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_BYTES)
    {
        return Err("在线模型目录超过 2 MB 限制".to_string());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取在线模型目录: {error}"))?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err("在线模型目录超过 2 MB 限制".to_string());
    }
    let signature_url = format!("{url}.sig");
    let mut signature_response = client
        .get(&signature_url)
        .send()
        .map_err(|error| format!("无法下载在线模型目录签名: {error}"))?
        .error_for_status()
        .map_err(|error| format!("在线模型目录签名请求失败: {error}"))?;
    if signature_response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_SIGNATURE_BYTES)
    {
        return Err("在线模型目录签名超过 16 KB 限制".to_string());
    }
    let mut signature = Vec::new();
    signature_response
        .by_ref()
        .take(MAX_CATALOG_SIGNATURE_BYTES + 1)
        .read_to_end(&mut signature)
        .map_err(|error| format!("无法读取在线模型目录签名: {error}"))?;
    if signature.len() as u64 > MAX_CATALOG_SIGNATURE_BYTES {
        return Err("在线模型目录签名超过 16 KB 限制".to_string());
    }
    verify_catalog_signature(&bytes, &signature)?;
    parse_remote_catalog(&bytes)?;
    let cache_path = catalog_cache_path(app)?;
    let signature_cache_path = catalog_cache_signature_path(app)?;
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建目录缓存: {error}"))?;
    }
    let temporary = cache_path.with_extension("json.tmp");
    let signature_temporary = signature_cache_path.with_extension("sig.tmp");
    fs::write(&temporary, &bytes).map_err(|error| format!("无法写入目录缓存: {error}"))?;
    fs::write(&signature_temporary, &signature)
        .map_err(|error| format!("无法写入目录签名缓存: {error}"))?;
    fs::rename(&temporary, &cache_path).map_err(|error| format!("无法更新目录缓存: {error}"))?;
    fs::rename(&signature_temporary, &signature_cache_path)
        .map_err(|error| format!("无法更新目录签名缓存: {error}"))
}

fn parse_remote_catalog(bytes: &[u8]) -> Result<RemoteCatalogEnvelope, String> {
    let envelope: RemoteCatalogEnvelope =
        serde_json::from_slice(bytes).map_err(|error| format!("在线模型目录无效: {error}"))?;
    if envelope.schema_version != 1 {
        return Err(format!(
            "不支持模型目录 schemaVersion {}",
            envelope.schema_version
        ));
    }
    if envelope.plugins.len() > MAX_CATALOG_PLUGINS {
        return Err(format!("在线模型目录最多支持 {MAX_CATALOG_PLUGINS} 个模型"));
    }
    let mut ids = std::collections::HashSet::new();
    for value in &envelope.plugins {
        let parsed: V2PluginManifest = serde_json::from_value(value.clone())
            .map_err(|error| format!("在线模型条目无效: {error}"))?;
        validate_remote_catalog_entry(&parsed)?;
        if !ids.insert(parsed.id.clone()) {
            return Err(format!("在线模型目录包含重复 id {}", parsed.id));
        }
        normalize_v2_manifest(parsed)?;
    }
    for value in &envelope.plugins {
        let parsed: V2PluginManifest = serde_json::from_value(value.clone())
            .map_err(|error| format!("在线模型条目无效: {error}"))?;
        for dependency in &parsed.recommended_dependencies {
            if !ids.contains(&dependency.plugin_id) && !builtin_plugin_id(&dependency.plugin_id) {
                return Err(format!(
                    "在线模型 {} 引用了目录中不存在的依赖 {}",
                    parsed.id, dependency.plugin_id
                ));
            }
        }
    }
    let mut api_ids = std::collections::HashSet::new();
    if envelope.api_models.len() > MAX_CATALOG_API_MODELS {
        return Err(format!(
            "在线模型目录最多支持 {MAX_CATALOG_API_MODELS} 个 API 模型"
        ));
    }
    for model in &envelope.api_models {
        validate_remote_api_model(model)?;
        if !api_ids.insert(model.id.clone()) {
            return Err(format!("在线模型目录包含重复 API 模型 id {}", model.id));
        }
    }
    Ok(envelope)
}

fn validate_remote_catalog_entry(manifest: &V2PluginManifest) -> Result<(), String> {
    let spec = adapter_spec(&manifest.adapter)
        .ok_or_else(|| format!("在线模型 {} 使用未知 adapter", manifest.id))?;
    if !manifest.runtime.package.is_empty() && !modelscope_component(&manifest.runtime.package) {
        return Err(format!("在线模型 {} 的 runtime package 无效", manifest.id));
    }
    for dependency in &manifest.recommended_dependencies {
        if dependency.role.trim().is_empty()
            || dependency.label.trim().is_empty()
            || dependency.plugin_id.trim().is_empty()
            || dependency.capability.trim().is_empty()
        {
            return Err(format!("在线模型 {} 包含无效的推荐依赖", manifest.id));
        }
    }
    let capabilities = manifest
        .capabilities
        .iter()
        .map(|capability| normalize_capability_id(capability))
        .collect::<Vec<_>>();
    if capabilities.as_slice() != [spec.capability] {
        return Err(format!(
            "在线模型 {} 的 capability 与 adapter 不匹配",
            manifest.id
        ));
    }
    if manifest.models.len() > MAX_CATALOG_VARIANTS {
        return Err(format!(
            "在线模型 {} 最多支持 {MAX_CATALOG_VARIANTS} 个版本",
            manifest.id
        ));
    }
    let mut variant_ids = std::collections::HashSet::new();
    for model in &manifest.models {
        if !variant_ids.insert(model.id.clone()) {
            return Err(format!(
                "在线模型 {} 包含重复版本 id {}",
                manifest.id, model.id
            ));
        }
        if model.repository_hosted && (!model.source.trim().is_empty() || !model.assets.is_empty())
        {
            return Err(format!(
                "在线模型 {} 标记为 ModelScope 托管时不能声明外部 source 或 assets",
                model.id
            ));
        }
        if !model.source.trim().is_empty() {
            validate_remote_asset(&model.source, &model.sha256)?;
        } else if model.assets.is_empty()
            && !model.repository_hosted
            && manifest.adapter != "rnnoise"
        {
            return Err(format!("在线模型 {} 没有可下载资源", model.id));
        }
        for asset in &model.assets {
            validate_remote_asset(&asset.source, &asset.sha256)?;
            safe_join(Path::new("."), &asset.path)?;
        }
        for file in &model.files {
            safe_join(Path::new("."), file)?;
        }
    }
    Ok(())
}

fn validate_remote_api_model(model: &ApiModelCatalogEntry) -> Result<(), String> {
    if model.id.trim().is_empty()
        || model.model_id.trim().is_empty()
        || model.name.trim().is_empty()
    {
        return Err("在线 API 模型缺少 id、modelId 或 name".to_string());
    }
    if !valid_api_model_identifier(&model.model_id) {
        return Err(format!("在线 API 模型 {} 的 modelId 无效", model.id));
    }
    if model.aliases.len() > MAX_API_MODEL_ALIASES {
        return Err(format!(
            "在线 API 模型 {} 最多支持 {MAX_API_MODEL_ALIASES} 个别名",
            model.id
        ));
    }
    let mut aliases = std::collections::HashSet::new();
    for alias in &model.aliases {
        if !valid_api_model_identifier(alias)
            || alias == &model.model_id
            || !aliases.insert(alias.as_str())
        {
            return Err(format!("在线 API 模型 {} 包含无效或重复别名", model.id));
        }
    }
    if !matches!(
        model.provider_id.as_str(),
        "api.bailian" | "api.openai-compatible"
    ) {
        return Err(format!("在线 API 模型 {} 使用未知 provider", model.id));
    }
    let capability_matches = match model.adapter.as_str() {
        "bailian-audio-process" => matches!(
            model.harness_capability.as_str(),
            CAPABILITY_ENHANCE | CAPABILITY_SOURCE_SEPARATION
        ),
        "bailian-tts" | "bailian-cosyvoice" | "compatible-tts" => {
            model.harness_capability == CAPABILITY_TTS
        }
        "bailian-asr" | "bailian-qwen-audio-asr" | "bailian-funasr" | "compatible-asr" => {
            model.harness_capability == CAPABILITY_ASR
        }
        "bailian-llm" | "compatible-llm" => model.harness_capability == CAPABILITY_TEXT,
        _ => false,
    };
    if !capability_matches {
        return Err(format!(
            "在线 API 模型 {} 的 adapter 与 capability 不匹配",
            model.id
        ));
    }
    if !matches!(model.streaming_mode.as_str(), "batch" | "streaming") {
        return Err(format!("在线 API 模型 {} 的 streamingMode 无效", model.id));
    }
    Ok(())
}

fn valid_api_model_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn validate_remote_asset(source: &str, sha256: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(source).map_err(|error| format!("模型资源 URL 无效: {error}"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("在线模型资源必须使用 HTTPS".to_string());
    }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("在线模型资源必须提供完整 SHA-256".to_string());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginModelManifest {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    assets: Vec<PluginAssetManifest>,
    #[serde(default)]
    repository_hosted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginAssetManifest {
    source: String,
    path: String,
    #[serde(default)]
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginPortManifest {
    name: String,
    #[serde(rename = "type")]
    port_type: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    modes: Vec<String>,
    #[serde(default)]
    optional: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginParameterOption {
    label: String,
    value: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginParameterManifest {
    name: String,
    label: String,
    #[serde(rename = "type")]
    parameter_type: String,
    #[serde(default)]
    description: String,
    #[serde(
        default,
        rename = "default",
        skip_serializing_if = "serde_json::Value::is_null"
    )]
    default_value: serde_json::Value,
    #[serde(default)]
    min: Option<f64>,
    #[serde(default)]
    max: Option<f64>,
    #[serde(default)]
    step: Option<f64>,
    #[serde(default)]
    options: Vec<PluginParameterOption>,
    #[serde(default)]
    multiline: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginDependencyManifest {
    role: String,
    label: String,
    plugin_id: String,
    capability: String,
    #[serde(default = "default_true")]
    default: bool,
    #[serde(default = "default_true")]
    optional: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    author: String,
    #[serde(default)]
    engine_author: String,
    description: String,
    #[serde(default)]
    license: String,
    runtime: String,
    #[serde(default)]
    runtime_package: String,
    adapter: String,
    capabilities: Vec<String>,
    #[serde(default)]
    display_capabilities: Vec<String>,
    #[serde(default)]
    acceleration: Vec<String>,
    #[serde(default)]
    size_label: String,
    #[serde(default)]
    featured: bool,
    #[serde(default)]
    tone: String,
    #[serde(default)]
    inputs: Vec<PluginPortManifest>,
    #[serde(default)]
    outputs: Vec<PluginPortManifest>,
    #[serde(default)]
    parameter_schema: Vec<PluginParameterManifest>,
    #[serde(default)]
    recommended_dependencies: Vec<PluginDependencyManifest>,
    model: Option<PluginModelManifest>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2RuntimeManifest {
    kind: String,
    entry: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    package: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2ModelManifest {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    precision: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    sha256: String,
    files: Vec<String>,
    #[serde(default)]
    assets: Vec<V2AssetManifest>,
    #[serde(default)]
    estimated_size_mb: u64,
    #[serde(default)]
    repository_hosted: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2AssetManifest {
    source: String,
    path: String,
    #[serde(default)]
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2PluginManifest {
    schema_version: u32,
    id: String,
    name: String,
    version: String,
    publisher: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    license: String,
    #[serde(default)]
    display_capabilities: Vec<String>,
    adapter: String,
    capabilities: Vec<String>,
    runtime: V2RuntimeManifest,
    models: Vec<V2ModelManifest>,
    #[serde(default)]
    acceleration: Vec<String>,
    #[serde(default)]
    featured: bool,
    #[serde(default)]
    tone: String,
    #[serde(default)]
    inputs: Vec<PluginPortManifest>,
    #[serde(default)]
    outputs: Vec<PluginPortManifest>,
    #[serde(default, rename = "parameters")]
    parameter_schema: Vec<PluginParameterManifest>,
    #[serde(default)]
    recommended_dependencies: Vec<PluginDependencyManifest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub(crate) id: String,
    pub(crate) name: String,
    author: String,
    engine_author: String,
    description: String,
    license: String,
    capabilities: Vec<String>,
    pub(crate) harness_capabilities: Vec<String>,
    runtime: String,
    acceleration: Vec<String>,
    version: String,
    size: String,
    pub(crate) installed: bool,
    pub(crate) enabled: bool,
    sidebar_visible: bool,
    builtin: bool,
    featured: bool,
    tone: String,
    pub(crate) provider_id: Option<String>,
    adapter: String,
    install_path: String,
    catalog_managed: bool,
    streaming_mode: String,
    variants: Vec<PluginVariantDescriptor>,
    selected_variant_id: Option<String>,
    default_variant_id: Option<String>,
    installable: bool,
    inputs: Vec<PluginPortManifest>,
    outputs: Vec<PluginPortManifest>,
    parameter_schema: Vec<PluginParameterManifest>,
    recommended_dependencies: Vec<PluginDependencyManifest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginVariantDescriptor {
    id: String,
    name: String,
    precision: String,
    size: String,
}

#[derive(Clone)]
pub(crate) struct PluginProvider {
    pub provider_id: String,
    pub name: String,
    pub runtime: String,
    pub adapter: String,
    pub capabilities: Vec<String>,
    pub model_id: String,
    pub model_name: String,
    pub model_path: Option<PathBuf>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallRequest {
    pub path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginInstallProgress {
    stage: &'static str,
    progress: u8,
    detail: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSourceUpdate {
    url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiModelCatalogEntry {
    id: String,
    name: String,
    author: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    capabilities: Vec<String>,
    harness_capability: String,
    provider_id: String,
    adapter: String,
    model_id: String,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default = "default_batch_streaming_mode")]
    streaming_mode: String,
    #[serde(default)]
    featured: bool,
    #[serde(default = "default_true")]
    visible: bool,
}

fn default_batch_streaming_mode() -> String {
    "batch".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCatalogEnvelope {
    schema_version: u32,
    #[serde(default)]
    plugins: Vec<serde_json::Value>,
    #[serde(default)]
    api_models: Vec<ApiModelCatalogEntry>,
}

#[derive(Default, Deserialize, Serialize)]
struct PluginState {
    #[serde(default)]
    sidebar_hidden: HashSet<String>,
    #[serde(default)]
    dependency_bindings: DependencyBindings,
}

pub type DependencyBindings = BTreeMap<String, BTreeMap<String, String>>;

const DEPRECATED_PLUGIN_IDS: &[&str] = &[
    "sensevoice-small",
    "org.qwenaudio.toolkits.sensevoice-small",
];

fn is_deprecated_plugin_id(plugin_id: &str) -> bool {
    DEPRECATED_PLUGIN_IDS.contains(&plugin_id)
}

fn sanitize_plugin_state(state: &mut PluginState) -> bool {
    let previous_sidebar_hidden = state.sidebar_hidden.len();
    state
        .sidebar_hidden
        .retain(|plugin_id| !is_deprecated_plugin_id(plugin_id));
    let mut changed = state.sidebar_hidden.len() != previous_sidebar_hidden;

    state.dependency_bindings.retain(|plugin_id, roles| {
        if is_deprecated_plugin_id(plugin_id) {
            changed = true;
            return false;
        }
        let previous_roles = roles.len();
        roles.retain(|_, dependency_id| !is_deprecated_plugin_id(dependency_id));
        changed |= roles.len() != previous_roles;
        if roles.is_empty() {
            changed = true;
            return false;
        }
        true
    });
    changed
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRemoval {
    pub plugin_id: String,
    pub deleted: bool,
    pub retained: bool,
    pub referenced_by: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRemovalResponse {
    pub plugins: Vec<PluginDescriptor>,
    pub removal: PluginRemoval,
}

#[tauri::command]
pub fn plugin_catalog(app: AppHandle) -> Result<Vec<PluginDescriptor>, String> {
    catalog(&app)
}

#[tauri::command]
pub fn plugin_api_catalog(app: AppHandle) -> Result<Vec<ApiModelCatalogEntry>, String> {
    cached_api_models(&app)
}

fn cached_api_models(app: &AppHandle) -> Result<Vec<ApiModelCatalogEntry>, String> {
    if catalog_source_url(app)?.is_none() {
        return Ok(Vec::new());
    }
    let Some(bytes) = read_verified_catalog_cache(app)? else {
        return Ok(Vec::new());
    };
    Ok(parse_remote_catalog(&bytes)?.api_models)
}

pub(crate) fn api_model_route(
    app: &AppHandle,
    provider_id: &str,
    capability: &str,
    model_id: &str,
) -> Result<Option<(String, String)>, String> {
    Ok(cached_api_models(app)?
        .into_iter()
        .find(|model| api_model_matches(model, provider_id, capability, model_id))
        .map(|model| {
            let adapter = match model.adapter.as_str() {
                "bailian-tts" | "bailian-asr" | "bailian-qwen-audio-asr" => "bailian".to_string(),
                adapter => adapter.to_string(),
            };
            (model.model_id, adapter)
        }))
}

fn api_model_matches(
    model: &ApiModelCatalogEntry,
    provider_id: &str,
    capability: &str,
    model_id: &str,
) -> bool {
    model.visible
        && model.provider_id == provider_id
        && model.harness_capability == capability
        && (model.model_id == model_id || model.aliases.iter().any(|alias| alias == model_id))
}

#[tauri::command]
pub fn plugin_dependency_bindings(app: AppHandle) -> Result<DependencyBindings, String> {
    Ok(read_state(&app)?.dependency_bindings)
}

#[tauri::command]
pub fn plugin_replace_dependency_bindings(
    app: AppHandle,
    bindings: DependencyBindings,
) -> Result<DependencyBindings, String> {
    validate_dependency_bindings(&bindings)?;
    let mut state = read_state(&app)?;
    state.dependency_bindings = bindings;
    sanitize_plugin_state(&mut state);
    write_state(&app, &state)?;
    Ok(state.dependency_bindings)
}

#[tauri::command]
pub fn plugin_set_dependency_binding(
    app: AppHandle,
    plugin_id: String,
    role: String,
    dependency_id: String,
) -> Result<DependencyBindings, String> {
    validate_binding_key(&plugin_id, "模型 ID")?;
    validate_binding_key(&role, "依赖角色")?;
    if !dependency_id.is_empty() {
        validate_binding_key(&dependency_id, "依赖模型 ID")?;
    }
    if is_deprecated_plugin_id(&plugin_id) || is_deprecated_plugin_id(&dependency_id) {
        return Err("该模型已下架，请刷新模型目录".to_string());
    }
    let mut state = read_state(&app)?;
    state
        .dependency_bindings
        .entry(plugin_id)
        .or_default()
        .insert(role, dependency_id);
    write_state(&app, &state)?;
    Ok(state.dependency_bindings)
}

#[tauri::command]
pub async fn plugin_refresh_catalog(app: AppHandle) -> Result<Vec<PluginDescriptor>, String> {
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || refresh_remote_catalog(&task_app))
        .await
        .map_err(|error| format!("模型目录刷新任务异常结束: {error}"))??;
    catalog(&app)
}

#[tauri::command]
pub async fn plugin_set_catalog_source(
    app: AppHandle,
    update: CatalogSourceUpdate,
) -> Result<Vec<PluginDescriptor>, String> {
    write_catalog_source(&app, update.url.as_deref())?;
    plugin_refresh_catalog(app).await
}

#[tauri::command]
pub async fn plugin_install_package(
    app: AppHandle,
    request: PluginInstallRequest,
) -> Result<PluginDescriptor, String> {
    install_from_path(app, request.path).await
}

#[tauri::command]
pub async fn plugin_install_catalog(
    app: AppHandle,
    plugin_id: String,
    variant_id: Option<String>,
) -> Result<PluginDescriptor, String> {
    begin_download_task()?;
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_catalog_model_blocking(&task_app, &plugin_id, variant_id.as_deref())
    })
    .await
    .map_err(|error| format!("目录模型安装任务异常结束: {error}"))?
}

fn install_catalog_model_blocking(
    app: &AppHandle,
    plugin_id: &str,
    variant_id: Option<&str>,
) -> Result<PluginDescriptor, String> {
    let mut value = catalog_manifest_value(app, plugin_id)?
        .ok_or_else(|| format!("模型商店中不存在 {plugin_id}"))?;
    let models = value
        .get_mut("models")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "模型清单没有可安装版本".to_string())?;
    let selected_index = select_variant_index(models, variant_id)?;
    let selected = models
        .get(selected_index)
        .cloned()
        .ok_or_else(|| "找不到所选模型版本".to_string())?;
    *models = vec![selected];
    let directory = plugins_directory(app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建插件目录: {error}"))?;
    let temp = directory.join(format!(".catalog-{}.json", timestamp_millis()));
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&value)
            .map_err(|error| format!("无法序列化模型清单: {error}"))?,
    )
    .map_err(|error| format!("无法准备模型清单: {error}"))?;
    let backup = match backup_incomplete_catalog_install(app, plugin_id) {
        Ok(backup) => backup,
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    };
    let result = install_from_path_blocking(app, &temp, true);
    let _ = fs::remove_file(&temp);
    match result {
        Ok(descriptor) => {
            if let Some(backup) = backup {
                let _ = fs::remove_dir_all(backup);
            }
            Ok(descriptor)
        }
        Err(error) => {
            if let Some(backup) = backup {
                let destination = plugins_directory(app)?.join(plugin_id);
                if destination.exists() {
                    let _ = fs::remove_dir_all(&destination);
                }
                let _ = fs::rename(backup, destination);
            }
            Err(error)
        }
    }
}

fn backup_incomplete_catalog_install(
    app: &AppHandle,
    plugin_id: &str,
) -> Result<Option<PathBuf>, String> {
    let destination = plugins_directory(app)?.join(plugin_id);
    if !destination.is_dir() {
        return Ok(None);
    }
    let manifest_path = destination.join("plugin.json");
    let complete = read_manifest(&manifest_path)
        .and_then(|manifest| validate_manifest(&destination, &manifest))
        .is_ok();
    if complete {
        return Ok(None);
    }
    let backup =
        plugins_directory(app)?.join(format!(".repair-{plugin_id}-{}", timestamp_millis()));
    fs::rename(&destination, &backup)
        .map_err(|error| format!("无法备份不完整的模型安装: {error}"))?;
    Ok(Some(backup))
}

#[tauri::command]
pub async fn plugin_install_recommended_dependency(
    app: AppHandle,
    dependency_id: String,
) -> Result<Vec<PluginDescriptor>, String> {
    begin_download_task()?;
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_recommended_dependency(&task_app, &dependency_id)
    })
    .await
    .map_err(|error| format!("依赖模型安装任务异常结束: {error}"))??;
    catalog(&app)
}

#[tauri::command]
pub fn plugin_set_download_paused(paused: bool) -> Result<(), String> {
    set_download_paused(paused)
}

#[tauri::command]
pub fn plugin_cancel_download() -> Result<(), String> {
    cancel_download()
}

fn install_recommended_dependency(app: &AppHandle, dependency_id: &str) -> Result<(), String> {
    if catalog_manifest_value(app, dependency_id)?.is_some() && !builtin_plugin_id(dependency_id) {
        let installed = catalog(app)?
            .into_iter()
            .find(|plugin| plugin.id == dependency_id)
            .is_some_and(|plugin| plugin.installed);
        if !installed {
            install_catalog_model_blocking(app, dependency_id, None)?;
        }
        let mut state = read_state(app)?;
        state.sidebar_hidden.insert(dependency_id.to_string());
        write_state(app, &state)?;
        emit_install(app, "complete", 100, "依赖模型已安装");
        return Ok(());
    }
    let models = models_directory(app)?;
    match dependency_id {
        "silero-vad" => {
            let destination = models.join("silero-vad").join("silero_vad.onnx");
            if !destination.is_file() {
                emit_install(app, "downloading", 24, "正在安装 Silero VAD");
                let cached = download_cached(
                    app,
                    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
                    "",
                    DownloadProgressRange { base: 24, span: 66 },
                    "正在下载 Silero VAD",
                )?;
                fs::create_dir_all(
                    destination
                        .parent()
                        .ok_or_else(|| "Silero VAD 模型目录无效".to_string())?,
                )
                .map_err(|error| format!("无法创建 Silero VAD 模型目录: {error}"))?;
                fs::copy(&cached, &destination)
                    .map_err(|error| format!("无法安装 Silero VAD: {error}"))?;
                let _ = fs::remove_file(cached);
            }
        }
        _ => return Err(format!("不支持的推荐依赖: {dependency_id}")),
    }
    let mut state = read_state(app)?;
    state.sidebar_hidden.insert(dependency_id.to_string());
    write_state(app, &state)?;
    emit_install(app, "complete", 100, "依赖模型已安装");
    Ok(())
}

#[tauri::command]
pub fn plugin_set_sidebar_visible(
    app: AppHandle,
    plugin_id: String,
    visible: bool,
) -> Result<Vec<PluginDescriptor>, String> {
    set_sidebar_visible(&app, &plugin_id, visible)?;
    catalog(&app)
}

#[tauri::command]
pub fn plugin_uninstall(
    app: AppHandle,
    plugin_id: String,
) -> Result<PluginRemovalResponse, String> {
    let removal = uninstall(&app, &plugin_id)?;
    Ok(PluginRemovalResponse {
        plugins: catalog(&app)?,
        removal,
    })
}

#[tauri::command]
pub fn plugin_readme(app: AppHandle, plugin_id: String) -> Result<Option<String>, String> {
    if plugin_id.is_empty()
        || plugin_id.contains("..")
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
    {
        return Ok(None);
    }
    let directory = plugins_directory(&app)?.join(&plugin_id);
    for name in [
        "README.md",
        "readme.md",
        "Readme.md",
        "README.markdown",
        "readme.markdown",
    ] {
        let path = directory.join(name);
        if path.is_file() {
            return fs::read_to_string(&path)
                .map(Some)
                .map_err(|error| format!("无法读取 README: {error}"));
        }
    }
    Ok(None)
}

#[derive(serde::Serialize)]
pub struct PluginFileEntry {
    pub path: String,
    pub size: u64,
}

#[tauri::command]
pub fn plugin_files(app: AppHandle, plugin_id: String) -> Result<Vec<PluginFileEntry>, String> {
    if plugin_id.is_empty()
        || plugin_id.contains("..")
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
    {
        return Ok(Vec::new());
    }
    let directory = plugins_directory(&app)?.join(&plugin_id);
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let mut stack = vec![directory.clone()];
    while let Some(current) = stack.pop() {
        let read = fs::read_dir(&current).map_err(|error| format!("无法读取模型目录: {error}"))?;
        for entry in read {
            let entry = entry.map_err(|error| format!("无法读取模型目录: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("无法读取模型目录: {error}"))?;
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(&directory)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            entries.push(PluginFileEntry {
                path: relative,
                size,
            });
            if entries.len() >= 2000 {
                break;
            }
        }
        if entries.len() >= 2000 {
            break;
        }
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

pub(crate) fn catalog(app: &AppHandle) -> Result<Vec<PluginDescriptor>, String> {
    let state = read_state(app)?;
    let mut plugins = builtin_plugins(app, &state)?;
    plugins.extend(installed_manifests(app, &state)?);
    for value in catalog_values(app)? {
        let manifest = parse_manifest_value(value.clone())?;
        let catalog_entry = catalog_descriptor(manifest, &value);
        if let Some(installed) = plugins
            .iter_mut()
            .find(|plugin| plugin.id == catalog_entry.id)
        {
            installed.name = catalog_entry.name;
            installed.author = catalog_entry.author;
            installed.description = catalog_entry.description;
            installed.license = catalog_entry.license;
            installed.capabilities = catalog_entry.capabilities;
            installed.acceleration = catalog_entry.acceleration;
            installed.version = catalog_entry.version;
            installed.featured = catalog_entry.featured;
            installed.tone = catalog_entry.tone;
            installed.catalog_managed = true;
            installed.streaming_mode = catalog_entry.streaming_mode;
            installed.variants = catalog_entry.variants;
            installed.default_variant_id = catalog_entry.default_variant_id;
            installed.inputs = catalog_entry.inputs;
            installed.outputs = catalog_entry.outputs;
            installed.parameter_schema = catalog_entry.parameter_schema;
            installed.recommended_dependencies = catalog_entry.recommended_dependencies;
        } else {
            plugins.push(catalog_entry);
        }
    }
    for plugin in &mut plugins {
        if plugin.recommended_dependencies.is_empty() {
            plugin.recommended_dependencies = inferred_dependencies(
                &plugin.harness_capabilities,
                &plugin.adapter,
                &plugin.inputs,
            );
        }
    }
    plugins.sort_by(|left, right| {
        right
            .featured
            .cmp(&left.featured)
            .then_with(|| right.installed.cmp(&left.installed))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(plugins)
}

pub(crate) fn installed_providers(app: &AppHandle) -> Result<Vec<PluginProvider>, String> {
    let mut providers = Vec::new();
    for (root, manifest) in read_installed_manifests(app)? {
        if validate_manifest(&root, &manifest).is_err() {
            continue;
        }
        let model_path = manifest
            .model
            .as_ref()
            .map(|model| safe_join(&root, &model.path))
            .transpose()?;
        let (model_id, model_name) = manifest
            .model
            .as_ref()
            .map(|model| (model.id.clone(), model.name.clone()))
            .unwrap_or_else(|| (manifest.adapter.clone(), manifest.name.clone()));
        providers.push(PluginProvider {
            provider_id: format!("plugin.{}", manifest.id),
            name: manifest.name,
            runtime: manifest.runtime,
            adapter: manifest.adapter,
            capabilities: manifest.capabilities,
            model_id,
            model_name,
            model_path,
        });
    }
    Ok(providers)
}

pub(crate) fn provider_by_id(
    app: &AppHandle,
    provider_id: &str,
) -> Result<Option<PluginProvider>, String> {
    Ok(installed_providers(app)?
        .into_iter()
        .find(|provider| provider.provider_id == provider_id))
}

pub(crate) fn is_plugin_installed(app: &AppHandle, plugin_id: &str) -> Result<bool, String> {
    Ok(catalog(app)?
        .into_iter()
        .find(|plugin| plugin.id == plugin_id)
        .is_some_and(|plugin| plugin.installed))
}

pub(crate) async fn install_from_path(
    app: AppHandle,
    source_path: String,
) -> Result<PluginDescriptor, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_from_path_blocking(&worker_app, Path::new(&source_path), false)
    })
    .await
    .map_err(|error| format!("插件安装线程异常结束: {error}"))?
}

fn set_sidebar_visible(app: &AppHandle, plugin_id: &str, visible: bool) -> Result<(), String> {
    validate_plugin_id(plugin_id)?;
    let plugin = catalog(app)?
        .into_iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| format!("找不到插件 {plugin_id}"))?;
    if !plugin.installed {
        return Err("模型文件尚未安装".to_string());
    }
    let mut state = read_state(app)?;
    if visible {
        state.sidebar_hidden.remove(plugin_id);
    } else {
        state.sidebar_hidden.insert(plugin_id.to_string());
    }
    write_state(app, &state)
}

fn dependency_references(app: &AppHandle, dependency_id: &str) -> Result<Vec<String>, String> {
    let state = read_state(app)?;
    let plugins = catalog(app)?;
    let installed_ids = plugins
        .iter()
        .filter(|plugin| plugin.installed)
        .map(|plugin| plugin.id.as_str())
        .collect::<HashSet<_>>();
    let mut references = Vec::new();

    for plugin in plugins.iter().filter(|plugin| plugin.installed) {
        for dependency in &plugin.recommended_dependencies {
            let selected = state
                .dependency_bindings
                .get(&plugin.id)
                .and_then(|roles| roles.get(&dependency.role))
                .map(String::as_str)
                .unwrap_or_else(|| {
                    if dependency.default {
                        dependency.plugin_id.as_str()
                    } else {
                        ""
                    }
                });
            if selected == dependency_id {
                references.push(plugin.name.clone());
                break;
            }
        }
    }

    for (plugin_id, roles) in &state.dependency_bindings {
        if installed_ids.contains(plugin_id.as_str()) || plugin_id == dependency_id {
            continue;
        }
        if roles.values().any(|selected| selected == dependency_id) {
            references.push(plugin_id.clone());
        }
    }
    references.sort();
    references.dedup();
    Ok(references)
}

fn validate_binding_key(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':' | '/')
        })
    {
        return Err(format!("{label} 格式无效"));
    }
    Ok(())
}

fn validate_dependency_bindings(bindings: &DependencyBindings) -> Result<(), String> {
    if bindings.len() > 2_000 {
        return Err("模型依赖绑定数量过多".to_string());
    }
    for (plugin_id, roles) in bindings {
        validate_binding_key(plugin_id, "模型 ID")?;
        if roles.len() > 32 {
            return Err(format!("模型 {plugin_id} 的依赖绑定数量过多"));
        }
        for (role, dependency_id) in roles {
            validate_binding_key(role, "依赖角色")?;
            if !dependency_id.is_empty() {
                validate_binding_key(dependency_id, "依赖模型 ID")?;
            }
        }
    }
    Ok(())
}

pub(crate) fn uninstall(app: &AppHandle, plugin_id: &str) -> Result<PluginRemoval, String> {
    validate_plugin_id(plugin_id)?;
    let referenced_by = dependency_references(app, plugin_id)?;
    if !referenced_by.is_empty() {
        let mut state = read_state(app)?;
        state.sidebar_hidden.insert(plugin_id.to_string());
        write_state(app, &state)?;
        return Ok(PluginRemoval {
            plugin_id: plugin_id.to_string(),
            deleted: false,
            retained: true,
            referenced_by,
        });
    }
    if builtin_plugin_id(plugin_id) {
        if plugin_id == "web-audio-stream" {
            return Err("Web Audio 是应用运行时，不能移除".to_string());
        }
        let plugin = catalog(app)?
            .into_iter()
            .find(|plugin| plugin.id == plugin_id)
            .ok_or_else(|| format!("找不到模型 {plugin_id}"))?;
        let target = PathBuf::from(plugin.install_path);
        let models = models_directory(app)?;
        if !target.starts_with(&models) {
            return Err("模型使用了外部路径，请手动管理该目录".to_string());
        }
        if target.is_dir() {
            fs::remove_dir_all(&target).map_err(|error| format!("无法移除模型: {error}"))?;
        } else if target.is_file() {
            fs::remove_file(&target).map_err(|error| format!("无法移除模型: {error}"))?;
        }
        let mut state = read_state(app)?;
        state.sidebar_hidden.remove(plugin_id);
        state.dependency_bindings.remove(plugin_id);
        write_state(app, &state)?;
        return Ok(PluginRemoval {
            plugin_id: plugin_id.to_string(),
            deleted: true,
            retained: false,
            referenced_by: Vec::new(),
        });
    }
    let target = plugins_directory(app)?.join(plugin_id);
    if !target.is_dir() {
        return Err(format!("找不到已安装插件 {plugin_id}"));
    }
    fs::remove_dir_all(&target).map_err(|error| format!("无法卸载插件: {error}"))?;
    let mut state = read_state(app)?;
    state.sidebar_hidden.remove(plugin_id);
    state.dependency_bindings.remove(plugin_id);
    write_state(app, &state)?;
    Ok(PluginRemoval {
        plugin_id: plugin_id.to_string(),
        deleted: true,
        retained: false,
        referenced_by: Vec::new(),
    })
}

fn install_from_path_blocking(
    app: &AppHandle,
    source: &Path,
    prefer_modelscope: bool,
) -> Result<PluginDescriptor, String> {
    let _install_guard = PLUGIN_INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "插件安装锁已损坏，请重启应用后重试".to_string())?;
    emit_install(app, "validating", 4, "正在检查插件包");
    if !source.exists() {
        return Err("选择的插件包不存在".to_string());
    }

    let plugins_dir = plugins_directory(app)?;
    fs::create_dir_all(&plugins_dir).map_err(|error| format!("无法创建插件目录: {error}"))?;
    let staging = plugins_dir.join(format!(".install-{}", timestamp_millis()));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|error| format!("无法清理安装暂存目录: {error}"))?;
    }
    fs::create_dir_all(&staging).map_err(|error| format!("无法创建安装暂存目录: {error}"))?;

    let result = (|| {
        if source.is_dir() {
            emit_install(app, "copying", 18, "正在复制插件目录");
            copy_directory(source, &staging)?;
        } else {
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if extension.eq_ignore_ascii_case("json") {
                emit_install(app, "copying", 12, "正在读取模型清单");
                fs::copy(source, staging.join("plugin.json"))
                    .map_err(|error| format!("无法复制模型清单: {error}"))?;
            } else if matches!(extension.to_ascii_lowercase().as_str(), "cspkg" | "zip") {
                emit_install(app, "extracting", 18, "正在安全解压 .cspkg");
                extract_archive(source, &staging)?;
            } else {
                return Err("插件必须是 plugin.json、.cspkg 文件或插件目录".to_string());
            }
        }

        let manifest_path = find_single_manifest(&staging)?;
        let package_root = manifest_path
            .parent()
            .ok_or_else(|| "plugin.json 缺少父目录".to_string())?;
        let manifest = read_manifest(&manifest_path)?;
        install_remote_model(app, package_root, &manifest, prefer_modelscope)?;
        validate_manifest(package_root, &manifest)?;
        if builtin_plugin_id(&manifest.id) {
            return Err("插件 ID 与内置适配器冲突，请使用独立 ID".to_string());
        }

        let destination = plugins_dir.join(&manifest.id);
        if destination.exists() {
            return Err(format!("{} 已安装，请先卸载旧版本", manifest.name));
        }

        emit_install(
            app,
            "installing",
            FINAL_INSTALL_PROGRESS,
            "正在写入本地插件目录",
        );
        if package_root == staging {
            fs::rename(&staging, &destination)
                .map_err(|error| format!("无法完成插件安装: {error}"))?;
        } else {
            fs::rename(package_root, &destination)
                .map_err(|error| format!("无法完成插件安装: {error}"))?;
            fs::remove_dir_all(&staging)
                .map_err(|error| format!("无法清理安装暂存目录: {error}"))?;
        }

        let mut state = read_state(app)?;
        state.sidebar_hidden.remove(&manifest.id);
        write_state(app, &state)?;
        emit_install(app, "complete", 100, "插件已安装并注册到 Harness");
        descriptor_from_manifest(&destination, manifest, true, &state)
    })();

    if result.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn builtin_plugins(app: &AppHandle, state: &PluginState) -> Result<Vec<PluginDescriptor>, String> {
    let vad = crate::vad::ensure_model_install(app)?;

    let mut plugins = vec![builtin_descriptor(
        "silero-vad",
        "Silero VAD",
        "Silero",
        "独立检测语音区域、停顿和静音，并输出可定位、播放的时间片段。",
        vec!["VAD", "时间片段"],
        vec![CAPABILITY_VAD],
        "sherpa-onnx",
        "silero-vad",
        "5.1.2",
        "644 KB",
        vad.is_file(),
        true,
        "yellow",
        &vad,
        state,
    )];
    for plugin in &mut plugins {
        plugin.enabled = plugin.installed;
    }
    Ok(plugins)
}

#[allow(clippy::too_many_arguments)]
fn builtin_descriptor(
    id: &str,
    name: &str,
    author: &str,
    description: &str,
    capabilities: Vec<&str>,
    harness_capabilities: Vec<&str>,
    runtime: &str,
    adapter: &str,
    version: &str,
    size: &str,
    installed: bool,
    featured: bool,
    tone: &str,
    path: &Path,
    state: &PluginState,
) -> PluginDescriptor {
    PluginDescriptor {
        id: id.to_string(),
        name: name.to_string(),
        author: author.to_string(),
        engine_author: runtime_author_for_entry(runtime),
        description: description.to_string(),
        license: String::new(),
        capabilities: capabilities.into_iter().map(str::to_string).collect(),
        harness_capabilities: harness_capabilities
            .into_iter()
            .map(str::to_string)
            .collect(),
        runtime: runtime.to_string(),
        acceleration: vec!["CPU".to_string()],
        version: version.to_string(),
        size: size.to_string(),
        installed,
        enabled: installed,
        sidebar_visible: !state.sidebar_hidden.contains(id),
        builtin: true,
        featured,
        tone: tone.to_string(),
        provider_id: match adapter {
            "silero-vad" => Some("local.silero-vad".to_string()),
            "web-audio" => Some("local.web-audio".to_string()),
            _ => None,
        },
        adapter: adapter.to_string(),
        install_path: path.to_string_lossy().into_owned(),
        catalog_managed: false,
        streaming_mode: adapter_streaming_mode(adapter).to_string(),
        variants: Vec::new(),
        selected_variant_id: None,
        default_variant_id: None,
        installable: true,
        inputs: Vec::new(),
        outputs: Vec::new(),
        parameter_schema: Vec::new(),
        recommended_dependencies: Vec::new(),
    }
}

fn installed_manifests(
    app: &AppHandle,
    state: &PluginState,
) -> Result<Vec<PluginDescriptor>, String> {
    let mut descriptors = Vec::new();
    for (root, manifest) in read_installed_manifests(app)? {
        let installed = validate_manifest(&root, &manifest).is_ok();
        descriptors.push(descriptor_from_manifest(&root, manifest, installed, state)?);
    }
    Ok(descriptors)
}

fn descriptor_from_manifest(
    root: &Path,
    manifest: PluginManifest,
    installed: bool,
    state: &PluginState,
) -> Result<PluginDescriptor, String> {
    let size = if manifest.size_label.trim().is_empty() {
        format_size(directory_size(root)?)
    } else {
        manifest.size_label.clone()
    };
    let mut capabilities = if manifest.display_capabilities.is_empty() {
        manifest
            .capabilities
            .iter()
            .map(|capability| capability_label(capability).to_string())
            .collect()
    } else {
        manifest.display_capabilities.clone()
    };
    if matches!(
        manifest.adapter.as_str(),
        "streaming-zipformer" | "streaming-paraformer"
    ) && !capabilities.iter().any(|item| item == "时间戳")
    {
        capabilities.push("时间戳".to_string());
    }
    Ok(PluginDescriptor {
        id: manifest.id.clone(),
        name: manifest.name,
        author: manifest.author,
        engine_author: if manifest.engine_author.trim().is_empty() {
            runtime_author_for_entry(&manifest.runtime)
        } else {
            manifest.engine_author
        },
        description: manifest.description,
        license: manifest.license,
        capabilities,
        harness_capabilities: manifest.capabilities,
        runtime: manifest.runtime,
        acceleration: if manifest.acceleration.is_empty() {
            vec!["CPU".to_string()]
        } else {
            manifest.acceleration
        },
        version: manifest.version,
        size,
        installed,
        enabled: installed,
        sidebar_visible: !state.sidebar_hidden.contains(&manifest.id),
        builtin: false,
        featured: manifest.featured,
        tone: valid_tone(&manifest.tone).to_string(),
        provider_id: Some(format!("plugin.{}", manifest.id)),
        adapter: manifest.adapter.clone(),
        install_path: root.to_string_lossy().into_owned(),
        catalog_managed: false,
        streaming_mode: adapter_streaming_mode(&manifest.adapter).to_string(),
        selected_variant_id: manifest.model.as_ref().map(|model| model.id.clone()),
        variants: Vec::new(),
        default_variant_id: None,
        installable: true,
        inputs: manifest.inputs,
        outputs: manifest.outputs,
        parameter_schema: manifest.parameter_schema,
        recommended_dependencies: manifest.recommended_dependencies,
    })
}

fn read_installed_manifests(app: &AppHandle) -> Result<Vec<(PathBuf, PluginManifest)>, String> {
    let directory = plugins_directory(app)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取插件目录: {error}")),
    };
    let mut manifests = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取插件目录项: {error}"))?;
        let root = entry.path();
        if !root.is_dir() || entry.file_name().to_string_lossy().starts_with(".install-") {
            continue;
        }
        let path = root.join("plugin.json");
        match read_manifest(&path) {
            Ok(manifest) => manifests.push((root, manifest)),
            Err(error) => log::warn!("ignoring invalid plugin at {}: {error}", path.display()),
        }
    }
    Ok(manifests)
}

fn read_manifest(path: &Path) -> Result<PluginManifest, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取 plugin.json: {error}"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("plugin.json 格式无效: {error}"))?;
    parse_manifest_value(value)
}

fn parse_manifest_value(value: serde_json::Value) -> Result<PluginManifest, String> {
    let schema_version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default() as u32;
    if schema_version == PLUGIN_SCHEMA_VERSION {
        let manifest: V2PluginManifest = serde_json::from_value(value)
            .map_err(|error| format!("plugin.json v2 格式无效: {error}"))?;
        normalize_v2_manifest(manifest)
    } else if schema_version == 1 {
        serde_json::from_value(value).map_err(|error| format!("旧版 plugin.json 格式无效: {error}"))
    } else {
        Err(format!("不支持 plugin.json schemaVersion {schema_version}"))
    }
}

fn catalog_descriptor(manifest: PluginManifest, value: &serde_json::Value) -> PluginDescriptor {
    let variants = value
        .get("models")
        .and_then(serde_json::Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(variant_descriptor)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let default_variant_id = default_variant_index(&variants)
        .and_then(|index| variants.get(index))
        .map(|variant| variant.id.clone());
    let size = default_variant_id
        .as_ref()
        .and_then(|id| variants.iter().find(|variant| &variant.id == id))
        .map(|variant| variant.size.clone())
        .unwrap_or_else(|| "按需下载".to_string());
    let mut capabilities = if manifest.display_capabilities.is_empty() {
        manifest
            .capabilities
            .iter()
            .map(|capability| capability_label(capability).to_string())
            .collect()
    } else {
        manifest.display_capabilities.clone()
    };
    if matches!(
        manifest.adapter.as_str(),
        "streaming-zipformer" | "streaming-paraformer"
    ) && !capabilities.iter().any(|item| item == "时间戳")
    {
        capabilities.push("时间戳".to_string());
    }
    PluginDescriptor {
        id: manifest.id.clone(),
        name: manifest.name,
        author: manifest.author,
        engine_author: if manifest.engine_author.trim().is_empty() {
            runtime_author_for_entry(&manifest.runtime)
        } else {
            manifest.engine_author
        },
        description: manifest.description,
        license: manifest.license,
        capabilities,
        harness_capabilities: manifest.capabilities,
        runtime: manifest.runtime,
        acceleration: manifest.acceleration,
        version: manifest.version,
        size,
        installed: false,
        enabled: false,
        sidebar_visible: true,
        builtin: false,
        featured: manifest.featured,
        tone: valid_tone(&manifest.tone).to_string(),
        provider_id: Some(format!("plugin.{}", manifest.id)),
        adapter: manifest.adapter.clone(),
        install_path: format!("catalog://{}", manifest.id),
        catalog_managed: true,
        streaming_mode: adapter_streaming_mode(&manifest.adapter).to_string(),
        variants,
        selected_variant_id: None,
        default_variant_id,
        installable: adapter_spec(&manifest.adapter).is_some(),
        inputs: manifest.inputs,
        outputs: manifest.outputs,
        parameter_schema: manifest.parameter_schema,
        recommended_dependencies: manifest.recommended_dependencies,
    }
}

fn variant_descriptor(value: &serde_json::Value) -> Option<PluginVariantDescriptor> {
    let id = value.get("id")?.as_str()?.to_string();
    let name = value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let precision = value
        .get("precision")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("FP32")
        .to_string();
    let size = value
        .get("estimatedSizeMb")
        .and_then(serde_json::Value::as_u64)
        .map(|size| format!("{size} MB"))
        .unwrap_or_else(|| "按需下载".to_string());
    Some(PluginVariantDescriptor {
        id,
        name,
        precision,
        size,
    })
}

fn default_variant_index(variants: &[PluginVariantDescriptor]) -> Option<usize> {
    variants
        .iter()
        .position(|variant| {
            variant.precision.eq_ignore_ascii_case("int8")
                || variant.precision.eq_ignore_ascii_case("q8")
                || variant.precision.eq_ignore_ascii_case("q8_0")
        })
        .or_else(|| (!variants.is_empty()).then_some(0))
}

fn select_variant_index(
    variants: &[serde_json::Value],
    requested: Option<&str>,
) -> Result<usize, String> {
    if let Some(requested) = requested {
        return variants
            .iter()
            .position(|variant| {
                variant.get("id").and_then(serde_json::Value::as_str) == Some(requested)
            })
            .ok_or_else(|| format!("找不到模型版本 {requested}"));
    }
    Ok(variants
        .iter()
        .position(|variant| {
            variant
                .get("precision")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|precision| {
                    precision.eq_ignore_ascii_case("int8")
                        || precision.eq_ignore_ascii_case("q8")
                        || precision.eq_ignore_ascii_case("q8_0")
                })
        })
        .unwrap_or(0))
}

fn validate_manifest(root: &Path, manifest: &PluginManifest) -> Result<(), String> {
    if !matches!(manifest.schema_version, 1 | PLUGIN_SCHEMA_VERSION) {
        return Err(format!(
            "不支持 plugin.json schemaVersion {}",
            manifest.schema_version
        ));
    }
    validate_plugin_id(&manifest.id)?;
    if manifest.name.trim().is_empty()
        || manifest.version.trim().is_empty()
        || manifest.author.trim().is_empty()
    {
        return Err("plugin.json 缺少名称、版本或作者".to_string());
    }
    let adapter = adapter_spec(&manifest.adapter)
        .ok_or_else(|| format!("当前版本不支持 adapter {}", manifest.adapter))?;
    let expected_capability = adapter.capability;
    if !manifest
        .capabilities
        .iter()
        .any(|capability| capability == expected_capability)
    {
        return Err(format!(
            "adapter {} 必须声明能力 {expected_capability}",
            manifest.adapter
        ));
    }
    if manifest.capabilities.len() != 1
        || manifest.capabilities.iter().any(|capability| {
            capability != expected_capability || !supported_capability(capability)
        })
    {
        return Err(format!(
            "adapter {} 只能声明能力 {expected_capability}",
            manifest.adapter
        ));
    }
    validate_declared_contract(manifest)?;
    if let Some(model) = &manifest.model {
        let model_root = safe_join(root, &model.path)?;
        for relative in &model.files {
            require_path(&safe_join(&model_root, relative)?)?;
        }
        for asset in &model.assets {
            require_file(&safe_join(&model_root, &asset.path)?)?;
        }
    }

    match adapter.id {
        "kokoro" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("voices.bin"))?;
            require_file(&model.join("tokens.txt"))?;
            require_directory(&model.join("espeak-ng-data"))?;
            if !model.join("model.int8.onnx").is_file() && !model.join("model.onnx").is_file() {
                return Err("Kokoro 插件缺少 model.int8.onnx 或 model.onnx".to_string());
            }
        }
        "vits" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("model.onnx"))?;
            require_file(&model.join("lexicon.txt"))?;
            require_file(&model.join("tokens.txt"))?;
        }
        "matcha" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("model-steps-3.onnx"))?;
            require_file(&model.join("vocos-16khz-univ.onnx"))?;
            require_file(&model.join("tokens.txt"))?;
            require_file(&model.join("lexicon.txt"))?;
            require_directory(&model.join("espeak-ng-data"))?;
        }
        "kitten" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("model.int8.onnx"))?;
            require_file(&model.join("voices.bin"))?;
            require_file(&model.join("tokens.txt"))?;
            require_directory(&model.join("espeak-ng-data"))?;
        }
        "zipvoice" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("encoder.int8.onnx"))?;
            require_file(&model.join("decoder.int8.onnx"))?;
            require_file(&model.join("vocos_24khz.onnx"))?;
            require_file(&model.join("tokens.txt"))?;
            require_file(&model.join("lexicon.txt"))?;
            require_directory(&model.join("espeak-ng-data"))?;
        }
        "pocket-tts" => {
            let model = required_model(root, manifest)?;
            for file in [
                "lm_flow.int8.onnx",
                "lm_main.int8.onnx",
                "encoder.onnx",
                "decoder.int8.onnx",
                "text_conditioner.onnx",
                "vocab.json",
                "token_scores.json",
            ] {
                require_file(&model.join(file))?;
            }
        }
        "supertonic" => {
            let model = required_model(root, manifest)?;
            for file in [
                "duration_predictor.int8.onnx",
                "text_encoder.int8.onnx",
                "vector_estimator.int8.onnx",
                "vocoder.int8.onnx",
                "tts.json",
                "unicode_indexer.bin",
                "voice.bin",
            ] {
                require_file(&model.join(file))?;
            }
        }
        "cosyvoice-local" => {
            let model = required_model(root, manifest)?;
            require_file(&find_file_with_extension(&model, "gguf")?)?;
            require_file(
                &model
                    .join("frontend-onnx")
                    .join("speech_tokenizer_v3.int8.onnx"),
            )?;
            require_file(&model.join("frontend-onnx").join("campplus.int8.onnx"))?;
            require_file(&cosyvoice_runtime_executable(&model)?)?;
            require_directory(&cosyvoice_backend_directory(&model)?)?;
        }
        "funasr-nano" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("funasr-encoder-f16.gguf"))?;
            require_file(&find_file_name_prefix(&model, "qwen3-0.6b-")?)?;
            require_file(&model.join("fsmn-vad.gguf"))?;
            require_file(&funasr_runtime_executable(&model)?)?;
        }
        "funasr-sensevoice-gguf" => {
            let model = required_model(root, manifest)?;
            require_file(&find_file_with_extension(&model, "gguf")?)?;
            require_file(&model.join("fsmn-vad.gguf"))?;
            require_file(&funasr_runtime_binary(&model, "llama-funasr-sensevoice")?)?;
        }
        "funasr-paraformer-gguf" => {
            let model = required_model(root, manifest)?;
            require_file(&find_file_with_extension(&model, "gguf")?)?;
            require_file(&model.join("fsmn-vad.gguf"))?;
            require_file(&funasr_runtime_binary(&model, "llama-funasr-paraformer")?)?;
        }
        "funasr-fsmn-vad-gguf" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("fsmn-vad.gguf"))?;
            require_file(&funasr_runtime_binary(&model, "llama-funasr-vad")?)?;
        }
        "streaming-zipformer" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("tokens.txt"))?;
            require_file(&model.join("decoder.onnx"))?;
            if model.join("encoder.int8.onnx").is_file() {
                require_file(&model.join("joiner.int8.onnx"))?;
            } else {
                require_file(&model.join("encoder.onnx"))?;
                require_file(&model.join("joiner.onnx"))?;
            }
        }
        "streaming-paraformer" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("tokens.txt"))?;
            require_file(&model.join("encoder.int8.onnx"))?;
            require_file(&model.join("decoder.int8.onnx"))?;
        }
        "wenet-ctc" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("model.int8.onnx"))?;
            require_file(&model.join("tokens.txt"))?;
        }
        "fire-red-asr-ctc" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("model.int8.onnx"))?;
            require_file(&model.join("tokens.txt"))?;
        }
        "fire-red-asr" | "nemo-parakeet" | "nemo-canary" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("encoder.int8.onnx"))?;
            require_file(&model.join("decoder.int8.onnx"))?;
            require_file(&model.join("tokens.txt"))?;
            if manifest.adapter == "nemo-parakeet" {
                require_file(&model.join("joiner.int8.onnx"))?;
            }
        }
        "moonshine-v2" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("encoder_model.ort"))?;
            require_file(&model.join("decoder_model_merged.ort"))?;
            require_file(&model.join("tokens.txt"))?;
        }
        "qwen3-asr" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("conv_frontend.onnx"))?;
            require_file(&model.join("encoder.int8.onnx"))?;
            require_file(&model.join("decoder.int8.onnx"))?;
            require_directory(&model.join("tokenizer"))?;
        }
        "audio-tagging" => {
            let model = required_model(root, manifest)?;
            require_matching_file(&model, "ONNX 权重", &|path| {
                path.extension().and_then(|value| value.to_str()) == Some("onnx")
            })?;
            require_matching_file(&model, "标签文件", &|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| {
                        name.contains("label") && (name.ends_with(".csv") || name.ends_with(".txt"))
                    })
            })?;
        }
        "keyword-spotting" => {
            let model = required_model(root, manifest)?;
            for prefix in ["encoder", "decoder", "joiner"] {
                require_matching_file(&model, prefix, &|path| {
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .is_some_and(|name| name.starts_with(prefix) && name.ends_with(".onnx"))
                })?;
            }
            require_named_file(&model, "tokens.txt")?;
            require_named_file(&model, "keywords.txt")?;
            require_named_file(&model, "keywords_raw.txt")?;
        }
        "language-id" => {
            let model = required_model(root, manifest)?;
            for component in ["encoder", "decoder"] {
                require_matching_file(&model, component, &|path| {
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .is_some_and(|name| name.contains(component) && name.ends_with(".onnx"))
                })?;
            }
        }
        "punctuation" | "speaker-embedding" => {
            let model = required_model(root, manifest)?;
            require_matching_file(&model, "ONNX 权重", &|path| {
                path.extension().and_then(|value| value.to_str()) == Some("onnx")
            })?;
        }
        "speaker-diarization" => {
            let model = required_model(root, manifest)?;
            require_matching_file(&model, "说话人分段权重", &|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| {
                        name.ends_with(".onnx")
                            && !name.contains("speaker")
                            && !name.contains("campplus")
                    })
            })?;
            require_matching_file(&model, "声纹权重", &|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| {
                        name.ends_with(".onnx")
                            && (name.contains("speaker") || name.contains("campplus"))
                    })
            })?;
        }
        "source-separation" => {
            let model = required_model(root, manifest)?;
            for stem in ["vocals", "accompaniment"] {
                require_matching_file(&model, stem, &|path| {
                    path.file_name()
                        .and_then(|value| value.to_str())
                        .is_some_and(|name| name.contains(stem) && name.ends_with(".onnx"))
                })?;
            }
        }
        "zipenhancer" => {
            let model = required_model(root, manifest)?;
            crate::onnx_audio::validate_onnx_audio_model(&model, "zipenhancer.onnx")?;
        }
        "mossformer2-separation" => {
            let model = required_model(root, manifest)?;
            crate::onnx_audio::validate_onnx_audio_model(&model, "mossformer2.onnx")?;
        }
        "wetext" => {
            let model = required_model(root, manifest)?;
            for relative in WETEXT_REQUIRED_FILES {
                require_file(&model.join(relative))?;
            }
        }
        "silero-vad" => {
            let model = required_model(root, manifest)?;
            if model.is_dir() {
                require_file(&model.join("silero_vad.onnx"))?;
            } else {
                require_file(&model)?;
            }
        }
        "dpdfnet2" => {
            let model = required_model(root, manifest)?;
            require_file(&model)?;
        }
        "gtcrn" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("gtcrn_simple.onnx"))?;
        }
        "deepfilternet" => {
            let model = required_model(root, manifest)?;
            require_file(&model.join("DeepFilterNet3_onnx.tar.gz"))?;
            require_file(&deepfilter_runtime_executable(&model)?)?;
        }
        "rnnoise" => {}
        "web-audio" => {
            if manifest.model.is_some() {
                return Err("Web Audio 插件不应声明模型文件".to_string());
            }
        }
        adapter => {
            return Err(format!("暂不支持校验插件 adapter: {adapter}"));
        }
    }
    Ok(())
}

fn validate_declared_contract(manifest: &PluginManifest) -> Result<(), String> {
    let valid_port_type = |port_type: &str| {
        matches!(
            port_type,
            "audio"
                | "speech-segments"
                | "transcript"
                | "text"
                | "boolean"
                | "keyword-events"
                | "audio-tags"
                | "language"
                | "speaker-embedding"
                | "speaker-segments"
                | "audio-tracks"
        )
    };
    for port in manifest.inputs.iter().chain(&manifest.outputs) {
        if port.name.trim().is_empty() || !valid_port_type(&port.port_type) {
            return Err(format!(
                "插件端口 {} 使用了不支持的类型 {}",
                port.name, port.port_type
            ));
        }
        if port
            .modes
            .iter()
            .any(|mode| !matches!(mode.as_str(), "batch" | "stream"))
        {
            return Err(format!(
                "插件端口 {} 的 mode 只能是 batch 或 stream",
                port.name
            ));
        }
    }
    let mut parameter_names = std::collections::HashSet::new();
    for parameter in &manifest.parameter_schema {
        if parameter.name.trim().is_empty() || !parameter_names.insert(&parameter.name) {
            return Err("插件参数 name 不能为空或重复".to_string());
        }
        if !matches!(
            parameter.parameter_type.as_str(),
            "string" | "number" | "boolean" | "enum"
        ) {
            return Err(format!(
                "插件参数 {} 使用了不支持的类型 {}",
                parameter.name, parameter.parameter_type
            ));
        }
        if parameter.parameter_type == "enum" && parameter.options.is_empty() {
            return Err(format!("枚举参数 {} 必须声明 options", parameter.name));
        }
        if let (Some(min), Some(max)) = (parameter.min, parameter.max) {
            if min > max {
                return Err(format!("插件参数 {} 的 min 不能大于 max", parameter.name));
            }
        }
    }
    Ok(())
}

fn normalize_v2_manifest(manifest: V2PluginManifest) -> Result<PluginManifest, String> {
    let engine_author = runtime_author(&manifest.runtime);
    let model_author = canonical_model_author(&manifest.id, &manifest.publisher);
    let runtime_package = if manifest.runtime.package.is_empty() {
        runtime_package_for_entry(&manifest.runtime.entry).to_string()
    } else {
        manifest.runtime.package.clone()
    };
    if !matches!(manifest.runtime.kind.as_str(), "native" | "onnx") {
        return Err("Manifest v2 首版仅允许 native 或 onnx runtime".to_string());
    }
    let supported_native = matches!(
        (manifest.adapter.as_str(), manifest.runtime.entry.as_str()),
        ("deepfilternet", "deep-filter")
            | ("rnnoise", "nnnoiseless")
            | ("cosyvoice-local", "cosyvoice.cpp")
            | ("funasr-nano", "llama-funasr-cli")
            | ("funasr-sensevoice-gguf", "llama-funasr-sensevoice")
            | ("funasr-paraformer-gguf", "llama-funasr-paraformer")
            | ("funasr-fsmn-vad-gguf", "llama-funasr-vad")
            | ("zipenhancer", "onnxruntime")
            | ("mossformer2-separation", "onnxruntime")
    );
    if manifest.runtime.entry != "sherpa-onnx"
        && manifest.runtime.entry != "kaldifst"
        && manifest.adapter != "web-audio"
        && !supported_native
    {
        return Err("当前仅开放 sherpa-onnx 与 kaldifst 模型适配器".to_string());
    }
    let capabilities = manifest
        .capabilities
        .iter()
        .map(|capability| normalize_capability_id(capability).to_string())
        .collect::<Vec<_>>();
    let recommended_dependencies = if manifest.recommended_dependencies.is_empty() {
        inferred_dependencies(&capabilities, &manifest.adapter, &manifest.inputs)
    } else {
        manifest.recommended_dependencies.clone()
    };
    let model = manifest.models.into_iter().next().map(|model| {
        let name = if model.name.trim().is_empty() {
            manifest.name.clone()
        } else {
            model.name
        };
        let _estimated_size_mb = model.estimated_size_mb;
        let _precision = model.precision;
        PluginModelManifest {
            path: format!("models/{}", model.id),
            id: model.id,
            name,
            source: model.source,
            sha256: model.sha256,
            files: model.files,
            assets: model
                .assets
                .into_iter()
                .map(|asset| PluginAssetManifest {
                    source: asset.source,
                    path: asset.path,
                    sha256: asset.sha256,
                })
                .collect(),
            repository_hosted: model.repository_hosted,
        }
    });
    Ok(PluginManifest {
        schema_version: manifest.schema_version,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: model_author,
        engine_author,
        description: manifest.description,
        license: manifest.license,
        runtime: manifest.runtime.entry,
        runtime_package,
        adapter: manifest.adapter,
        capabilities,
        display_capabilities: manifest.display_capabilities,
        acceleration: manifest.acceleration,
        size_label: String::new(),
        featured: manifest.featured,
        tone: manifest.tone,
        inputs: manifest.inputs,
        outputs: manifest.outputs,
        parameter_schema: manifest.parameter_schema,
        recommended_dependencies,
        model,
    })
}

fn canonical_model_author(id: &str, declared: &str) -> String {
    match id {
        "k2-fsa.gtcrn" => "Xiaobin Rong et al.",
        "k2-fsa.streaming-paraformer" => "Alibaba DAMO Academy",
        "wenet-e2e.wenetspeech-yue-u2pp-ctc" => "WeNet",
        "lourdle.fun-cosyvoice3-local" => "FunAudioLLM",
        "k2-fsa.vits-melo-zh-en" => "MyShell.ai",
        "k2-fsa.pocket-tts-en" => "Kyutai",
        "k2-fsa.supertonic-3" => "Supertone",
        "k2-fsa.kitten-nano-en" => "KittenML",
        "k2-fsa.audio-tagging" => "RicherMans",
        "k2-fsa.whisper-language-id" => "OpenAI",
        "k2-fsa.spleeter-2stems" => "Deezer",
        "modelscope.zipenhancer-16k" | "modelscope.mossformer2-separation-8k" => {
            "Alibaba DAMO Academy"
        }
        "k2-fsa.punctuation-zh-en" => "Alibaba DAMO Academy",
        "k2-fsa.speaker-embedding" => "Alibaba DAMO Academy",
        "k2-fsa.speaker-diarization" => "pyannote.audio",
        _ => declared,
    }
    .to_string()
}

fn runtime_author(runtime: &V2RuntimeManifest) -> String {
    if !runtime.author.trim().is_empty() {
        return runtime.author.trim().to_string();
    }
    runtime_author_for_entry(&runtime.entry)
}

fn runtime_author_for_entry(entry: &str) -> String {
    match entry {
        "sherpa-onnx" => "k2-fsa",
        "kaldifst" => "k2-fsa",
        "cosyvoice.cpp" => "Lourdle",
        "deep-filter" => "Rikorose",
        "nnnoiseless" => "nnnoiseless contributors",
        "onnxruntime" => "Microsoft",
        "llama-funasr-cli"
        | "llama-funasr-sensevoice"
        | "llama-funasr-paraformer"
        | "llama-funasr-vad" => "QwenAudio / llama.cpp",
        other => other,
    }
    .to_string()
}

fn runtime_package_for_entry(entry: &str) -> &'static str {
    match entry {
        "deep-filter" => "deepfilter-0.5.6",
        "cosyvoice.cpp" => "cosyvoice-cpp-0aaa9ef-b9837",
        "onnxruntime" => "onnxruntime-1.27.0",
        "llama-funasr-cli"
        | "llama-funasr-sensevoice"
        | "llama-funasr-paraformer"
        | "llama-funasr-vad" => "funasr-llamacpp-0.1.10",
        _ => "",
    }
}

fn inferred_dependencies(
    capabilities: &[String],
    adapter: &str,
    inputs: &[PluginPortManifest],
) -> Vec<PluginDependencyManifest> {
    if capabilities.iter().any(|item| item == CAPABILITY_ASR)
        && !matches!(
            adapter,
            "funasr-nano" | "funasr-sensevoice-gguf" | "funasr-paraformer-gguf"
        )
    {
        return vec![PluginDependencyManifest {
            role: "speech-segmentation".to_string(),
            label: "自动分段".to_string(),
            plugin_id: "funaudiollm.fsmn-vad-gguf".to_string(),
            capability: CAPABILITY_VAD.to_string(),
            default: true,
            optional: true,
        }];
    }
    let voice_clone = capabilities.iter().any(|item| item == CAPABILITY_TTS)
        && (inputs.iter().any(|input| input.port_type == "audio")
            || matches!(adapter, "zipvoice" | "pocket-tts" | "cosyvoice-local"));
    if voice_clone {
        return vec![PluginDependencyManifest {
            role: "reference-transcription".to_string(),
            label: "参考文本识别".to_string(),
            plugin_id: "funaudiollm.sensevoice-small-gguf".to_string(),
            capability: CAPABILITY_ASR.to_string(),
            default: true,
            optional: true,
        }];
    }
    Vec::new()
}

fn normalize_capability_id(capability: &str) -> &str {
    match capability {
        "speech.tts" => CAPABILITY_TTS,
        "speech.asr" => CAPABILITY_ASR,
        "speech.vad" => CAPABILITY_VAD,
        "audio.denoise" | "audio.enhance" => CAPABILITY_ENHANCE,
        "stream.processor" => CAPABILITY_LIVE,
        other => other,
    }
}

#[derive(Debug, Deserialize)]
struct ModelScopeRepoFilesResponse {
    #[serde(rename = "Code")]
    code: u32,
    #[serde(rename = "Message", default)]
    message: String,
    #[serde(rename = "Data")]
    data: Option<ModelScopeRepoFilesData>,
}

#[derive(Debug, Deserialize)]
struct ModelScopeRepoFilesData {
    #[serde(rename = "Files", default)]
    files: Vec<ModelScopeRepoFile>,
}

#[derive(Debug, Deserialize)]
struct ModelScopeRepoFile {
    #[serde(rename = "Path")]
    path: String,
    #[serde(rename = "Type")]
    kind: String,
}

fn modelscope_repo_files() -> Result<Vec<ModelScopeRepoFile>, String> {
    let response = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .user_agent("QwenAudio-Toolkits/0.1")
        .build()
        .map_err(|error| format!("无法创建 ModelScope 模型目录连接: {error}"))?
        .get(DEFAULT_MODEL_REPOSITORY_FILES_API)
        .send()
        .map_err(|error| format!("无法读取 ModelScope 模型目录: {error}"))?
        .error_for_status()
        .map_err(|error| format!("ModelScope 模型目录请求失败: {error}"))?
        .json::<ModelScopeRepoFilesResponse>()
        .map_err(|error| format!("ModelScope 模型目录格式无效: {error}"))?;
    if response.code != 200 {
        return Err(if response.message.trim().is_empty() {
            format!("ModelScope 模型目录请求失败: code {}", response.code)
        } else {
            format!("ModelScope 模型目录请求失败: {}", response.message)
        });
    }
    response
        .data
        .map(|data| data.files)
        .ok_or_else(|| "ModelScope 模型目录没有返回文件列表".to_string())
}

fn modelscope_file_url(path: &str) -> Result<String, String> {
    if path.is_empty()
        || path.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || segment.contains('\\')
        })
    {
        return Err("ModelScope 模型文件路径无效".to_string());
    }
    let mut url = reqwest::Url::parse(DEFAULT_MODEL_REPOSITORY_RESOLVE)
        .map_err(|error| format!("ModelScope 模型地址无效: {error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "ModelScope 模型地址不支持追加文件路径".to_string())?;
        for segment in path.split('/') {
            segments.push(segment);
        }
    }
    Ok(url.to_string())
}

fn modelscope_component(value: &str) -> bool {
    !value.trim().is_empty()
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|character| character == '/' || character == '\\')
}

fn modelscope_payload_file(relative: &str) -> bool {
    let file_name = relative.rsplit('/').next().unwrap_or_default();
    let in_test_wavs = relative.split('/').any(|segment| segment == "test_wavs");
    (!in_test_wavs || matches!(file_name, "keywords.txt" | "keywords_raw.txt"))
        && file_name != ".gitattributes"
        && file_name != "README.md"
}

fn modelscope_declared_file(relative: &str, declared: &[String]) -> bool {
    modelscope_payload_file(relative)
        && declared.iter().any(|path| {
            let path = path.trim_end_matches('/');
            relative == path
                || relative
                    .strip_prefix(path)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        })
}

fn is_non_empty_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

fn is_non_empty_path(path: &Path) -> bool {
    if is_non_empty_file(path) {
        return true;
    }
    path.is_dir()
        && fs::read_dir(path).is_ok_and(|mut entries| {
            entries
                .next()
                .transpose()
                .is_ok_and(|entry| entry.is_some())
        })
}

fn copy_download_atomically(source: &Path, destination: &Path, label: &str) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{label}目标目录无效"))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建{label}目录: {error}"))?;
    let file_name = destination
        .file_name()
        .map(|name| name.to_string_lossy())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("{label}目标文件名无效"))?;
    let temporary = parent.join(format!(".{file_name}.partial"));
    let _ = fs::remove_file(&temporary);
    if let Err(error) = fs::copy(source, &temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法写入{label}: {error}"));
    }
    if let Err(error) = fs::rename(&temporary, destination) {
        if destination.is_file() {
            if let Err(replace_error) =
                fs::remove_file(destination).and_then(|_| fs::rename(&temporary, destination))
            {
                let _ = fs::remove_file(&temporary);
                return Err(format!("无法保存{label}: {replace_error}"));
            }
        } else {
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法保存{label}: {error}"));
        }
    }
    Ok(())
}

fn download_modelscope_model(
    app: &AppHandle,
    manifest: &PluginManifest,
    model: &PluginModelManifest,
    destination: &Path,
) -> Result<bool, String> {
    if !modelscope_component(&manifest.id) || !modelscope_component(&model.id) {
        return Ok(false);
    }
    let prefixes = [
        format!("models/{}/{}/", manifest.id, model.id),
        format!("{}/models/{}/", manifest.id, model.id),
    ];
    let declared = model
        .files
        .iter()
        .cloned()
        .chain(model.assets.iter().map(|asset| asset.path.clone()))
        .collect::<Vec<_>>();
    for prefix in prefixes {
        let downloaded = if declared.is_empty() {
            download_modelscope_directory(
                app,
                &prefix,
                destination,
                &manifest.name,
                MODEL_PROGRESS,
            )?
        } else {
            download_modelscope_directory_filtered(
                app,
                &prefix,
                destination,
                &manifest.name,
                MODEL_PROGRESS,
                |relative| modelscope_declared_file(relative, &declared),
            )?
        };
        if downloaded {
            return Ok(true);
        }
    }
    Ok(false)
}

fn download_modelscope_directory(
    app: &AppHandle,
    prefix: &str,
    destination: &Path,
    label: &str,
    progress: DownloadProgressRange,
) -> Result<bool, String> {
    download_modelscope_directory_filtered(
        app,
        prefix,
        destination,
        label,
        progress,
        modelscope_payload_file,
    )
}

fn download_modelscope_directory_filtered(
    app: &AppHandle,
    prefix: &str,
    destination: &Path,
    label: &str,
    progress: DownloadProgressRange,
    include: impl Fn(&str) -> bool,
) -> Result<bool, String> {
    let files = modelscope_repo_files()?;
    let payload = files
        .into_iter()
        .filter_map(|file| {
            if file.kind != "blob" || !file.path.starts_with(prefix) {
                return None;
            }
            let relative = file.path.strip_prefix(prefix)?.to_string();
            if !include(&relative) {
                return None;
            }
            Some((file.path, relative))
        })
        .collect::<Vec<_>>();
    if payload.is_empty() {
        return Ok(false);
    }

    emit_install(
        app,
        "downloading",
        progress.base,
        &format!("正在从 ModelScope 下载 {label}"),
    );
    let total = payload.len();
    for (chunk_index, chunk) in payload.chunks(MODELSCOPE_FILE_CONCURRENCY).enumerate() {
        std::thread::scope(|scope| {
            let mut handles = Vec::with_capacity(chunk.len());
            for (index, (path, relative)) in chunk.iter().enumerate() {
                let app = app.clone();
                let destination = destination.to_path_buf();
                let path = path.clone();
                let relative = relative.clone();
                let global_index = chunk_index * MODELSCOPE_FILE_CONCURRENCY + index;
                let file_progress_base =
                    batch_progress(progress.base, progress.span, global_index, total);
                let file_progress_end =
                    batch_progress(progress.base, progress.span, global_index + 1, total);
                handles.push(scope.spawn(move || {
                    download_modelscope_file(
                        &app,
                        &destination,
                        &path,
                        &relative,
                        global_index,
                        total,
                        DownloadProgressRange {
                            base: file_progress_base,
                            span: file_progress_end.saturating_sub(file_progress_base),
                        },
                    )
                }));
            }
            for handle in handles {
                handle
                    .join()
                    .map_err(|_| "ModelScope 模型下载线程异常退出".to_string())??;
            }
            Ok::<(), String>(())
        })?;
        let completed = ((chunk_index + 1) * MODELSCOPE_FILE_CONCURRENCY).min(total);
        emit_install(
            app,
            "downloading",
            batch_progress(progress.base, progress.span, completed, total),
            &format!("正在从 ModelScope 下载 {label} ({completed}/{total})"),
        );
    }
    Ok(true)
}

fn batch_progress(base: u8, span: u8, completed: usize, total: usize) -> u8 {
    if total == 0 {
        return base.min(100);
    }
    let offset = usize::from(span).saturating_mul(completed.min(total)) / total;
    base.saturating_add(offset as u8).min(100)
}

fn runtime_platform_id() -> Result<&'static str, String> {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => Ok("macos-arm64"),
        ("macos", "x86_64") => Ok("macos-x64"),
        ("windows", "x86_64") => Ok("windows-x64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("linux", "arm") => Ok("linux-armv7"),
        (os, arch) => Err(format!("当前系统没有可用的模型运行时: {os}/{arch}")),
    }
}

fn shared_runtime_directory(app: &AppHandle, package: &str) -> Result<PathBuf, String> {
    if !modelscope_component(package) {
        return Err("模型运行时包 ID 无效".to_string());
    }
    Ok(runtimes_directory(app)?
        .join(package)
        .join(runtime_platform_id()?))
}

fn write_runtime_pointer(model_dir: &Path, runtime_dir: &Path) -> Result<(), String> {
    fs::write(
        model_dir.join(RUNTIME_POINTER_FILE),
        runtime_dir.to_string_lossy().as_bytes(),
    )
    .map_err(|error| format!("无法关联模型运行时: {error}"))
}

pub(crate) fn runtime_directory_for_model(model_dir: &Path) -> PathBuf {
    fs::read_to_string(model_dir.join(RUNTIME_POINTER_FILE))
        .ok()
        .map(|path| PathBuf::from(path.trim()))
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| model_dir.join("runtime"))
}

fn prepare_shared_runtime(
    app: &AppHandle,
    manifest: &PluginManifest,
    model_dir: &Path,
    prefer_modelscope: bool,
) -> Result<(), String> {
    if manifest.runtime_package.is_empty() {
        return Ok(());
    }
    let runtime_dir = shared_runtime_directory(app, &manifest.runtime_package)?;
    fs::create_dir_all(&runtime_dir).map_err(|error| format!("无法创建共享运行时目录: {error}"))?;
    if prefer_modelscope && !runtime_dir.join(RUNTIME_COMPLETE_FILE).is_file() {
        let prefix = format!(
            "runtimes/{}/{}/",
            manifest.runtime_package,
            runtime_platform_id()?
        );
        let downloaded = download_modelscope_directory(
            app,
            &prefix,
            &runtime_dir,
            "模型运行时",
            SHARED_RUNTIME_PROGRESS,
        )?;
        if !downloaded {
            return Err(format!(
                "ModelScope 中没有当前平台的 {} 运行时",
                manifest.runtime_package
            ));
        }
    }
    write_runtime_pointer(model_dir, &runtime_dir)
}

fn mark_shared_runtime_ready(model_dir: &Path) -> Result<(), String> {
    let pointer = model_dir.join(RUNTIME_POINTER_FILE);
    if !pointer.is_file() {
        return Ok(());
    }
    fs::write(
        runtime_directory_for_model(model_dir).join(RUNTIME_COMPLETE_FILE),
        b"ready\n",
    )
    .map_err(|error| format!("无法记录模型运行时状态: {error}"))
}

fn download_modelscope_file(
    app: &AppHandle,
    destination: &Path,
    path: &str,
    relative: &str,
    index: usize,
    total: usize,
    progress: DownloadProgressRange,
) -> Result<(), String> {
    let target = safe_join(destination, relative)?;
    if is_non_empty_file(&target) {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 ModelScope 模型目录: {error}"))?;
    }
    let source = modelscope_file_url(path)?;
    let cached = download_cached(
        app,
        &source,
        "",
        progress,
        &format!("正在下载 ModelScope 模型文件 ({}/{})", index + 1, total),
    )
    .map_err(|error| format!("下载 ModelScope 文件 {relative} 失败: {error}"))?;
    copy_download_atomically(&cached, &target, "ModelScope 模型文件")?;
    let _ = fs::remove_file(cached);
    Ok(())
}

fn install_remote_model(
    app: &AppHandle,
    root: &Path,
    manifest: &PluginManifest,
    prefer_modelscope: bool,
) -> Result<(), String> {
    let Some(model) = manifest.model.as_ref() else {
        return Ok(());
    };
    if model.files.is_empty()
        && model.source.trim().is_empty()
        && model.assets.is_empty()
        && manifest.runtime_package.is_empty()
    {
        return Ok(());
    }
    if !prefer_modelscope
        && model.source.trim().is_empty()
        && model.assets.is_empty()
        && manifest.runtime_package.is_empty()
    {
        return Ok(());
    }
    let destination = safe_join(root, &model.path)?;
    fs::create_dir_all(&destination).map_err(|error| format!("无法创建模型暂存目录: {error}"))?;
    prepare_shared_runtime(app, manifest, &destination, prefer_modelscope)?;
    let model_files_ready = !model.files.is_empty()
        && model.files.iter().all(|relative| {
            safe_join(&destination, relative)
                .map(|path| is_non_empty_path(&path))
                .unwrap_or(false)
        });
    let model_assets_ready = model.assets.iter().all(|asset| {
        safe_join(&destination, &asset.path)
            .map(|path| is_non_empty_file(&path))
            .unwrap_or(false)
    });
    let model_payload_ready = model_files_ready && model_assets_ready;
    let adapter_runtime_ready = match manifest.adapter.as_str() {
        "deepfilternet" => deepfilter_runtime_executable(&destination).is_ok(),
        "cosyvoice-local" => {
            cosyvoice_runtime_executable(&destination).is_ok()
                && cosyvoice_backend_directory(&destination).is_ok()
        }
        adapter if is_funasr_llamacpp_adapter(adapter) => {
            funasr_runtime_for_adapter(&destination, adapter).is_ok()
        }
        "zipenhancer" => {
            crate::onnx_audio::validate_onnx_audio_model(&destination, "zipenhancer.onnx").is_ok()
        }
        "mossformer2-separation" => {
            crate::onnx_audio::validate_onnx_audio_model(&destination, "mossformer2.onnx").is_ok()
        }
        _ => true,
    };
    if model_payload_ready && adapter_runtime_ready {
        mark_shared_runtime_ready(&destination)?;
        return Ok(());
    }
    if model_payload_ready && manifest.adapter == "cosyvoice-local" {
        install_cosyvoice_runtime(app, &destination)?;
        return Ok(());
    }
    if model_payload_ready && is_funasr_llamacpp_adapter(&manifest.adapter) {
        install_funasr_runtime(app, &destination, prefer_modelscope)?;
        return Ok(());
    }
    if !model.source.trim().is_empty() && !model.source.starts_with("https://") {
        return Err("远程模型 source 必须使用 HTTPS".to_string());
    }
    let modelscope_downloaded = if prefer_modelscope {
        download_modelscope_model(app, manifest, model, &destination)?
    } else {
        false
    };
    if prefer_modelscope && model.repository_hosted && !modelscope_downloaded {
        return Err(format!(
            "无法从 ModelScope 下载 {} 的模型文件；已禁止回退到 Hugging Face，请检查网络后重试",
            manifest.name
        ));
    }
    if !modelscope_downloaded && !model.source.trim().is_empty() {
        emit_install(app, "downloading", MODEL_PROGRESS_BASE, "正在下载模型权重");
        let archive_path = download_cached(
            app,
            &model.source,
            &model.sha256,
            MODEL_PROGRESS,
            "正在下载模型权重",
        )?;
        if manifest.adapter == "deepfilternet" {
            let target = destination.join("DeepFilterNet3_onnx.tar.gz");
            copy_download_atomically(&archive_path, &target, "DeepFilterNet3 权重")?;
            let _ = fs::remove_file(archive_path);
            install_deepfilter_runtime(app, &destination)?;
            return Ok(());
        }
        emit_install(app, "extracting-model", 68, "正在解压并校验模型文件");
        extract_model_download(&archive_path, &destination, &model.source)?;
        flatten_single_directory(&destination)?;
        let _ = fs::remove_file(archive_path);
    }
    if modelscope_downloaded && manifest.adapter == "deepfilternet" {
        install_deepfilter_runtime(app, &destination)?;
    }
    for asset in &model.assets {
        let asset_path = safe_join(&destination, &asset.path)?;
        if !asset_path.is_file() {
            download_model_asset(app, asset, &asset_path)?;
        }
    }
    if matches!(
        manifest.adapter.as_str(),
        "funasr-sensevoice-gguf" | "funasr-paraformer-gguf"
    ) {
        install_fsmn_vad_gguf(app, manifest, model, &destination)?;
    }
    if manifest.adapter == "cosyvoice-local" {
        install_cosyvoice_runtime(app, &destination)?;
    }
    if is_funasr_llamacpp_adapter(&manifest.adapter) {
        install_funasr_runtime(app, &destination, prefer_modelscope)?;
    }
    for relative in &model.files {
        let required = safe_join(&destination, relative)?;
        if !is_non_empty_path(&required) {
            return Err(format!("模型缺少必需文件或目录 {}", required.display()));
        }
    }
    if manifest.adapter == "speaker-diarization" {
        let mut dependency = manifest.clone();
        dependency.adapter = "speaker-embedding".to_string();
        dependency.model = Some(PluginModelManifest {
            id: "3dspeaker-campplus".to_string(),
            name: "3D-Speaker CAM++".to_string(),
            path: model.path.clone(),
            source: String::new(),
            sha256: String::new(),
            files: vec!["3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx".to_string()],
            assets: Vec::new(),
            repository_hosted: true,
        });
        dependency.id = "k2-fsa.speaker-embedding".to_string();
        install_remote_model(app, root, &dependency, prefer_modelscope)?;
    }
    Ok(())
}

fn download_model_asset(
    app: &AppHandle,
    asset: &PluginAssetManifest,
    destination: &Path,
) -> Result<(), String> {
    if !asset.source.starts_with("https://") {
        return Err("远程模型资源必须使用 HTTPS".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建模型资源目录: {error}"))?;
    }
    emit_install(
        app,
        "downloading",
        ASSET_PROGRESS_BASE,
        "正在下载模型附加资源",
    );
    let cached = download_cached(
        app,
        &asset.source,
        &asset.sha256,
        ASSET_PROGRESS,
        "正在下载模型附加资源",
    )?;
    copy_download_atomically(&cached, destination, "模型附加资源")?;
    let _ = fs::remove_file(cached);
    Ok(())
}

fn install_fsmn_vad_gguf(
    app: &AppHandle,
    manifest: &PluginManifest,
    model: &PluginModelManifest,
    destination: &Path,
) -> Result<(), String> {
    let target = destination.join("fsmn-vad.gguf");
    if is_non_empty_file(&target) {
        return Ok(());
    }
    let prefixes = [
        format!("models/{}/{}/", manifest.id, model.id),
        format!("{}/models/{}/", manifest.id, model.id),
    ];
    for prefix in prefixes {
        if download_modelscope_directory_filtered(
            app,
            &prefix,
            destination,
            "FSMN-VAD",
            ASSET_PROGRESS,
            |relative| relative == "fsmn-vad.gguf",
        )? {
            return Ok(());
        }
    }
    Err(format!(
        "ModelScope 中没有 {} 对应的 FSMN-VAD 文件",
        manifest.name
    ))
}

fn deepfilter_runtime_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "deep-filter.exe"
    } else {
        "deep-filter"
    }
}

pub(crate) fn deepfilter_runtime_executable(model_dir: &Path) -> Result<PathBuf, String> {
    let shared = runtime_directory_for_model(model_dir).join(deepfilter_runtime_file_name());
    let legacy = model_dir.join(deepfilter_runtime_file_name());
    let executable = if shared.is_file() { shared } else { legacy };
    if !executable.is_file() {
        return Err("DeepFilterNet 插件缺少当前平台运行时".to_string());
    }
    ensure_executable_permission(&executable, "DeepFilterNet")?;
    Ok(executable)
}

fn deepfilter_runtime_asset() -> Result<PluginAssetManifest, String> {
    let (asset, sha256) = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => (
            "deep-filter-0.5.6-aarch64-apple-darwin",
            "4601e7f4e4c03e59a4c5b5000216ef3add3e808799cfccd95e14e83ea4611081",
        ),
        ("macos", "x86_64") => (
            "deep-filter-0.5.6-x86_64-apple-darwin",
            "d3be84003acb7c23e738ad7f70a158ec779a8d233a82e7fa3e717d112eb5b50f",
        ),
        ("windows", "x86_64") => (
            "deep-filter-0.5.6-x86_64-pc-windows-msvc.exe",
            "75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915",
        ),
        ("linux", "x86_64") => (
            "deep-filter-0.5.6-x86_64-unknown-linux-musl",
            "70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da",
        ),
        ("linux", "aarch64") => (
            "deep-filter-0.5.6-aarch64-unknown-linux-gnu",
            "14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166",
        ),
        ("linux", "arm") => (
            "deep-filter-0.5.6-armv7-unknown-linux-gnueabihf",
            "29feffdfacbaa30ff7811bd275f252d405d43ad6e5523ffcedeaf3ff5bb8335b",
        ),
        (os, arch) => return Err(format!("DeepFilterNet 暂不支持当前平台: {os}/{arch}")),
    };
    Ok(PluginAssetManifest {
        source: format!(
            "https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/{asset}"
        ),
        path: deepfilter_runtime_file_name().to_string(),
        sha256: sha256.to_string(),
    })
}

pub(crate) fn ensure_executable_permission(path: &Path, label: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("无法读取 {label} 运行时权限: {error}"))?
            .permissions();
        let mode = permissions.mode();
        if mode & 0o111 == 0 {
            permissions.set_mode(mode | 0o111);
            fs::set_permissions(path, permissions)
                .map_err(|error| format!("无法设置 {label} 运行时权限: {error}"))?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, label);
    }
    Ok(())
}

fn install_deepfilter_runtime(app: &AppHandle, destination: &Path) -> Result<(), String> {
    let target = runtime_directory_for_model(destination).join(deepfilter_runtime_file_name());
    if !target.is_file() {
        let asset = deepfilter_runtime_asset()?;
        download_model_asset(app, &asset, &target)?;
    }
    ensure_executable_permission(&target, "DeepFilterNet")?;
    mark_shared_runtime_ready(destination)?;
    Ok(())
}

fn funasr_runtime_asset() -> Result<PluginAssetManifest, String> {
    // runtime-llamacpp-v0.1.10 adds `llama-funasr-cli --stream` (LOCKED/PARTIAL/DONE
    // realtime protocol 流式在 qwen-audio-toolkits 的本地实时识别里依赖该协议),
    // currently built for macos-arm64 only; other platforms stay on v0.1.9 until
    // their assets are rebuilt on those platforms.
    let (archive, sha256, tag) = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => (
            "funasr-llamacpp-macos-arm64.tar.gz",
            "e4fb4978e580b5b9cda0fec30ad49787738452fa3c33c6cb5e23861ebf3e77e5",
            "runtime-llamacpp-v0.1.10",
        ),
        ("windows", "x86_64") => (
            "funasr-llamacpp-windows-x64.zip",
            "6767af74e42c8b928742e12d5995c139636d9482ea151cdbb51f1b7573667772",
            "runtime-llamacpp-v0.1.9",
        ),
        ("linux", "x86_64") => (
            "funasr-llamacpp-linux-x64.tar.gz",
            "2cd54174a3755f89c11f071dedfb935eff96007617e2e952604d90230ea9eb48",
            "runtime-llamacpp-v0.1.9",
        ),
        ("linux", "aarch64") => (
            "funasr-llamacpp-linux-arm64.tar.gz",
            "521866e75594e56eb5023b65eb1ecf6ab7c3b5069522b71cd33aa37b8406ed4b",
            "runtime-llamacpp-v0.1.9",
        ),
        (os, arch) => return Err(format!("FunASR 官方运行时暂不支持当前平台: {os}/{arch}")),
    };
    Ok(PluginAssetManifest {
        source: format!("https://github.com/QwenAudio/Fun-ASR/releases/download/{tag}/{archive}"),
        path: "runtime".to_string(),
        sha256: sha256.to_string(),
    })
}

fn install_funasr_runtime(
    app: &AppHandle,
    destination: &Path,
    prefer_modelscope: bool,
) -> Result<(), String> {
    if let Ok(executable) = funasr_runtime_executable(destination) {
        ensure_executable_permission(&executable, "FunASR")?;
        mark_shared_runtime_ready(destination)?;
        return Ok(());
    }
    if prefer_modelscope {
        return Err(
            "ModelScope 中的 FunASR 运行时不完整，已禁止回退到 GitHub，请重试安装".to_string(),
        );
    }
    let asset = funasr_runtime_asset()?;
    let archive = download_cached(
        app,
        &asset.source,
        &asset.sha256,
        DownloadProgressRange { base: 82, span: 8 },
        "正在下载 FunASR 官方运行时",
    )?;
    let runtime_dir = runtime_directory_for_model(destination);
    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir)
            .map_err(|error| format!("无法清理 FunASR 运行时目录: {error}"))?;
    }
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("无法创建 FunASR 运行时目录: {error}"))?;
    extract_model_download(&archive, &runtime_dir, &asset.source)?;
    flatten_single_directory(&runtime_dir)?;
    let _ = fs::remove_file(archive);
    let executable = funasr_runtime_executable(destination)?;
    ensure_executable_permission(&executable, "FunASR")?;
    mark_shared_runtime_ready(destination)?;
    Ok(())
}

pub(crate) fn funasr_runtime_executable(model_dir: &Path) -> Result<PathBuf, String> {
    funasr_runtime_binary(model_dir, "llama-funasr-cli")
}

fn is_funasr_llamacpp_adapter(adapter: &str) -> bool {
    matches!(
        adapter,
        "funasr-nano"
            | "funasr-sensevoice-gguf"
            | "funasr-paraformer-gguf"
            | "funasr-fsmn-vad-gguf"
    )
}

fn funasr_runtime_for_adapter(model_dir: &Path, adapter: &str) -> Result<PathBuf, String> {
    let binary = match adapter {
        "funasr-nano" => "llama-funasr-cli",
        "funasr-sensevoice-gguf" => "llama-funasr-sensevoice",
        "funasr-paraformer-gguf" => "llama-funasr-paraformer",
        "funasr-fsmn-vad-gguf" => "llama-funasr-vad",
        _ => return Err(format!("未知 FunASR llama.cpp 适配器: {adapter}")),
    };
    funasr_runtime_binary(model_dir, binary)
}

pub(crate) fn funasr_runtime_binary(model_dir: &Path, binary: &str) -> Result<PathBuf, String> {
    let name = if cfg!(target_os = "windows") {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    };
    let runtime_dir = runtime_directory_for_model(model_dir);
    let executable = runtime_dir.join(&name);
    let executable = if executable.is_file() {
        executable
    } else {
        find_file_named(&runtime_dir, &name)?
            .ok_or_else(|| "FunASR 插件缺少官方 llama.cpp 运行时".to_string())?
    };
    ensure_executable_permission(&executable, "FunASR")?;
    Ok(executable)
}

fn find_file_named(root: &Path, name: &str) -> Result<Option<PathBuf>, String> {
    if !root.is_dir() {
        return Ok(None);
    }
    for entry in fs::read_dir(root).map_err(|error| format!("无法检查运行时目录: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("无法检查运行时文件: {error}"))?
            .path();
        if path.is_file() && path.file_name().and_then(|value| value.to_str()) == Some(name) {
            return Ok(Some(path));
        }
        if path.is_dir() {
            if let Some(found) = find_file_named(&path, name)? {
                return Ok(Some(found));
            }
        }
    }
    Ok(None)
}

fn cosyvoice_runtime_asset() -> Result<PluginAssetManifest, String> {
    let (source, sha256) = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        (
            "https://github.com/Lourdle/cosyvoice.cpp/releases/download/0aaa9ef/cosyvoice-0aaa9ef-macos-arm64-miniaudio-no_icu.tgz",
            "33de7921da6d76865ecfa3af1607a4630aeea82644a2d123cd4a0e944b2fa0b3",
        )
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        (
            "https://github.com/Lourdle/cosyvoice.cpp/releases/download/0aaa9ef/cosyvoice-0aaa9ef-windows-x64-miniaudio-no_icu.zip",
            "780ee37541088549c97eb7d761fac4d323d84086591e8a600d7e9b82c08b6398",
        )
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        (
            "https://github.com/Lourdle/cosyvoice.cpp/releases/download/0aaa9ef/cosyvoice-0aaa9ef-linux-x86_64-miniaudio-no_icu.tgz",
            "21641815a36a3c70be221993d05153b8df07e1346fdb14cedf4610213f5f7bce",
        )
    } else {
        return Err("Fun-CosyVoice3 Local 暂不支持当前系统架构".to_string());
    };
    Ok(PluginAssetManifest {
        source: source.to_string(),
        path: "runtime".to_string(),
        sha256: sha256.to_string(),
    })
}

fn cosyvoice_ggml_asset() -> Result<PluginAssetManifest, String> {
    let (source, sha256) = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        (
            "https://github.com/ggml-org/llama.cpp/releases/download/b9837/llama-b9837-bin-macos-arm64.tar.gz",
            "f26992b35d3d9e538bfe130a8bd9b74ad8bf3d7e0b809802d032ff6e7ac5a467",
        )
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        (
            "https://github.com/ggml-org/llama.cpp/releases/download/b9837/llama-b9837-bin-win-cpu-x64.zip",
            "d53a9a0107c088d57592e4a43bf56ec3e3d274e9e45413d7d5c9bec583d173fd",
        )
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        (
            "https://github.com/ggml-org/llama.cpp/releases/download/b9837/llama-b9837-bin-ubuntu-x64.tar.gz",
            "77af0da85fad74006bc2b3d44ba29a6998dba949e4bb20a6ba4ab48fbbc4bda7",
        )
    } else {
        return Err("Fun-CosyVoice3 Local 暂不支持当前系统架构".to_string());
    };
    Ok(PluginAssetManifest {
        source: source.to_string(),
        path: "runtime/ggml".to_string(),
        sha256: sha256.to_string(),
    })
}

fn install_cosyvoice_runtime(app: &AppHandle, destination: &Path) -> Result<(), String> {
    if cosyvoice_runtime_executable(destination).is_ok()
        && cosyvoice_backend_directory(destination).is_ok()
    {
        let executable = cosyvoice_runtime_executable(destination)?;
        ensure_executable_permission(&executable, "CosyVoice")?;
        mark_shared_runtime_ready(destination)?;
        return Ok(());
    }
    let asset = cosyvoice_runtime_asset()?;
    emit_install(
        app,
        "downloading-runtime",
        74,
        "正在下载 CosyVoice 本地运行时",
    );
    let archive_path = download_cached(
        app,
        &asset.source,
        &asset.sha256,
        DownloadProgressRange { base: 74, span: 8 },
        "正在下载 CosyVoice 本地运行时",
    )?;
    let runtime_dir = runtime_directory_for_model(destination);
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("无法创建 CosyVoice 运行时目录: {error}"))?;
    extract_runtime_archive(&asset.source, &archive_path, &runtime_dir)?;
    let _ = fs::remove_file(archive_path);

    let ggml_asset = cosyvoice_ggml_asset()?;
    emit_install(
        app,
        "downloading-runtime",
        82,
        "正在下载 CosyVoice GGML 后端",
    );
    let ggml_archive = download_cached(
        app,
        &ggml_asset.source,
        &ggml_asset.sha256,
        DownloadProgressRange { base: 82, span: 8 },
        "正在下载 CosyVoice GGML 后端",
    )?;
    let ggml_dir = runtime_dir.join("ggml");
    fs::create_dir_all(&ggml_dir)
        .map_err(|error| format!("无法创建 CosyVoice GGML 目录: {error}"))?;
    extract_runtime_archive(&ggml_asset.source, &ggml_archive, &ggml_dir)?;
    let _ = fs::remove_file(ggml_archive);
    ensure_cosyvoice_backend_aliases(destination)?;

    let executable = cosyvoice_runtime_executable(destination)?;
    cosyvoice_backend_directory(destination)?;
    ensure_executable_permission(&executable, "CosyVoice")?;
    mark_shared_runtime_ready(destination)?;
    Ok(())
}

fn extract_runtime_archive(
    source: &str,
    archive_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    if source.ends_with(".zip") {
        return extract_archive(archive_path, destination);
    }
    let file =
        fs::File::open(archive_path).map_err(|error| format!("无法打开本地运行时: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("无法读取本地运行时: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("无法读取本地运行时条目: {error}"))?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            continue;
        }
        if !entry
            .unpack_in(destination)
            .map_err(|error| format!("无法解压本地运行时: {error}"))?
        {
            return Err("本地运行时包含越界路径".to_string());
        }
    }
    Ok(())
}

fn ensure_cosyvoice_backend_aliases(model_dir: &Path) -> Result<(), String> {
    let runtime_root = runtime_directory_for_model(model_dir);
    if cfg!(target_os = "macos") {
        ensure_library_alias(&runtime_root, "libonnxruntime.1.dylib", "libonnxruntime.1.")?;
    } else if cfg!(target_os = "linux") {
        ensure_library_alias(&runtime_root, "libonnxruntime.so.1", "libonnxruntime.so.1.")?;
    }
    let root = runtime_root.join("ggml");
    let aliases: &[(&str, &str)] = if cfg!(target_os = "macos") {
        &[
            ("libggml.0.dylib", "libggml.0."),
            ("libggml-base.0.dylib", "libggml-base.0."),
            ("libggml-cpu.0.dylib", "libggml-cpu.0."),
            ("libggml-blas.0.dylib", "libggml-blas.0."),
            ("libggml-metal.0.dylib", "libggml-metal.0."),
            ("libggml-rpc.0.dylib", "libggml-rpc.0."),
        ]
    } else if cfg!(target_os = "linux") {
        &[
            ("libggml.so.0", "libggml.so.0."),
            ("libggml-base.so.0", "libggml-base.so.0."),
            ("libggml-cpu.so.0", "libggml-cpu.so.0."),
            ("libggml-blas.so.0", "libggml-blas.so.0."),
            ("libggml-rpc.so.0", "libggml-rpc.so.0."),
        ]
    } else {
        return Ok(());
    };
    for (alias, source_prefix) in aliases {
        ensure_library_alias(&root, alias, source_prefix)?;
    }
    Ok(())
}

fn ensure_library_alias(root: &Path, alias: &str, source_prefix: &str) -> Result<(), String> {
    if find_named_file(root, alias).is_some() {
        return Ok(());
    }
    let source = find_matching_file(root, &|path| {
        path.file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.starts_with(source_prefix) && name != alias)
    })
    .ok_or_else(|| format!("CosyVoice 运行时缺少 {source_prefix}*"))?;
    let parent = source
        .parent()
        .ok_or_else(|| "CosyVoice 运行时目录无效".to_string())?;
    fs::copy(&source, parent.join(alias))
        .map_err(|error| format!("无法准备 CosyVoice 运行库 {alias}: {error}"))?;
    Ok(())
}

pub(crate) fn cosyvoice_runtime_executable(model_dir: &Path) -> Result<PathBuf, String> {
    let executable = find_named_file(
        &runtime_directory_for_model(model_dir),
        if cfg!(target_os = "windows") {
            "cosyvoice-cli.exe"
        } else {
            "cosyvoice-cli"
        },
    )
    .ok_or_else(|| "CosyVoice 插件缺少 cosyvoice-cli 运行时".to_string())?;
    ensure_executable_permission(&executable, "CosyVoice")?;
    Ok(executable)
}

pub(crate) fn cosyvoice_model_file(model_dir: &Path) -> Result<PathBuf, String> {
    find_file_with_extension(model_dir, "gguf")
}

pub(crate) fn cosyvoice_backend_directory(model_dir: &Path) -> Result<PathBuf, String> {
    ensure_cosyvoice_backend_aliases(model_dir)?;
    let library = if cfg!(target_os = "windows") {
        "ggml.dll"
    } else if cfg!(target_os = "macos") {
        "libggml.0.dylib"
    } else {
        "libggml.so.0"
    };
    find_named_file(
        &runtime_directory_for_model(model_dir).join("ggml"),
        library,
    )
    .and_then(|path| path.parent().map(Path::to_path_buf))
    .ok_or_else(|| format!("CosyVoice 插件缺少 {library} 后端"))
}

fn find_file_with_extension(root: &Path, extension: &str) -> Result<PathBuf, String> {
    find_matching_file(root, &|path| {
        path.extension().and_then(|value| value.to_str()) == Some(extension)
    })
    .ok_or_else(|| format!("{} 中没有找到 .{extension} 文件", root.display()))
}

fn find_file_name_prefix(root: &Path, prefix: &str) -> Result<PathBuf, String> {
    fs::read_dir(root)
        .map_err(|error| format!("无法检查模型目录: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(prefix))
        })
        .ok_or_else(|| format!("模型目录缺少 {prefix}*"))
}

fn find_named_file(root: &Path, file_name: &str) -> Option<PathBuf> {
    find_matching_file(root, &|path| {
        path.file_name().and_then(|value| value.to_str()) == Some(file_name)
    })
}

fn find_matching_file(root: &Path, predicate: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && predicate(&path) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_matching_file(&path, predicate) {
                return Some(found);
            }
        }
    }
    None
}

fn extract_model_download(source: &Path, destination: &Path, url: &str) -> Result<(), String> {
    if url.ends_with(".tar.bz2") {
        let file = fs::File::open(source).map_err(|error| format!("无法打开模型包: {error}"))?;
        let decoder = bzip2::read::BzDecoder::new(file);
        extract_tar_archive(decoder, destination)
    } else if url.ends_with(".tar.gz") || url.ends_with(".tgz") {
        let file = fs::File::open(source).map_err(|error| format!("无法打开模型包: {error}"))?;
        let decoder = flate2::read::GzDecoder::new(file);
        extract_tar_archive(decoder, destination)
    } else if url.ends_with(".whl") {
        extract_wetext_rules(source, destination)
    } else if url.ends_with(".zip") {
        extract_archive(source, destination)
    } else {
        let file_name = url
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "无法确定模型文件名".to_string())?;
        fs::copy(source, destination.join(file_name))
            .map(|_| ())
            .map_err(|error| format!("无法安装模型文件: {error}"))
    }
}

fn extract_tar_archive(reader: impl Read, destination: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|error| format!("无法读取模型包: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("无法读取模型包条目: {error}"))?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err("模型包不能包含符号链接或硬链接".to_string());
        }
        if !entry
            .unpack_in(destination)
            .map_err(|error| format!("无法解压模型包: {error}"))?
        {
            return Err("模型包包含越界路径".to_string());
        }
    }
    Ok(())
}

fn extract_wetext_rules(source: &Path, destination: &Path) -> Result<(), String> {
    let file =
        fs::File::open(source).map_err(|error| format!("无法打开 WeText 规则包: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("无法读取 WeText 规则包: {error}"))?;
    let rules_root = Path::new("wetext/fsts");
    let mut extracted = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 WeText 规则: {error}"))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "WeText 规则包包含越界路径".to_string())?;
        if entry.is_dir()
            || !relative.starts_with(rules_root)
            || relative.extension().and_then(|value| value.to_str()) != Some("fst")
        {
            continue;
        }
        let output = destination.join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建 WeText 规则目录: {error}"))?;
        }
        let mut output_file =
            fs::File::create(&output).map_err(|error| format!("无法写入 WeText 规则: {error}"))?;
        io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("无法解压 WeText 规则: {error}"))?;
        extracted += 1;
    }
    if extracted == 0 {
        return Err("WeText 规则包中没有找到 FST 文件".to_string());
    }
    Ok(())
}

fn flatten_single_directory(root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(root)
        .map_err(|error| format!("无法检查模型目录: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法检查模型目录: {error}"))?;
    if entries.len() != 1 || !entries[0].path().is_dir() {
        return Ok(());
    }
    let nested = entries[0].path();
    for entry in fs::read_dir(&nested).map_err(|error| format!("无法整理模型目录: {error}"))?
    {
        let entry = entry.map_err(|error| format!("无法整理模型文件: {error}"))?;
        fs::rename(entry.path(), root.join(entry.file_name()))
            .map_err(|error| format!("无法整理模型文件: {error}"))?;
    }
    fs::remove_dir(nested).map_err(|error| format!("无法整理模型目录: {error}"))
}

struct AdapterSpec {
    id: &'static str,
    capability: &'static str,
    supports_streaming: bool,
}

fn adapter_spec(adapter: &str) -> Option<AdapterSpec> {
    let capability = match adapter {
        "kokoro" | "vits" | "matcha" | "kitten" | "zipvoice" | "pocket-tts" | "supertonic"
        | "cosyvoice-local" => CAPABILITY_TTS,
        "streaming-zipformer"
        | "streaming-paraformer"
        | "funasr-nano"
        | "funasr-sensevoice-gguf"
        | "funasr-paraformer-gguf"
        | "wenet-ctc"
        | "fire-red-asr-ctc"
        | "fire-red-asr"
        | "moonshine-v2"
        | "nemo-parakeet"
        | "nemo-canary"
        | "qwen3-asr" => CAPABILITY_ASR,
        "silero-vad" | "funasr-fsmn-vad-gguf" => CAPABILITY_VAD,
        "dpdfnet2" | "gtcrn" | "deepfilternet" | "rnnoise" | "zipenhancer" => CAPABILITY_ENHANCE,
        "web-audio" => CAPABILITY_LIVE,
        "audio-tagging" => CAPABILITY_AUDIO_TAGGING,
        "keyword-spotting" => CAPABILITY_KWS,
        "language-id" => CAPABILITY_LANGUAGE_ID,
        "punctuation" => CAPABILITY_PUNCTUATION,
        "wetext" => CAPABILITY_TEXT_NORMALIZE,
        "speaker-embedding" => CAPABILITY_SPEAKER_EMBED,
        "speaker-diarization" => CAPABILITY_DIARIZATION,
        "source-separation" | "mossformer2-separation" => CAPABILITY_SOURCE_SEPARATION,
        _ => return None,
    };
    Some(AdapterSpec {
        id: match adapter {
            "kokoro" => "kokoro",
            "vits" => "vits",
            "matcha" => "matcha",
            "kitten" => "kitten",
            "zipvoice" => "zipvoice",
            "pocket-tts" => "pocket-tts",
            "supertonic" => "supertonic",
            "cosyvoice-local" => "cosyvoice-local",
            "streaming-zipformer" => "streaming-zipformer",
            "streaming-paraformer" => "streaming-paraformer",
            "funasr-nano" => "funasr-nano",
            "funasr-sensevoice-gguf" => "funasr-sensevoice-gguf",
            "funasr-paraformer-gguf" => "funasr-paraformer-gguf",
            "funasr-fsmn-vad-gguf" => "funasr-fsmn-vad-gguf",
            "wenet-ctc" => "wenet-ctc",
            "fire-red-asr-ctc" => "fire-red-asr-ctc",
            "fire-red-asr" => "fire-red-asr",
            "moonshine-v2" => "moonshine-v2",
            "nemo-parakeet" => "nemo-parakeet",
            "nemo-canary" => "nemo-canary",
            "qwen3-asr" => "qwen3-asr",
            "silero-vad" => "silero-vad",
            "dpdfnet2" => "dpdfnet2",
            "gtcrn" => "gtcrn",
            "deepfilternet" => "deepfilternet",
            "rnnoise" => "rnnoise",
            "audio-tagging" => "audio-tagging",
            "keyword-spotting" => "keyword-spotting",
            "language-id" => "language-id",
            "punctuation" => "punctuation",
            "wetext" => "wetext",
            "speaker-embedding" => "speaker-embedding",
            "speaker-diarization" => "speaker-diarization",
            "source-separation" => "source-separation",
            "zipenhancer" => "zipenhancer",
            "mossformer2-separation" => "mossformer2-separation",
            _ => "web-audio",
        },
        capability,
        supports_streaming: matches!(
            adapter,
            "silero-vad"
                | "web-audio"
                | "streaming-zipformer"
                | "streaming-paraformer"
                | "funasr-nano"
                | "deepfilternet"
                | "rnnoise"
        ),
    })
}

pub(crate) fn adapter_capability(adapter: &str) -> Option<&'static str> {
    adapter_spec(adapter).map(|spec| spec.capability)
}

fn adapter_streaming_mode(adapter: &str) -> &'static str {
    if adapter_spec(adapter).is_some_and(|spec| spec.supports_streaming) {
        "streaming"
    } else {
        "batch"
    }
}

fn required_model(root: &Path, manifest: &PluginManifest) -> Result<PathBuf, String> {
    let model = manifest
        .model
        .as_ref()
        .ok_or_else(|| format!("{} 插件缺少 model 配置", manifest.adapter))?;
    if model.id.trim().is_empty() || model.name.trim().is_empty() {
        return Err("model.id 与 model.name 不能为空".to_string());
    }
    safe_join(root, &model.path)
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("插件模型路径必须位于插件目录内".to_string());
    }
    Ok(root.join(path))
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.len() < 3
        || plugin_id.len() > 80
        || !plugin_id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '-'
                || character == '.'
        })
    {
        return Err("插件 ID 只能包含小写字母、数字和连字符".to_string());
    }
    Ok(())
}

fn supported_capability(capability: &str) -> bool {
    matches!(
        capability,
        CAPABILITY_TTS
            | CAPABILITY_ASR
            | CAPABILITY_VAD
            | CAPABILITY_TEXT
            | CAPABILITY_ENHANCE
            | CAPABILITY_LIVE
            | CAPABILITY_AUDIO_TAGGING
            | CAPABILITY_KWS
            | CAPABILITY_LANGUAGE_ID
            | CAPABILITY_PUNCTUATION
            | CAPABILITY_TEXT_NORMALIZE
            | CAPABILITY_SPEAKER_EMBED
            | CAPABILITY_DIARIZATION
            | CAPABILITY_SOURCE_SEPARATION
    )
}

fn builtin_plugin_id(plugin_id: &str) -> bool {
    matches!(plugin_id, "silero-vad" | "web-audio-stream")
}

fn capability_label(capability: &str) -> &'static str {
    match capability {
        CAPABILITY_TTS => "音频生成",
        CAPABILITY_ASR => "语音识别",
        CAPABILITY_VAD => "语音活动检测",
        CAPABILITY_TEXT => "文本生成",
        CAPABILITY_ENHANCE => "音频增强",
        CAPABILITY_LIVE => "实时音频",
        CAPABILITY_AUDIO_TAGGING => "音频标签",
        CAPABILITY_KWS => "关键词检测",
        CAPABILITY_LANGUAGE_ID => "语言识别",
        CAPABILITY_PUNCTUATION => "标点恢复",
        CAPABILITY_TEXT_NORMALIZE => "文本归一化",
        CAPABILITY_SPEAKER_EMBED => "声纹比对",
        CAPABILITY_DIARIZATION => "说话人分离",
        CAPABILITY_SOURCE_SEPARATION => "人声分离",
        _ => "扩展能力",
    }
}

fn valid_tone(tone: &str) -> &'static str {
    match tone {
        "green" => "green",
        "coral" => "coral",
        "yellow" => "yellow",
        "blue" => "blue",
        _ => "violet",
    }
}

fn require_file(path: &Path) -> Result<(), String> {
    if is_non_empty_file(path) {
        Ok(())
    } else {
        Err(format!("插件缺少必需文件 {}", path.display()))
    }
}

fn require_named_file(root: &Path, file_name: &str) -> Result<(), String> {
    require_matching_file(root, file_name, &|path| {
        path.file_name().and_then(|value| value.to_str()) == Some(file_name)
    })
}

fn require_matching_file(
    root: &Path,
    label: &str,
    predicate: &dyn Fn(&Path) -> bool,
) -> Result<(), String> {
    let path =
        find_matching_file(root, predicate).ok_or_else(|| format!("插件缺少必需文件 {label}"))?;
    require_file(&path)
}

fn require_path(path: &Path) -> Result<(), String> {
    if path.is_file() || path.is_dir() {
        Ok(())
    } else {
        Err(format!("插件缺少必需文件或目录 {}", path.display()))
    }
}

fn require_directory(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        Ok(())
    } else {
        Err(format!("插件缺少必需目录 {}", path.display()))
    }
}

fn extract_archive(source: &Path, destination: &Path) -> Result<(), String> {
    let file = fs::File::open(source).map_err(|error| format!("无法打开插件包: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("无法读取 .cspkg: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("插件包包含过多文件".to_string());
    }
    let mut total_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取插件包条目: {error}"))?;
        total_size = total_size.saturating_add(entry.size());
        if total_size > MAX_PACKAGE_BYTES {
            return Err("插件包解压后超过 20 GB 限制".to_string());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("插件包不能包含符号链接".to_string());
        }
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "插件包包含越界路径".to_string())?;
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| format!("无法创建插件目录: {error}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建插件目录: {error}"))?;
        }
        let mut output_file =
            fs::File::create(&output).map_err(|error| format!("无法写入插件文件: {error}"))?;
        io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("无法解压插件文件: {error}"))?;
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| format!("无法读取插件目录: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("插件目录不能包含符号链接".to_string());
    }
    for entry in fs::read_dir(source).map_err(|error| format!("无法读取插件目录: {error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取插件目录项: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取插件文件类型: {error}"))?;
        if file_type.is_symlink() {
            return Err("插件目录不能包含符号链接".to_string());
        }
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path)
                .map_err(|error| format!("无法创建插件目录: {error}"))?;
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("无法复制插件文件: {error}"))?;
        }
    }
    Ok(())
}

fn find_single_manifest(root: &Path) -> Result<PathBuf, String> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0_u8)];
    while let Some((directory, depth)) = pending.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("无法检查插件目录: {error}"))?
        {
            let entry = entry.map_err(|error| format!("无法检查插件目录项: {error}"))?;
            let path = entry.path();
            if entry.file_name() == "plugin.json" {
                found.push(path);
            } else if depth < 2
                && entry
                    .file_type()
                    .map_err(|error| format!("无法检查插件文件类型: {error}"))?
                    .is_dir()
            {
                pending.push((path, depth + 1));
            }
        }
    }
    match found.len() {
        0 => Err("插件包中没有 plugin.json".to_string()),
        1 => Ok(found.remove(0)),
        _ => Err("插件包中只能包含一个 plugin.json".to_string()),
    }
}

fn directory_size(root: &Path) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("无法统计插件大小: {error}"))?
        {
            let entry = entry.map_err(|error| format!("无法统计插件目录项: {error}"))?;
            let metadata = entry
                .metadata()
                .map_err(|error| format!("无法读取插件文件信息: {error}"))?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / 1024_f64.powi(3))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1024_f64.powi(2))
    } else {
        format!("{} KB", (bytes / 1024).max(1))
    }
}

fn models_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("models"))
        .map_err(|error| format!("无法定位模型目录: {error}"))
}

fn runtimes_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("runtimes"))
        .map_err(|error| format!("无法定位模型运行时目录: {error}"))
}

fn plugins_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("plugins"))
        .map_err(|error| format!("无法定位插件目录: {error}"))
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("plugin-state.json"))
        .map_err(|error| format!("无法定位插件状态文件: {error}"))
}

fn read_state(app: &AppHandle) -> Result<PluginState, String> {
    let path = state_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => {
            let mut state: PluginState = serde_json::from_slice(&bytes)
                .map_err(|error| format!("无法读取插件状态: {error}"))?;
            if sanitize_plugin_state(&mut state) {
                write_state(app, &state)?;
            }
            Ok(state)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PluginState::default()),
        Err(error) => Err(format!("无法读取插件状态: {error}")),
    }
}

fn write_state(app: &AppHandle, state: &PluginState) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建应用目录: {error}"))?;
    }
    let bytes =
        serde_json::to_vec_pretty(state).map_err(|error| format!("无法序列化插件状态: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("无法保存插件状态: {error}"))
}

fn emit_install(app: &AppHandle, stage: &'static str, progress: u8, detail: &str) {
    let _ = app.emit(
        "plugin-install-progress",
        PluginInstallProgress {
            stage,
            progress,
            detail: detail.to_string(),
        },
    );
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn plugin_state_keeps_legacy_files_sidebar_visible() {
        let state: PluginState = serde_json::from_str(r#"{"enabled":{"silero-vad":true}}"#)
            .expect("parse legacy plugin state");
        assert!(state.sidebar_hidden.is_empty());
        assert!(state.dependency_bindings.is_empty());
    }

    #[test]
    fn plugin_state_persists_dependency_bindings() {
        let state: PluginState = serde_json::from_str(
            r#"{"dependency_bindings":{"funaudiollm.sensevoice-small-gguf":{"speech-segmentation":"silero-vad"}}}"#,
        )
        .expect("parse dependency bindings");
        assert_eq!(
            state
                .dependency_bindings
                .get("funaudiollm.sensevoice-small-gguf")
                .and_then(|roles| roles.get("speech-segmentation"))
                .map(String::as_str),
            Some("silero-vad")
        );
        assert!(validate_dependency_bindings(&state.dependency_bindings).is_ok());
    }

    #[test]
    fn plugin_state_removes_deprecated_sensevoice_entries() {
        let mut state: PluginState = serde_json::from_str(
            r#"{
                "sidebar_hidden":["sensevoice-small","wetext.text-normalization"],
                "dependency_bindings":{
                    "sensevoice-small":{"speech-segmentation":"silero-vad"},
                    "lourdle.fun-cosyvoice3-local":{"reference-transcription":"sensevoice-small"},
                    "k2-fsa.vits-aishell3":{"text-normalization":"wetext.text-normalization"}
                }
            }"#,
        )
        .expect("parse stale plugin state");

        assert!(sanitize_plugin_state(&mut state));
        assert_eq!(
            state.sidebar_hidden,
            HashSet::from(["wetext.text-normalization".to_string()])
        );
        assert_eq!(state.dependency_bindings.len(), 1);
        assert_eq!(
            state
                .dependency_bindings
                .get("k2-fsa.vits-aishell3")
                .and_then(|roles| roles.get("text-normalization"))
                .map(String::as_str),
            Some("wetext.text-normalization")
        );
    }

    #[test]
    fn modelscope_urls_keep_model_paths_inside_repository() {
        let url = modelscope_file_url(
            "k2-fsa.streaming-zipformer-zh/models/streaming-zipformer-zh-int8-2025-06-30/tokens.txt",
        )
        .expect("ModelScope file URL should be valid");
        assert!(url.ends_with(
            "/k2-fsa.streaming-zipformer-zh/models/streaming-zipformer-zh-int8-2025-06-30/tokens.txt"
        ));
        assert!(modelscope_file_url("../outside/model.onnx").is_err());
    }

    #[test]
    fn modelscope_payload_skips_test_audio_and_metadata() {
        assert!(modelscope_payload_file("encoder.int8.onnx"));
        assert!(modelscope_payload_file("espeak-ng-data/lang/eng"));
        assert!(modelscope_payload_file("test_wavs/keywords.txt"));
        assert!(modelscope_payload_file("test_wavs/keywords_raw.txt"));
        assert!(!modelscope_payload_file("test_wavs/0.wav"));
        assert!(!modelscope_payload_file("README.md"));
        assert!(!modelscope_payload_file(".gitattributes"));
    }

    #[test]
    fn modelscope_model_payload_only_includes_manifest_files() {
        let declared = vec![
            "model.onnx".to_string(),
            "tokens.txt".to_string(),
            "espeak-ng-data".to_string(),
        ];
        assert!(modelscope_declared_file("model.onnx", &declared));
        assert!(modelscope_declared_file(
            "espeak-ng-data/lang/cmn",
            &declared
        ));
        assert!(!modelscope_declared_file("rule.far", &declared));
        assert!(!modelscope_declared_file("model.onnx.backup", &declared));
        assert!(!modelscope_declared_file("test_wavs/0.wav", &declared));
    }

    #[test]
    fn remote_catalog_cannot_remove_builtin_model_payload() {
        let builtin = serde_json::json!({
            "id": "example.model",
            "models": [{
                "id": "default",
                "files": ["required.bin"],
                "assets": [{"path": "rules/default.fst", "source": "https://example.com/default.fst"}],
                "repositoryHosted": true
            }]
        });
        let remote = serde_json::json!({
            "id": "example.model",
            "models": [{"id": "default", "files": ["legacy.bin"], "assets": []}]
        });

        let merged = merge_catalog_entry_payload(&builtin, remote);
        let model = &merged["models"][0];
        assert!(model["files"].as_array().is_some_and(|files| {
            files.iter().any(|file| file == "required.bin")
                && files.iter().any(|file| file == "legacy.bin")
        }));
        assert_eq!(model["assets"][0]["path"], "rules/default.fst");
        assert_eq!(model["repositoryHosted"], true);
    }

    #[test]
    fn modelscope_batch_progress_is_bounded_and_monotonic() {
        let progress = (0..=9)
            .map(|completed| batch_progress(38, 28, completed, 9))
            .collect::<Vec<_>>();
        assert_eq!(progress.first(), Some(&38));
        assert_eq!(progress.last(), Some(&66));
        assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(batch_progress(95, 20, 1, 1), 100);
        assert_eq!(batch_progress(24, 42, 0, 0), 24);
    }

    #[test]
    fn install_progress_stages_never_move_backwards() {
        let stages = [
            12,
            SHARED_RUNTIME_PROGRESS_BASE,
            SHARED_RUNTIME_PROGRESS_BASE + SHARED_RUNTIME_PROGRESS_SPAN,
            MODEL_PROGRESS_BASE,
            MODEL_PROGRESS_BASE + MODEL_PROGRESS_SPAN,
            68,
            ASSET_PROGRESS_BASE,
            ASSET_PROGRESS_BASE + ASSET_PROGRESS_SPAN,
            74,
            82,
            90,
            FINAL_INSTALL_PROGRESS,
            100,
        ];
        assert!(stages.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(stages.into_iter().all(|progress| progress <= 100));
    }

    #[test]
    fn shared_runtime_pointer_overrides_legacy_model_runtime() {
        let root =
            env::temp_dir().join(format!("qwen-audio-shared-runtime-{}", timestamp_millis()));
        let model = root.join("models").join("example");
        let runtime = root.join("runtimes").join("example-1").join("test");
        fs::create_dir_all(&model).expect("create model directory");
        fs::create_dir_all(&runtime).expect("create runtime directory");

        write_runtime_pointer(&model, &runtime).expect("write runtime pointer");
        mark_shared_runtime_ready(&model).expect("mark runtime ready");

        assert_eq!(runtime_directory_for_model(&model), runtime);
        assert!(runtime.join(RUNTIME_COMPLETE_FILE).is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_shared_runtime_falls_back_to_legacy_layout() {
        let root =
            env::temp_dir().join(format!("qwen-audio-legacy-runtime-{}", timestamp_millis()));
        fs::create_dir_all(&root).expect("create model directory");
        fs::write(root.join(RUNTIME_POINTER_FILE), "/missing/runtime")
            .expect("write stale runtime pointer");

        assert_eq!(runtime_directory_for_model(&root), root.join("runtime"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn downloaded_files_replace_partial_targets() {
        let root = env::temp_dir().join(format!("qwen-audio-plugin-{}", timestamp_millis()));
        fs::create_dir_all(&root).expect("create test directory");
        let source = root.join("source.bin");
        let target = root.join("nested").join("model.bin");
        fs::write(&source, b"complete").expect("write source");
        fs::create_dir_all(target.parent().expect("target parent")).expect("create target parent");
        fs::write(&target, b"").expect("write partial target");

        copy_download_atomically(&source, &target, "测试模型").expect("copy model");

        assert!(is_non_empty_file(&target));
        assert_eq!(fs::read(&target).expect("read target"), b"complete");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn funasr_runtime_binary_restores_executable_permission() {
        use std::os::unix::fs::PermissionsExt;

        let root = env::temp_dir().join(format!(
            "qwen-audio-funasr-permission-{}",
            timestamp_millis()
        ));
        let runtime = root.join("runtime");
        fs::create_dir_all(&runtime).expect("create runtime directory");
        let executable = runtime.join("llama-funasr-sensevoice");
        fs::write(&executable, b"runtime").expect("write runtime fixture");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o644))
            .expect("remove executable permission");

        let resolved = funasr_runtime_binary(&root, "llama-funasr-sensevoice")
            .expect("resolve FunASR runtime");

        assert_eq!(resolved, executable);
        assert_ne!(
            fs::metadata(&resolved)
                .expect("read repaired permissions")
                .permissions()
                .mode()
                & 0o111,
            0
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_v2_normalizes_to_harness_contract() {
        let raw: V2PluginManifest = serde_json::from_str(include_str!(
            "../../examples/plugins/web-audio-recorder/plugin.json"
        ))
        .expect("example manifest should parse");
        let manifest = normalize_v2_manifest(raw).expect("manifest should normalize");
        assert_eq!(manifest.schema_version, 2);
        assert_eq!(manifest.adapter, "web-audio");
        assert_eq!(manifest.capabilities, vec![CAPABILITY_LIVE]);
        assert!(manifest.model.is_none());
    }

    #[test]
    fn legacy_catalog_entries_infer_versioned_runtime_packages() {
        assert_eq!(
            runtime_package_for_entry("llama-funasr-cli"),
            "funasr-llamacpp-0.1.10"
        );
        assert_eq!(
            runtime_package_for_entry("cosyvoice.cpp"),
            "cosyvoice-cpp-0aaa9ef-b9837"
        );
        assert_eq!(runtime_package_for_entry("sherpa-onnx"), "");
    }

    #[test]
    fn manifest_v2_keeps_declarative_ports_and_parameters() {
        let raw: V2PluginManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "id": "example.streaming-asr",
            "name": "Example Streaming ASR",
            "version": "1.0.0",
            "publisher": "Example",
            "adapter": "streaming-zipformer",
            "capabilities": ["speech.asr"],
            "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
            "models": [],
            "inputs": [
                {"name": "audio", "type": "audio", "modes": ["batch", "stream"]}
            ],
            "outputs": [
                {"name": "transcript", "type": "transcript", "modes": ["stream"]}
            ],
            "parameters": [
                {
                    "name": "language",
                    "label": "Language",
                    "type": "enum",
                    "default": "auto",
                    "options": [{"label": "Auto", "value": "auto"}]
                }
            ]
        }))
        .expect("declarative manifest should parse");
        let manifest = normalize_v2_manifest(raw).expect("manifest should normalize");
        assert_eq!(manifest.inputs[0].port_type, "audio");
        assert_eq!(manifest.outputs[0].port_type, "transcript");
        assert_eq!(manifest.parameter_schema[0].name, "language");
        assert_eq!(
            manifest.parameter_schema[0].default_value,
            serde_json::json!("auto")
        );
    }

    #[test]
    fn manifest_validation_rejects_missing_declared_model_files() {
        let raw: V2PluginManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "id": "example.rnnoise",
            "name": "Example RNNoise",
            "version": "1.0.0",
            "publisher": "Example",
            "adapter": "rnnoise",
            "capabilities": ["audio.enhance"],
            "runtime": {"kind": "native", "entry": "nnnoiseless"},
            "models": [{
                "id": "rnnoise-default",
                "name": "RNNoise Default",
                "files": ["model.bin"]
            }]
        }))
        .expect("manifest should parse");
        let manifest = normalize_v2_manifest(raw).expect("manifest should normalize");
        let root = env::temp_dir().join(format!("qwen-audio-validation-{}", timestamp_millis()));
        let model = root.join("models").join("rnnoise-default");
        fs::create_dir_all(&model).expect("create model directory");

        assert!(validate_manifest(&root, &manifest).is_err());
        fs::write(model.join("model.bin"), b"complete").expect("write model file");
        assert!(validate_manifest(&root, &manifest).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_validation_accepts_declared_model_directories() {
        let raw: V2PluginManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "id": "example.kitten",
            "name": "Example Kitten",
            "version": "1.0.0",
            "publisher": "Example",
            "adapter": "kitten",
            "capabilities": ["speech.tts"],
            "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
            "models": [{
                "id": "kitten-model",
                "name": "Kitten Model",
                "files": ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data"]
            }]
        }))
        .expect("manifest should parse");
        let manifest = normalize_v2_manifest(raw).expect("manifest should normalize");
        let root = env::temp_dir().join(format!(
            "qwen-audio-directory-validation-{}",
            timestamp_millis()
        ));
        let model = root.join("models").join("kitten-model");
        fs::create_dir_all(model.join("espeak-ng-data")).expect("create model directory");
        for file in ["model.int8.onnx", "voices.bin", "tokens.txt"] {
            fs::write(model.join(file), b"complete").expect("write model file");
        }

        assert!(validate_manifest(&root, &manifest).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keyword_spotting_install_requires_builtin_keywords() {
        let raw: V2PluginManifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 2,
            "id": "example.keyword-spotting",
            "name": "Keyword Spotting",
            "version": "1.0.0",
            "publisher": "Example",
            "adapter": "keyword-spotting",
            "capabilities": ["speech.keyword"],
            "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
            "models": [{"id": "kws", "files": []}]
        }))
        .expect("manifest should parse");
        let manifest = normalize_v2_manifest(raw).expect("manifest should normalize");
        let root =
            env::temp_dir().join(format!("qwen-audio-kws-validation-{}", timestamp_millis()));
        let model = root.join("models").join("kws");
        fs::create_dir_all(&model).expect("create KWS model directory");
        for file in [
            "encoder.int8.onnx",
            "decoder.int8.onnx",
            "joiner.int8.onnx",
            "tokens.txt",
        ] {
            fs::write(model.join(file), b"complete").expect("write KWS fixture");
        }

        assert!(validate_manifest(&root, &manifest).is_err());
        let test_wavs = model.join("test_wavs");
        fs::create_dir_all(&test_wavs).expect("create KWS metadata directory");
        fs::write(test_wavs.join("keywords.txt"), b"hello").expect("write KWS keywords");
        assert!(validate_manifest(&root, &manifest).is_err());
        fs::write(test_wavs.join("keywords_raw.txt"), b"hello @hello")
            .expect("write raw KWS keywords");
        assert!(validate_manifest(&root, &manifest).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wetext_validation_rejects_incomplete_rule_sets() {
        let manifest = parse_manifest_value(
            serde_json::from_str(WETEXT_MANIFEST).expect("WeText manifest should parse"),
        )
        .expect("WeText manifest should normalize");
        let root = env::temp_dir().join(format!(
            "qwen-audio-wetext-validation-{}",
            timestamp_millis()
        ));
        let model = root.join("models").join("wetext-fsts-0.1.6");

        for &relative in WETEXT_REQUIRED_FILES {
            if relative == "wetext/fsts/full_to_half.fst" {
                continue;
            }
            let path = model.join(relative);
            fs::create_dir_all(path.parent().expect("rule parent")).expect("create rule parent");
            fs::write(path, b"complete").expect("write rule fixture");
        }
        assert!(validate_manifest(&root, &manifest).is_err());

        let missing = model.join("wetext/fsts/full_to_half.fst");
        fs::create_dir_all(missing.parent().expect("missing rule parent"))
            .expect("create missing rule parent");
        fs::write(missing, b"complete").expect("write missing rule fixture");
        assert!(validate_manifest(&root, &manifest).is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn adapter_registry_exposes_capability_contracts() {
        assert_eq!(adapter_capability("kokoro"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("vits"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("matcha"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("kitten"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("zipvoice"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("pocket-tts"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("supertonic"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("cosyvoice-local"), Some(CAPABILITY_TTS));
        assert_eq!(adapter_capability("funasr-nano"), Some(CAPABILITY_ASR));
        assert_eq!(adapter_capability("silero-vad"), Some(CAPABILITY_VAD));
        assert_eq!(adapter_capability("dpdfnet2"), Some(CAPABILITY_ENHANCE));
        assert_eq!(adapter_capability("gtcrn"), Some(CAPABILITY_ENHANCE));
        assert_eq!(
            adapter_capability("deepfilternet"),
            Some(CAPABILITY_ENHANCE)
        );
        assert_eq!(adapter_capability("rnnoise"), Some(CAPABILITY_ENHANCE));
        assert_eq!(adapter_capability("zipenhancer"), Some(CAPABILITY_ENHANCE));
        assert_eq!(
            adapter_capability("mossformer2-separation"),
            Some(CAPABILITY_SOURCE_SEPARATION)
        );
        assert_eq!(adapter_capability("unknown"), None);
        assert_eq!(adapter_streaming_mode("silero-vad"), "streaming");
        assert_eq!(adapter_streaming_mode("funasr-nano"), "streaming");
        assert_eq!(adapter_streaming_mode("wenet-ctc"), "batch");
    }

    #[test]
    fn remote_catalog_accepts_registered_adapters_with_verified_assets() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "plugins": [{
                "schemaVersion": 2,
                "id": "example.remote-wenet",
                "name": "Remote WeNet",
                "version": "1.0.0",
                "publisher": "Example",
                "adapter": "wenet-ctc",
                "capabilities": ["speech.asr"],
                "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
                "models": [{
                    "id": "wenet-int8",
                    "source": "https://example.com/model.tar.bz2",
                    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "files": ["model.int8.onnx", "tokens.txt"]
                }]
            }]
        }))
        .expect("serialize remote catalog");
        let catalog = parse_remote_catalog(&bytes).expect("parse remote catalog");
        assert_eq!(catalog.plugins.len(), 1);
    }

    #[test]
    fn published_model_catalog_matches_client_contract() {
        let catalog = parse_remote_catalog(include_bytes!("../../catalog/model-catalog.json"))
            .expect("parse published model catalog");
        assert!(catalog.plugins.len() >= 9);
    }

    #[test]
    fn embedded_catalog_payloads_only_use_modelscope_repository() {
        for plugin in builtin_catalog_values().expect("parse embedded catalog") {
            for model in plugin["models"]
                .as_array()
                .expect("catalog models should be an array")
            {
                let has_payload = model["files"]
                    .as_array()
                    .is_some_and(|files| !files.is_empty())
                    || model["repositoryHosted"].as_bool() == Some(true);
                if !has_payload {
                    continue;
                }
                assert_eq!(model["repositoryHosted"], true);
                assert_eq!(model["source"], "");
                assert!(model["assets"]
                    .as_array()
                    .is_some_and(|assets| assets.is_empty()));
            }
        }
    }

    #[test]
    fn inferred_asr_segmentation_uses_modelscope_fsmn_vad() {
        let dependencies = inferred_dependencies(&[CAPABILITY_ASR.to_string()], "wenet-ctc", &[]);
        assert_eq!(dependencies.len(), 1);
        assert_eq!(dependencies[0].plugin_id, "funaudiollm.fsmn-vad-gguf");
    }

    #[test]
    #[ignore = "requires QWEN_AUDIO_FUNASR_RUNTIME_ARCHIVE"]
    fn funasr_runtime_archive_contains_all_supported_binaries() {
        let archive = PathBuf::from(
            env::var("QWEN_AUDIO_FUNASR_RUNTIME_ARCHIVE")
                .expect("QWEN_AUDIO_FUNASR_RUNTIME_ARCHIVE is required"),
        );
        let root = env::temp_dir().join(format!("funasr-runtime-test-{}", timestamp_millis()));
        fs::create_dir_all(&root).expect("create runtime fixture");
        extract_model_download(&archive, &root, "runtime.tar.gz").expect("extract runtime");
        for binary in [
            "llama-funasr-cli",
            "llama-funasr-sensevoice",
            "llama-funasr-paraformer",
            "llama-funasr-vad",
        ] {
            assert!(
                find_file_named(&root, binary).unwrap().is_some(),
                "{binary}"
            );
        }
        let manifest = parse_manifest_value(
            serde_json::from_str(FUNASR_NANO_MANIFEST).expect("parse Nano manifest"),
        )
        .expect("normalize Nano manifest");
        let model = root.join("models").join("funasr-nano-2512-official-q4km");
        fs::create_dir_all(model.join("runtime")).expect("create model runtime");
        for file in [
            "funasr-encoder-f16.gguf",
            "qwen3-0.6b-q4km.gguf",
            "fsmn-vad.gguf",
        ] {
            fs::write(model.join(file), []).expect("create model fixture");
        }
        for binary in [
            "llama-funasr-cli",
            "llama-funasr-sensevoice",
            "llama-funasr-paraformer",
            "llama-funasr-vad",
        ] {
            fs::copy(
                find_file_named(&root, binary).unwrap().unwrap(),
                model.join("runtime").join(binary),
            )
            .expect("copy runtime fixture");
        }
        validate_manifest(&root, &manifest).expect("validate Nano fixture");
        fs::remove_dir_all(root).expect("remove runtime fixture");
    }

    #[test]
    fn remote_catalog_accepts_model_pack_dependencies() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "plugins": [
                {
                    "schemaVersion": 2,
                    "id": "example.remote-vad",
                    "name": "Remote VAD",
                    "version": "1.0.0",
                    "publisher": "Example",
                    "adapter": "silero-vad",
                    "capabilities": ["speech.vad"],
                    "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
                    "models": [{
                        "id": "vad-model",
                        "source": "https://example.com/vad.onnx",
                        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "files": ["silero_vad.onnx"]
                    }]
                },
                {
                    "schemaVersion": 2,
                    "id": "example.remote-asr",
                    "name": "Remote ASR",
                    "version": "1.0.0",
                    "publisher": "Example",
                    "adapter": "wenet-ctc",
                    "capabilities": ["speech.asr"],
                    "recommendedDependencies": [{
                        "role": "speech-segmentation",
                        "label": "Automatic segmentation",
                        "pluginId": "example.remote-vad",
                        "capability": "speech.detect",
                        "default": true,
                        "optional": true
                    }],
                    "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
                    "models": [{
                        "id": "asr-model",
                        "source": "https://example.com/asr.tar.bz2",
                        "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                        "files": ["model.int8.onnx", "tokens.txt"]
                    }]
                }
            ]
        }))
        .expect("serialize model pack");
        let catalog = parse_remote_catalog(&bytes).expect("parse model pack");
        assert_eq!(catalog.plugins.len(), 2);
    }

    #[test]
    fn remote_catalog_rejects_missing_pack_dependency() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "plugins": [{
                "schemaVersion": 2,
                "id": "example.remote-asr",
                "name": "Remote ASR",
                "version": "1.0.0",
                "publisher": "Example",
                "adapter": "wenet-ctc",
                "capabilities": ["speech.asr"],
                "recommendedDependencies": [{
                    "role": "speech-segmentation",
                    "label": "Automatic segmentation",
                    "pluginId": "example.missing-vad",
                    "capability": "speech.detect"
                }],
                "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
                "models": [{
                    "id": "asr-model",
                    "source": "https://example.com/asr.tar.bz2",
                    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "files": ["model.int8.onnx", "tokens.txt"]
                }]
            }]
        }))
        .expect("serialize invalid model pack");
        assert!(parse_remote_catalog(&bytes).is_err());
    }

    #[test]
    fn remote_catalog_accepts_supported_api_models() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "apiModels": [{
                "id": "bailian-next-asr",
                "name": "Next ASR",
                "author": "Example",
                "description": "Remote metadata for a supported API adapter.",
                "capabilities": ["ASR", "流式"],
                "harnessCapability": "speech.transcribe",
                "providerId": "api.bailian",
                "adapter": "bailian-funasr",
                "modelId": "next-asr-realtime",
                "aliases": ["legacy-asr-realtime"],
                "streamingMode": "streaming",
                "featured": false,
                "visible": true
            }]
        }))
        .expect("serialize remote API catalog");
        let catalog = parse_remote_catalog(&bytes).expect("parse remote API catalog");
        assert_eq!(catalog.api_models.len(), 1);
        assert_eq!(catalog.api_models[0].model_id, "next-asr-realtime");
        assert!(api_model_matches(
            &catalog.api_models[0],
            "api.bailian",
            CAPABILITY_ASR,
            "legacy-asr-realtime"
        ));
        assert!(!api_model_matches(
            &catalog.api_models[0],
            "api.bailian",
            CAPABILITY_TTS,
            "legacy-asr-realtime"
        ));
    }

    #[test]
    fn exported_catalog_matches_the_runtime_schema() {
        let catalog = parse_remote_catalog(include_bytes!("../../catalog/model-catalog.json"))
            .expect("parse exported model catalog");
        assert_eq!(catalog.api_models.len(), 16);
        assert!(catalog.api_models.iter().any(|model| model
            .aliases
            .iter()
            .any(|alias| alias == "fun-asr-realtime")));
    }

    #[test]
    fn remote_catalog_rejects_duplicate_api_aliases() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "apiModels": [{
                "id": "bailian-next-asr",
                "name": "Next ASR",
                "author": "Example",
                "harnessCapability": "speech.transcribe",
                "providerId": "api.bailian",
                "adapter": "bailian-funasr",
                "modelId": "next-asr-realtime",
                "aliases": ["legacy-asr", "legacy-asr"],
                "streamingMode": "streaming"
            }]
        }))
        .expect("serialize invalid API aliases");
        assert!(parse_remote_catalog(&bytes).is_err());
    }

    #[test]
    fn remote_catalog_rejects_unknown_adapters_and_unverified_assets() {
        for (adapter, sha256) in [
            (
                "unknown-runtime",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ),
            ("wenet-ctc", ""),
        ] {
            let bytes = serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "plugins": [{
                    "schemaVersion": 2,
                    "id": "example.invalid",
                    "name": "Invalid",
                    "version": "1.0.0",
                    "publisher": "Example",
                    "adapter": adapter,
                    "capabilities": ["speech.asr"],
                    "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
                    "models": [{
                        "id": "model",
                        "source": "https://example.com/model.onnx",
                        "sha256": sha256,
                        "files": ["model.int8.onnx"]
                    }]
                }]
            }))
            .expect("serialize invalid remote catalog");
            assert!(parse_remote_catalog(&bytes).is_err());
        }
    }

    #[test]
    fn remote_catalog_accepts_modelscope_hosted_variants() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "plugins": [{
                "schemaVersion": 2,
                "id": "example.hosted-asr",
                "name": "Hosted ASR",
                "version": "1.0.0",
                "publisher": "Example",
                "adapter": "wenet-ctc",
                "capabilities": ["speech.asr"],
                "runtime": {"kind": "onnx", "entry": "sherpa-onnx"},
                "models": [{
                    "id": "model-int8",
                    "source": "",
                    "files": ["model.int8.onnx", "tokens.txt"],
                    "repositoryHosted": true
                }]
            }]
        }))
        .expect("serialize hosted catalog");

        parse_remote_catalog(&bytes).expect("hosted catalog should validate");
    }

    #[test]
    fn configured_model_repository_catalog_is_valid() {
        let Ok(path) = env::var("QWEN_AUDIO_MODEL_CATALOG") else {
            return;
        };
        let bytes = fs::read(path).expect("read configured model catalog");
        parse_remote_catalog(&bytes).expect("configured model catalog should validate");
    }

    #[test]
    fn configured_installed_model_repository_is_runnable() {
        let Ok(path) = env::var("QWEN_AUDIO_AUDIT_PLUGIN_ROOT") else {
            return;
        };
        let root = PathBuf::from(path);
        let mut validated = 0;
        for entry in fs::read_dir(&root).expect("read audit plugin directory") {
            let plugin_root = entry.expect("read audit plugin entry").path();
            if !plugin_root.is_dir() {
                continue;
            }
            let manifest = read_manifest(&plugin_root.join("plugin.json"))
                .unwrap_or_else(|error| panic!("{}: {error}", plugin_root.display()));
            validate_manifest(&plugin_root, &manifest)
                .unwrap_or_else(|error| panic!("{}: {error}", plugin_root.display()));
            validated += 1;
        }
        assert!(validated >= 32, "expected the complete model repository");
    }

    #[test]
    #[ignore = "requires COSYVOICE_RUNTIME_ARCHIVE and COSYVOICE_GGML_ARCHIVE"]
    fn cosyvoice_runtime_archives_extract_into_a_runnable_layout() {
        let runtime_archive =
            PathBuf::from(env::var("COSYVOICE_RUNTIME_ARCHIVE").expect("runtime archive"));
        let ggml_archive = PathBuf::from(env::var("COSYVOICE_GGML_ARCHIVE").expect("GGML archive"));
        let root = env::temp_dir().join(format!("cosyvoice-runtime-test-{}", timestamp_millis()));
        let runtime_dir = root.join("runtime");
        let ggml_dir = runtime_dir.join("ggml");
        fs::create_dir_all(&ggml_dir).expect("create test directories");
        extract_runtime_archive(".tar.gz", &runtime_archive, &runtime_dir)
            .expect("extract CosyVoice runtime");
        extract_runtime_archive(".tar.gz", &ggml_archive, &ggml_dir).expect("extract GGML runtime");
        ensure_cosyvoice_backend_aliases(&root).expect("prepare GGML aliases");
        assert!(cosyvoice_runtime_executable(&root).is_ok());
        let backend = cosyvoice_backend_directory(&root).expect("locate GGML backend");
        if cfg!(target_os = "macos") {
            assert!(runtime_dir.join("libonnxruntime.1.dylib").is_file());
            assert!(backend.join("libggml-blas.0.dylib").is_file());
            assert!(backend.join("libggml-rpc.0.dylib").is_file());
        } else if cfg!(target_os = "linux") {
            assert!(runtime_dir.join("libonnxruntime.so.1").is_file());
            assert!(backend.join("libggml-blas.so.0").is_file());
            assert!(backend.join("libggml-rpc.so.0").is_file());
        }
        fs::remove_dir_all(root).expect("remove test runtime");
    }

    #[test]
    fn catalog_manifests_parse_and_use_registered_adapters() {
        for raw in CATALOG_MANIFESTS {
            let parsed: V2PluginManifest =
                serde_json::from_str(raw).expect("catalog manifest should parse");
            assert!(
                adapter_spec(&parsed.adapter).is_some(),
                "{} uses unknown adapter {}",
                parsed.id,
                parsed.adapter
            );
            let normalized =
                normalize_v2_manifest(parsed).expect("catalog manifest should normalize");
            assert_eq!(normalized.capabilities.len(), 1);
        }
    }

    #[test]
    fn official_funasr_catalog_models_are_modelscope_only() {
        for raw in [
            FUNASR_NANO_MANIFEST,
            SENSEVOICE_GGUF_MANIFEST,
            PARAFORMER_GGUF_MANIFEST,
            FSMN_VAD_GGUF_MANIFEST,
        ] {
            let parsed: V2PluginManifest =
                serde_json::from_str(raw).expect("FunASR manifest should parse");
            let normalized =
                normalize_v2_manifest(parsed).expect("FunASR manifest should normalize");
            let model = normalized
                .model
                .expect("FunASR manifest should have a model");
            assert!(model.repository_hosted);
            assert!(model.source.is_empty());
            assert!(model.assets.is_empty());
        }
    }

    #[test]
    fn funasr_nano_catalog_pack_contains_its_vad_without_external_dependencies() {
        let parsed: V2PluginManifest =
            serde_json::from_str(FUNASR_NANO_MANIFEST).expect("FunASR Nano manifest should parse");
        let normalized =
            normalize_v2_manifest(parsed).expect("FunASR Nano manifest should normalize");

        assert!(normalized.recommended_dependencies.is_empty());
        assert!(normalized
            .model
            .expect("FunASR Nano manifest should have a model")
            .files
            .iter()
            .any(|file| file == "fsmn-vad.gguf"));
    }

    #[test]
    fn multi_asset_tts_models_keep_their_vocoders() {
        for raw in [ZIPVOICE_MANIFEST, MATCHA_TTS_MANIFEST] {
            let parsed: V2PluginManifest =
                serde_json::from_str(raw).expect("multi-asset manifest should parse");
            let normalized =
                normalize_v2_manifest(parsed).expect("multi-asset manifest should normalize");
            let model = normalized.model.expect("model is required");
            assert_eq!(model.assets.len(), 1);
            assert!(model.assets[0].source.starts_with("https://"));
            assert!(model.assets[0].path.ends_with(".onnx"));
        }
    }

    #[test]
    fn catalog_variants_default_to_int8_and_honor_selection() {
        let variants = vec![
            serde_json::json!({"id": "model-fp32", "precision": "FP32"}),
            serde_json::json!({"id": "model-int8", "precision": "INT8"}),
        ];
        assert_eq!(select_variant_index(&variants, None).unwrap(), 1);
        assert_eq!(
            select_variant_index(&variants, Some("model-fp32")).unwrap(),
            0
        );
        assert!(select_variant_index(&variants, Some("missing")).is_err());
    }

    #[test]
    fn rejects_unsafe_plugin_ids_and_paths() {
        assert!(validate_plugin_id("org.qwenaudio.toolkits.kokoro-2").is_ok());
        assert!(validate_plugin_id("../escape").is_err());
        assert!(safe_join(Path::new("/tmp/root"), "model/files").is_ok());
        assert!(safe_join(Path::new("/tmp/root"), "../outside").is_err());
    }
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
