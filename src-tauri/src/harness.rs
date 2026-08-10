use crate::{
    advanced_models::{
        run_audio_tagging, run_diarization, run_keyword_spotting, run_language_id, run_punctuation,
        run_source_separation, run_speaker_embedding,
    },
    asr::{
        create_streaming_asr_recognizer, transcribe_audio_with_runtime, transcribe_streaming_audio,
        AsrProgressCallback, AsrRuntime, AsrTranscribeRequest,
    },
    audio_io::{
        decode_wav_bytes, decode_wav_data_url, encode_wav_bytes, normalize_generated_speech,
        resample_audio, wav_data_url, waveform_envelope, webview_safe_wav_bytes, PcmAudio,
    },
    audio_processing::{
        process_audio_with_runtime, AudioProcessRequest, AudioProcessingRuntime, StreamingEnhancer,
        RNNOISE_SAMPLE_RATE,
    },
    plugins,
    tts::{generate_speech_with_runtime, TtsGenerateRequest, TtsRuntime},
    vad::{
        create_streaming_vad, detect_speech_with_model, StreamingVad, StreamingVadUpdate,
        VadDetectRequest,
    },
    wetext::normalize_text,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc as std_mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};
use uuid::Uuid;

pub const CAPABILITY_TTS: &str = "speech.synthesize";
pub const CAPABILITY_ASR: &str = "speech.transcribe";
pub const CAPABILITY_VAD: &str = "speech.detect";
pub const CAPABILITY_TEXT: &str = "text.generate";
pub const CAPABILITY_ENHANCE: &str = "audio.enhance";
pub const CAPABILITY_LIVE: &str = "audio.live";
pub const CAPABILITY_AUDIO_TAGGING: &str = "audio.classify";
pub const CAPABILITY_KWS: &str = "speech.keyword";
pub const CAPABILITY_LANGUAGE_ID: &str = "speech.language";
pub const CAPABILITY_PUNCTUATION: &str = "text.punctuate";
pub const CAPABILITY_TEXT_NORMALIZE: &str = "text.normalize";
pub const CAPABILITY_SPEAKER_EMBED: &str = "speaker.embed";
pub const CAPABILITY_DIARIZATION: &str = "speaker.diarize";
pub const CAPABILITY_SOURCE_SEPARATION: &str = "audio.separate";

const API_PROVIDER_ID: &str = "api.openai-compatible";
const BAILIAN_PROVIDER_ID: &str = "api.bailian";
const SENSEVOICE_GGUF_PROVIDER_ID: &str = "plugin.funaudiollm.sensevoice-small-gguf";
const BAILIAN_TTS_MODEL: &str = "qwen-audio-3.0-tts-flash";
const BAILIAN_TTS_PLUS_MODEL: &str = "qwen-audio-3.0-tts-plus";
const BAILIAN_QWEN_ASR_MODEL: &str = "qwen3-asr-flash";
const BAILIAN_FUN_ASR_MODEL: &str = "fun-asr-realtime";
const BAILIAN_FUN_ASR_8K_MODEL: &str = "fun-asr-flash-8k-realtime";
const BAILIAN_PARAFORMER_MODEL: &str = "paraformer-realtime-v2";
const BAILIAN_PARAFORMER_8K_MODEL: &str = "paraformer-realtime-8k-v2";
const BAILIAN_QWEN_36_PLUS_MODEL: &str = "qwen3.6-plus";
const BAILIAN_QWEN_37_PLUS_MODEL: &str = "qwen3.7-plus";
const BAILIAN_COSYVOICE_MODEL: &str = "cosyvoice-v2";
const BAILIAN_COSYVOICE_3_PLUS_MODEL: &str = "cosyvoice-v3-plus";
const BAILIAN_COSYVOICE_35_PLUS_MODEL: &str = "cosyvoice-v3.5-plus";
const BAILIAN_COSYVOICE_35_FLASH_MODEL: &str = "cosyvoice-v3.5-flash";
const BAILIAN_DENOISE_MODEL: &str = "fun-audio-denoising";
const LOCAL_STREAMING_ASR_SAMPLE_RATE: u32 = 16_000;
const MAX_RUNS: usize = 250;
const INLINE_ARTIFACT_PAYLOAD_LIMIT: usize = 256 * 1024;
const EXTERNAL_PAYLOAD_KEY: &str = "__payloadFile";
static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn default_conversation_visible() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BailianModelKind {
    Tts,
    CosyVoice,
    Asr,
    FunAsr,
    Text,
    Enhance,
}

fn bailian_model_kind(model: &str) -> Option<BailianModelKind> {
    match model {
        BAILIAN_TTS_MODEL | BAILIAN_TTS_PLUS_MODEL => Some(BailianModelKind::Tts),
        BAILIAN_COSYVOICE_MODEL
        | BAILIAN_COSYVOICE_3_PLUS_MODEL
        | BAILIAN_COSYVOICE_35_PLUS_MODEL
        | BAILIAN_COSYVOICE_35_FLASH_MODEL => Some(BailianModelKind::CosyVoice),
        BAILIAN_QWEN_ASR_MODEL => Some(BailianModelKind::Asr),
        BAILIAN_FUN_ASR_MODEL
        | BAILIAN_FUN_ASR_8K_MODEL
        | BAILIAN_PARAFORMER_MODEL
        | BAILIAN_PARAFORMER_8K_MODEL => Some(BailianModelKind::FunAsr),
        BAILIAN_QWEN_36_PLUS_MODEL | BAILIAN_QWEN_37_PLUS_MODEL => Some(BailianModelKind::Text),
        BAILIAN_DENOISE_MODEL => Some(BailianModelKind::Enhance),
        _ => None,
    }
}

fn bailian_model_supports_capability(capability: &str, model: &str) -> bool {
    match capability {
        CAPABILITY_TTS => matches!(
            bailian_model_kind(model),
            Some(BailianModelKind::Tts | BailianModelKind::CosyVoice)
        ),
        CAPABILITY_ASR => matches!(
            bailian_model_kind(model),
            Some(BailianModelKind::Asr | BailianModelKind::FunAsr)
        ),
        CAPABILITY_TEXT => matches!(bailian_model_kind(model), Some(BailianModelKind::Text)),
        CAPABILITY_ENHANCE => {
            matches!(bailian_model_kind(model), Some(BailianModelKind::Enhance))
        }
        CAPABILITY_SOURCE_SEPARATION => false,
        _ => false,
    }
}

fn bailian_adapter_for(capability: &str, model: &str) -> &'static str {
    if matches!(
        capability,
        CAPABILITY_ENHANCE | CAPABILITY_SOURCE_SEPARATION
    ) {
        return "bailian-audio-process";
    }
    match bailian_model_kind(model) {
        Some(BailianModelKind::FunAsr) => "bailian-funasr",
        Some(BailianModelKind::CosyVoice) => "bailian-cosyvoice",
        Some(BailianModelKind::Text) => "bailian-llm",
        _ => "bailian",
    }
}

fn is_bailian_funasr_model(model: &str) -> bool {
    matches!(bailian_model_kind(model), Some(BailianModelKind::FunAsr))
}

fn bailian_cosyvoice_model(model: Option<&str>) -> Result<&str, String> {
    let model = model.unwrap_or(BAILIAN_COSYVOICE_MODEL);
    if matches!(bailian_model_kind(model), Some(BailianModelKind::CosyVoice)) {
        Ok(model)
    } else {
        Err(format!("模型 {model} 不支持 CosyVoice 流式合成"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTaskRequest {
    pub(crate) run_id: Option<String>,
    #[serde(default)]
    conversation_provider_id: Option<String>,
    #[serde(default = "default_conversation_visible")]
    conversation_visible: bool,
    #[serde(default)]
    dependency_run_ids: Vec<String>,
    capability: String,
    provider_id: Option<String>,
    routing: Option<String>,
    title: Option<String>,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    parameters: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessArtifact {
    id: String,
    kind: String,
    name: String,
    mime_type: String,
    file_path: Option<String>,
    duration: Option<f32>,
    size_bytes: Option<u64>,
    payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRun {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_provider_id: Option<String>,
    #[serde(default = "default_conversation_visible")]
    conversation_visible: bool,
    #[serde(default)]
    dependency_run_ids: Vec<String>,
    capability: String,
    title: String,
    input_summary: String,
    provider_id: String,
    provider_name: String,
    model_id: String,
    status: String,
    progress: u8,
    #[serde(default)]
    activity: Option<String>,
    created_at: u64,
    started_at: Option<u64>,
    completed_at: Option<u64>,
    duration_ms: Option<u64>,
    artifacts: Vec<HarnessArtifact>,
    error: Option<String>,
    retryable: bool,
}

impl HarnessArtifact {
    fn summary(&self) -> Self {
        Self {
            id: self.id.clone(),
            kind: self.kind.clone(),
            name: self.name.clone(),
            mime_type: self.mime_type.clone(),
            file_path: self.file_path.clone(),
            duration: self.duration,
            size_bytes: self.size_bytes,
            payload: Value::Null,
        }
    }
}

impl HarnessRun {
    fn summary(&self) -> Self {
        Self {
            id: self.id.clone(),
            conversation_provider_id: self.conversation_provider_id.clone(),
            conversation_visible: self.conversation_visible,
            dependency_run_ids: self.dependency_run_ids.clone(),
            capability: self.capability.clone(),
            title: self.title.clone(),
            input_summary: self.input_summary.clone(),
            provider_id: self.provider_id.clone(),
            provider_name: self.provider_name.clone(),
            model_id: self.model_id.clone(),
            status: self.status.clone(),
            progress: self.progress,
            activity: self.activity.clone(),
            created_at: self.created_at,
            started_at: self.started_at,
            completed_at: self.completed_at,
            duration_ms: self.duration_ms,
            artifacts: self
                .artifacts
                .iter()
                .map(HarnessArtifact::summary)
                .collect(),
            error: self.error.clone(),
            retryable: self.retryable,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessExecution {
    run: HarnessRun,
    output: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCatalog {
    capabilities: Vec<CapabilityDescriptor>,
    providers: Vec<ProviderDescriptor>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityDescriptor {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    input: &'static str,
    output: &'static str,
    supports_batch: bool,
    supports_streaming: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDescriptor {
    id: String,
    name: String,
    kind: String,
    runtime: String,
    status: String,
    configured: bool,
    local: bool,
    capabilities: Vec<String>,
    models: Vec<ModelDescriptor>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelDescriptor {
    id: String,
    name: String,
    installed: bool,
    loaded: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiProviderConfig {
    name: String,
    base_url: String,
    api_key: String,
    tts_model: String,
    tts_voice: String,
    asr_model: String,
    #[serde(default = "default_llm_model")]
    llm_model: String,
    enabled: bool,
}

fn default_llm_model() -> String {
    "qwen-plus".to_string()
}

impl Default for ApiProviderConfig {
    fn default() -> Self {
        Self {
            name: "OpenAI-compatible API".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: String::new(),
            tts_model: "gpt-4o-mini-tts".to_string(),
            tts_voice: "alloy".to_string(),
            asr_model: "gpt-4o-mini-transcribe".to_string(),
            llm_model: default_llm_model(),
            enabled: false,
        }
    }
}

impl ApiProviderConfig {
    fn configured(&self) -> bool {
        let local = self.base_url.starts_with("http://127.0.0.1")
            || self.base_url.starts_with("http://localhost");
        self.enabled
            && (self.base_url.starts_with("https://") || local)
            && (local || !self.api_key.trim().is_empty())
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderUpdate {
    name: String,
    base_url: String,
    api_key: Option<String>,
    tts_model: String,
    tts_voice: String,
    asr_model: String,
    llm_model: String,
    enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderSettings {
    id: &'static str,
    name: String,
    base_url: String,
    api_key_configured: bool,
    tts_model: String,
    tts_voice: String,
    asr_model: String,
    llm_model: String,
    enabled: bool,
    status: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BailianProviderConfig {
    name: String,
    base_url: String,
    api_key: String,
    tts_model: String,
    tts_voice: String,
    asr_model: String,
    enabled: bool,
}

impl Default for BailianProviderConfig {
    fn default() -> Self {
        Self {
            name: "阿里云百炼".to_string(),
            base_url: "https://dashscope.aliyuncs.com".to_string(),
            api_key: String::new(),
            tts_model: "qwen-audio-3.0-tts-flash".to_string(),
            tts_voice: "longanhuan_v3.6".to_string(),
            asr_model: "qwen3-asr-flash".to_string(),
            enabled: false,
        }
    }
}

impl BailianProviderConfig {
    fn configured(&self) -> bool {
        self.enabled && !self.api_key.trim().is_empty()
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BailianProviderUpdate {
    api_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BailianVoiceCreateRequest {
    target_model: String,
    mode: String,
    prefix: String,
    language: Option<String>,
    audio_data_url: Option<String>,
    voice_prompt: Option<String>,
    preview_text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BailianVoice {
    id: String,
    target_model: String,
    status: String,
    created_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BailianProviderSettings {
    id: &'static str,
    name: String,
    api_key_configured: bool,
    enabled: bool,
    status: &'static str,
}

#[derive(Default)]
pub struct HarnessRuntime {
    runs: Mutex<Vec<HarnessRun>>,
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
    funasr_streams: Mutex<HashMap<String, mpsc::Sender<FunAsrStreamCommand>>>,
    vad_streams: Mutex<HashMap<String, StreamingVad>>,
    enhancement_streams: Mutex<HashMap<String, EnhancementStreamHandle>>,
    initialized: AtomicBool,
}

enum FunAsrStreamCommand {
    Audio(Vec<u8>),
    Finish,
}

struct EnhancementStreamHandle {
    sender: std_mpsc::Sender<EnhancementStreamCommand>,
}

enum EnhancementStreamCommand {
    Audio {
        pcm: Vec<u8>,
        response: std_mpsc::Sender<Result<Vec<u8>, String>>,
    },
    Finish {
        response: std_mpsc::Sender<Result<Vec<u8>, String>>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunAsrStreamStartRequest {
    clip_name: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    sample_rate: u32,
    language: Option<String>,
    context: Option<String>,
    semantic_punctuation: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunAsrStreamStartResponse {
    session_id: String,
    run: HarnessRun,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VadStreamStartRequest {
    provider_id: Option<String>,
    model_id: Option<String>,
    adapter: Option<String>,
    threshold: Option<f32>,
    min_speech_duration: Option<f32>,
    min_silence_duration: Option<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadStreamStartResponse {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancementStreamStartRequest {
    provider_id: String,
    sample_rate: u32,
    strength: Option<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancementStreamStartResponse {
    session_id: String,
    sample_rate: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancementStreamChunk {
    pcm_base64: String,
    sample_rate: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CosyVoiceStreamStartRequest {
    text: String,
    model_id: Option<String>,
    voice: Option<String>,
    speed: Option<f32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CosyVoiceStreamStartResponse {
    session_id: String,
    run: HarnessRun,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FunAsrStreamEvent {
    session_id: String,
    run_id: String,
    kind: &'static str,
    text: String,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CosyVoiceStreamEvent {
    session_id: String,
    run_id: String,
    kind: &'static str,
    pcm_base64: Option<String>,
    sample_rate: u32,
    chunk_index: Option<u64>,
    error: Option<String>,
}

#[derive(Clone)]
struct ResolvedProvider {
    id: String,
    name: String,
    model_id: String,
    is_api: bool,
    adapter: String,
    model_path: Option<PathBuf>,
}

impl HarnessRuntime {
    pub(crate) fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        if self.initialized.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        let path = runs_path(app)?;
        let mut loaded = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Vec<HarnessRun>>(&bytes)
                .map_err(|error| format!("无法读取运行历史: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(format!("无法打开运行历史: {error}")),
        };
        let mut compacted = false;
        for run in &mut loaded {
            compacted |= externalize_run_payloads(app, run)?;
        }
        if compacted {
            write_runs_file(&path, &loaded)?;
        }
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "运行历史状态不可用".to_string())?;
        *runs = loaded;
        Ok(())
    }

    pub(crate) fn list(&self, app: &AppHandle) -> Result<Vec<HarnessRun>, String> {
        self.initialize(app)?;
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "运行历史状态不可用".to_string())?
            .iter()
            .map(HarnessRun::summary)
            .collect::<Vec<_>>();
        runs.sort_by_key(|run| std::cmp::Reverse(run.created_at));
        Ok(runs)
    }

    pub(crate) fn get(&self, app: &AppHandle, run_id: &str) -> Result<HarnessRun, String> {
        self.initialize(app)?;
        self.runs
            .lock()
            .map_err(|_| "运行历史状态不可用".to_string())?
            .iter()
            .find(|run| run.id == run_id)
            .cloned()
            .ok_or_else(|| format!("找不到运行记录 {run_id}"))
    }

    fn insert(&self, app: &AppHandle, mut run: HarnessRun) -> Result<(), String> {
        self.initialize(app)?;
        externalize_run_payloads(app, &mut run)?;
        {
            let mut runs = self
                .runs
                .lock()
                .map_err(|_| "运行历史状态不可用".to_string())?;
            if runs.iter().any(|item| item.id == run.id) {
                return Err("运行 ID 已存在".to_string());
            }
            runs.push(run);
            if runs.len() > MAX_RUNS {
                runs.sort_by_key(|run| std::cmp::Reverse(run.created_at));
                runs.truncate(MAX_RUNS);
            }
        }
        self.persist(app)
    }

    fn update(
        &self,
        app: &AppHandle,
        run_id: &str,
        change: impl FnOnce(&mut HarnessRun),
    ) -> Result<HarnessRun, String> {
        self.initialize(app)?;
        let updated = {
            let mut runs = self
                .runs
                .lock()
                .map_err(|_| "运行历史状态不可用".to_string())?;
            let run = runs
                .iter_mut()
                .find(|run| run.id == run_id)
                .ok_or_else(|| format!("找不到运行记录 {run_id}"))?;
            change(run);
            externalize_run_payloads(app, run)?;
            run.clone()
        };
        self.persist(app)?;
        Ok(updated)
    }

    pub(crate) fn remove(&self, app: &AppHandle, run_id: &str) -> Result<(), String> {
        self.initialize(app)?;
        if self
            .active
            .lock()
            .map_err(|_| "运行状态不可用".to_string())?
            .contains_key(run_id)
        {
            return Err("运行中的任务不能删除，请先取消".to_string());
        }
        {
            let mut runs = self
                .runs
                .lock()
                .map_err(|_| "运行历史状态不可用".to_string())?;
            let before = runs.len();
            runs.retain(|run| run.id != run_id);
            if runs.len() == before {
                return Err(format!("找不到运行记录 {run_id}"));
            }
        }
        self.persist(app)?;
        let request_path = request_path(app, run_id)?;
        if request_path.exists() {
            fs::remove_file(request_path).map_err(|error| format!("无法删除重试数据: {error}"))?;
        }
        let artifact_dir = artifact_payload_dir(app, run_id)?;
        if artifact_dir.exists() {
            fs::remove_dir_all(artifact_dir)
                .map_err(|error| format!("无法删除运行产物缓存: {error}"))?;
        }
        Ok(())
    }

    fn persist(&self, app: &AppHandle) -> Result<(), String> {
        let path = runs_path(app)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建运行历史目录: {error}"))?;
        }
        let runs = self
            .runs
            .lock()
            .map_err(|_| "运行历史状态不可用".to_string())?
            .clone();
        write_runs_file(&path, &runs)
    }
}

#[tauri::command]
pub fn harness_catalog(app: AppHandle) -> HarnessCatalog {
    catalog_for_app(&app)
}

pub(crate) fn catalog_for_app(app: &AppHandle) -> HarnessCatalog {
    let bailian = read_bailian_provider_config(app).unwrap_or_default();
    let model = |status: Option<Value>, fallback_id: &str, fallback_name: &str| {
        let installed = status
            .as_ref()
            .and_then(|value| value.get("installed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let loaded = status
            .as_ref()
            .and_then(|value| value.get("loaded"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let id = status
            .as_ref()
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            .unwrap_or(fallback_id)
            .to_string();
        let name = status
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(fallback_name)
            .to_string();
        ModelDescriptor {
            id,
            name,
            installed,
            loaded,
        }
    };

    let vad_model = crate::vad::model_status(app)
        .ok()
        .and_then(|status| serde_json::to_value(status).ok());
    let vad_model = model(vad_model, "silero-vad", "Silero VAD");
    let vad_enabled =
        plugins::is_plugin_installed(app, "silero-vad").unwrap_or(vad_model.installed);
    let stream_enabled = plugins::is_plugin_installed(app, "web-audio-stream").unwrap_or(true);

    HarnessCatalog {
        capabilities: vec![
            CapabilityDescriptor {
                id: CAPABILITY_TTS,
                name: "音频生成",
                description: "从文字生成可编辑的音频文件",
                input: "text",
                output: "audio",
                supports_batch: true,
                supports_streaming: true,
            },
            CapabilityDescriptor {
                id: CAPABILITY_ASR,
                name: "语音识别",
                description: "识别语音并输出分段与时间戳",
                input: "audio",
                output: "transcript",
                supports_batch: true,
                supports_streaming: true,
            },
            CapabilityDescriptor {
                id: CAPABILITY_VAD,
                name: "语音活动检测",
                description: "检测语音区间并输出可定位、播放的时间片段",
                input: "audio",
                output: "speech-segments",
                supports_batch: true,
                supports_streaming: true,
            },
            CapabilityDescriptor {
                id: CAPABILITY_TEXT,
                name: "文本生成",
                description: "根据消息上下文生成回复、摘要或结构化文本",
                input: "messages",
                output: "text",
                supports_batch: true,
                supports_streaming: true,
            },
            CapabilityDescriptor {
                id: CAPABILITY_ENHANCE,
                name: "音频增强",
                description: "执行降噪、静音压缩、响度与淡化处理",
                input: "audio",
                output: "audio",
                supports_batch: true,
                supports_streaming: true,
            },
            CapabilityDescriptor {
                id: CAPABILITY_LIVE,
                name: "实时音频",
                description: "连接麦克风、监控并录制音频流",
                input: "stream",
                output: "stream",
                supports_batch: false,
                supports_streaming: true,
            },
            CapabilityDescriptor {
                id: CAPABILITY_AUDIO_TAGGING,
                name: "音频标签",
                description: "识别环境声、事件和音频场景",
                input: "audio",
                output: "audio-tags",
                supports_batch: true,
                supports_streaming: false,
            },
            CapabilityDescriptor {
                id: CAPABILITY_KWS,
                name: "关键词检测",
                description: "检测音频流中的关键词和唤醒词",
                input: "audio-stream",
                output: "keyword-events",
                supports_batch: true,
                supports_streaming: true,
            },
            CapabilityDescriptor {
                id: CAPABILITY_LANGUAGE_ID,
                name: "语言识别",
                description: "判断语音所使用的语言",
                input: "audio",
                output: "language",
                supports_batch: true,
                supports_streaming: false,
            },
            CapabilityDescriptor {
                id: CAPABILITY_PUNCTUATION,
                name: "标点恢复",
                description: "为识别文本恢复中英文标点",
                input: "text",
                output: "text",
                supports_batch: true,
                supports_streaming: false,
            },
            CapabilityDescriptor {
                id: CAPABILITY_TEXT_NORMALIZE,
                name: "文本归一化",
                description: "执行中英日 TN 与 ITN 文本归一化",
                input: "text",
                output: "text",
                supports_batch: true,
                supports_streaming: false,
            },
            CapabilityDescriptor {
                id: CAPABILITY_SPEAKER_EMBED,
                name: "声纹提取",
                description: "提取可用于识别和聚类的说话人向量",
                input: "audio",
                output: "speaker-embedding",
                supports_batch: true,
                supports_streaming: false,
            },
            CapabilityDescriptor {
                id: CAPABILITY_DIARIZATION,
                name: "说话人分离",
                description: "输出不同说话人的时间区间",
                input: "audio",
                output: "speaker-segments",
                supports_batch: true,
                supports_streaming: false,
            },
            CapabilityDescriptor {
                id: CAPABILITY_SOURCE_SEPARATION,
                name: "人声分离",
                description: "将混合音频拆分为人声和伴奏",
                input: "audio",
                output: "audio-tracks",
                supports_batch: true,
                supports_streaming: false,
            },
        ],
        providers: {
            let mut providers = vec![
                ProviderDescriptor {
                    id: "local.silero-vad".to_string(),
                    name: "Silero VAD".to_string(),
                    kind: "local-model".to_string(),
                    runtime: "sherpa-onnx".to_string(),
                    status: if !vad_model.installed {
                        "missing"
                    } else if vad_enabled {
                        "ready"
                    } else {
                        "disabled"
                    }
                    .to_string(),
                    configured: vad_model.installed && vad_enabled,
                    local: true,
                    capabilities: vec![CAPABILITY_VAD.to_string()],
                    models: vec![vad_model],
                },
                ProviderDescriptor {
                    id: "local.web-audio".to_string(),
                    name: "Web Audio Stream".to_string(),
                    kind: "local-runtime".to_string(),
                    runtime: "Web Audio".to_string(),
                    status: if stream_enabled { "ready" } else { "disabled" }.to_string(),
                    configured: stream_enabled,
                    local: true,
                    capabilities: vec![CAPABILITY_LIVE.to_string()],
                    models: Vec::new(),
                },
                ProviderDescriptor {
                    id: BAILIAN_PROVIDER_ID.to_string(),
                    name: bailian.name.clone(),
                    kind: "api".to_string(),
                    runtime: trim_endpoint(&bailian.base_url),
                    status: if bailian.configured() {
                        "ready"
                    } else {
                        "unconfigured"
                    }
                    .to_string(),
                    configured: bailian.configured(),
                    local: false,
                    capabilities: vec![
                        CAPABILITY_TTS.to_string(),
                        CAPABILITY_ASR.to_string(),
                        CAPABILITY_TEXT.to_string(),
                        CAPABILITY_ENHANCE.to_string(),
                    ],
                    models: vec![
                        ModelDescriptor {
                            id: BAILIAN_TTS_MODEL.to_string(),
                            name: "Qwen Audio 3.0 TTS Flash".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_TTS_PLUS_MODEL.to_string(),
                            name: "Qwen Audio 3.0 TTS Plus".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_QWEN_ASR_MODEL.to_string(),
                            name: "Qwen3 ASR Flash".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_FUN_ASR_MODEL.to_string(),
                            name: "FunASR Realtime".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_FUN_ASR_8K_MODEL.to_string(),
                            name: "FunASR Flash 8K Realtime".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_PARAFORMER_MODEL.to_string(),
                            name: "Paraformer Realtime v2".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_PARAFORMER_8K_MODEL.to_string(),
                            name: "Paraformer Realtime 8K v2".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_QWEN_36_PLUS_MODEL.to_string(),
                            name: "Qwen3.6 Plus".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_QWEN_37_PLUS_MODEL.to_string(),
                            name: "Qwen3.7 Plus".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_COSYVOICE_MODEL.to_string(),
                            name: "CosyVoice v2".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_COSYVOICE_35_PLUS_MODEL.to_string(),
                            name: "CosyVoice v3.5 Plus".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_COSYVOICE_35_FLASH_MODEL.to_string(),
                            name: "CosyVoice v3.5 Flash".to_string(),
                            installed: true,
                            loaded: false,
                        },
                        ModelDescriptor {
                            id: BAILIAN_DENOISE_MODEL.to_string(),
                            name: "Fun Audio Denoising".to_string(),
                            installed: true,
                            loaded: false,
                        },
                    ],
                },
            ];
            if let Ok(plugin_providers) = plugins::installed_providers(app) {
                providers.extend(
                    plugin_providers
                        .into_iter()
                        .map(|provider| ProviderDescriptor {
                            id: provider.provider_id,
                            name: provider.name,
                            kind: "plugin".to_string(),
                            runtime: provider.runtime,
                            status: "ready".to_string(),
                            configured: true,
                            local: true,
                            capabilities: provider.capabilities,
                            models: vec![ModelDescriptor {
                                id: provider.model_id,
                                name: provider.model_name,
                                installed: true,
                                loaded: false,
                            }],
                        }),
                );
            }
            providers
        },
    }
}

#[tauri::command]
pub fn harness_list_runs(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
) -> Result<Vec<HarnessRun>, String> {
    runtime.list(&app)
}

#[tauri::command]
pub fn harness_get_run(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    run_id: String,
) -> Result<HarnessRun, String> {
    runtime.get(&app, &run_id)
}

#[tauri::command]
pub fn harness_get_run_output(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    run_id: String,
) -> Result<HarnessExecution, String> {
    get_run_output(&app, runtime.inner(), &run_id)
}

#[tauri::command]
pub fn harness_get_run_preview(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    run_id: String,
) -> Result<HarnessExecution, String> {
    get_run_preview(&app, runtime.inner(), &run_id)
}

pub(crate) fn get_run_preview(
    app: &AppHandle,
    runtime: &Arc<HarnessRuntime>,
    run_id: &str,
) -> Result<HarnessExecution, String> {
    let run = runtime.get(app, run_id)?;
    let artifact = run
        .artifacts
        .first()
        .ok_or_else(|| "该运行还没有可读取的产物".to_string())?;
    let mut output = stored_payload(artifact)?;
    if let Some(object) = output.as_object_mut() {
        object.remove("dataUrl");
        object.remove("sourceAudioDataUrl");
        if capability_accepts_audio(&run.capability) {
            if let Ok(source_path) = ensure_source_audio_file(app, run_id) {
                object.insert(
                    "sourceAudioFilePath".to_string(),
                    Value::String(path_string(&source_path)),
                );
            }
        }
        if let Some(tracks) = object.get_mut("tracks").and_then(Value::as_array_mut) {
            for track in tracks {
                if let Some(track) = track.as_object_mut() {
                    track.remove("dataUrl");
                }
            }
        }
    }
    Ok(HarnessExecution { run, output })
}

pub(crate) fn get_run_output(
    app: &AppHandle,
    runtime: &Arc<HarnessRuntime>,
    run_id: &str,
) -> Result<HarnessExecution, String> {
    let run = runtime.get(app, run_id)?;
    let artifact = run
        .artifacts
        .first()
        .ok_or_else(|| "该运行还没有可读取的产物".to_string())?;
    let mut output = hydrate_payload(artifact)?;
    if capability_accepts_audio(&run.capability) {
        if let Ok(source_path) = ensure_source_audio_file(app, run_id) {
            let waveform = cached_source_waveform(&source_path);
            if let Some(object) = output.as_object_mut() {
                object.insert(
                    "sourceAudioFilePath".to_string(),
                    Value::String(path_string(&source_path)),
                );
                let has_waveform = object
                    .get("waveform")
                    .and_then(Value::as_array)
                    .is_some_and(|values| !values.is_empty());
                if !has_waveform {
                    if let Some(waveform) = waveform {
                        object.insert("waveform".to_string(), json!(waveform));
                    }
                }
            }
        }
    }
    Ok(HarnessExecution { run, output })
}

#[tauri::command]
pub fn harness_start_run(
    app: AppHandle,
    harness_runtime: State<'_, Arc<HarnessRuntime>>,
    tts_runtime: State<'_, Arc<TtsRuntime>>,
    asr_runtime: State<'_, Arc<AsrRuntime>>,
    audio_runtime: State<'_, Arc<AudioProcessingRuntime>>,
    request: HarnessTaskRequest,
) -> Result<HarnessRun, String> {
    start_run(
        app,
        harness_runtime.inner().clone(),
        tts_runtime.inner().clone(),
        asr_runtime.inner().clone(),
        audio_runtime.inner().clone(),
        request,
    )
}

pub(crate) fn start_run(
    app: AppHandle,
    harness_runtime: Arc<HarnessRuntime>,
    tts_runtime: Arc<TtsRuntime>,
    asr_runtime: Arc<AsrRuntime>,
    audio_runtime: Arc<AudioProcessingRuntime>,
    request: HarnessTaskRequest,
) -> Result<HarnessRun, String> {
    validate_capability(&request.capability)?;
    harness_runtime.initialize(&app)?;
    let provider = match resolve_provider(&app, &request) {
        Ok(provider) => provider,
        Err(error) => {
            let run = failed_submission(&request, error);
            persist_request(&app, &run.id, &request)?;
            harness_runtime.insert(&app, run.clone())?;
            emit_run(&app, &run);
            return Ok(run);
        }
    };
    let run_id = request
        .run_id
        .as_deref()
        .filter(|value| valid_run_id(value))
        .map(str::to_string)
        .unwrap_or_else(new_run_id);
    let created_at = timestamp_millis();
    let run = HarnessRun {
        id: run_id.clone(),
        conversation_provider_id: request.conversation_provider_id.clone(),
        conversation_visible: request.conversation_visible,
        dependency_run_ids: request.dependency_run_ids.clone(),
        capability: request.capability.clone(),
        title: request
            .title
            .clone()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| capability_title(&request.capability).to_string()),
        input_summary: input_summary(&request),
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        model_id: provider.model_id.clone(),
        status: "queued".to_string(),
        progress: 2,
        activity: Some("等待处理".to_string()),
        created_at,
        started_at: None,
        completed_at: None,
        duration_ms: None,
        artifacts: Vec::new(),
        error: None,
        retryable: true,
    };
    persist_request(&app, &run_id, &request)?;
    harness_runtime.insert(&app, run.clone())?;
    let cancel = Arc::new(AtomicBool::new(false));
    harness_runtime
        .active
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?
        .insert(run_id.clone(), cancel.clone());
    emit_run(&app, &run);

    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = timestamp_millis();
        if let Ok(running) = harness_runtime.update(&task_app, &run_id, |run| {
            run.status = "running".to_string();
            run.progress = 8;
            run.activity = Some(run_activity(&request, &provider));
            run.started_at = Some(started);
        }) {
            emit_run(&task_app, &running);
        }

        let execution_started = Instant::now();
        let progress_runtime = harness_runtime.clone();
        let progress_app = task_app.clone();
        let progress_run_id = run_id.clone();
        let progress_callback: AsrProgressCallback = Arc::new(move |progress, detail| {
            if let Ok(run) = progress_runtime.update(&progress_app, &progress_run_id, |run| {
                if run.status == "running" {
                    run.progress = progress.clamp(8, 98);
                    run.activity = Some(detail.clone());
                }
            }) {
                emit_run(&progress_app, &run);
            }
        });
        let result = execute_request(
            task_app.clone(),
            tts_runtime,
            asr_runtime,
            audio_runtime,
            &request,
            &provider,
            cancel.clone(),
            Some(progress_callback),
        )
        .await;
        let canceled = cancel.load(Ordering::Relaxed);
        let completed = timestamp_millis();
        let duration_ms = execution_started.elapsed().as_millis() as u64;
        let updated = harness_runtime.update(&task_app, &run_id, |run| {
            run.completed_at = Some(completed);
            run.duration_ms = Some(duration_ms);
            run.activity = None;
            if canceled {
                run.status = "canceled".to_string();
                run.progress = 100;
                run.error = None;
                return;
            }
            match &result {
                Ok(artifact) => {
                    run.status = "completed".to_string();
                    run.progress = 100;
                    run.artifacts = vec![artifact.clone()];
                    run.error = None;
                }
                Err(error) => {
                    run.status = "failed".to_string();
                    run.progress = 100;
                    run.error = Some(error.clone());
                }
            }
        });
        if let Ok(run) = updated {
            emit_run(&task_app, &run);
        }
        if let Ok(mut active) = harness_runtime.active.lock() {
            active.remove(&run_id);
        }
    });

    Ok(run)
}

#[tauri::command]
pub fn harness_cancel_run(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    run_id: String,
) -> Result<HarnessRun, String> {
    cancel_run(&app, runtime.inner(), &run_id)
}

pub(crate) fn cancel_run(
    app: &AppHandle,
    runtime: &Arc<HarnessRuntime>,
    run_id: &str,
) -> Result<HarnessRun, String> {
    let cancel = runtime
        .active
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?
        .get(run_id)
        .cloned()
        .ok_or_else(|| "该任务已经结束，无法取消".to_string())?;
    cancel.store(true, Ordering::Relaxed);
    let run = runtime.update(app, run_id, |run| {
        run.status = "canceling".to_string();
    })?;
    emit_run(app, &run);
    Ok(run)
}

#[tauri::command]
pub fn harness_delete_run(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    run_id: String,
) -> Result<(), String> {
    runtime.remove(&app, &run_id)
}

#[tauri::command]
pub fn harness_retry_run(
    app: AppHandle,
    harness_runtime: State<'_, Arc<HarnessRuntime>>,
    tts_runtime: State<'_, Arc<TtsRuntime>>,
    asr_runtime: State<'_, Arc<AsrRuntime>>,
    audio_runtime: State<'_, Arc<AudioProcessingRuntime>>,
    run_id: String,
) -> Result<HarnessRun, String> {
    retry_run(
        app,
        harness_runtime.inner().clone(),
        tts_runtime.inner().clone(),
        asr_runtime.inner().clone(),
        audio_runtime.inner().clone(),
        &run_id,
    )
}

pub(crate) fn retry_run(
    app: AppHandle,
    harness_runtime: Arc<HarnessRuntime>,
    tts_runtime: Arc<TtsRuntime>,
    asr_runtime: Arc<AsrRuntime>,
    audio_runtime: Arc<AudioProcessingRuntime>,
    run_id: &str,
) -> Result<HarnessRun, String> {
    let mut request = load_request(&app, run_id)?;
    request.run_id = None;
    start_run(
        app,
        harness_runtime,
        tts_runtime,
        asr_runtime,
        audio_runtime,
        request,
    )
}

#[tauri::command]
pub fn harness_api_provider_settings(app: AppHandle) -> Result<ApiProviderSettings, String> {
    provider_settings(&app)
}

pub(crate) fn provider_settings(app: &AppHandle) -> Result<ApiProviderSettings, String> {
    let config = read_api_provider_config(app)?;
    let configured = config.configured();
    Ok(ApiProviderSettings {
        id: API_PROVIDER_ID,
        name: config.name,
        base_url: config.base_url,
        api_key_configured: !config.api_key.trim().is_empty(),
        tts_model: config.tts_model,
        tts_voice: config.tts_voice,
        asr_model: config.asr_model,
        llm_model: config.llm_model,
        enabled: config.enabled,
        status: if configured { "ready" } else { "unconfigured" },
    })
}

#[tauri::command]
pub fn harness_save_api_provider(
    app: AppHandle,
    update: ApiProviderUpdate,
) -> Result<ApiProviderSettings, String> {
    if !(update.base_url.starts_with("https://")
        || update.base_url.starts_with("http://127.0.0.1")
        || update.base_url.starts_with("http://localhost"))
    {
        return Err("API 地址必须使用 HTTPS；本机服务可使用 localhost".to_string());
    }
    let mut current = read_api_provider_config(&app)?;
    current.name = update.name.trim().to_string();
    current.base_url = update.base_url.trim_end_matches('/').to_string();
    if let Some(api_key) = update.api_key {
        if !api_key.trim().is_empty() {
            current.api_key = api_key.trim().to_string();
        }
    }
    current.tts_model = update.tts_model.trim().to_string();
    current.tts_voice = update.tts_voice.trim().to_string();
    current.asr_model = update.asr_model.trim().to_string();
    current.llm_model = update.llm_model.trim().to_string();
    current.enabled = update.enabled;
    write_api_provider_config(&app, &current)?;
    provider_settings(&app)
}

#[tauri::command]
pub fn harness_bailian_provider_settings(
    app: AppHandle,
) -> Result<BailianProviderSettings, String> {
    bailian_provider_settings(&app)
}

pub(crate) fn bailian_provider_settings(
    app: &AppHandle,
) -> Result<BailianProviderSettings, String> {
    let config = read_bailian_provider_config(app)?;
    let configured = config.configured();
    Ok(BailianProviderSettings {
        id: BAILIAN_PROVIDER_ID,
        name: config.name,
        api_key_configured: !config.api_key.trim().is_empty(),
        enabled: config.enabled,
        status: if configured { "ready" } else { "unconfigured" },
    })
}

#[tauri::command]
pub fn harness_save_bailian_provider(
    app: AppHandle,
    update: BailianProviderUpdate,
) -> Result<BailianProviderSettings, String> {
    let mut current = read_bailian_provider_config(&app)?;
    if let Some(api_key) = update.api_key {
        if !api_key.trim().is_empty() {
            current.api_key = api_key.trim().to_string();
        }
    }
    if current.api_key.trim().is_empty() {
        return Err("请填写百炼 Access Key".to_string());
    }
    current.enabled = true;
    write_bailian_provider_config(&app, &current)?;
    bailian_provider_settings(&app)
}

#[tauri::command]
#[allow(unused_variables)]
pub async fn harness_list_bailian_voices(
    app: AppHandle,
    target_model: String,
) -> Result<Vec<BailianVoice>, String> {
    let config = configured_bailian_provider(&app)?;
    let response = api_client()?
        .post(format!(
            "{}/api/v1/services/audio/tts/customization",
            config.base_url
        ))
        .bearer_auth(&config.api_key)
        .json(&json!({
            "model": "voice-enrollment",
            "input": { "action": "list_voice", "page_size": 100, "page_index": 0 }
        }))
        .send()
        .await
        .map_err(|error| format!("无法读取百炼音色: {error}"))?;
    let raw = checked_response(response, "百炼音色列表")
        .await?
        .json::<Value>()
        .await
        .map_err(|error| format!("百炼音色列表返回无效 JSON: {error}"))?;
    let total = raw
        .pointer("/output/total_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let last_page = total.saturating_sub(1) / 100;
    let mut registry = read_bailian_voice_registry(&app)?;
    for page_index in last_page.saturating_sub(2)..=last_page {
        let response = api_client()?
            .post(format!(
                "{}/api/v1/services/audio/tts/customization",
                config.base_url
            ))
            .bearer_auth(&config.api_key)
            .json(&json!({
                "model": "voice-enrollment",
                "input": {
                    "action": "list_voice",
                    "page_size": 100,
                    "page_index": page_index
                }
            }))
            .send()
            .await
            .map_err(|error| format!("无法读取百炼音色: {error}"))?;
        let page = checked_response(response, "百炼音色列表")
            .await?
            .json::<Value>()
            .await
            .map_err(|error| format!("百炼音色列表返回无效 JSON: {error}"))?;
        for voice in page
            .pointer("/output/voice_list")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = voice.get("voice_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(model) = voice.get("target_model").and_then(Value::as_str) else {
                continue;
            };
            if voice.get("status").and_then(Value::as_str) != Some("OK") {
                continue;
            }
            registry.push(BailianVoice {
                id: id.to_string(),
                target_model: model.to_string(),
                status: "OK".to_string(),
                created_at: voice
                    .get("gmt_create")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
    }
    let mut unique = HashMap::new();
    for voice in registry {
        unique.insert(voice.id.clone(), voice);
    }
    let mut registry = unique.into_values().collect::<Vec<_>>();
    registry.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    write_bailian_voice_registry(&app, &registry)?;
    Ok(registry.into_iter().collect())
}

#[tauri::command]
pub async fn harness_create_bailian_voice(
    app: AppHandle,
    request: BailianVoiceCreateRequest,
) -> Result<BailianVoice, String> {
    let config = configured_bailian_provider(&app)?;
    let prefix = request.prefix.trim();
    if prefix.is_empty()
        || prefix.len() > 10
        || !prefix
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("音色名称只能使用 1-10 个英文字母或数字".to_string());
    }
    let mut input = json!({
        "action": "create_voice",
        "target_model": request.target_model,
        "prefix": prefix,
        "language_hints": [request.language.as_deref().unwrap_or("zh")]
    });
    match request.mode.as_str() {
        "clone" => {
            let audio = request
                .audio_data_url
                .as_deref()
                .filter(|value| value.starts_with("data:audio/"))
                .ok_or_else(|| "请上传或录制参考音频".to_string())?;
            input["url"] = Value::String(audio.to_string());
            input["enable_preprocess"] = Value::Bool(true);
            input["max_prompt_audio_length"] = json!(20.0);
        }
        "design" if request.target_model.starts_with("cosyvoice-v3.5-") => {
            let prompt = request
                .voice_prompt
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "请描述需要设计的声音".to_string())?;
            let preview = request
                .preview_text
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "请输入试听文本".to_string())?;
            input["voice_prompt"] = Value::String(prompt.chars().take(500).collect());
            input["preview_text"] = Value::String(preview.chars().take(200).collect());
        }
        "design" => return Err("当前模型不支持声音设计".to_string()),
        _ => return Err("未知的音色创建方式".to_string()),
    }
    let response = api_client()?
        .post(format!(
            "{}/api/v1/services/audio/tts/customization",
            config.base_url
        ))
        .bearer_auth(&config.api_key)
        .json(&json!({ "model": "voice-enrollment", "input": input }))
        .send()
        .await
        .map_err(|error| format!("创建百炼音色失败: {error}"))?;
    let raw = checked_response(response, "创建百炼音色")
        .await?
        .json::<Value>()
        .await
        .map_err(|error| format!("创建百炼音色返回无效 JSON: {error}"))?;
    let voice_id = raw
        .pointer("/output/voice_id")
        .and_then(Value::as_str)
        .ok_or_else(|| bailian_response_error("创建百炼音色", &raw))?;
    let created = BailianVoice {
        id: voice_id.to_string(),
        target_model: request.target_model,
        status: "OK".to_string(),
        created_at: None,
    };
    let mut registry = read_bailian_voice_registry(&app)?;
    registry.retain(|voice| voice.id != created.id);
    registry.insert(0, created.clone());
    write_bailian_voice_registry(&app, &registry)?;
    Ok(created)
}

#[tauri::command]
pub async fn harness_delete_bailian_voice(app: AppHandle, voice_id: String) -> Result<(), String> {
    let config = configured_bailian_provider(&app)?;
    let voice_id = voice_id.trim();
    if voice_id.is_empty() {
        return Err("音色 ID 不能为空".to_string());
    }
    let response = api_client()?
        .post(format!(
            "{}/api/v1/services/audio/tts/customization",
            config.base_url
        ))
        .bearer_auth(&config.api_key)
        .json(&json!({
            "model": "voice-enrollment",
            "input": { "action": "delete_voice", "voice_id": voice_id }
        }))
        .send()
        .await
        .map_err(|error| format!("删除百炼音色失败: {error}"))?;
    checked_response(response, "删除百炼音色").await?;
    let mut registry = read_bailian_voice_registry(&app)?;
    registry.retain(|voice| voice.id != voice_id);
    write_bailian_voice_registry(&app, &registry)
}

#[tauri::command]
pub fn harness_start_funasr_stream(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    request: FunAsrStreamStartRequest,
) -> Result<FunAsrStreamStartResponse, String> {
    if !(8_000..=48_000).contains(&request.sample_rate) {
        return Err("流式 ASR 输入采样率必须在 8 kHz 到 48 kHz 之间".to_string());
    }
    if let Some(provider_id) = request
        .provider_id
        .clone()
        .filter(|provider_id| provider_id.starts_with("plugin."))
    {
        return start_local_asr_stream(&app, runtime.inner(), request, &provider_id);
    }

    let config = configured_bailian_provider(&app)?;
    let model_id = request
        .model_id
        .as_deref()
        .filter(|model| is_bailian_funasr_model(model))
        .unwrap_or(BAILIAN_FUN_ASR_MODEL)
        .to_string();
    let session_id = Uuid::new_v4().to_string();
    let run_id = new_run_id();
    let now = timestamp_millis();
    let clip_name = request.clip_name.trim();
    let run = HarnessRun {
        id: run_id.clone(),
        conversation_provider_id: None,
        conversation_visible: true,
        dependency_run_ids: Vec::new(),
        capability: CAPABILITY_ASR.to_string(),
        title: "实时语音识别".to_string(),
        input_summary: if clip_name.is_empty() {
            "实时麦克风".to_string()
        } else {
            clip_name.to_string()
        },
        provider_id: BAILIAN_PROVIDER_ID.to_string(),
        provider_name: config.name.clone(),
        model_id: model_id.clone(),
        status: "running".to_string(),
        progress: 12,
        activity: Some("正在接收实时识别结果".to_string()),
        created_at: now,
        started_at: Some(now),
        completed_at: None,
        duration_ms: None,
        artifacts: Vec::new(),
        error: None,
        retryable: false,
    };
    runtime.insert(&app, run.clone())?;

    let (sender, receiver) = mpsc::channel(64);
    runtime
        .funasr_streams
        .lock()
        .map_err(|_| "FunASR 流式会话状态不可用".to_string())?
        .insert(session_id.clone(), sender);
    emit_run(&app, &run);

    let task_app = app.clone();
    let task_runtime = runtime.inner().clone();
    let task_session_id = session_id.clone();
    let task_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let result = run_funasr_stream(
            &task_app,
            &task_session_id,
            &task_run_id,
            &config,
            &model_id,
            request,
            receiver,
        )
        .await;
        let completed_at = timestamp_millis();
        let duration_ms = started.elapsed().as_millis() as u64;
        let final_text = result
            .as_ref()
            .ok()
            .and_then(|payload| payload.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let artifact = result
            .as_ref()
            .ok()
            .and_then(|payload| artifact_from_payload(CAPABILITY_ASR, payload.clone()).ok());
        let updated = task_runtime.update(&task_app, &task_run_id, |run| {
            run.completed_at = Some(completed_at);
            run.duration_ms = Some(duration_ms);
            run.progress = 100;
            match (&result, artifact) {
                (Ok(_), Some(artifact)) => {
                    run.status = "completed".to_string();
                    run.artifacts = vec![artifact];
                    run.error = None;
                }
                (Ok(_), None) => {
                    run.status = "failed".to_string();
                    run.error = Some("无法保存 FunASR 流式识别结果".to_string());
                }
                (Err(error), _) => {
                    run.status = "failed".to_string();
                    run.error = Some(error.clone());
                }
            }
        });
        if let Ok(run) = updated {
            emit_run(&task_app, &run);
        }
        let (kind, error) = match result {
            Ok(_) => ("completed", None),
            Err(error) => ("error", Some(error)),
        };
        let _ = task_app.emit(
            "funasr-stream-event",
            FunAsrStreamEvent {
                session_id: task_session_id.clone(),
                run_id: task_run_id,
                kind,
                text: final_text,
                error,
            },
        );
        if let Ok(mut streams) = task_runtime.funasr_streams.lock() {
            streams.remove(&task_session_id);
        }
    });

    Ok(FunAsrStreamStartResponse { session_id, run })
}

fn start_local_asr_stream(
    app: &AppHandle,
    runtime: &Arc<HarnessRuntime>,
    request: FunAsrStreamStartRequest,
    provider_id: &str,
) -> Result<FunAsrStreamStartResponse, String> {
    let provider = plugins::provider_by_id(app, provider_id)?
        .ok_or_else(|| format!("Provider {provider_id} 未安装或已停用"))?;
    if !matches!(
        provider.adapter.as_str(),
        "streaming-zipformer" | "streaming-paraformer" | "funasr-nano"
    ) {
        return Err(format!("{} 不是本地流式 ASR 模型", provider.name));
    }
    let model_path = provider
        .model_path
        .clone()
        .ok_or_else(|| format!("{} 缺少模型目录", provider.name))?;
    let session_id = Uuid::new_v4().to_string();
    let run_id = new_run_id();
    let now = timestamp_millis();
    let clip_name = request.clip_name.trim();
    let run = HarnessRun {
        id: run_id.clone(),
        conversation_provider_id: None,
        conversation_visible: true,
        dependency_run_ids: Vec::new(),
        capability: CAPABILITY_ASR.to_string(),
        title: "实时音频识别".to_string(),
        input_summary: if clip_name.is_empty() {
            "实时麦克风".to_string()
        } else {
            clip_name.to_string()
        },
        provider_id: provider.provider_id,
        provider_name: provider.name,
        model_id: provider.model_id,
        status: "running".to_string(),
        progress: 12,
        activity: Some("正在接收实时识别结果".to_string()),
        created_at: now,
        started_at: Some(now),
        completed_at: None,
        duration_ms: None,
        artifacts: Vec::new(),
        error: None,
        retryable: false,
    };
    runtime.insert(app, run.clone())?;
    let (sender, receiver) = mpsc::channel(64);
    runtime
        .funasr_streams
        .lock()
        .map_err(|_| "本地流式 ASR 会话状态不可用".to_string())?
        .insert(session_id.clone(), sender);
    emit_run(app, &run);

    let task_app = app.clone();
    let task_runtime = runtime.clone();
    let task_session_id = session_id.clone();
    let task_run_id = run_id.clone();
    let adapter = provider.adapter;
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let result = run_local_asr_stream(
            task_app.clone(),
            task_session_id.clone(),
            task_run_id.clone(),
            model_path,
            adapter,
            request,
            receiver,
        )
        .await;
        finish_streaming_asr_run(
            &task_app,
            &task_runtime,
            &task_session_id,
            &task_run_id,
            started,
            result,
        );
    });

    Ok(FunAsrStreamStartResponse { session_id, run })
}

#[tauri::command]
pub fn harness_push_funasr_stream(
    runtime: State<'_, Arc<HarnessRuntime>>,
    session_id: String,
    pcm_base64: String,
) -> Result<(), String> {
    let pcm = STANDARD
        .decode(pcm_base64)
        .map_err(|error| format!("FunASR PCM 数据无效: {error}"))?;
    if pcm.is_empty() || pcm.len() % 2 != 0 {
        return Err("FunASR PCM 数据必须是非空的 16-bit 音频".to_string());
    }
    let sender = runtime
        .funasr_streams
        .lock()
        .map_err(|_| "FunASR 流式会话状态不可用".to_string())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "FunASR 流式会话不存在或已经结束".to_string())?;
    sender
        .try_send(FunAsrStreamCommand::Audio(pcm))
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => {
                "FunASR 处理速度跟不上输入，已触发背压保护".to_string()
            }
            mpsc::error::TrySendError::Closed(_) => "FunASR 流式会话已经关闭".to_string(),
        })
}

#[tauri::command]
pub async fn harness_finish_funasr_stream(
    runtime: State<'_, Arc<HarnessRuntime>>,
    session_id: String,
) -> Result<(), String> {
    let sender = {
        runtime
            .funasr_streams
            .lock()
            .map_err(|_| "FunASR 流式会话状态不可用".to_string())?
            .get(&session_id)
            .cloned()
    };
    let Some(sender) = sender else {
        return Ok(());
    };
    sender
        .send(FunAsrStreamCommand::Finish)
        .await
        .map_err(|_| "FunASR 流式会话已经关闭".to_string())?;
    for _ in 0..200 {
        let completed = !runtime
            .funasr_streams
            .lock()
            .map_err(|_| "FunASR 流式会话状态不可用".to_string())?
            .contains_key(&session_id);
        if completed {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("等待 FunASR 完成事件超时".to_string())
}

#[tauri::command]
pub fn harness_start_vad_stream(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    request: VadStreamStartRequest,
) -> Result<VadStreamStartResponse, String> {
    if request.adapter.as_deref() != Some("silero-vad")
        || request.provider_id.as_deref() != Some("local.silero-vad")
    {
        return Err(format!(
            "当前实时 VAD 适配器不支持 {} ({})",
            request.adapter.as_deref().unwrap_or("未配置适配器"),
            request.model_id.as_deref().unwrap_or("未配置模型")
        ));
    }
    let session_id = Uuid::new_v4().to_string();
    let detector = create_streaming_vad(
        &app,
        request.threshold,
        request.min_speech_duration,
        request.min_silence_duration,
    )?;
    runtime
        .vad_streams
        .lock()
        .map_err(|_| "VAD 流式会话状态不可用".to_string())?
        .insert(session_id.clone(), detector);
    Ok(VadStreamStartResponse { session_id })
}

#[tauri::command]
pub fn harness_push_vad_stream(
    runtime: State<'_, Arc<HarnessRuntime>>,
    session_id: String,
    pcm_base64: String,
) -> Result<StreamingVadUpdate, String> {
    let pcm = STANDARD
        .decode(pcm_base64)
        .map_err(|error| format!("VAD PCM 数据无效: {error}"))?;
    if pcm.is_empty() || pcm.len() % 2 != 0 {
        return Err("VAD PCM 数据必须是非空的 16-bit 音频".to_string());
    }
    let mut streams = runtime
        .vad_streams
        .lock()
        .map_err(|_| "VAD 流式会话状态不可用".to_string())?;
    let detector = streams
        .get_mut(&session_id)
        .ok_or_else(|| "VAD 流式会话不存在或已经结束".to_string())?;
    Ok(detector.accept_pcm16(&pcm))
}

#[tauri::command]
pub fn harness_finish_vad_stream(
    runtime: State<'_, Arc<HarnessRuntime>>,
    session_id: String,
) -> Result<(), String> {
    runtime
        .vad_streams
        .lock()
        .map_err(|_| "VAD 流式会话状态不可用".to_string())?
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
pub fn harness_start_enhancement_stream(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    request: EnhancementStreamStartRequest,
) -> Result<EnhancementStreamStartResponse, String> {
    if request.sample_rate != RNNOISE_SAMPLE_RATE {
        return Err(format!(
            "实时音频增强当前需要 {} kHz PCM 输入",
            RNNOISE_SAMPLE_RATE / 1000
        ));
    }
    let provider = plugins::provider_by_id(&app, &request.provider_id)?
        .ok_or_else(|| format!("Provider {} 未安装或已停用", request.provider_id))?;
    let adapter = provider.adapter;
    let model_path = provider.model_path;
    let strength = request.strength.unwrap_or(1.0);
    let (sender, receiver) = std_mpsc::channel();
    let (started_sender, started_receiver) = std_mpsc::channel();
    thread::Builder::new()
        .name(format!("audio-enhance-{}", adapter))
        .spawn(move || {
            let mut enhancer =
                match StreamingEnhancer::create(&adapter, model_path.as_deref(), strength) {
                    Ok(enhancer) => {
                        let _ = started_sender.send(Ok(()));
                        enhancer
                    }
                    Err(error) => {
                        let _ = started_sender.send(Err(error));
                        return;
                    }
                };
            while let Ok(command) = receiver.recv() {
                match command {
                    EnhancementStreamCommand::Audio { pcm, response } => {
                        let _ = response.send(enhancer.accept_pcm16(&pcm));
                    }
                    EnhancementStreamCommand::Finish { response } => {
                        let _ = response.send(enhancer.finish());
                        break;
                    }
                }
            }
        })
        .map_err(|error| format!("无法启动实时增强线程: {error}"))?;
    started_receiver
        .recv()
        .map_err(|_| "实时增强线程启动失败".to_string())??;
    let session_id = Uuid::new_v4().to_string();
    runtime
        .enhancement_streams
        .lock()
        .map_err(|_| "实时增强会话状态不可用".to_string())?
        .insert(session_id.clone(), EnhancementStreamHandle { sender });
    Ok(EnhancementStreamStartResponse {
        session_id,
        sample_rate: RNNOISE_SAMPLE_RATE,
    })
}

#[tauri::command]
pub fn harness_push_enhancement_stream(
    runtime: State<'_, Arc<HarnessRuntime>>,
    session_id: String,
    pcm_base64: String,
) -> Result<EnhancementStreamChunk, String> {
    let pcm = STANDARD
        .decode(pcm_base64)
        .map_err(|error| format!("实时增强 PCM 数据无效: {error}"))?;
    if pcm.is_empty() || pcm.len() % 2 != 0 {
        return Err("实时增强 PCM 必须是非空的 16-bit 单声道音频".to_string());
    }
    let sender = runtime
        .enhancement_streams
        .lock()
        .map_err(|_| "实时增强会话状态不可用".to_string())?
        .get(&session_id)
        .ok_or_else(|| "实时增强会话不存在或已经结束".to_string())?
        .sender
        .clone();
    let (response, receiver) = std_mpsc::channel();
    sender
        .send(EnhancementStreamCommand::Audio { pcm, response })
        .map_err(|_| "实时增强线程已经结束".to_string())?;
    let output = receiver
        .recv()
        .map_err(|_| "实时增强线程没有返回音频".to_string())??;
    Ok(EnhancementStreamChunk {
        pcm_base64: STANDARD.encode(output),
        sample_rate: RNNOISE_SAMPLE_RATE,
    })
}

#[tauri::command]
pub fn harness_finish_enhancement_stream(
    runtime: State<'_, Arc<HarnessRuntime>>,
    session_id: String,
) -> Result<EnhancementStreamChunk, String> {
    let handle = runtime
        .enhancement_streams
        .lock()
        .map_err(|_| "实时增强会话状态不可用".to_string())?
        .remove(&session_id)
        .ok_or_else(|| "实时增强会话不存在或已经结束".to_string())?;
    let (response, receiver) = std_mpsc::channel();
    handle
        .sender
        .send(EnhancementStreamCommand::Finish { response })
        .map_err(|_| "实时增强线程已经结束".to_string())?;
    let output = receiver
        .recv()
        .map_err(|_| "实时增强线程没有返回尾部音频".to_string())??;
    Ok(EnhancementStreamChunk {
        pcm_base64: STANDARD.encode(output),
        sample_rate: RNNOISE_SAMPLE_RATE,
    })
}

#[tauri::command]
pub fn harness_start_cosyvoice_stream(
    app: AppHandle,
    runtime: State<'_, Arc<HarnessRuntime>>,
    request: CosyVoiceStreamStartRequest,
) -> Result<CosyVoiceStreamStartResponse, String> {
    let config = configured_bailian_provider(&app)?;
    if request.text.trim().is_empty() {
        return Err("CosyVoice 合成文本不能为空".to_string());
    }
    let model_id = bailian_cosyvoice_model(request.model_id.as_deref())?.to_string();
    if model_id != BAILIAN_COSYVOICE_MODEL
        && request
            .voice
            .as_deref()
            .map_or(true, |voice| voice.trim().is_empty())
    {
        return Err("CosyVoice v3.5 需要声音复刻或声音设计生成的音色 ID".to_string());
    }
    let session_id = Uuid::new_v4().to_string();
    let run_id = new_run_id();
    let now = timestamp_millis();
    let run = HarnessRun {
        id: run_id.clone(),
        conversation_provider_id: None,
        conversation_visible: true,
        dependency_run_ids: Vec::new(),
        capability: CAPABILITY_TTS.to_string(),
        title: "实时语音合成".to_string(),
        input_summary: request.text.chars().take(80).collect(),
        provider_id: BAILIAN_PROVIDER_ID.to_string(),
        provider_name: config.name.clone(),
        model_id: model_id.clone(),
        status: "running".to_string(),
        progress: 12,
        activity: Some("正在合成并播放音频".to_string()),
        created_at: now,
        started_at: Some(now),
        completed_at: None,
        duration_ms: None,
        artifacts: Vec::new(),
        error: None,
        retryable: false,
    };
    runtime.insert(&app, run.clone())?;
    emit_run(&app, &run);

    let task_app = app.clone();
    let task_runtime = runtime.inner().clone();
    let task_session_id = session_id.clone();
    let task_run_id = run_id.clone();
    let task_model_id = model_id;
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let result = run_cosyvoice_stream(
            &task_app,
            &task_session_id,
            &task_run_id,
            &config,
            &task_model_id,
            request,
        )
        .await;
        let completed_at = timestamp_millis();
        let duration_ms = started.elapsed().as_millis() as u64;
        let artifact = result
            .as_ref()
            .ok()
            .and_then(|payload| artifact_from_payload(CAPABILITY_TTS, payload.clone()).ok());
        let updated = task_runtime.update(&task_app, &task_run_id, |run| {
            run.completed_at = Some(completed_at);
            run.duration_ms = Some(duration_ms);
            run.progress = 100;
            match (&result, artifact) {
                (Ok(_), Some(artifact)) => {
                    run.status = "completed".to_string();
                    run.artifacts = vec![artifact];
                    run.error = None;
                }
                (Ok(_), None) => {
                    run.status = "failed".to_string();
                    run.error = Some("无法保存 CosyVoice 流式合成结果".to_string());
                }
                (Err(error), _) => {
                    run.status = "failed".to_string();
                    run.error = Some(error.clone());
                }
            }
        });
        if let Ok(run) = updated {
            emit_run(&task_app, &run);
        }
        let (kind, error) = match result {
            Ok(_) => ("completed", None),
            Err(error) => ("error", Some(error)),
        };
        let _ = task_app.emit(
            "cosyvoice-stream-event",
            CosyVoiceStreamEvent {
                session_id: task_session_id,
                run_id: task_run_id,
                kind,
                pcm_base64: None,
                sample_rate: 24_000,
                chunk_index: None,
                error,
            },
        );
    });

    Ok(CosyVoiceStreamStartResponse { session_id, run })
}

async fn run_cosyvoice_stream(
    app: &AppHandle,
    session_id: &str,
    run_id: &str,
    config: &BailianProviderConfig,
    model_id: &str,
    request: CosyVoiceStreamStartRequest,
) -> Result<Value, String> {
    let websocket_url = config
        .base_url
        .replacen("https://", "wss://", 1)
        .trim_end_matches('/')
        .to_string()
        + "/api-ws/v1/inference";
    let mut websocket_request = websocket_url
        .into_client_request()
        .map_err(|error| format!("无法创建 CosyVoice WebSocket 请求: {error}"))?;
    websocket_request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .map_err(|error| format!("百炼 AK 格式无效: {error}"))?,
    );
    websocket_request.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static("qwenaudio-toolkits/0.1"),
    );
    let (mut socket, _) = connect_async(websocket_request)
        .await
        .map_err(|error| format!("CosyVoice WebSocket 连接失败: {error}"))?;
    let task_id = Uuid::new_v4().to_string();
    let voice = request
        .voice
        .as_deref()
        .filter(|voice| !voice.trim().is_empty())
        .unwrap_or("longxiaochun_v2");
    let speed = request.speed.unwrap_or(1.0).clamp(0.5, 2.0);
    socket
        .send(Message::Text(
            json!({
                "header": {
                    "action": "run-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": {
                    "task_group": "audio",
                    "task": "tts",
                    "function": "SpeechSynthesizer",
                    "model": model_id,
                    "parameters": {
                        "text_type": "PlainText",
                        "voice": voice,
                        "format": "pcm",
                        "sample_rate": 24000,
                        "volume": 50,
                        "rate": speed,
                        "pitch": 1.0
                    },
                    "input": {}
                }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法启动 CosyVoice 任务: {error}"))?;

    tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| format!("CosyVoice 启动失败: {error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let event = serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("CosyVoice 返回了无效事件: {error}"))?;
            match event.pointer("/header/event").and_then(Value::as_str) {
                Some("task-started") => return Ok(()),
                Some("task-failed") => return Err(cosyvoice_event_error(&event)),
                _ => {}
            }
        }
        Err("CosyVoice 在任务启动前关闭了连接".to_string())
    })
    .await
    .map_err(|_| "CosyVoice 任务启动超时".to_string())??;
    socket
        .send(Message::Text(
            json!({
                "header": {
                    "action": "continue-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": { "input": { "text": request.text } }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法发送 CosyVoice 文本: {error}"))?;
    socket
        .send(Message::Text(
            json!({
                "header": {
                    "action": "finish-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": { "input": {} }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法结束 CosyVoice 任务: {error}"))?;

    let started = Instant::now();
    let mut pcm = Vec::new();
    let mut chunk_index = 0_u64;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(30), socket.next())
            .await
            .map_err(|_| "CosyVoice 音频分片等待超时".to_string())?
            .ok_or_else(|| "CosyVoice 在合成完成前关闭了连接".to_string())?;
        let message = message.map_err(|error| format!("CosyVoice 接收失败: {error}"))?;
        match message {
            Message::Binary(bytes) => {
                chunk_index += 1;
                pcm.extend_from_slice(&bytes);
                let _ = app.emit(
                    "cosyvoice-stream-event",
                    CosyVoiceStreamEvent {
                        session_id: session_id.to_string(),
                        run_id: run_id.to_string(),
                        kind: "audio",
                        pcm_base64: Some(STANDARD.encode(&bytes)),
                        sample_rate: 24_000,
                        chunk_index: Some(chunk_index),
                        error: None,
                    },
                );
            }
            Message::Text(text) => {
                let event = serde_json::from_str::<Value>(&text)
                    .map_err(|error| format!("CosyVoice 返回了无效事件: {error}"))?;
                match event.pointer("/header/event").and_then(Value::as_str) {
                    Some("task-finished") => break,
                    Some("task-failed") => return Err(cosyvoice_event_error(&event)),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if pcm.is_empty() {
        return Err("CosyVoice 没有返回音频".to_string());
    }
    let samples = pcm
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32)
        .collect::<Vec<_>>();
    let wav = encode_wav_bytes(&PcmAudio {
        samples,
        sample_rate: 24_000,
        channels: 1,
    })?;
    persist_api_tts_output(
        app,
        &wav,
        started,
        &format!("百炼 · {BAILIAN_COSYVOICE_MODEL}"),
        "cosyvoice-stream",
    )
}

async fn run_funasr_stream(
    app: &AppHandle,
    session_id: &str,
    run_id: &str,
    config: &BailianProviderConfig,
    model_id: &str,
    request: FunAsrStreamStartRequest,
    mut receiver: mpsc::Receiver<FunAsrStreamCommand>,
) -> Result<Value, String> {
    let input_sample_rate = request.sample_rate;
    let target_sample_rate = if model_id.contains("-8k-") {
        8_000
    } else {
        input_sample_rate
    };
    let websocket_url = config
        .base_url
        .replacen("https://", "wss://", 1)
        .trim_end_matches('/')
        .to_string()
        + "/api-ws/v1/inference";
    let mut websocket_request = websocket_url
        .into_client_request()
        .map_err(|error| format!("无法创建 FunASR WebSocket 请求: {error}"))?;
    websocket_request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .map_err(|error| format!("百炼 AK 格式无效: {error}"))?,
    );
    websocket_request.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static("qwenaudio-toolkits/0.1"),
    );
    let (mut socket, _) = connect_async(websocket_request)
        .await
        .map_err(|error| format!("FunASR WebSocket 连接失败: {error}"))?;
    let task_id = Uuid::new_v4().to_string();
    let context = request
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let input = context
        .map(|text| {
            json!({
                "context": [{
                    "role": "user",
                    "content": [{
                        "type": "input_text",
                        "text": text.chars().take(400).collect::<String>()
                    }]
                }]
            })
        })
        .unwrap_or_else(|| json!({}));
    let mut parameters = json!({
        "format": "pcm",
        "sample_rate": target_sample_rate,
        "semantic_punctuation_enabled": request.semantic_punctuation.unwrap_or(true)
    });
    if let Some(language) = request
        .language
        .as_deref()
        .filter(|value| !value.trim().is_empty() && *value != "auto")
    {
        parameters["language_hints"] = json!([language]);
    }
    socket
        .send(Message::Text(
            json!({
                "header": {
                    "action": "run-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": {
                    "task_group": "audio",
                    "task": "asr",
                    "function": "recognition",
                    "model": model_id,
                    "parameters": parameters,
                    "input": input
                }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法启动 FunASR 任务: {error}"))?;

    tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| format!("FunASR 启动失败: {error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let event = serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("FunASR 返回了无效事件: {error}"))?;
            match event.pointer("/header/event").and_then(Value::as_str) {
                Some("task-started") => return Ok(()),
                Some("task-failed") => return Err(funasr_event_error(&event)),
                _ => {}
            }
        }
        Err("FunASR 在任务启动前关闭了连接".to_string())
    })
    .await
    .map_err(|_| "FunASR 任务启动超时".to_string())??;

    let (mut writer, mut reader) = socket.split();
    let started = Instant::now();
    let mut total_samples = 0usize;
    let mut captured_pcm = Vec::new();
    let mut final_sentences = Vec::new();
    let mut partial_text = String::new();
    let mut finishing = false;
    loop {
        tokio::select! {
            command = receiver.recv(), if !finishing => {
                match command {
                    Some(FunAsrStreamCommand::Audio(bytes)) => {
                        let bytes = if input_sample_rate == target_sample_rate {
                            bytes
                        } else {
                            let samples = bytes
                                .chunks_exact(2)
                                .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32)
                                .collect::<Vec<_>>();
                            let converted = resample_audio(
                                &PcmAudio {
                                    samples,
                                    sample_rate: input_sample_rate,
                                    channels: 1,
                                },
                                target_sample_rate,
                            )?;
                            converted
                                .samples
                                .iter()
                                .flat_map(|sample| {
                                    ((sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
                                        .to_le_bytes()
                                })
                                .collect()
                        };
                        total_samples += bytes.len() / 2;
                        captured_pcm.extend_from_slice(&bytes);
                        writer
                            .send(Message::Binary(bytes))
                            .await
                            .map_err(|error| format!("FunASR 音频发送失败: {error}"))?;
                    }
                    Some(FunAsrStreamCommand::Finish) | None => {
                        writer
                            .send(Message::Text(
                                json!({
                                    "header": {
                                        "action": "finish-task",
                                        "task_id": task_id,
                                        "streaming": "duplex"
                                    },
                                    "payload": { "input": {} }
                                })
                                .to_string()
                                ,
                            ))
                            .await
                            .map_err(|error| format!("无法结束 FunASR 任务: {error}"))?;
                        finishing = true;
                    }
                }
            }
            message = reader.next() => {
                let message = message
                    .ok_or_else(|| "FunASR 在返回完成事件前关闭了连接".to_string())?
                    .map_err(|error| format!("FunASR 接收失败: {error}"))?;
                let Message::Text(text) = message else {
                    continue;
                };
                let event = serde_json::from_str::<Value>(&text)
                    .map_err(|error| format!("FunASR 返回了无效事件: {error}"))?;
                match event.pointer("/header/event").and_then(Value::as_str) {
                    Some("result-generated") => {
                        let sentence = event
                            .pointer("/payload/output/sentence")
                            .cloned()
                            .unwrap_or(Value::Null);
                        let heartbeat = sentence
                            .get("heartbeat")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if heartbeat {
                            continue;
                        }
                        let sentence_text = sentence
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        let sentence_end = sentence
                            .get("sentence_end")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        if sentence_end {
                            if !sentence_text.is_empty() {
                                final_sentences.push(sentence);
                            }
                            partial_text.clear();
                        } else {
                            partial_text = sentence_text;
                        }
                        let mut text = final_sentences
                            .iter()
                            .filter_map(|item| item.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n");
                        if !partial_text.is_empty() {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&partial_text);
                        }
                        let _ = app.emit(
                            "funasr-stream-event",
                            FunAsrStreamEvent {
                                session_id: session_id.to_string(),
                                run_id: run_id.to_string(),
                                kind: if sentence_end { "final" } else { "partial" },
                                text,
                                error: None,
                            },
                        );
                    }
                    Some("task-finished") => break,
                    Some("task-failed") => return Err(funasr_event_error(&event)),
                    _ => {}
                }
            }
        }
    }

    let duration = total_samples as f32 / target_sample_rate as f32;
    let segments = funasr_segments(&final_sentences, duration);
    let text = segments
        .iter()
        .filter_map(|segment| segment.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err("FunASR 没有识别出有效文本".to_string());
    }
    let speech_seconds = segments
        .iter()
        .map(|segment| {
            let start = segment.get("start").and_then(Value::as_f64).unwrap_or(0.0);
            let end = segment.get("end").and_then(Value::as_f64).unwrap_or(start);
            (end - start).max(0.0)
        })
        .sum::<f64>() as f32;
    let inference_seconds = started.elapsed().as_secs_f32();
    let captured_audio = PcmAudio {
        samples: captured_pcm
            .chunks_exact(2)
            .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32)
            .collect(),
        sample_rate: target_sample_rate,
        channels: 1,
    };
    let source_wav = encode_wav_bytes(&captured_audio)?;
    let source_file_path = write_recording(app, &request.clip_name, &source_wav)?;
    Ok(json!({
        "clipName": request.clip_name,
        "sourceFilePath": path_string(&source_file_path),
        "text": text,
        "language": request.language.unwrap_or_else(|| "auto".to_string()),
        "duration": duration,
        "speechSeconds": speech_seconds,
        "segments": segments,
        "inferenceSeconds": inference_seconds,
        "realTimeFactor": inference_seconds / duration.max(0.001),
        "engine": format!("百炼 · {model_id}")
    }))
}

async fn run_local_asr_stream(
    app: AppHandle,
    session_id: String,
    run_id: String,
    model_path: PathBuf,
    adapter: String,
    request: FunAsrStreamStartRequest,
    receiver: mpsc::Receiver<FunAsrStreamCommand>,
) -> Result<Value, String> {
    if adapter == "funasr-nano" {
        return run_funasr_nano_stream(app, session_id, run_id, model_path, request, receiver)
            .await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut receiver = receiver;
        let mut recognizer = create_streaming_asr_recognizer(&model_path, &adapter)?;
        let started = Instant::now();
        let mut captured_samples = Vec::new();
        let mut latest = None;
        let mut emitted_text = String::new();

        loop {
            match receiver.blocking_recv() {
                Some(FunAsrStreamCommand::Audio(bytes)) => {
                    let samples = bytes
                        .chunks_exact(2)
                        .map(|chunk| {
                            i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32
                        })
                        .collect::<Vec<_>>();
                    let samples = if request.sample_rate == LOCAL_STREAMING_ASR_SAMPLE_RATE {
                        samples
                    } else {
                        resample_audio(
                            &PcmAudio {
                                samples,
                                sample_rate: request.sample_rate,
                                channels: 1,
                            },
                            LOCAL_STREAMING_ASR_SAMPLE_RATE,
                        )?
                        .samples
                    };
                    captured_samples.extend_from_slice(&samples);
                    if let Some(update) = recognizer.accept_samples(&samples) {
                        if !update.text.is_empty() && update.text != emitted_text {
                            emitted_text.clone_from(&update.text);
                            let _ = app.emit(
                                "funasr-stream-event",
                                FunAsrStreamEvent {
                                    session_id: session_id.clone(),
                                    run_id: run_id.clone(),
                                    kind: "partial",
                                    text: update.text.clone(),
                                    error: None,
                                },
                            );
                        }
                        latest = Some(update);
                    }
                }
                Some(FunAsrStreamCommand::Finish) | None => {
                    latest = recognizer.finish().or(latest);
                    break;
                }
            }
        }

        let result = latest.ok_or_else(|| "本地流式 ASR 没有返回识别结果".to_string())?;
        if result.text.trim().is_empty() {
            return Err("本地流式 ASR 没有识别出有效文本".to_string());
        }
        let duration = captured_samples.len() as f32 / LOCAL_STREAMING_ASR_SAMPLE_RATE as f32;
        emitted_text.clone_from(&result.text);
        let tokens = result
            .tokens
            .iter()
            .enumerate()
            .map(|(index, token)| {
                let start = result.timestamps.get(index).copied().unwrap_or_default();
                let end = result
                    .timestamps
                    .get(index + 1)
                    .copied()
                    .unwrap_or((start + 0.2).min(duration));
                json!({ "text": token, "start": start, "end": end })
            })
            .collect::<Vec<_>>();
        let _ = app.emit(
            "funasr-stream-event",
            FunAsrStreamEvent {
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                kind: "final",
                text: result.text.clone(),
                error: None,
            },
        );
        let source_wav = encode_wav_bytes(&PcmAudio {
            samples: captured_samples,
            sample_rate: LOCAL_STREAMING_ASR_SAMPLE_RATE,
            channels: 1,
        })?;
        let source_file_path = write_recording(&app, &request.clip_name, &source_wav)?;
        let inference_seconds = started.elapsed().as_secs_f32();
        Ok(json!({
            "clipName": request.clip_name,
            "sourceFilePath": path_string(&source_file_path),
            "text": result.text,
            "language": request.language.unwrap_or_else(|| "auto".to_string()),
            "duration": duration,
            "speechSeconds": duration,
            "segments": [{
                "id": "stream-0",
                "start": 0.0,
                "end": duration,
                "text": emitted_text,
                "tokens": tokens
            }],
            "inferenceSeconds": inference_seconds,
            "realTimeFactor": inference_seconds / duration.max(0.001),
            "engine": format!("{} / sherpa-onnx", if adapter == "streaming-paraformer" {
                "Streaming Paraformer"
            } else {
                "Streaming Zipformer"
            })
        }))
    })
    .await
    .map_err(|error| format!("本地流式 ASR 线程异常结束: {error}"))?
}

// Streaming FunASR Nano: spawn `llama-funasr-cli --stream` once for the whole session and
// keep it alive for as long as the frontend keeps pushing audio. PCM pushed via
// harness_push_funasr_stream is resampled to 16 kHz mono and written straight to the child's
// stdin; a dedicated reader thread parses its "LOCKED "/"PARTIAL "/"DONE" stdout protocol
// (see funasr-cli.cpp's run_streaming()) and emits the same funasr-stream-event the cloud
// FunASR Realtime and sherpa-onnx streaming adapters already use, so the frontend does not
// need to know which adapter produced a given session.
async fn run_funasr_nano_stream(
    app: AppHandle,
    session_id: String,
    run_id: String,
    model_path: PathBuf,
    request: FunAsrStreamStartRequest,
    mut receiver: mpsc::Receiver<FunAsrStreamCommand>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let runtime_bin = plugins::funasr_runtime_executable(&model_path)?;
        let decoder = find_model_file(&model_path, |name| name.starts_with("qwen3-0.6b-"))?;
        let vad = resolve_funasr_vad_path(&model_path)
            .ok_or_else(|| "FunASR Nano 模型包缺少内置 FSMN-VAD".to_string())?;
        let mut child = Command::new(&runtime_bin)
            .arg("--enc")
            .arg(model_path.join("funasr-encoder-f16.gguf"))
            .arg("-m")
            .arg(&decoder)
            .arg("--vad")
            .arg(&vad)
            .arg("--stream")
            .current_dir(runtime_bin.parent().unwrap_or(&model_path))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("无法启动本地实时 FunASR: {error}"))?;
        let mut child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法写入本地实时 FunASR 输入".to_string())?;
        let child_stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取本地实时 FunASR 输出".to_string())?;

        let reader_app = app.clone();
        let reader_session_id = session_id.clone();
        let reader_run_id = run_id.clone();
        let (done_tx, done_rx) = std_mpsc::channel::<String>();
        let reader_handle = thread::spawn(move || {
            let mut locked_text = String::new();
            for line in BufReader::new(child_stdout).lines().map_while(Result::ok) {
                if let Some(text) = line.strip_prefix("LOCKED ") {
                    locked_text.push_str(text);
                    let _ = reader_app.emit(
                        "funasr-stream-event",
                        FunAsrStreamEvent {
                            session_id: reader_session_id.clone(),
                            run_id: reader_run_id.clone(),
                            kind: "partial",
                            text: locked_text.clone(),
                            error: None,
                        },
                    );
                } else if let Some(text) = line.strip_prefix("PARTIAL ") {
                    let _ = reader_app.emit(
                        "funasr-stream-event",
                        FunAsrStreamEvent {
                            session_id: reader_session_id.clone(),
                            run_id: reader_run_id.clone(),
                            kind: "partial",
                            text: format!("{locked_text}{text}"),
                            error: None,
                        },
                    );
                } else if line == "DONE" {
                    break;
                }
            }
            let _ = done_tx.send(locked_text);
        });

        let mut captured_samples = Vec::new();
        while let Some(command) = receiver.blocking_recv() {
            match command {
                FunAsrStreamCommand::Audio(bytes) => {
                    let samples = bytes
                        .chunks_exact(2)
                        .map(|chunk| {
                            i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32
                        })
                        .collect::<Vec<_>>();
                    let samples = if request.sample_rate == LOCAL_STREAMING_ASR_SAMPLE_RATE {
                        samples
                    } else {
                        resample_audio(
                            &PcmAudio {
                                samples,
                                sample_rate: request.sample_rate,
                                channels: 1,
                            },
                            LOCAL_STREAMING_ASR_SAMPLE_RATE,
                        )?
                        .samples
                    };
                    let pcm_bytes = samples
                        .iter()
                        .flat_map(|sample| {
                            { (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16 }.to_le_bytes()
                        })
                        .collect::<Vec<u8>>();
                    if child_stdin.write_all(&pcm_bytes).is_err() {
                        break; // child exited early (crash) -- fall through to drain+report below
                    }
                    captured_samples.extend_from_slice(&samples);
                }
                FunAsrStreamCommand::Finish => break,
            }
        }
        drop(child_stdin); // EOF -> child force-closes the trailing segment and prints DONE
        let locked_text = done_rx
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_default();
        let _ = child.wait();
        let _ = reader_handle.join();

        if locked_text.trim().is_empty() {
            return Err("本地流式 ASR 没有识别出有效文本".to_string());
        }
        let duration = captured_samples.len() as f32 / LOCAL_STREAMING_ASR_SAMPLE_RATE as f32;
        let _ = app.emit(
            "funasr-stream-event",
            FunAsrStreamEvent {
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                kind: "final",
                text: locked_text.clone(),
                error: None,
            },
        );
        let source_wav = encode_wav_bytes(&PcmAudio {
            samples: captured_samples,
            sample_rate: LOCAL_STREAMING_ASR_SAMPLE_RATE,
            channels: 1,
        })?;
        let source_file_path = write_recording(&app, &request.clip_name, &source_wav)?;
        let inference_seconds = started.elapsed().as_secs_f32();
        Ok(json!({
            "clipName": request.clip_name,
            "sourceFilePath": path_string(&source_file_path),
            "text": locked_text,
            "language": request.language.unwrap_or_else(|| "auto".to_string()),
            "duration": duration,
            "speechSeconds": duration,
            "segments": [{
                "id": "stream-0",
                "start": 0.0,
                "end": duration,
                "text": locked_text,
                "tokens": []
            }],
            "inferenceSeconds": inference_seconds,
            "realTimeFactor": inference_seconds / duration.max(0.001),
            "engine": "Fun-ASR Nano / llama.cpp"
        }))
    })
    .await
    .map_err(|error| format!("本地实时 FunASR 线程异常结束: {error}"))?
}

fn finish_streaming_asr_run(
    app: &AppHandle,
    runtime: &Arc<HarnessRuntime>,
    session_id: &str,
    run_id: &str,
    started: Instant,
    result: Result<Value, String>,
) {
    let final_text = result
        .as_ref()
        .ok()
        .and_then(|payload| payload.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let artifact = result
        .as_ref()
        .ok()
        .and_then(|payload| artifact_from_payload(CAPABILITY_ASR, payload.clone()).ok());
    let updated = runtime.update(app, run_id, |run| {
        run.completed_at = Some(timestamp_millis());
        run.duration_ms = Some(started.elapsed().as_millis() as u64);
        run.progress = 100;
        match (&result, artifact) {
            (Ok(_), Some(artifact)) => {
                run.status = "completed".to_string();
                run.artifacts = vec![artifact];
                run.error = None;
            }
            (Ok(_), None) => {
                run.status = "failed".to_string();
                run.error = Some("无法保存本地流式识别结果".to_string());
            }
            (Err(error), _) => {
                run.status = "failed".to_string();
                run.error = Some(error.clone());
            }
        }
    });
    if let Ok(run) = updated {
        emit_run(app, &run);
    }
    let (kind, error) = match result {
        Ok(_) => ("completed", None),
        Err(error) => ("error", Some(error)),
    };
    let _ = app.emit(
        "funasr-stream-event",
        FunAsrStreamEvent {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            kind,
            text: final_text,
            error,
        },
    );
    if let Ok(mut streams) = runtime.funasr_streams.lock() {
        streams.remove(session_id);
    }
}

async fn execute_local_cosyvoice(
    app: AppHandle,
    text: String,
    speed: f32,
    reference_audio_data_url: Option<String>,
    reference_text: Option<String>,
    model_path: PathBuf,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let reference_audio_data_url = reference_audio_data_url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "离线 CosyVoice 需要一段参考音频".to_string())?;
    let reference_text = reference_text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "离线 CosyVoice 需要与参考音频对应的参考文本".to_string())?;
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("generated");

    tauri::async_runtime::spawn_blocking(move || {
        if cancel.load(Ordering::Relaxed) {
            return Err("任务已取消".to_string());
        }
        fs::create_dir_all(&output_dir)
            .map_err(|error| format!("无法创建音频输出目录: {error}"))?;
        let runtime = plugins::cosyvoice_runtime_executable(&model_path)?;
        let backend_dir = plugins::cosyvoice_backend_directory(&model_path)?;
        let model = plugins::cosyvoice_model_file(&model_path)?;
        let speech_tokenizer = model_path
            .join("frontend-onnx")
            .join("speech_tokenizer_v3.int8.onnx");
        let campplus = model_path.join("frontend-onnx").join("campplus.int8.onnx");
        let mut reference_audio = decode_wav_data_url(&reference_audio_data_url)?;
        let reference_gain_db = normalize_generated_speech(&mut reference_audio);
        let reference_wav = encode_wav_bytes(&reference_audio)?;
        let stamp = timestamp_millis();
        let reference_path = output_dir.join(format!("cosyvoice-reference-{stamp}.wav"));
        let file_name = format!("fun-cosyvoice3-{stamp}.wav");
        let output_path = output_dir.join(&file_name);
        fs::write(&reference_path, reference_wav)
            .map_err(|error| format!("无法准备 CosyVoice 参考音频: {error}"))?;

        let mut command = Command::new(&runtime);
        command
            .arg("--model")
            .arg(&model)
            .arg("--backend-path")
            .arg(&backend_dir)
            .arg("--cpu")
            .arg("--speech-tokenizer")
            .arg(&speech_tokenizer)
            .arg("--campplus")
            .arg(&campplus)
            .arg("--prompt-audio")
            .arg(&reference_path)
            .arg("--prompt-text")
            .arg(&reference_text)
            .arg("--text")
            .arg(text.trim())
            .arg("--speed")
            .arg(speed.to_string())
            .arg("--output")
            .arg(&output_path)
            .arg("--quiet");
        if let Some(directory) = runtime.parent() {
            command.current_dir(directory);
            let mut search_paths = vec![directory.to_path_buf(), backend_dir.clone()];
            if let Some(existing) = env::var_os(if cfg!(target_os = "macos") {
                "DYLD_LIBRARY_PATH"
            } else if cfg!(target_os = "windows") {
                "PATH"
            } else {
                "LD_LIBRARY_PATH"
            }) {
                search_paths.extend(env::split_paths(&existing));
            }
            let variable = if cfg!(target_os = "macos") {
                "DYLD_LIBRARY_PATH"
            } else if cfg!(target_os = "windows") {
                "PATH"
            } else {
                "LD_LIBRARY_PATH"
            };
            command.env(
                variable,
                env::join_paths(search_paths)
                    .map_err(|error| format!("无法配置 CosyVoice 动态库目录: {error}"))?,
            );
        }

        let started = Instant::now();
        let command_result = command.output();
        let _ = fs::remove_file(&reference_path);
        let output = command_result.map_err(|error| format!("无法启动 CosyVoice: {error}"))?;
        if !output.status.success() {
            let _ = fs::remove_file(&output_path);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "CosyVoice 生成失败: {}",
                stderr
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("运行时未返回错误详情")
            ));
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&output_path);
            return Err("任务已取消".to_string());
        }

        let source_bytes =
            fs::read(&output_path).map_err(|error| format!("无法读取 CosyVoice 输出: {error}"))?;
        let mut audio = decode_wav_bytes(&source_bytes)?;
        let loudness_gain_db = normalize_generated_speech(&mut audio);
        // cosyvoice.cpp writes IEEE-float WAV. Always persist PCM16 so WebKit can
        // decode the same artifact for playback, waveform, and Mel analysis.
        let bytes = encode_wav_bytes(&audio)?;
        fs::write(&output_path, &bytes)
            .map_err(|error| format!("无法保存 CosyVoice 音频: {error}"))?;
        let duration = audio.duration();
        let inference_seconds = started.elapsed().as_secs_f32();
        Ok(json!({
            "fileName": file_name,
            "filePath": path_string(&output_path),
            "dataUrl": wav_data_url(&bytes),
            "duration": duration,
            "sampleRate": audio.sample_rate,
            "channels": audio.channels,
            "sizeBytes": bytes.len() as u64,
            "waveform": waveform_envelope(&audio, 240),
            "inferenceSeconds": inference_seconds,
            "realTimeFactor": inference_seconds / duration.max(0.001),
            "loudnessGainDb": loudness_gain_db,
            "referenceGainDb": reference_gain_db,
            "sid": -1,
            "engine": "cosyvoice.cpp · Fun-CosyVoice3 0.5B"
        }))
    })
    .await
    .map_err(|error| format!("CosyVoice 推理线程异常结束: {error}"))?
}

async fn execute_official_funasr(
    app: AppHandle,
    audio_data_url: String,
    clip_name: String,
    model_path: PathBuf,
    adapter: String,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if cancel.load(Ordering::Relaxed) {
            return Err("任务已取消".to_string());
        }
        let decoded = decode_wav_data_url(&audio_data_url)?;
        let resampled = resample_audio(&decoded, 16_000)?;
        let audio = PcmAudio {
            samples: resampled.mono_samples(),
            sample_rate: 16_000,
            channels: 1,
        };
        let duration = audio.samples.len() as f32 / 16_000.0;
        let wav = encode_wav_bytes(&audio)?;
        let source_file_path = write_recording(&app, &clip_name, &wav)?;
        let (runtime, model_args, engine) = match adapter.as_str() {
            "funasr-nano" => {
                let decoder = find_model_file(&model_path, |name| name.starts_with("qwen3-0.6b-"))?;
                (
                    plugins::funasr_runtime_executable(&model_path)?,
                    vec![
                        "--enc".to_string(),
                        path_string(&model_path.join("funasr-encoder-f16.gguf")),
                        "-m".to_string(),
                        path_string(&decoder),
                    ],
                    "Fun-ASR Nano",
                )
            }
            "funasr-sensevoice-gguf" => (
                plugins::funasr_runtime_binary(&model_path, "llama-funasr-sensevoice")?,
                vec![
                    "-m".to_string(),
                    path_string(&find_model_file(&model_path, |name| {
                        name.starts_with("sensevoice-small")
                    })?),
                    "--keep-tags".to_string(),
                ],
                "SenseVoice Small GGUF",
            ),
            "funasr-paraformer-gguf" => (
                plugins::funasr_runtime_binary(&model_path, "llama-funasr-paraformer")?,
                vec![
                    "-m".to_string(),
                    path_string(&find_model_file(&model_path, |name| {
                        name.starts_with("paraformer")
                    })?),
                ],
                "Paraformer GGUF",
            ),
            _ => return Err(format!("不支持的 FunASR 官方适配器: {adapter}")),
        };
        let started = Instant::now();
        let vad = resolve_funasr_vad_path(&model_path)
            .ok_or_else(|| format!("{engine} 模型包缺少内置 FSMN-VAD"))?;
        let mut command = Command::new(&runtime);
        command
            .args(model_args)
            .arg("-a")
            .arg(&source_file_path)
            .arg("--vad")
            .arg(vad)
            .arg("--vad-maxseg")
            .arg("30000");
        let output = command
            .current_dir(runtime.parent().unwrap_or(&model_path))
            .output()
            .map_err(|error| format!("无法启动 FunASR 官方运行时: {error}"))?;
        if cancel.load(Ordering::Relaxed) {
            return Err("任务已取消".to_string());
        }
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "FunASR 识别失败: {}",
                error
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("运行时未返回错误详情")
            ));
        }
        let raw_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let (text, language, emotion, audio_event) = if adapter == "funasr-sensevoice-gguf" {
            parse_sensevoice_output(&raw_text)
        } else {
            (raw_text, "auto".to_string(), None, None)
        };
        if text.is_empty() {
            return Err("FunASR 没有识别出有效文本".to_string());
        }
        let inference_seconds = started.elapsed().as_secs_f32();
        Ok(json!({
            "clipName": clip_name,
            "sourceFilePath": path_string(&source_file_path),
            "text": text,
            "language": language,
            "emotion": emotion,
            "audioEvent": audio_event,
            "duration": duration,
            "speechSeconds": duration,
            "segments": [{
                "id": "funasr-official-0",
                "start": 0.0,
                "end": duration,
                "text": text,
                "tokens": []
            }],
            "inferenceSeconds": inference_seconds,
            "realTimeFactor": inference_seconds / duration.max(0.001),
            "engine": format!("QwenAudio {engine} llama.cpp")
        }))
    })
    .await
    .map_err(|error| format!("FunASR 官方运行时异常结束: {error}"))?
}

fn parse_sensevoice_output(raw: &str) -> (String, String, Option<String>, Option<String>) {
    let mut rest = raw.trim();
    let mut tags = Vec::new();
    while let Some(value) = rest.strip_prefix("<|") {
        let Some(end) = value.find("|>") else { break };
        tags.push(value[..end].to_string());
        rest = &value[end + 2..];
    }
    let language = tags.first().cloned().unwrap_or_else(|| "auto".to_string());
    let emotion = tags.get(1).cloned();
    let audio_event = tags.get(2).cloned();
    (rest.trim().to_string(), language, emotion, audio_event)
}

// Each official FunASR GGUF model pack is self-contained and carries the FSMN-VAD file used
// by its own CLI. The standalone FSMN plugin is a separate user-facing VAD model, not a runtime
// dependency of Nano, SenseVoice, or Paraformer.
fn resolve_funasr_vad_path(model_path: &Path) -> Option<PathBuf> {
    let bundled = model_path.join("fsmn-vad.gguf");
    bundled.is_file().then_some(bundled)
}

fn find_model_file(model_path: &Path, predicate: impl Fn(&str) -> bool) -> Result<PathBuf, String> {
    fs::read_dir(model_path)
        .map_err(|error| format!("无法检查 FunASR 模型目录: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(&predicate)
        })
        .ok_or_else(|| "FunASR 模型目录缺少 GGUF 权重".to_string())
}

async fn execute_official_fsmn_vad(
    app: AppHandle,
    audio_data_url: String,
    clip_name: String,
    model_path: PathBuf,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_wav_data_url(&audio_data_url)?;
        let resampled = resample_audio(&decoded, 16_000)?;
        let audio = PcmAudio {
            samples: resampled.mono_samples(),
            sample_rate: 16_000,
            channels: 1,
        };
        let duration = audio.duration();
        let wav = encode_wav_bytes(&audio)?;
        let source_file_path = write_recording(&app, &clip_name, &wav)?;
        let runtime = plugins::funasr_runtime_binary(&model_path, "llama-funasr-vad")?;
        let started = Instant::now();
        let output = Command::new(&runtime)
            .arg("-m")
            .arg(model_path.join("fsmn-vad.gguf"))
            .arg("-a")
            .arg(&source_file_path)
            .current_dir(runtime.parent().unwrap_or(&model_path))
            .output()
            .map_err(|error| format!("无法启动 FSMN-VAD 官方运行时: {error}"))?;
        if cancel.load(Ordering::Relaxed) {
            return Err("任务已取消".to_string());
        }
        if !output.status.success() {
            return Err(format!(
                "FSMN-VAD 检测失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let segments = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut values = line.split_whitespace();
                let start = values.next()?.parse::<f32>().ok()? / 1000.0;
                let end = values.next()?.parse::<f32>().ok()? / 1000.0;
                (end > start).then_some((start, end))
            })
            .collect::<Vec<_>>();
        let speech_seconds = segments.iter().map(|(start, end)| end - start).sum::<f32>();
        let inference_seconds = started.elapsed().as_secs_f32();
        Ok(json!({
            "clipName": clip_name,
            "sourceFilePath": path_string(&source_file_path),
            "duration": duration,
            "speechSeconds": speech_seconds,
            "silenceSeconds": (duration - speech_seconds).max(0.0),
            "segments": segments.iter().enumerate().map(|(index, (start, end))| json!({
                "id": format!("fsmn-vad-{index}"), "start": start, "end": end,
                "duration": end - start
            })).collect::<Vec<_>>(),
            "waveform": waveform_envelope(&audio, 240),
            "inferenceSeconds": inference_seconds,
            "realTimeFactor": inference_seconds / duration.max(0.001),
            "threshold": 0.5,
            "engine": "QwenAudio FSMN-VAD llama.cpp"
        }))
    })
    .await
    .map_err(|error| format!("FSMN-VAD 官方运行时异常结束: {error}"))?
}

#[allow(clippy::too_many_arguments)]
async fn execute_request(
    app: AppHandle,
    tts_runtime: Arc<TtsRuntime>,
    asr_runtime: Arc<AsrRuntime>,
    audio_runtime: Arc<AudioProcessingRuntime>,
    request: &HarnessTaskRequest,
    provider: &ResolvedProvider,
    cancel: Arc<AtomicBool>,
    progress_callback: Option<AsrProgressCallback>,
) -> Result<HarnessArtifact, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    if !provider.is_api {
        let adapter_capability =
            plugins::adapter_capability(&provider.adapter).ok_or_else(|| {
                format!(
                    "Provider {} 使用了未知 adapter {}",
                    provider.id, provider.adapter
                )
            })?;
        if adapter_capability != request.capability {
            return Err(format!(
                "Provider {} 的 adapter {} 无法执行 {}",
                provider.id, provider.adapter, request.capability
            ));
        }
    }

    let execution_started = Instant::now();
    let mut payload = match (request.capability.as_str(), provider.is_api) {
        (CAPABILITY_TTS, false) => {
            let text = match optional_string(&request.parameters, "synthesisText") {
                Some(text) => text,
                None => required_string(&request.input, "text")?,
            };
            let sid = number(&request.parameters, "sid").unwrap_or(3.0) as i32;
            let speed = number(&request.parameters, "speed").unwrap_or(0.96) as f32;
            let silence_scale =
                number(&request.parameters, "silenceScale").map(|value| value as f32);
            let reference_audio_data_url =
                optional_string(&request.parameters, "referenceAudioDataUrl");
            let reference_text = optional_string(&request.parameters, "referenceText");
            let num_steps =
                number(&request.parameters, "numSteps").map(|value| value.round() as i32);
            let language = optional_string(&request.parameters, "language");
            if provider.adapter == "cosyvoice-local" {
                execute_local_cosyvoice(
                    app.clone(),
                    text,
                    speed,
                    reference_audio_data_url,
                    reference_text,
                    provider
                        .model_path
                        .clone()
                        .ok_or_else(|| "CosyVoice Provider 缺少模型目录".to_string())?,
                    cancel,
                )
                .await?
            } else {
                let result = generate_speech_with_runtime(
                    app.clone(),
                    tts_runtime,
                    TtsGenerateRequest::new(
                        text,
                        sid,
                        speed,
                        silence_scale,
                        reference_audio_data_url,
                        reference_text,
                        num_steps,
                        language,
                    ),
                    Some(cancel),
                    provider.model_path.clone(),
                    progress_callback.clone(),
                )
                .await?;
                serde_json::to_value(result)
                    .map_err(|error| format!("无法整理音频生成结果: {error}"))?
            }
        }
        (CAPABILITY_TTS, true) => {
            if matches!(provider.adapter.as_str(), "bailian" | "bailian-cosyvoice") {
                execute_bailian_tts(&app, request, &provider.model_id, cancel).await?
            } else {
                execute_api_tts(&app, request, cancel).await?
            }
        }
        (CAPABILITY_ASR, false) => {
            let audio_data_url = required_string(&request.input, "audioDataUrl")?;
            let clip_name = required_string(&request.input, "clipName")?;
            if matches!(
                provider.adapter.as_str(),
                "funasr-nano" | "funasr-sensevoice-gguf" | "funasr-paraformer-gguf"
            ) {
                execute_official_funasr(
                    app.clone(),
                    audio_data_url,
                    clip_name,
                    provider
                        .model_path
                        .clone()
                        .ok_or_else(|| "FunASR Provider 缺少模型目录".to_string())?,
                    provider.adapter.clone(),
                    cancel,
                )
                .await?
            } else {
                let speech_segments = request
                    .input
                    .get("speechSegments")
                    .and_then(Value::as_array)
                    .map(|segments| {
                        segments
                            .iter()
                            .filter_map(|segment| {
                                let start = segment.get("start")?.as_f64()? as f32;
                                let end = segment.get("end")?.as_f64()? as f32;
                                (end > start).then_some((start, end))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let asr_request = AsrTranscribeRequest::new(audio_data_url, clip_name)
                    .with_speech_segments(speech_segments)
                    .with_model_options(
                        optional_string(&request.parameters, "hotwords").unwrap_or_default(),
                        optional_string(&request.parameters, "sourceLanguage")
                            .unwrap_or_else(|| "en".to_string()),
                        optional_string(&request.parameters, "targetLanguage")
                            .unwrap_or_else(|| "en".to_string()),
                        request
                            .parameters
                            .get("punctuation")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                    );
                let result = if matches!(
                    provider.adapter.as_str(),
                    "streaming-zipformer" | "streaming-paraformer"
                ) {
                    transcribe_streaming_audio(
                        asr_request,
                        Some(cancel),
                        provider
                            .model_path
                            .clone()
                            .ok_or_else(|| "Zipformer Provider 缺少模型目录".to_string())?,
                        provider.adapter.clone(),
                    )
                    .await?
                } else {
                    let model_path = provider
                        .model_path
                        .clone()
                        .ok_or_else(|| "本地 ASR Provider 缺少模型目录".to_string())?;
                    transcribe_audio_with_runtime(
                        app.clone(),
                        asr_runtime,
                        asr_request,
                        Some(cancel),
                        model_path,
                        provider.adapter.clone(),
                        progress_callback.clone(),
                    )
                    .await?
                };
                serde_json::to_value(result)
                    .map_err(|error| format!("无法整理识别结果: {error}"))?
            }
        }
        (CAPABILITY_ASR, true) => {
            if provider.adapter == "bailian-funasr" {
                execute_bailian_funasr(&app, request, &provider.model_id, cancel).await?
            } else if provider.adapter == "bailian" {
                execute_bailian_asr(&app, request, &provider.model_id, cancel).await?
            } else {
                execute_api_asr(&app, request, cancel).await?
            }
        }
        (CAPABILITY_VAD, false) => {
            let audio_data_url = required_string(&request.input, "audioDataUrl")?;
            let clip_name = required_string(&request.input, "clipName")?;
            if provider.adapter == "funasr-fsmn-vad-gguf" {
                execute_official_fsmn_vad(
                    app.clone(),
                    audio_data_url,
                    clip_name,
                    provider
                        .model_path
                        .clone()
                        .ok_or_else(|| "FSMN-VAD Provider 缺少模型目录".to_string())?,
                    cancel,
                )
                .await?
            } else {
                let result = detect_speech_with_model(
                    app.clone(),
                    VadDetectRequest::new(
                        audio_data_url,
                        clip_name,
                        optional_number(&request.parameters, "threshold"),
                        optional_number(&request.parameters, "minSpeechDuration"),
                        optional_number(&request.parameters, "minSilenceDuration"),
                    ),
                    Some(cancel),
                    provider.model_path.clone(),
                )
                .await?;
                serde_json::to_value(result)
                    .map_err(|error| format!("无法整理 VAD 结果: {error}"))?
            }
        }
        (CAPABILITY_VAD, true) => {
            return Err("当前 API Provider 没有声明 speech.detect 适配器".to_string())
        }
        (CAPABILITY_TEXT, true) => execute_api_text(&app, request, provider, cancel).await?,
        (CAPABILITY_TEXT, false) => {
            return Err("当前还没有安装可执行 text.generate 的本地适配器".to_string())
        }
        (CAPABILITY_ENHANCE, false) => {
            let audio_data_url = required_string(&request.input, "audioDataUrl")?;
            let clip_name = required_string(&request.input, "clipName")?;
            let operations = string_array(&request.parameters, "operations");
            let result = process_audio_with_runtime(
                app.clone(),
                audio_runtime,
                AudioProcessRequest::new(
                    audio_data_url,
                    clip_name,
                    operations,
                    optional_number(&request.parameters, "selectionStart"),
                    optional_number(&request.parameters, "selectionEnd"),
                    optional_number(&request.parameters, "denoiseStrength"),
                    optional_number(&request.parameters, "targetLoudnessDb"),
                    optional_number(&request.parameters, "silencePaddingMs")
                        .map(|value| value.max(0.0) as u32),
                    optional_number(&request.parameters, "fadeMs")
                        .map(|value| value.max(0.0) as u32),
                ),
                Some(cancel),
                provider.model_path.clone(),
                None,
                Some(provider.adapter.clone()),
                progress_callback.clone(),
            )
            .await?;
            serde_json::to_value(result)
                .map_err(|error| format!("无法整理音频处理结果: {error}"))?
        }
        (CAPABILITY_AUDIO_TAGGING, false) => {
            let audio = required_string(&request.input, "audioDataUrl")?;
            run_audio_tagging(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "Audio Tagging 缺少模型目录".to_string())?,
                &audio,
            )?
        }
        (CAPABILITY_LANGUAGE_ID, false) => {
            let audio = required_string(&request.input, "audioDataUrl")?;
            run_language_id(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "Language ID 缺少模型目录".to_string())?,
                &audio,
            )?
        }
        (CAPABILITY_PUNCTUATION, false) => {
            let text = required_string(&request.input, "text")?;
            run_punctuation(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "Punctuation 缺少模型目录".to_string())?,
                &text,
            )?
        }
        (CAPABILITY_TEXT_NORMALIZE, false) => {
            let text = required_string(&request.input, "text")?;
            normalize_text(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "WeText 缺少规则目录".to_string())?,
                &text,
                &request.parameters,
            )?
        }
        (CAPABILITY_KWS, false) => {
            let audio = required_string(&request.input, "audioDataUrl")?;
            let keywords = string_array(&request.parameters, "keywords");
            run_keyword_spotting(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "Keyword Spotting 缺少模型目录".to_string())?,
                &audio,
                &keywords,
            )?
        }
        (CAPABILITY_SPEAKER_EMBED, false) => {
            let audio = required_string(&request.input, "audioDataUrl")?;
            run_speaker_embedding(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "Speaker Embedding 缺少模型目录".to_string())?,
                &audio,
            )?
        }
        (CAPABILITY_DIARIZATION, false) => {
            let audio = required_string(&request.input, "audioDataUrl")?;
            run_diarization(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "Speaker Diarization 缺少模型目录".to_string())?,
                &audio,
            )?
        }
        (CAPABILITY_SOURCE_SEPARATION, false) => {
            let audio = required_string(&request.input, "audioDataUrl")?;
            run_source_separation(
                provider
                    .model_path
                    .as_deref()
                    .ok_or_else(|| "Source Separation 缺少模型目录".to_string())?,
                &audio,
            )?
        }
        (CAPABILITY_ENHANCE, true) if provider.adapter == "bailian-audio-process" => {
            execute_bailian_audio_process(&app, request, &provider.model_id, cancel, false).await?
        }
        (CAPABILITY_SOURCE_SEPARATION, true) if provider.adapter == "bailian-audio-process" => {
            execute_bailian_audio_process(&app, request, &provider.model_id, cancel, true).await?
        }
        (CAPABILITY_ENHANCE, true) => {
            return Err("当前 API Provider 没有声明 audio.enhance 适配器".to_string())
        }
        (CAPABILITY_LIVE, false) => {
            if request
                .input
                .get("audioDataUrl")
                .and_then(Value::as_str)
                .is_some()
            {
                save_live_recording(&app, request)?
            } else {
                json!({
                    "sessionReady": true,
                    "engine": "Web Audio local stream",
                    "inputDevice": request.input.get("inputDevice").and_then(Value::as_str).unwrap_or("default"),
                    "outputDevice": request.input.get("outputDevice").and_then(Value::as_str).unwrap_or("default"),
                    "record": request.parameters.get("record").and_then(Value::as_bool).unwrap_or(true)
                })
            }
        }
        (CAPABILITY_LIVE, true) => return Err("实时流仅支持本地 Provider".to_string()),
        _ => return Err(format!("不支持的能力: {}", request.capability)),
    };

    if let Some(callback) = progress_callback.as_ref() {
        callback(98, "正在整理运行结果".to_string());
    }

    if let Some(object) = payload.as_object_mut() {
        object
            .entry("inferenceSeconds")
            .or_insert_with(|| json!(execution_started.elapsed().as_secs_f32()));
    }
    artifact_from_payload(&request.capability, payload)
}

fn capability_accepts_audio(capability: &str) -> bool {
    matches!(
        capability,
        CAPABILITY_ASR
            | CAPABILITY_VAD
            | CAPABILITY_ENHANCE
            | CAPABILITY_AUDIO_TAGGING
            | CAPABILITY_KWS
            | CAPABILITY_LANGUAGE_ID
            | CAPABILITY_SPEAKER_EMBED
            | CAPABILITY_DIARIZATION
            | CAPABILITY_SOURCE_SEPARATION
    )
}

async fn execute_bailian_audio_process(
    app: &AppHandle,
    request: &HarnessTaskRequest,
    model_id: &str,
    cancel: Arc<AtomicBool>,
    separate: bool,
) -> Result<Value, String> {
    let config = configured_bailian_provider(app)?;
    let audio_data_url = required_string(&request.input, "audioDataUrl")?;
    let clip_name = required_string(&request.input, "clipName")?;
    let input_bytes = decode_data_url_bytes(&audio_data_url)?;
    let input_audio = decode_wav_data_url(&audio_data_url)?;
    let sample_rate_out = request
        .parameters
        .get("sampleRate")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(8_000, 192_000) as u32)
        .unwrap_or(input_audio.sample_rate);
    let websocket_url = config
        .base_url
        .replacen("https://", "wss://", 1)
        .trim_end_matches('/')
        .to_string()
        + "/api-ws/v1/inference";
    let mut websocket_request = websocket_url
        .into_client_request()
        .map_err(|error| format!("无法创建百炼音频处理请求: {error}"))?;
    websocket_request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .map_err(|error| format!("百炼 AK 格式无效: {error}"))?,
    );
    websocket_request.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static("qwenaudio-toolkits/0.1"),
    );

    let started = Instant::now();
    let (mut socket, _) = connect_async(websocket_request)
        .await
        .map_err(|error| format!("百炼音频处理 WebSocket 连接失败: {error}"))?;
    let task_id = Uuid::new_v4().to_string();
    let mut parameters = json!({
        "model": model_id,
        "format": "wav",
        "sample_rate_in": input_audio.sample_rate,
        "sample_rate_out": sample_rate_out
    });
    if !separate {
        parameters["enable_denoise"] = Value::Bool(true);
    }
    socket
        .send(Message::Text(
            json!({
                "header": {
                    "action": "run-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": {
                    "task_group": "audio",
                    "task": "audio-process",
                    "function": "process",
                    "model": model_id,
                    "parameters": parameters,
                    "input": {}
                }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法启动百炼音频处理任务: {error}"))?;

    tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| format!("百炼音频处理启动失败: {error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let event = serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("百炼音频处理返回了无效事件: {error}"))?;
            match event.pointer("/header/event").and_then(Value::as_str) {
                Some("task-started") => return Ok(()),
                Some("task-failed") => return Err(bailian_audio_process_event_error(&event)),
                _ => {}
            }
        }
        Err("百炼音频处理在任务启动前关闭了连接".to_string())
    })
    .await
    .map_err(|_| "百炼音频处理任务启动超时".to_string())??;

    let (mut writer, mut reader) = socket.split();
    let mut reader_task = tokio::spawn(async move {
        let mut audio_bytes = Vec::new();
        let mut output = json!({});
        let mut usage = json!({});
        while let Some(message) = reader.next().await {
            let message = message.map_err(|error| format!("百炼音频处理接收失败: {error}"))?;
            match message {
                Message::Binary(bytes) => audio_bytes.extend_from_slice(&bytes),
                Message::Text(text) => {
                    let event = serde_json::from_str::<Value>(&text)
                        .map_err(|error| format!("百炼音频处理返回了无效事件: {error}"))?;
                    if let Some(value) = event.pointer("/payload/output") {
                        output = value.clone();
                    }
                    if let Some(value) = event.pointer("/payload/usage") {
                        usage = value.clone();
                    }
                    match event.pointer("/header/event").and_then(Value::as_str) {
                        Some("task-finished") => return Ok((audio_bytes, output, usage)),
                        Some("task-failed") => {
                            return Err(bailian_audio_process_event_error(&event))
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        Err("百炼音频处理在完成前关闭了连接".to_string())
    });

    for chunk in input_bytes.chunks(64 * 1024) {
        if cancel.load(Ordering::Relaxed) {
            reader_task.abort();
            return Err("任务已取消".to_string());
        }
        writer
            .send(Message::Binary(chunk.to_vec()))
            .await
            .map_err(|error| format!("无法发送音频数据: {error}"))?;
        tokio::task::yield_now().await;
    }
    writer
        .send(Message::Text(
            json!({
                "header": {
                    "action": "finish-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": { "input": {} }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法结束百炼音频处理任务: {error}"))?;

    let (output_bytes, output, usage) = loop {
        tokio::select! {
            result = &mut reader_task => {
                break result
                    .map_err(|error| format!("百炼音频处理接收任务异常: {error}"))??;
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                if cancel.load(Ordering::Relaxed) {
                    reader_task.abort();
                    return Err("任务已取消".to_string());
                }
                if started.elapsed() > Duration::from_secs(600) {
                    reader_task.abort();
                    return Err("百炼音频处理等待结果超时".to_string());
                }
            }
        }
    };
    if output_bytes.is_empty() {
        return Err("百炼音频处理没有返回音频".to_string());
    }
    let output_audio = decode_wav_bytes(&output_bytes).or_else(|_| {
        if output_bytes.len() % 2 != 0 {
            return Err("百炼返回的音频数据长度无效".to_string());
        }
        Ok(PcmAudio {
            samples: output_bytes
                .chunks_exact(2)
                .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32)
                .collect(),
            sample_rate: output
                .get("sample_rate_out")
                .and_then(Value::as_u64)
                .map(|value| value as u32)
                .unwrap_or(sample_rate_out),
            channels: if separate { 8 } else { 1 },
        })
    })?;
    let source_file_path = write_recording(app, &clip_name, &input_bytes)?;
    let inference_seconds = started.elapsed().as_secs_f32();
    let engine = format!("百炼 · {model_id}");

    if separate {
        if output_audio.channels != 8 {
            return Err(format!(
                "百炼音乐分离应返回 8 声道音频，实际返回 {} 声道",
                output_audio.channels
            ));
        }
        let stem_specs = [
            ("vocals", "人声", 0_usize),
            ("other", "其他乐器", 2_usize),
            ("drums", "鼓声", 4_usize),
            ("bass", "贝斯", 6_usize),
        ];
        let mut tracks = Vec::with_capacity(stem_specs.len());
        for (id, name, first_channel) in stem_specs {
            let samples = output_audio
                .samples
                .chunks_exact(8)
                .flat_map(|frame| [frame[first_channel], frame[first_channel + 1]])
                .collect();
            let stem = PcmAudio {
                samples,
                sample_rate: output_audio.sample_rate,
                channels: 2,
            };
            let bytes = encode_wav_bytes(&stem)?;
            let file_path = write_recording(app, &format!("{clip_name}-{id}.wav"), &bytes)?;
            tracks.push(json!({
                "id": id,
                "name": name,
                "filePath": path_string(&file_path),
                "dataUrl": wav_data_url(&bytes),
                "duration": stem.duration(),
                "sampleRate": stem.sample_rate,
                "channels": stem.channels
            }));
        }
        return Ok(json!({
            "tracks": tracks,
            "sourceFilePath": path_string(&source_file_path),
            "duration": output_audio.duration(),
            "engine": engine,
            "inferenceSeconds": inference_seconds,
            "usage": usage,
            "serviceOutput": output
        }));
    }

    let output_wav = encode_wav_bytes(&output_audio)?;
    let output_file_path = write_recording(app, &format!("{clip_name}-denoised.wav"), &output_wav)?;
    Ok(json!({
        "fileName": output_file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("denoised.wav"),
        "filePath": path_string(&output_file_path),
        "sourceFilePath": path_string(&source_file_path),
        "dataUrl": wav_data_url(&output_wav),
        "duration": output_audio.duration(),
        "inputDuration": input_audio.duration(),
        "sampleRate": output_audio.sample_rate,
        "channels": output_audio.channels,
        "sizeBytes": output_wav.len(),
        "waveform": waveform_envelope(&output_audio, 240),
        "inferenceSeconds": inference_seconds,
        "operation": "denoise",
        "engine": engine,
        "detail": "百炼离线音频降噪",
        "voiceQuality": output.get("voice_quality").cloned().unwrap_or(Value::Null),
        "validSpeechMs": output.get("valid_speech_ms").cloned().unwrap_or(Value::Null),
        "usage": usage,
        "serviceOutput": output
    }))
}

fn bailian_audio_process_event_error(event: &Value) -> String {
    event
        .pointer("/header/error_message")
        .and_then(Value::as_str)
        .or_else(|| event.pointer("/header/error_code").and_then(Value::as_str))
        .unwrap_or("百炼音频处理任务失败")
        .to_string()
}

async fn execute_api_tts(
    app: &AppHandle,
    request: &HarnessTaskRequest,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let config = configured_api_provider(app)?;
    let text = required_string(&request.input, "text")?;
    let speed = number(&request.parameters, "speed").unwrap_or(1.0);
    let voice = request
        .parameters
        .get("voice")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&config.tts_voice);
    let started = Instant::now();
    let response = with_api_auth(
        api_client()?.post(format!("{}/audio/speech", config.base_url)),
        &config.api_key,
    )
    .json(&json!({
        "model": config.tts_model,
        "input": text,
        "voice": voice,
        "response_format": "wav",
        "speed": speed
    }))
    .send()
    .await
    .map_err(|error| format!("语音 API 请求失败: {error}"))?;
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    let response = checked_response(response, "语音 API").await?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("无法读取语音 API 输出: {error}"))?
        .to_vec();
    persist_api_tts_output(
        app,
        &bytes,
        started,
        &format!("API · {}", config.tts_model),
        "api-tts",
    )
}

fn persist_api_tts_output(
    app: &AppHandle,
    bytes: &[u8],
    started: Instant,
    engine: &str,
    file_prefix: &str,
) -> Result<Value, String> {
    let bytes = repair_streaming_wav_lengths(bytes);
    let mut audio =
        decode_wav_bytes(&bytes).map_err(|error| format!("API 必须返回 WAV 音频: {error}"))?;
    normalize_generated_speech(&mut audio);
    let bytes = encode_wav_bytes(&audio)?;
    let duration = audio.duration();
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("generated");
    fs::create_dir_all(&output_dir).map_err(|error| format!("无法创建语音输出目录: {error}"))?;
    let file_name = format!("{file_prefix}-{}.wav", timestamp_millis());
    let file_path = output_dir.join(&file_name);
    fs::write(&file_path, &bytes).map_err(|error| format!("无法保存 API 语音: {error}"))?;
    let inference_seconds = started.elapsed().as_secs_f32();

    Ok(json!({
        "fileName": file_name,
        "filePath": path_string(&file_path),
        "dataUrl": wav_data_url(&bytes),
        "duration": duration,
        "sampleRate": audio.sample_rate,
        "channels": audio.channels,
        "sizeBytes": bytes.len(),
        "waveform": waveform_envelope(&audio, 240),
        "inferenceSeconds": inference_seconds,
        "realTimeFactor": inference_seconds / duration.max(0.001),
        "sid": -1,
        "engine": engine
    }))
}

fn repair_streaming_wav_lengths(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return bytes.to_vec();
    }
    let mut repaired = bytes.to_vec();
    let riff_size = u32::try_from(repaired.len().saturating_sub(8)).unwrap_or(u32::MAX);
    repaired[4..8].copy_from_slice(&riff_size.to_le_bytes());
    if let Some(data_offset) = repaired[..repaired.len().min(256)]
        .windows(4)
        .position(|window| window == b"data")
    {
        let size_offset = data_offset + 4;
        if size_offset + 4 <= repaired.len() {
            let data_size =
                u32::try_from(repaired.len().saturating_sub(size_offset + 4)).unwrap_or(u32::MAX);
            repaired[size_offset..size_offset + 4].copy_from_slice(&data_size.to_le_bytes());
        }
    }
    repaired
}

async fn execute_api_asr(
    app: &AppHandle,
    request: &HarnessTaskRequest,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let config = configured_api_provider(app)?;
    let audio_data_url = required_string(&request.input, "audioDataUrl")?;
    let clip_name = required_string(&request.input, "clipName")?;
    let bytes = decode_data_url_bytes(&audio_data_url)?;
    let audio = decode_wav_data_url(&audio_data_url)?;
    let started = Instant::now();
    let part = Part::bytes(bytes)
        .file_name(clip_name.clone())
        .mime_str("audio/wav")
        .map_err(|error| format!("无法创建识别请求: {error}"))?;
    let form = Form::new()
        .part("file", part)
        .text("model", config.asr_model.clone())
        .text("response_format", "verbose_json")
        .text("timestamp_granularities[]", "segment");
    let response = with_api_auth(
        api_client()?.post(format!("{}/audio/transcriptions", config.base_url)),
        &config.api_key,
    )
    .multipart(form)
    .send()
    .await
    .map_err(|error| format!("识别 API 请求失败: {error}"))?;
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    let response = checked_response(response, "识别 API").await?;
    let raw = response
        .json::<Value>()
        .await
        .map_err(|error| format!("识别 API 没有返回有效 JSON: {error}"))?;
    let duration = raw
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or_else(|| audio.duration() as f64) as f32;
    let text = raw
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut segments = raw
        .get("segments")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    let segment_text = item.get("text")?.as_str()?.trim();
                    if segment_text.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "id": format!("segment-{}", index + 1),
                        "start": item.get("start").and_then(Value::as_f64).unwrap_or(0.0),
                        "end": item.get("end").and_then(Value::as_f64).unwrap_or(duration as f64),
                        "text": segment_text,
                        "tokens": []
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if segments.is_empty() && !text.is_empty() {
        segments.push(json!({
            "id": "segment-1",
            "start": 0.0,
            "end": duration,
            "text": text,
            "tokens": []
        }));
    }
    let speech_seconds = segments
        .iter()
        .map(|segment| {
            let start = segment.get("start").and_then(Value::as_f64).unwrap_or(0.0);
            let end = segment.get("end").and_then(Value::as_f64).unwrap_or(start);
            (end - start).max(0.0)
        })
        .sum::<f64>() as f32;
    let inference_seconds = started.elapsed().as_secs_f32();

    Ok(json!({
        "clipName": clip_name,
        "text": text,
        "language": raw.get("language").and_then(Value::as_str).unwrap_or("auto"),
        "duration": duration,
        "speechSeconds": speech_seconds,
        "segments": segments,
        "inferenceSeconds": inference_seconds,
        "realTimeFactor": inference_seconds / duration.max(0.001),
        "engine": format!("API · {}", config.asr_model)
    }))
}

async fn execute_bailian_tts(
    app: &AppHandle,
    request: &HarnessTaskRequest,
    model_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let config = configured_bailian_provider(app)?;
    let text = required_string(&request.input, "text")?;
    let speed = number(&request.parameters, "speed")
        .unwrap_or(1.0)
        .clamp(0.5, 2.0);
    let voice = request
        .parameters
        .get("voice")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| (model_id == BAILIAN_COSYVOICE_MODEL).then(|| "longxiaochun_v2".to_string()))
        .ok_or_else(|| "CosyVoice v3.5 需要声音复刻或声音设计生成的音色 ID".to_string())?;
    let started = Instant::now();
    let response = api_client()?
        .post(format!(
            "{}/api/v1/services/audio/tts/SpeechSynthesizer",
            config.base_url
        ))
        .bearer_auth(&config.api_key)
        .json(&json!({
            "model": model_id,
            "input": {
                "text": text,
                "voice": voice,
                "format": "wav",
                "sample_rate": 24000,
                "rate": speed
            }
        }))
        .send()
        .await
        .map_err(|error| format!("百炼语音合成请求失败: {error}"))?;
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    let raw = checked_response(response, "百炼语音合成")
        .await
        .map_err(|error| {
            if model_id.starts_with("cosyvoice-v3.5-") && error.contains("418") {
                "CosyVoice v3.5 音色不匹配：请使用为当前 v3.5 模型创建的声音复刻或声音设计音色 ID"
                    .to_string()
            } else {
                error
            }
        })?
        .json::<Value>()
        .await
        .map_err(|error| format!("百炼语音合成没有返回有效 JSON: {error}"))?;
    let audio_url =
        bailian_tts_audio_url(&raw).ok_or_else(|| bailian_response_error("百炼语音合成", &raw))?;
    let bytes = download_bailian_audio(audio_url).await?;
    persist_api_tts_output(
        app,
        &bytes,
        started,
        &format!("百炼 · {model_id}"),
        "bailian-tts",
    )
}

async fn download_bailian_audio(url: &str) -> Result<Vec<u8>, String> {
    let secure_url = secure_audio_download_url(url);
    let client = api_client()?;
    let mut last_error = "网络请求失败".to_string();

    for attempt in 1..=3 {
        match client.get(&secure_url).send().await {
            Ok(response) if response.status().is_server_error() && attempt < 3 => {
                last_error = format!("服务返回 {}", response.status());
            }
            Ok(response) => {
                return checked_response(response, "百炼音频下载")
                    .await?
                    .bytes()
                    .await
                    .map(|bytes| bytes.to_vec())
                    .map_err(|error| format!("无法读取百炼合成音频: {error}"));
            }
            Err(error) => {
                last_error = error
                    .to_string()
                    .split(" for url")
                    .next()
                    .unwrap_or("网络请求失败")
                    .to_string();
            }
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
        }
    }

    Err(format!("无法下载百炼合成音频，已重试 3 次: {last_error}"))
}

fn secure_audio_download_url(url: &str) -> String {
    url.strip_prefix("http://")
        .map(|rest| format!("https://{rest}"))
        .unwrap_or_else(|| url.to_string())
}

async fn execute_bailian_asr(
    app: &AppHandle,
    request: &HarnessTaskRequest,
    model_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let config = configured_bailian_provider(app)?;
    let audio_data_url = required_string(&request.input, "audioDataUrl")?;
    let clip_name = required_string(&request.input, "clipName")?;
    if audio_data_url.len() > 10 * 1024 * 1024 {
        return Err("百炼 Qwen ASR 单次音频不得超过 10 MB，请先切分音频".to_string());
    }
    let audio = decode_wav_data_url(&audio_data_url)?;
    let duration = audio.duration();
    let started = Instant::now();
    let response = api_client()?
        .post(format!(
            "{}/compatible-mode/v1/chat/completions",
            config.base_url
        ))
        .bearer_auth(&config.api_key)
        .json(&json!({
            "model": model_id,
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "input_audio",
                    "input_audio": {
                        "data": audio_data_url
                    }
                }]
            }],
            "stream": false,
            "asr_options": {
                "enable_itn": true
            }
        }))
        .send()
        .await
        .map_err(|error| format!("百炼语音识别请求失败: {error}"))?;
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    let raw = checked_response(response, "百炼语音识别")
        .await?
        .json::<Value>()
        .await
        .map_err(|error| format!("百炼语音识别没有返回有效 JSON: {error}"))?;
    let text = bailian_asr_text(&raw).unwrap_or_default();
    if text.is_empty() {
        return Err(bailian_response_error("百炼语音识别", &raw));
    }
    let language = raw
        .pointer("/choices/0/message/annotations/0/language")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let inference_seconds = started.elapsed().as_secs_f32();

    Ok(json!({
        "clipName": clip_name,
        "text": text,
        "language": language,
        "duration": duration,
        "speechSeconds": duration,
        "segments": [{
            "id": "segment-1",
            "start": 0.0,
            "end": duration,
            "text": text,
            "tokens": []
        }],
        "inferenceSeconds": inference_seconds,
        "realTimeFactor": inference_seconds / duration.max(0.001),
        "engine": format!("百炼 · {model_id}")
    }))
}

async fn execute_bailian_funasr(
    app: &AppHandle,
    request: &HarnessTaskRequest,
    model_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let config = configured_bailian_provider(app)?;
    let audio_data_url = required_string(&request.input, "audioDataUrl")?;
    let clip_name = required_string(&request.input, "clipName")?;
    let decoded = decode_wav_data_url(&audio_data_url)?;
    let audio = if model_id.contains("-8k-") {
        resample_audio(&decoded, 8_000)?
    } else {
        decoded
    };
    let duration = audio.duration();
    let mono = audio.mono_samples();
    let language = request
        .parameters
        .get("language")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && *value != "auto");
    let context = request
        .parameters
        .get("context")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let semantic_punctuation = request
        .parameters
        .get("semanticPunctuation")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let websocket_url = config
        .base_url
        .replacen("https://", "wss://", 1)
        .trim_end_matches('/')
        .to_string()
        + "/api-ws/v1/inference";
    let mut websocket_request = websocket_url
        .into_client_request()
        .map_err(|error| format!("无法创建 FunASR WebSocket 请求: {error}"))?;
    websocket_request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", config.api_key))
            .map_err(|error| format!("百炼 AK 格式无效: {error}"))?,
    );
    websocket_request.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static("qwenaudio-toolkits/0.1"),
    );

    let started = Instant::now();
    let (mut socket, _) = connect_async(websocket_request)
        .await
        .map_err(|error| format!("FunASR WebSocket 连接失败: {error}"))?;
    let task_id = Uuid::new_v4().to_string();
    let mut input = json!({});
    if let Some(context) = context {
        input = json!({
            "context": [{
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": context.chars().take(400).collect::<String>()
                }]
            }]
        });
    }
    let mut parameters = json!({
        "format": "pcm",
        "sample_rate": audio.sample_rate,
        "semantic_punctuation_enabled": semantic_punctuation
    });
    if let Some(language) = language {
        parameters["language_hints"] = json!([language]);
    }
    socket
        .send(Message::Text(
            json!({
                "header": {
                    "action": "run-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": {
                    "task_group": "audio",
                    "task": "asr",
                    "function": "recognition",
                    "model": model_id,
                    "parameters": parameters,
                    "input": input
                }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法启动 FunASR 任务: {error}"))?;

    tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| format!("FunASR 启动失败: {error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let event = serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("FunASR 返回了无效事件: {error}"))?;
            match event.pointer("/header/event").and_then(Value::as_str) {
                Some("task-started") => return Ok(()),
                Some("task-failed") => {
                    return Err(funasr_event_error(&event));
                }
                _ => {}
            }
        }
        Err("FunASR 在任务启动前关闭了连接".to_string())
    })
    .await
    .map_err(|_| "FunASR 任务启动超时".to_string())??;

    let (mut writer, mut reader) = socket.split();
    let reader_task = tokio::spawn(async move {
        let mut sentences = Vec::new();
        while let Some(message) = reader.next().await {
            let message = message.map_err(|error| format!("FunASR 接收失败: {error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let event = serde_json::from_str::<Value>(&text)
                .map_err(|error| format!("FunASR 返回了无效事件: {error}"))?;
            match event.pointer("/header/event").and_then(Value::as_str) {
                Some("result-generated") => {
                    let sentence = event
                        .pointer("/payload/output/sentence")
                        .cloned()
                        .unwrap_or(Value::Null);
                    let final_sentence = sentence
                        .get("sentence_end")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let heartbeat = sentence
                        .get("heartbeat")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if final_sentence && !heartbeat {
                        sentences.push(sentence);
                    }
                }
                Some("task-finished") => return Ok(sentences),
                Some("task-failed") => return Err(funasr_event_error(&event)),
                _ => {}
            }
        }
        Err("FunASR 在返回完成事件前关闭了连接".to_string())
    });

    let chunk_frames = (audio.sample_rate as usize / 10).max(1);
    for chunk in mono.chunks(chunk_frames) {
        if cancel.load(Ordering::Relaxed) {
            return Err("任务已取消".to_string());
        }
        let mut bytes = Vec::with_capacity(chunk.len() * 2);
        for sample in chunk {
            let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        writer
            .send(Message::Binary(bytes))
            .await
            .map_err(|error| format!("FunASR 音频发送失败: {error}"))?;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    writer
        .send(Message::Text(
            json!({
                "header": {
                    "action": "finish-task",
                    "task_id": task_id,
                    "streaming": "duplex"
                },
                "payload": { "input": {} }
            })
            .to_string(),
        ))
        .await
        .map_err(|error| format!("无法结束 FunASR 任务: {error}"))?;
    let sentences = tokio::time::timeout(Duration::from_secs(60), reader_task)
        .await
        .map_err(|_| "FunASR 等待最终结果超时".to_string())?
        .map_err(|error| format!("FunASR 结果任务异常: {error}"))??;
    let segments = funasr_segments(&sentences, duration);
    let text = segments
        .iter()
        .filter_map(|segment| segment.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return Err("FunASR 没有识别出有效文本".to_string());
    }
    let speech_seconds = segments
        .iter()
        .map(|segment| {
            let start = segment.get("start").and_then(Value::as_f64).unwrap_or(0.0);
            let end = segment.get("end").and_then(Value::as_f64).unwrap_or(start);
            (end - start).max(0.0)
        })
        .sum::<f64>() as f32;
    let inference_seconds = started.elapsed().as_secs_f32();

    Ok(json!({
        "clipName": clip_name,
        "text": text,
        "language": language.unwrap_or("auto"),
        "duration": duration,
        "speechSeconds": speech_seconds,
        "segments": segments,
        "inferenceSeconds": inference_seconds,
        "realTimeFactor": inference_seconds / duration.max(0.001),
        "engine": format!("百炼 · {model_id}")
    }))
}

fn funasr_event_error(event: &Value) -> String {
    let code = event
        .pointer("/header/error_code")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");
    let message = event
        .pointer("/header/error_message")
        .and_then(Value::as_str)
        .unwrap_or("没有错误详情");
    format!("FunASR 任务失败 ({code}): {message}")
}

fn cosyvoice_event_error(event: &Value) -> String {
    let code = event
        .pointer("/header/error_code")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");
    let message = event
        .pointer("/header/error_message")
        .and_then(Value::as_str)
        .unwrap_or("没有错误详情");
    if code == "418" || message.contains("418") {
        return "CosyVoice 音色不匹配：请使用为当前模型创建的声音复刻或声音设计音色 ID".to_string();
    }
    format!("CosyVoice 任务失败 ({code}): {message}")
}

fn funasr_segments(sentences: &[Value], duration: f32) -> Vec<Value> {
    sentences
        .iter()
        .enumerate()
        .filter_map(|(index, sentence)| {
            let text = sentence.get("text")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            let start = sentence
                .get("begin_time")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                / 1000.0;
            let end = sentence
                .get("end_time")
                .and_then(Value::as_f64)
                .unwrap_or(duration as f64 * 1000.0)
                / 1000.0;
            let tokens = sentence
                .get("words")
                .and_then(Value::as_array)
                .map(|words| {
                    words
                        .iter()
                        .filter_map(|word| {
                            let word_text = word.get("text")?.as_str()?;
                            let punctuation = word
                                .get("punctuation")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            Some(json!({
                                "text": format!("{word_text}{punctuation}"),
                                "start": word.get("begin_time").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
                                "end": word.get("end_time").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0
                            }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(json!({
                "id": format!("segment-{}", index + 1),
                "start": start,
                "end": end,
                "text": text,
                "tokens": tokens
            }))
        })
        .collect()
}

fn bailian_response_error(label: &str, raw: &Value) -> String {
    let detail = raw
        .get("message")
        .or_else(|| raw.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("响应中缺少有效输出");
    format!("{label}失败: {detail}")
}

fn bailian_tts_audio_url(raw: &Value) -> Option<&str> {
    raw.pointer("/output/audio/url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn bailian_asr_text(raw: &Value) -> Option<String> {
    raw.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn execute_api_text(
    app: &AppHandle,
    request: &HarnessTaskRequest,
    provider: &ResolvedProvider,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    let (base_url, api_key) = if provider.id == BAILIAN_PROVIDER_ID {
        let config = configured_bailian_provider(app)?;
        (
            format!(
                "{}/compatible-mode/v1",
                config.base_url.trim_end_matches('/')
            ),
            config.api_key,
        )
    } else {
        let config = configured_api_provider(app)?;
        (config.base_url, config.api_key)
    };
    let messages = request
        .input
        .get("messages")
        .filter(|value| value.is_array())
        .cloned()
        .or_else(|| {
            request
                .input
                .get("prompt")
                .and_then(Value::as_str)
                .map(|prompt| json!([{ "role": "user", "content": prompt }]))
        })
        .ok_or_else(|| "任务输入缺少 messages 或 prompt".to_string())?;
    let temperature = number(&request.parameters, "temperature").unwrap_or(0.7);
    let max_tokens = number(&request.parameters, "maxTokens")
        .unwrap_or(512.0)
        .clamp(1.0, 8192.0) as u64;
    let started = Instant::now();
    let response = with_api_auth(
        api_client()?.post(format!("{}/chat/completions", base_url)),
        &api_key,
    )
    .json(&json!({
        "model": provider.model_id,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens
    }))
    .send()
    .await
    .map_err(|error| format!("文本生成 API 请求失败: {error}"))?;
    if cancel.load(Ordering::Relaxed) {
        return Err("任务已取消".to_string());
    }
    let response = checked_response(response, "文本生成 API").await?;
    let raw = response
        .json::<Value>()
        .await
        .map_err(|error| format!("文本生成 API 没有返回有效 JSON: {error}"))?;
    let text = raw
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("文本生成 API 没有返回回复内容".to_string());
    }
    Ok(json!({
        "text": text,
        "model": provider.model_id,
        "inferenceSeconds": started.elapsed().as_secs_f32(),
        "inputTokens": raw.pointer("/usage/prompt_tokens").and_then(Value::as_u64),
        "outputTokens": raw.pointer("/usage/completion_tokens").and_then(Value::as_u64),
        "engine": format!("{} · {}", provider.name, provider.model_id)
    }))
}

async fn checked_response(
    response: reqwest::Response,
    label: &str,
) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let detail = response
        .text()
        .await
        .unwrap_or_else(|_| "没有错误详情".to_string());
    let detail = detail.chars().take(600).collect::<String>();
    Err(format!("{label} 返回 {status}: {detail}"))
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("无法创建 API 客户端: {error}"))
}

fn with_api_auth(builder: reqwest::RequestBuilder, api_key: &str) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        builder
    } else {
        builder.bearer_auth(api_key)
    }
}

fn artifact_from_payload(capability: &str, mut payload: Value) -> Result<HarnessArtifact, String> {
    let (kind, mime_type, fallback_name) = match capability {
        CAPABILITY_TTS | CAPABILITY_ENHANCE => ("audio", "audio/wav", "audio-output.wav"),
        CAPABILITY_ASR => ("transcript", "application/json", "transcript.json"),
        CAPABILITY_VAD => ("data", "application/json", "speech-segments.json"),
        CAPABILITY_TEXT => ("data", "application/json", "text-output.json"),
        CAPABILITY_LIVE if payload.get("filePath").is_some() => {
            ("audio", "audio/wav", "live-recording.wav")
        }
        CAPABILITY_LIVE => ("stream", "application/json", "live-session.json"),
        _ => ("data", "application/json", "output.json"),
    };
    let name = payload
        .get("fileName")
        .or_else(|| payload.get("clipName"))
        .and_then(Value::as_str)
        .unwrap_or(fallback_name)
        .to_string();
    let file_path = payload
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::to_string);
    let duration = payload
        .get("duration")
        .and_then(Value::as_f64)
        .map(|value| value as f32);
    let size_bytes = payload.get("sizeBytes").and_then(Value::as_u64);
    if let Some(object) = payload.as_object_mut() {
        object.remove("dataUrl");
        if let Some(tracks) = object.get_mut("tracks").and_then(Value::as_array_mut) {
            for track in tracks {
                let Some(track) = track.as_object_mut() else {
                    continue;
                };
                if track.get("filePath").and_then(Value::as_str).is_some() {
                    track.remove("dataUrl");
                }
            }
        }
    }

    Ok(HarnessArtifact {
        id: format!("artifact-{}", RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed)),
        kind: kind.to_string(),
        name,
        mime_type: mime_type.to_string(),
        file_path,
        duration,
        size_bytes,
        payload,
    })
}

fn write_recording(app: &AppHandle, requested_name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("recordings");
    fs::create_dir_all(&output_dir).map_err(|error| format!("无法创建录音目录: {error}"))?;
    let stem = requested_name
        .trim_end_matches(".wav")
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || !character.is_ascii()
            {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let file_path = output_dir.join(format!("{stem}-{}.wav", timestamp_millis()));
    fs::write(&file_path, bytes).map_err(|error| format!("无法保存实时录音: {error}"))?;
    Ok(file_path)
}

fn save_live_recording(app: &AppHandle, request: &HarnessTaskRequest) -> Result<Value, String> {
    let audio_data_url = required_string(&request.input, "audioDataUrl")?;
    let requested_name = request
        .input
        .get("clipName")
        .and_then(Value::as_str)
        .unwrap_or("live-recording.wav");
    let bytes = decode_data_url_bytes(&audio_data_url)?;
    let audio = decode_wav_data_url(&audio_data_url)?;
    let file_path = write_recording(app, requested_name, &bytes)?;
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("live-recording.wav");

    Ok(json!({
        "fileName": file_name,
        "filePath": path_string(&file_path),
        "dataUrl": audio_data_url,
        "duration": audio.duration(),
        "sampleRate": audio.sample_rate,
        "channels": audio.channels,
        "sizeBytes": bytes.len(),
        "waveform": waveform_envelope(&audio, 240),
        "inferenceSeconds": 0.0,
        "realTimeFactor": 0.0,
        "sid": -1,
        "engine": "Web Audio · Local WAV capture"
    }))
}

fn stored_payload(artifact: &HarnessArtifact) -> Result<Value, String> {
    if let Some(payload_path) = artifact
        .payload
        .get(EXTERNAL_PAYLOAD_KEY)
        .and_then(Value::as_str)
    {
        let bytes = fs::read(payload_path).map_err(|error| format!("无法读取运行产物: {error}"))?;
        serde_json::from_slice(&bytes).map_err(|error| format!("运行产物已经损坏: {error}"))
    } else {
        Ok(artifact.payload.clone())
    }
}

fn hydrate_payload(artifact: &HarnessArtifact) -> Result<Value, String> {
    let mut payload = stored_payload(artifact)?;
    if artifact.kind == "audio" {
        let path = artifact
            .file_path
            .as_deref()
            .ok_or_else(|| "音频产物缺少文件路径".to_string())?;
        let bytes = fs::read(path).map_err(|error| format!("无法读取音频产物: {error}"))?;
        let safe_bytes = webview_safe_wav_bytes(&bytes)?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "音频产物元数据无效".to_string())?;
        object.insert(
            "dataUrl".to_string(),
            Value::String(wav_data_url(safe_bytes.as_ref())),
        );
    }
    if let Some(source_path) = payload
        .get("sourceFilePath")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        let bytes =
            fs::read(&source_path).map_err(|error| format!("无法读取源音频产物: {error}"))?;
        let safe_bytes = webview_safe_wav_bytes(&bytes)?;
        let object = payload
            .as_object_mut()
            .ok_or_else(|| "产物元数据无效".to_string())?;
        object.insert(
            "sourceAudioDataUrl".to_string(),
            Value::String(wav_data_url(safe_bytes.as_ref())),
        );
    }
    if let Some(tracks) = payload.get_mut("tracks").and_then(Value::as_array_mut) {
        for track in tracks {
            let Some(track) = track.as_object_mut() else {
                continue;
            };
            let Some(path) = track
                .get("filePath")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            let bytes =
                fs::read(&path).map_err(|error| format!("无法读取分离音轨 {path}: {error}"))?;
            let safe_bytes = webview_safe_wav_bytes(&bytes)?;
            track.insert(
                "dataUrl".to_string(),
                Value::String(wav_data_url(safe_bytes.as_ref())),
            );
        }
    }
    Ok(payload)
}

fn resolve_provider(
    app: &AppHandle,
    request: &HarnessTaskRequest,
) -> Result<ResolvedProvider, String> {
    let requested = request.provider_id.as_deref().unwrap_or("auto");
    if requested == BAILIAN_PROVIDER_ID {
        let config = read_bailian_provider_config(app)?;
        if !config.configured() {
            return Err("阿里云百炼尚未配置，请先填写 AK 并启用".to_string());
        }
        let requested_model = request
            .parameters
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let model_id = match (request.capability.as_str(), requested_model) {
            (CAPABILITY_TTS, None) => BAILIAN_TTS_MODEL,
            (CAPABILITY_TTS, Some(model))
                if bailian_model_supports_capability(CAPABILITY_TTS, model) =>
            {
                model
            }
            (CAPABILITY_ASR, None | Some(BAILIAN_QWEN_ASR_MODEL)) => BAILIAN_QWEN_ASR_MODEL,
            (CAPABILITY_ASR, Some(model))
                if bailian_model_supports_capability(CAPABILITY_ASR, model) =>
            {
                model
            }
            (CAPABILITY_TEXT, None | Some(BAILIAN_QWEN_37_PLUS_MODEL)) => {
                BAILIAN_QWEN_37_PLUS_MODEL
            }
            (CAPABILITY_TEXT, Some(BAILIAN_QWEN_36_PLUS_MODEL)) => BAILIAN_QWEN_36_PLUS_MODEL,
            (CAPABILITY_ENHANCE, None | Some(BAILIAN_DENOISE_MODEL)) => BAILIAN_DENOISE_MODEL,
            (
                CAPABILITY_TTS
                | CAPABILITY_ASR
                | CAPABILITY_TEXT
                | CAPABILITY_ENHANCE
                | CAPABILITY_SOURCE_SEPARATION,
                Some(model),
            ) => return Err(format!("百炼模型 {model} 不支持所选能力")),
            _ => return Err("阿里云百炼当前不支持所选能力".to_string()),
        };
        return Ok(ResolvedProvider {
            id: BAILIAN_PROVIDER_ID.to_string(),
            name: config.name,
            model_id: model_id.to_string(),
            is_api: true,
            adapter: bailian_adapter_for(&request.capability, model_id).to_string(),
            model_path: None,
        });
    }
    let api_config = read_api_provider_config(app)?;
    let quality_api = request.routing.as_deref() == Some("quality")
        && matches!(
            request.capability.as_str(),
            CAPABILITY_TTS | CAPABILITY_ASR | CAPABILITY_TEXT
        )
        && api_config.configured();
    let use_api = requested == API_PROVIDER_ID || (requested == "auto" && quality_api);
    if use_api {
        if !api_config.configured() {
            return Err("API Provider 尚未配置，请先填写地址与密钥".to_string());
        }
        let model_id = match request.capability.as_str() {
            CAPABILITY_TTS => api_config.tts_model,
            CAPABILITY_ASR => api_config.asr_model,
            CAPABILITY_TEXT => api_config.llm_model,
            _ => return Err("该 API Provider 不支持所选能力".to_string()),
        };
        return Ok(ResolvedProvider {
            id: API_PROVIDER_ID.to_string(),
            name: api_config.name,
            model_id,
            is_api: true,
            adapter: "openai-compatible".to_string(),
            model_path: None,
        });
    }

    if requested.starts_with("plugin.") {
        let provider = plugins::provider_by_id(app, requested)?
            .ok_or_else(|| format!("Provider {requested} 未安装或已停用"))?;
        if !provider
            .capabilities
            .iter()
            .any(|capability| capability == &request.capability)
        {
            return Err(format!(
                "Provider {requested} 不支持 {}",
                request.capability
            ));
        }
        return Ok(ResolvedProvider {
            id: provider.provider_id,
            name: provider.name,
            model_id: provider.model_id,
            is_api: false,
            adapter: provider.adapter,
            model_path: provider.model_path,
        });
    }

    if requested == "auto" && request.capability == CAPABILITY_ASR {
        let provider = plugins::provider_by_id(app, SENSEVOICE_GGUF_PROVIDER_ID)?
            .ok_or_else(|| "SenseVoice Small GGUF 尚未安装，请先在模型商店安装".to_string())?;
        return Ok(ResolvedProvider {
            id: provider.provider_id,
            name: provider.name,
            model_id: provider.model_id,
            is_api: false,
            adapter: provider.adapter,
            model_path: provider.model_path,
        });
    }

    let (id, name, model_id, plugin_id, adapter) = match request.capability.as_str() {
        CAPABILITY_TTS => return Err("请指定已安装的本地语音合成模型".to_string()),
        CAPABILITY_ASR => {
            return Err("请指定已安装的本地 ASR 插件或安装 SenseVoice Small GGUF".to_string())
        }
        CAPABILITY_VAD => (
            "local.silero-vad",
            "Silero VAD",
            "silero-vad",
            "silero-vad",
            "silero-vad",
        ),
        CAPABILITY_TEXT => {
            return Err("text.generate 需要配置 API Provider 或安装本地 LLM 插件".to_string())
        }
        CAPABILITY_ENHANCE => return Err("请指定已安装的本地音频增强模型".to_string()),
        CAPABILITY_LIVE => (
            "local.web-audio",
            "Web Audio Stream",
            "web-audio",
            "web-audio-stream",
            "web-audio",
        ),
        _ => return Err(format!("不支持的能力: {}", request.capability)),
    };
    if requested != "auto" && requested != id {
        return Err(format!(
            "Provider {requested} 不支持 {}",
            request.capability
        ));
    }
    if !plugins::is_plugin_installed(app, plugin_id)? {
        return Err(format!("{name} 尚未安装"));
    }
    Ok(ResolvedProvider {
        id: id.to_string(),
        name: name.to_string(),
        model_id: model_id.to_string(),
        is_api: false,
        adapter: adapter.to_string(),
        model_path: None,
    })
}

fn failed_submission(request: &HarnessTaskRequest, error: String) -> HarnessRun {
    let now = timestamp_millis();
    HarnessRun {
        id: request
            .run_id
            .as_deref()
            .filter(|value| valid_run_id(value))
            .map(str::to_string)
            .unwrap_or_else(new_run_id),
        conversation_provider_id: request.conversation_provider_id.clone(),
        conversation_visible: request.conversation_visible,
        dependency_run_ids: request.dependency_run_ids.clone(),
        capability: request.capability.clone(),
        title: request
            .title
            .clone()
            .unwrap_or_else(|| capability_title(&request.capability).to_string()),
        input_summary: input_summary(request),
        provider_id: request
            .provider_id
            .clone()
            .unwrap_or_else(|| "auto".to_string()),
        provider_name: "自动路由".to_string(),
        model_id: String::new(),
        status: "failed".to_string(),
        progress: 100,
        activity: None,
        created_at: now,
        started_at: Some(now),
        completed_at: Some(now),
        duration_ms: Some(0),
        artifacts: Vec::new(),
        error: Some(error),
        retryable: true,
    }
}

fn run_activity(request: &HarnessTaskRequest, provider: &ResolvedProvider) -> String {
    if provider.is_api {
        return match request.capability.as_str() {
            CAPABILITY_TTS => "正在连接语音合成服务",
            CAPABILITY_ASR => "正在上传音频并等待识别",
            CAPABILITY_TEXT => "等待模型生成",
            CAPABILITY_ENHANCE | CAPABILITY_SOURCE_SEPARATION => "正在上传音频并等待云端处理",
            _ => "等待云端模型返回结果",
        }
        .to_string();
    }

    match request.capability.as_str() {
        CAPABILITY_TTS => "正在加载语音模型",
        CAPABILITY_ASR => "正在读取音频",
        CAPABILITY_VAD => "正在加载 VAD 模型",
        CAPABILITY_ENHANCE => "正在加载音频处理模型",
        CAPABILITY_AUDIO_TAGGING => "正在分析音频标签",
        CAPABILITY_LANGUAGE_ID => "正在识别音频语言",
        CAPABILITY_PUNCTUATION => "正在恢复标点",
        CAPABILITY_TEXT_NORMALIZE => "正在规范化文本",
        CAPABILITY_KWS => "正在检测关键词",
        CAPABILITY_SPEAKER_EMBED => "正在提取说话人特征",
        CAPABILITY_DIARIZATION => "正在分析说话人时间线",
        CAPABILITY_SOURCE_SEPARATION => "正在分离音轨",
        _ => "正在运行模型",
    }
    .to_string()
}

fn validate_capability(capability: &str) -> Result<(), String> {
    if matches!(
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
    ) {
        Ok(())
    } else {
        Err(format!("未知能力: {capability}"))
    }
}

fn capability_title(capability: &str) -> &'static str {
    match capability {
        CAPABILITY_TTS => "生成语音",
        CAPABILITY_ASR => "语音转文字",
        CAPABILITY_VAD => "检测语音片段",
        CAPABILITY_TEXT => "生成文本",
        CAPABILITY_ENHANCE => "清理录音",
        CAPABILITY_LIVE => "实时处理",
        CAPABILITY_AUDIO_TAGGING => "识别音频内容",
        CAPABILITY_KWS => "检测关键词",
        CAPABILITY_LANGUAGE_ID => "识别语言",
        CAPABILITY_PUNCTUATION => "恢复标点",
        CAPABILITY_TEXT_NORMALIZE => "文本归一化",
        CAPABILITY_SPEAKER_EMBED => "提取声纹",
        CAPABILITY_DIARIZATION => "区分说话人",
        CAPABILITY_SOURCE_SEPARATION => "分离音源",
        _ => "音频任务",
    }
}

fn input_summary(request: &HarnessTaskRequest) -> String {
    let text = request
        .input
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| messages.last())
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .or_else(|| request.input.get("text").and_then(Value::as_str))
        .or_else(|| request.input.get("prompt").and_then(Value::as_str));
    if let Some(summary) = text
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(72).collect::<String>())
    {
        return summary;
    }
    request
        .input
        .get("clipName")
        .or_else(|| request.input.get("inputDevice"))
        .and_then(Value::as_str)
        .unwrap_or("本地输入")
        .to_string()
}

fn required_string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("任务输入缺少 {key}"))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn optional_number(value: &Value, key: &str) -> Option<f32> {
    number(value, key).map(|number| number as f32)
}

fn string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn emit_run(app: &AppHandle, run: &HarnessRun) {
    let _ = app.emit("harness-run-event", run.summary());
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;
    use crate::audio_io::{peak_dbfs, rms_dbfs};

    fn provider(base_url: &str, api_key: &str) -> ApiProviderConfig {
        ApiProviderConfig {
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn localhost_provider_does_not_require_an_api_key() {
        assert!(provider("http://127.0.0.1:11434/v1", "").configured());
        assert!(provider("http://localhost:1234/v1", "").configured());
    }

    #[test]
    fn remote_provider_requires_an_api_key() {
        assert!(!provider("https://example.com/v1", "").configured());
        assert!(provider("https://example.com/v1", "secret").configured());
    }

    #[test]
    fn remote_audio_downloads_prefer_https() {
        assert_eq!(
            secure_audio_download_url("http://example.com/result.wav?signature=test"),
            "https://example.com/result.wav?signature=test"
        );
        assert_eq!(
            secure_audio_download_url("https://example.com/result.wav"),
            "https://example.com/result.wav"
        );
    }

    #[test]
    fn funasr_uses_only_the_vad_bundled_with_its_model_pack() {
        let model = env::temp_dir().join(format!("funasr-vad-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&model).expect("create model directory");
        assert!(resolve_funasr_vad_path(&model).is_none());

        let bundled = model.join("fsmn-vad.gguf");
        fs::write(&bundled, b"test").expect("write bundled VAD");
        assert_eq!(resolve_funasr_vad_path(&model), Some(bundled));
        fs::remove_dir_all(model).expect("remove model directory");
    }

    #[test]
    fn every_bailian_tts_model_is_routable_with_the_expected_adapter() {
        for model in [
            BAILIAN_TTS_MODEL,
            BAILIAN_TTS_PLUS_MODEL,
            BAILIAN_COSYVOICE_MODEL,
            BAILIAN_COSYVOICE_3_PLUS_MODEL,
            BAILIAN_COSYVOICE_35_PLUS_MODEL,
            BAILIAN_COSYVOICE_35_FLASH_MODEL,
        ] {
            assert!(
                bailian_model_supports_capability(CAPABILITY_TTS, model),
                "{model}"
            );
        }
        assert_ne!(
            bailian_model_kind(BAILIAN_TTS_MODEL),
            Some(BailianModelKind::CosyVoice)
        );
        assert_ne!(
            bailian_model_kind(BAILIAN_TTS_PLUS_MODEL),
            Some(BailianModelKind::CosyVoice)
        );
        for model in [
            BAILIAN_COSYVOICE_MODEL,
            BAILIAN_COSYVOICE_3_PLUS_MODEL,
            BAILIAN_COSYVOICE_35_PLUS_MODEL,
            BAILIAN_COSYVOICE_35_FLASH_MODEL,
        ] {
            assert_eq!(bailian_model_kind(model), Some(BailianModelKind::CosyVoice));
        }
    }

    #[test]
    fn bailian_capability_routing_is_centralized() {
        assert_eq!(
            bailian_model_kind(BAILIAN_QWEN_ASR_MODEL),
            Some(BailianModelKind::Asr)
        );
        assert_eq!(
            bailian_model_kind(BAILIAN_FUN_ASR_MODEL),
            Some(BailianModelKind::FunAsr)
        );
        assert_eq!(
            bailian_model_kind(BAILIAN_COSYVOICE_35_PLUS_MODEL),
            Some(BailianModelKind::CosyVoice)
        );
        assert_eq!(
            bailian_cosyvoice_model(None).expect("default CosyVoice model"),
            BAILIAN_COSYVOICE_MODEL
        );
        assert!(bailian_cosyvoice_model(Some(BAILIAN_TTS_MODEL)).is_err());
        assert!(bailian_model_supports_capability(
            CAPABILITY_ASR,
            BAILIAN_QWEN_ASR_MODEL
        ));
        assert!(bailian_model_supports_capability(
            CAPABILITY_TTS,
            BAILIAN_COSYVOICE_MODEL
        ));
        assert!(!bailian_model_supports_capability(
            CAPABILITY_SOURCE_SEPARATION,
            BAILIAN_DENOISE_MODEL
        ));
        assert_eq!(
            bailian_adapter_for(CAPABILITY_ASR, BAILIAN_FUN_ASR_MODEL),
            "bailian-funasr"
        );
        assert_eq!(
            bailian_adapter_for(CAPABILITY_TTS, BAILIAN_COSYVOICE_MODEL),
            "bailian-cosyvoice"
        );
    }

    #[test]
    fn audio_input_capabilities_share_source_audio_hydration() {
        for capability in [
            CAPABILITY_ASR,
            CAPABILITY_VAD,
            CAPABILITY_ENHANCE,
            CAPABILITY_AUDIO_TAGGING,
            CAPABILITY_KWS,
            CAPABILITY_LANGUAGE_ID,
            CAPABILITY_SPEAKER_EMBED,
            CAPABILITY_DIARIZATION,
            CAPABILITY_SOURCE_SEPARATION,
        ] {
            assert!(capability_accepts_audio(capability), "{capability}");
        }
        assert!(!capability_accepts_audio(CAPABILITY_TTS));
        assert!(!capability_accepts_audio(CAPABILITY_TEXT));
        assert!(!capability_accepts_audio(CAPABILITY_PUNCTUATION));
        assert!(!capability_accepts_audio(CAPABILITY_TEXT_NORMALIZE));
    }

    #[test]
    fn run_summary_drops_artifact_payloads() {
        let run = HarnessRun {
            id: "run-summary".to_string(),
            conversation_provider_id: Some("plugin.owner".to_string()),
            conversation_visible: true,
            dependency_run_ids: Vec::new(),
            capability: CAPABILITY_ASR.to_string(),
            title: "Summary".to_string(),
            input_summary: "audio.wav".to_string(),
            provider_id: "local".to_string(),
            provider_name: "Local".to_string(),
            model_id: "model".to_string(),
            status: "completed".to_string(),
            progress: 100,
            activity: None,
            created_at: 1,
            started_at: Some(1),
            completed_at: Some(2),
            duration_ms: Some(1),
            artifacts: vec![HarnessArtifact {
                id: "artifact".to_string(),
                kind: "data".to_string(),
                name: "result.json".to_string(),
                mime_type: "application/json".to_string(),
                file_path: None,
                duration: Some(1.0),
                size_bytes: Some(1024),
                payload: json!({ "large": "payload" }),
            }],
            error: None,
            retryable: false,
        };

        let summary = run.summary();
        assert_eq!(summary.artifacts[0].payload, Value::Null);
        assert_eq!(summary.artifacts[0].duration, Some(1.0));
        assert_eq!(summary.status, "completed");
    }

    #[test]
    fn stored_payload_reads_externalized_json() {
        let path = env::temp_dir().join(format!(
            "qwenaudio-toolkits-artifact-{}.json",
            timestamp_millis()
        ));
        fs::write(&path, br#"{"text":"cached"}"#).expect("write payload");
        let artifact = HarnessArtifact {
            id: "artifact".to_string(),
            kind: "data".to_string(),
            name: "result.json".to_string(),
            mime_type: "application/json".to_string(),
            file_path: None,
            duration: None,
            size_bytes: None,
            payload: json!({ (EXTERNAL_PAYLOAD_KEY): path_string(&path) }),
        };

        assert_eq!(
            stored_payload(&artifact).expect("read payload")["text"],
            "cached"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn bailian_provider_requires_key_and_enabled_state() {
        let mut config = BailianProviderConfig {
            api_key: "secret".to_string(),
            enabled: true,
            ..Default::default()
        };
        assert!(config.configured());
        config.api_key.clear();
        assert!(!config.configured());
        config.api_key = "secret".to_string();
        config.enabled = false;
        assert!(!config.configured());
    }

    #[test]
    fn bailian_error_uses_service_message() {
        let raw = json!({ "code": "InvalidApiKey", "message": "key is invalid" });
        assert_eq!(
            bailian_response_error("百炼语音识别", &raw),
            "百炼语音识别失败: key is invalid"
        );
    }

    #[test]
    fn bailian_contract_parsers_read_official_response_shapes() {
        let tts = json!({
            "output": {
                "audio": {
                    "url": "https://example.com/output.wav"
                }
            }
        });
        let asr = json!({
            "choices": [{
                "message": {
                    "content": "你好，百炼。"
                }
            }]
        });
        assert_eq!(
            bailian_tts_audio_url(&tts),
            Some("https://example.com/output.wav")
        );
        assert_eq!(bailian_asr_text(&asr).as_deref(), Some("你好，百炼。"));
    }

    #[test]
    fn funasr_parser_preserves_sentence_and_word_timestamps() {
        let sentences = vec![json!({
            "begin_time": 170,
            "end_time": 920,
            "text": "你好。",
            "words": [{
                "begin_time": 170,
                "end_time": 620,
                "text": "你好",
                "punctuation": "。"
            }]
        })];
        let segments = funasr_segments(&sentences, 1.0);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0]["text"], "你好。");
        assert_eq!(segments[0]["start"], 0.17);
        assert_eq!(segments[0]["end"], 0.92);
        assert_eq!(segments[0]["tokens"][0]["text"], "你好。");
    }

    #[test]
    fn repairs_streaming_wav_placeholder_lengths() {
        let mut wav = Vec::from(&b"RIFF\xff\xff\xff\x7fWAVEfmt "[..]);
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&24_000u32.to_le_bytes());
        wav.extend_from_slice(&48_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&0x7fff_ffffu32.to_le_bytes());
        wav.extend_from_slice(&[0, 0, 1, 0]);

        let repaired = repair_streaming_wav_lengths(&wav);
        assert_eq!(
            u32::from_le_bytes(repaired[4..8].try_into().unwrap()),
            repaired.len() as u32 - 8
        );
        assert_eq!(u32::from_le_bytes(repaired[40..44].try_into().unwrap()), 4);
        assert!(decode_wav_bytes(&repaired).is_ok());
    }

    #[test]
    fn normalizes_very_quiet_generated_speech() {
        let mut audio = PcmAudio {
            samples: (0..24_000)
                .map(|index| ((index as f32 * 0.07).sin()) * 0.001)
                .collect(),
            sample_rate: 24_000,
            channels: 1,
        };

        let gain = normalize_generated_speech(&mut audio);

        assert!(gain > 35.0);
        assert!((-22.2..=-21.8).contains(&rms_dbfs(&audio.samples)));
        assert!(peak_dbfs(&audio.samples) <= -3.0);
    }

    #[test]
    fn leaves_normal_generated_speech_nearly_unchanged() {
        let mut audio = PcmAudio {
            samples: (0..24_000)
                .map(|index| ((index as f32 * 0.07).sin()) * 0.12)
                .collect(),
            sample_rate: 24_000,
            channels: 1,
        };

        let gain = normalize_generated_speech(&mut audio);

        assert!(gain < 1.0);
        assert!(peak_dbfs(&audio.samples) <= -3.0);
    }
}

fn new_run_id() -> String {
    format!(
        "run-{}-{}",
        timestamp_millis(),
        RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn valid_run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn persist_request(
    app: &AppHandle,
    run_id: &str,
    request: &HarnessTaskRequest,
) -> Result<(), String> {
    let path = request_path(app, run_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建重试数据目录: {error}"))?;
    }
    let bytes =
        serde_json::to_vec(request).map_err(|error| format!("无法序列化任务输入: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("无法保存任务输入: {error}"))
}

fn load_request(app: &AppHandle, run_id: &str) -> Result<HarnessTaskRequest, String> {
    let path = request_path(app, run_id)?;
    let bytes = fs::read(path).map_err(|error| format!("无法读取重试数据: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("重试数据已经损坏: {error}"))
}

fn ensure_source_audio_file(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("harness")
        .join("source-audio");
    for extension in ["wav", "mp3", "flac", "m4a", "ogg", "audio"] {
        let existing = output_dir.join(format!("{run_id}.{extension}"));
        if existing.exists() {
            return Ok(existing);
        }
    }

    let request = load_request(app, run_id)?;
    let audio_data_url = request
        .input
        .get("audioDataUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "任务没有可读取的源音频".to_string())?;
    let extension = if audio_data_url.starts_with("data:audio/mpeg")
        || audio_data_url.starts_with("data:audio/mp3")
    {
        "mp3"
    } else if audio_data_url.starts_with("data:audio/flac") {
        "flac"
    } else if audio_data_url.starts_with("data:audio/mp4")
        || audio_data_url.starts_with("data:audio/x-m4a")
    {
        "m4a"
    } else if audio_data_url.starts_with("data:audio/ogg") {
        "ogg"
    } else if audio_data_url.starts_with("data:audio/wav")
        || audio_data_url.starts_with("data:audio/x-wav")
    {
        "wav"
    } else {
        "audio"
    };
    let bytes = decode_data_url_bytes(audio_data_url)?;
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("无法创建历史音频缓存目录: {error}"))?;
    let output_path = output_dir.join(format!("{run_id}.{extension}"));
    let temporary_path = output_dir.join(format!("{run_id}.{extension}.tmp"));
    fs::write(&temporary_path, bytes).map_err(|error| format!("无法缓存历史源音频: {error}"))?;
    fs::rename(&temporary_path, &output_path)
        .map_err(|error| format!("无法提交历史源音频缓存: {error}"))?;
    Ok(output_path)
}

fn cached_source_waveform(source_path: &Path) -> Option<Vec<f32>> {
    let cache_path = source_path.with_extension("waveform.json");
    if let Ok(bytes) = fs::read(&cache_path) {
        if let Ok(waveform) = serde_json::from_slice::<Vec<f32>>(&bytes) {
            return Some(waveform);
        }
    }
    if source_path.extension().and_then(|value| value.to_str()) != Some("wav") {
        return None;
    }
    let bytes = fs::read(source_path).ok()?;
    let audio = decode_wav_bytes(&bytes).ok()?;
    let waveform = waveform_envelope(&audio, 320);
    if let Ok(bytes) = serde_json::to_vec(&waveform) {
        let _ = fs::write(cache_path, bytes);
    }
    Some(waveform)
}

fn artifact_payload_dir(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("harness").join("artifacts").join(run_id))
        .map_err(|error| format!("无法定位运行产物目录: {error}"))
}

fn externalize_run_payloads(app: &AppHandle, run: &mut HarnessRun) -> Result<bool, String> {
    let mut changed = false;
    for (index, artifact) in run.artifacts.iter_mut().enumerate() {
        if artifact.payload.get(EXTERNAL_PAYLOAD_KEY).is_some() {
            continue;
        }
        let bytes = serde_json::to_vec(&artifact.payload)
            .map_err(|error| format!("无法序列化运行产物: {error}"))?;
        if bytes.len() <= INLINE_ARTIFACT_PAYLOAD_LIMIT {
            continue;
        }
        let output_dir = artifact_payload_dir(app, &run.id)?;
        fs::create_dir_all(&output_dir)
            .map_err(|error| format!("无法创建运行产物目录: {error}"))?;
        let output_path = output_dir.join(format!("artifact-{index}.json"));
        let temporary_path = output_dir.join(format!("artifact-{index}.json.tmp"));
        fs::write(&temporary_path, bytes).map_err(|error| format!("无法写入运行产物: {error}"))?;
        fs::rename(&temporary_path, &output_path)
            .map_err(|error| format!("无法提交运行产物: {error}"))?;
        artifact.payload = json!({
            (EXTERNAL_PAYLOAD_KEY): path_string(&output_path),
        });
        changed = true;
    }
    Ok(changed)
}

fn write_runs_file(path: &Path, runs: &[HarnessRun]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建运行历史目录: {error}"))?;
    }
    let bytes =
        serde_json::to_vec_pretty(runs).map_err(|error| format!("无法序列化运行历史: {error}"))?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, bytes).map_err(|error| format!("无法保存运行历史: {error}"))?;
    fs::rename(&temporary_path, path).map_err(|error| format!("无法提交运行历史: {error}"))
}

fn runs_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("harness").join("runs.json"))
        .map_err(|error| format!("无法定位应用数据目录: {error}"))
}

fn request_path(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| {
            path.join("harness")
                .join("requests")
                .join(format!("{run_id}.json"))
        })
        .map_err(|error| format!("无法定位应用数据目录: {error}"))
}

fn api_provider_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("providers").join("openai-compatible.json"))
        .map_err(|error| format!("无法定位应用配置目录: {error}"))
}

fn read_api_provider_config(app: &AppHandle) -> Result<ApiProviderConfig, String> {
    let path = api_provider_path(app)?;
    let mut config = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("API Provider 配置无效: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ApiProviderConfig::default(),
        Err(error) => return Err(format!("无法读取 API Provider 配置: {error}")),
    };
    if let Ok(value) = env::var("QWEN_AUDIO_OPENAI_BASE_URL") {
        config.base_url = value.trim_end_matches('/').to_string();
    }
    if let Ok(value) = env::var("QWEN_AUDIO_OPENAI_API_KEY") {
        config.api_key = value;
        config.enabled = true;
    }
    if let Ok(value) = env::var("QWEN_AUDIO_OPENAI_TTS_MODEL") {
        config.tts_model = value;
    }
    if let Ok(value) = env::var("QWEN_AUDIO_OPENAI_ASR_MODEL") {
        config.asr_model = value;
    }
    Ok(config)
}

fn write_api_provider_config(app: &AppHandle, config: &ApiProviderConfig) -> Result<(), String> {
    let path = api_provider_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Provider 配置目录: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("无法序列化 Provider 配置: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("无法保存 Provider 配置: {error}"))
}

fn configured_api_provider(app: &AppHandle) -> Result<ApiProviderConfig, String> {
    let config = read_api_provider_config(app)?;
    if config.configured() {
        Ok(config)
    } else {
        Err("API Provider 尚未配置或未启用".to_string())
    }
}

fn bailian_provider_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("providers").join("bailian.json"))
        .map_err(|error| format!("无法定位应用配置目录: {error}"))
}

fn bailian_voice_registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("providers").join("bailian-voices.json"))
        .map_err(|error| format!("无法定位音色配置目录: {error}"))
}

fn read_bailian_voice_registry(app: &AppHandle) -> Result<Vec<BailianVoice>, String> {
    let path = bailian_voice_registry_path(app)?;
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|error| format!("本地音色列表无效: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("无法读取本地音色列表: {error}")),
    }
}

fn write_bailian_voice_registry(app: &AppHandle, voices: &[BailianVoice]) -> Result<(), String> {
    let path = bailian_voice_registry_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建音色配置目录: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(voices)
        .map_err(|error| format!("无法序列化音色列表: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("无法保存音色列表: {error}"))
}

fn read_bailian_provider_config(app: &AppHandle) -> Result<BailianProviderConfig, String> {
    let path = bailian_provider_path(app)?;
    let mut config = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("百炼 Provider 配置无效: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            BailianProviderConfig::default()
        }
        Err(error) => return Err(format!("无法读取百炼 Provider 配置: {error}")),
    };
    if let Ok(value) = env::var("QWEN_AUDIO_BAILIAN_BASE_URL") {
        config.base_url = value.trim_end_matches('/').to_string();
    }
    if let Ok(value) =
        env::var("DASHSCOPE_API_KEY").or_else(|_| env::var("QWEN_AUDIO_BAILIAN_API_KEY"))
    {
        config.api_key = value;
        config.enabled = true;
    }
    if let Ok(value) = env::var("QWEN_AUDIO_BAILIAN_TTS_MODEL") {
        config.tts_model = value;
    }
    if let Ok(value) = env::var("QWEN_AUDIO_BAILIAN_ASR_MODEL") {
        config.asr_model = value;
    }
    Ok(config)
}

fn write_bailian_provider_config(
    app: &AppHandle,
    config: &BailianProviderConfig,
) -> Result<(), String> {
    let path = bailian_provider_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 Provider 配置目录: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("无法序列化百炼 Provider 配置: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("无法保存百炼 Provider 配置: {error}"))
}

fn configured_bailian_provider(app: &AppHandle) -> Result<BailianProviderConfig, String> {
    let config = read_bailian_provider_config(app)?;
    if config.configured() {
        Ok(config)
    } else {
        Err("阿里云百炼尚未配置或未启用".to_string())
    }
}

fn decode_data_url_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, encoded)| encoded)
        .ok_or_else(|| "无法读取音频数据".to_string())?;
    STANDARD
        .decode(encoded)
        .map_err(|error| format!("音频 Base64 解码失败: {error}"))
}

fn trim_endpoint(endpoint: &str) -> String {
    endpoint
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string()
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
