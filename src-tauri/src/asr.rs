use crate::audio_io::{decode_wav_data_url, resample_audio, waveform_envelope};
use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    OfflineCanaryModelConfig, OfflineFireRedAsrCtcModelConfig, OfflineFireRedAsrModelConfig,
    OfflineFunASRNanoModelConfig, OfflineMoonshineModelConfig, OfflineQwen3ASRModelConfig,
    OfflineRecognizer, OfflineRecognizerConfig, OfflineRecognizerResult,
    OfflineSenseVoiceModelConfig, OfflineWenetCtcModelConfig, OnlineRecognizer,
    OnlineRecognizerConfig, OnlineStream,
};
use std::{
    env,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

pub(crate) type AsrProgressCallback = Arc<dyn Fn(u8, String) + Send + Sync>;
use tauri::{AppHandle, Emitter, Manager, State};

const MODEL_ID: &str = "sensevoice-small-int8-2024-07-17";
const MODEL_DIRECTORY: &str = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
const MODEL_DISPLAY_NAME: &str = "SenseVoice Small";
const SAMPLE_RATE: i32 = 16_000;

#[derive(Default)]
pub struct AsrRuntime {
    recognizer: Mutex<Option<LoadedRecognizer>>,
}

struct LoadedRecognizer {
    model_dir: PathBuf,
    adapter: String,
    options_key: String,
    recognizer: Arc<OfflineRecognizer>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrProgress {
    stage: &'static str,
    progress: u8,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrModelStatus {
    id: &'static str,
    name: &'static str,
    installed: bool,
    loaded: bool,
    path: String,
    sample_rate: i32,
    languages: Vec<&'static str>,
    token_timestamps: bool,
    vad: bool,
    runtime: &'static str,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrTranscribeRequest {
    audio_data_url: String,
    clip_name: String,
    speech_segments: Vec<(f32, f32)>,
    hotwords: String,
    source_language: String,
    target_language: String,
    punctuation: bool,
}

impl AsrTranscribeRequest {
    pub(crate) fn new(audio_data_url: String, clip_name: String) -> Self {
        Self {
            audio_data_url,
            clip_name,
            speech_segments: Vec::new(),
            hotwords: String::new(),
            source_language: "en".to_string(),
            target_language: "en".to_string(),
            punctuation: true,
        }
    }

    pub(crate) fn with_speech_segments(mut self, segments: Vec<(f32, f32)>) -> Self {
        self.speech_segments = segments;
        self
    }

    pub(crate) fn with_model_options(
        mut self,
        hotwords: String,
        source_language: String,
        target_language: String,
        punctuation: bool,
    ) -> Self {
        self.hotwords = hotwords;
        self.source_language = source_language;
        self.target_language = target_language;
        self.punctuation = punctuation;
        self
    }

    fn options_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}",
            self.hotwords, self.source_language, self.target_language, self.punctuation
        )
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrToken {
    text: String,
    start: f32,
    end: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrSegment {
    id: String,
    start: f32,
    end: f32,
    text: String,
    tokens: Vec<AsrToken>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrTranscriptionResult {
    clip_name: String,
    text: String,
    language: String,
    duration: f32,
    speech_seconds: f32,
    waveform: Vec<f32>,
    segments: Vec<AsrSegment>,
    inference_seconds: f32,
    real_time_factor: f32,
    engine: &'static str,
}

struct AudioSamples {
    samples: Vec<f32>,
    duration: f32,
}

pub(crate) struct StreamingAsrRecognizer {
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
}

#[derive(Clone)]
pub(crate) struct StreamingAsrUpdate {
    pub(crate) text: String,
    pub(crate) tokens: Vec<String>,
    pub(crate) timestamps: Vec<f32>,
}

pub(crate) fn create_streaming_asr_recognizer(
    model_dir: &Path,
    adapter: &str,
) -> Result<StreamingAsrRecognizer, String> {
    let config = online_recognizer_config(model_dir, adapter);
    let recognizer = OnlineRecognizer::create(&config)
        .ok_or_else(|| format!("无法加载 {adapter}，请检查模型文件"))?;
    let stream = recognizer.create_stream();
    Ok(StreamingAsrRecognizer { recognizer, stream })
}

impl StreamingAsrRecognizer {
    pub(crate) fn accept_samples(&mut self, samples: &[f32]) -> Option<StreamingAsrUpdate> {
        self.stream.accept_waveform(SAMPLE_RATE, samples);
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
        self.current_result()
    }

    pub(crate) fn finish(&mut self) -> Option<StreamingAsrUpdate> {
        self.stream.input_finished();
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
        self.current_result()
    }

    fn current_result(&self) -> Option<StreamingAsrUpdate> {
        self.recognizer
            .get_result(&self.stream)
            .map(|result| StreamingAsrUpdate {
                text: result.text.trim().to_string(),
                tokens: result.tokens,
                timestamps: result.timestamps.unwrap_or_default(),
            })
    }
}

impl AsrRuntime {
    fn loaded(&self) -> bool {
        self.recognizer
            .lock()
            .map(|recognizer| recognizer.is_some())
            .unwrap_or(false)
    }

    fn recognizer(
        &self,
        model_dir: &Path,
        adapter: &str,
        request: &AsrTranscribeRequest,
    ) -> Result<Arc<OfflineRecognizer>, String> {
        let mut recognizer = self
            .recognizer
            .lock()
            .map_err(|_| "SenseVoice 运行时状态不可用".to_string())?;

        let options_key = request.options_key();
        if let Some(loaded) = recognizer.as_ref() {
            if loaded.model_dir == model_dir
                && loaded.adapter == adapter
                && loaded.options_key == options_key
            {
                return Ok(loaded.recognizer.clone());
            }
        }

        let config = offline_recognizer_config(model_dir, adapter, Some(request));
        let loaded = OfflineRecognizer::create(&config).ok_or_else(|| {
            format!(
                "无法加载 {}，请检查模型文件是否完整",
                adapter_label(adapter)
            )
        })?;
        let loaded = Arc::new(loaded);
        *recognizer = Some(LoadedRecognizer {
            model_dir: model_dir.to_path_buf(),
            adapter: adapter.to_string(),
            options_key,
            recognizer: loaded.clone(),
        });
        Ok(loaded)
    }
}

#[tauri::command]
pub fn asr_model_status(
    app: AppHandle,
    runtime: State<'_, Arc<AsrRuntime>>,
) -> Result<AsrModelStatus, String> {
    let model_dir = model_directory(&app)?;
    Ok(AsrModelStatus {
        id: MODEL_ID,
        name: MODEL_DISPLAY_NAME,
        installed: model_is_installed(&model_dir, "sensevoice"),
        loaded: runtime.loaded(),
        path: path_string(&model_dir),
        sample_rate: SAMPLE_RATE,
        languages: vec!["zh", "en", "ja", "ko", "yue"],
        token_timestamps: true,
        vad: false,
        runtime: "sherpa-onnx 1.13.4",
    })
}

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    runtime: State<'_, Arc<AsrRuntime>>,
    request: AsrTranscribeRequest,
) -> Result<AsrTranscriptionResult, String> {
    transcribe_audio_with_runtime(
        app,
        runtime.inner().clone(),
        request,
        None,
        None,
        None,
        None,
    )
    .await
}

pub(crate) async fn transcribe_audio_with_runtime(
    app: AppHandle,
    runtime: Arc<AsrRuntime>,
    request: AsrTranscribeRequest,
    cancel: Option<Arc<AtomicBool>>,
    model_dir_override: Option<PathBuf>,
    adapter_override: Option<String>,
    progress_callback: Option<AsrProgressCallback>,
) -> Result<AsrTranscriptionResult, String> {
    if is_canceled(cancel.as_deref()) {
        return Err("任务已取消".to_string());
    }

    let model_dir = model_dir_override.unwrap_or(model_directory(&app)?);
    let adapter = adapter_override.unwrap_or_else(|| "sensevoice".to_string());
    if !model_is_installed(&model_dir, &adapter) {
        return Err(format!(
            "{} 模型尚未安装，请将模型安装到 {}",
            adapter_label(&adapter),
            path_string(&model_dir)
        ));
    }

    let progress_app = app.clone();
    let task_label = adapter_label(&adapter).to_string();

    tauri::async_runtime::spawn_blocking(move || {
        if is_canceled(cancel.as_deref()) {
            return Err("任务已取消".to_string());
        }
        emit_progress(&progress_app, "preparing", 4, "正在读取音频");
        if let Some(callback) = progress_callback.as_ref() {
            callback(4, "正在读取音频".to_string());
        }
        let decoded = decode_wav_data_url(&request.audio_data_url)?;
        let resampled = resample_audio(&decoded, SAMPLE_RATE as u32)?;
        let waveform = waveform_envelope(&resampled, 320);
        let samples = resampled.mono_samples();
        let audio = AudioSamples {
            duration: samples.len() as f32 / SAMPLE_RATE as f32,
            samples,
        };
        if audio.samples.is_empty() || audio.duration < 0.1 {
            return Err("音频内容为空，无法识别".to_string());
        }
        if request.speech_segments.is_empty()
            && adapter_max_input_seconds(&adapter).is_some_and(|limit| audio.duration > limit)
        {
            return Err(format!(
                "{} 单段最多支持约 {} 秒音频，请启用 VAD 后再识别",
                adapter_label(&adapter),
                adapter_max_input_seconds(&adapter).unwrap_or_default() as u32
            ));
        }

        emit_progress(
            &progress_app,
            "loading",
            9,
            &format!("正在加载 {}", adapter_label(&adapter)),
        );
        if let Some(callback) = progress_callback.as_ref() {
            callback(9, format!("正在加载 {}", adapter_label(&adapter)));
        }
        let recognizer = runtime.recognizer(&model_dir, &adapter, &request)?;
        let started = Instant::now();

        emit_progress(&progress_app, "recognizing", 14, "正在识别音频");
        if let Some(callback) = progress_callback.as_ref() {
            callback(14, "正在识别音频".to_string());
        }
        if is_canceled(cancel.as_deref()) {
            return Err("任务已取消".to_string());
        }
        let ranges = if request.speech_segments.is_empty() {
            vec![(0.0, audio.duration)]
        } else {
            request
                .speech_segments
                .iter()
                .filter_map(|(start, end)| {
                    let start = start.clamp(0.0, audio.duration);
                    let end = end.clamp(start, audio.duration);
                    (end - start >= 0.08).then_some((start, end))
                })
                .collect::<Vec<_>>()
        };
        let mut segments = Vec::new();
        let mut transcript = String::new();
        for (index, (start, end)) in ranges.iter().copied().enumerate() {
            if is_canceled(cancel.as_deref()) {
                return Err("任务已取消".to_string());
            }
            let start_sample = (start * SAMPLE_RATE as f32) as usize;
            let end_sample = ((end * SAMPLE_RATE as f32) as usize).min(audio.samples.len());
            if end_sample <= start_sample {
                continue;
            }
            emit_progress(
                &progress_app,
                "recognizing",
                14 + ((index + 1) * 80 / ranges.len().max(1)) as u8,
                &format!("正在识别片段 {}/{}", index + 1, ranges.len()),
            );
            if let Some(callback) = progress_callback.as_ref() {
                callback(
                    14 + ((index + 1) * 80 / ranges.len().max(1)) as u8,
                    format!("正在识别片段 {}/{}", index + 1, ranges.len()),
                );
            }
            let stream = recognizer.create_stream();
            stream.accept_waveform(SAMPLE_RATE, &audio.samples[start_sample..end_sample]);
            recognizer.decode(&stream);
            let Some(result) = stream.get_result() else {
                continue;
            };
            let text = result.text.trim().to_string();
            if text.is_empty() || text == "." || text == "The." {
                continue;
            }
            if transcript
                .chars()
                .last()
                .is_some_and(|character| character.is_ascii_alphanumeric())
                && text
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphanumeric())
            {
                transcript.push(' ');
            }
            transcript.push_str(&text);
            segments.push(AsrSegment {
                id: format!("result-{}", segments.len() + 1),
                start,
                end,
                tokens: align_tokens(&result, start, end - start),
                text,
            });
        }
        if transcript.is_empty() {
            return Err("检测到了语音，但没有得到可用文本".to_string());
        }
        let inference_seconds = started.elapsed().as_secs_f32();
        let language = detect_language(&transcript);
        let real_time_factor = inference_seconds / audio.duration.max(0.001);
        emit_progress(&progress_app, "complete", 100, "识别完成");
        Ok(AsrTranscriptionResult {
            clip_name: request.clip_name,
            text: transcript,
            language,
            duration: audio.duration,
            speech_seconds: ranges.iter().map(|(start, end)| end - start).sum(),
            waveform,
            segments,
            inference_seconds,
            real_time_factor,
            engine: adapter_engine(&adapter),
        })
    })
    .await
    .map_err(|error| format!("{task_label} 识别任务异常结束: {error}"))?
}

pub(crate) async fn transcribe_streaming_audio(
    request: AsrTranscribeRequest,
    cancel: Option<Arc<AtomicBool>>,
    model_dir: PathBuf,
    adapter: String,
) -> Result<AsrTranscriptionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if is_canceled(cancel.as_deref()) {
            return Err("任务已取消".to_string());
        }
        let decoded = decode_wav_data_url(&request.audio_data_url)?;
        let resampled = resample_audio(&decoded, SAMPLE_RATE as u32)?;
        let waveform = waveform_envelope(&resampled, 320);
        let samples = resampled.mono_samples();
        let duration = samples.len() as f32 / SAMPLE_RATE as f32;
        if samples.is_empty() || duration < 0.1 {
            return Err("音频内容为空，无法识别".to_string());
        }

        let mut recognizer = create_streaming_asr_recognizer(&model_dir, &adapter)?;
        let started = Instant::now();
        let mut result = None;
        for chunk in samples.chunks(SAMPLE_RATE as usize / 2) {
            if is_canceled(cancel.as_deref()) {
                return Err("任务已取消".to_string());
            }
            result = recognizer.accept_samples(chunk).or(result);
        }
        let result = recognizer
            .finish()
            .or(result)
            .ok_or_else(|| "Zipformer 没有返回识别结果".to_string())?;
        let text = result.text.trim().to_string();
        if text.is_empty() {
            return Err("没有识别到可用文本".to_string());
        }
        let timestamps = result.timestamps;
        let tokens = result
            .tokens
            .iter()
            .enumerate()
            .map(|(index, token)| {
                let start = timestamps.get(index).copied().unwrap_or_default();
                let end = timestamps
                    .get(index + 1)
                    .copied()
                    .unwrap_or((start + 0.2).min(duration));
                AsrToken {
                    text: token.clone(),
                    start,
                    end,
                }
            })
            .collect();
        let inference_seconds = started.elapsed().as_secs_f32();
        Ok(AsrTranscriptionResult {
            clip_name: request.clip_name,
            text: text.clone(),
            language: detect_language(&text),
            duration,
            speech_seconds: duration,
            waveform,
            segments: vec![AsrSegment {
                id: "zipformer-0".to_string(),
                start: 0.0,
                end: duration,
                text,
                tokens,
            }],
            inference_seconds,
            real_time_factor: inference_seconds / duration.max(0.001),
            engine: if adapter == "streaming-paraformer" {
                "Streaming Paraformer / sherpa-onnx"
            } else {
                "Streaming Zipformer / sherpa-onnx"
            },
        })
    })
    .await
    .map_err(|error| format!("Zipformer 识别线程异常结束: {error}"))?
}

fn online_recognizer_config(model_dir: &Path, adapter: &str) -> OnlineRecognizerConfig {
    let mut config = OnlineRecognizerConfig::default();
    if adapter == "streaming-paraformer" {
        config.model_config.paraformer.encoder =
            Some(path_string(&model_dir.join("encoder.int8.onnx")));
        config.model_config.paraformer.decoder =
            Some(path_string(&model_dir.join("decoder.int8.onnx")));
    } else {
        let int8 = model_dir.join("encoder.int8.onnx").is_file();
        config.model_config.transducer.encoder = Some(path_string(&model_dir.join(if int8 {
            "encoder.int8.onnx"
        } else {
            "encoder.onnx"
        })));
        config.model_config.transducer.decoder = Some(path_string(&model_dir.join("decoder.onnx")));
        config.model_config.transducer.joiner = Some(path_string(&model_dir.join(if int8 {
            "joiner.int8.onnx"
        } else {
            "joiner.onnx"
        })));
    }
    config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
    config.model_config.num_threads = inference_threads();
    config.model_config.provider = Some("cpu".to_string());
    config.decoding_method = Some("greedy_search".to_string());
    config
}

fn offline_recognizer_config(
    model_dir: &Path,
    adapter: &str,
    request: Option<&AsrTranscribeRequest>,
) -> OfflineRecognizerConfig {
    let mut config = OfflineRecognizerConfig::default();
    match adapter {
        "funasr-nano" => {
            let llm = if model_dir.join("llm.int8.onnx").is_file() {
                model_dir.join("llm.int8.onnx")
            } else {
                model_dir.join("llm.fp16.onnx")
            };
            config.model_config.funasr_nano = OfflineFunASRNanoModelConfig {
                encoder_adaptor: Some(path_string(&model_dir.join("encoder_adaptor.int8.onnx"))),
                llm: Some(path_string(&llm)),
                embedding: Some(path_string(&model_dir.join("embedding.int8.onnx"))),
                tokenizer: Some(path_string(&model_dir.join("Qwen3-0.6B"))),
                system_prompt: Some("You are a helpful assistant.".to_string()),
                user_prompt: Some("请转写这段语音。".to_string()),
                max_new_tokens: 512,
                temperature: 0.000001,
                top_p: 0.8,
                seed: 42,
                language: None,
                itn: 1,
                hotwords: None,
            };
        }
        "wenet-ctc" => {
            config.model_config.wenet_ctc = OfflineWenetCtcModelConfig {
                model: Some(path_string(&model_dir.join("model.int8.onnx"))),
            };
            config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
        }
        "fire-red-asr-ctc" => {
            config.model_config.fire_red_asr_ctc = OfflineFireRedAsrCtcModelConfig {
                model: Some(path_string(&model_dir.join("model.int8.onnx"))),
            };
            config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
        }
        "fire-red-asr" => {
            config.model_config.fire_red_asr = OfflineFireRedAsrModelConfig {
                encoder: Some(path_string(&model_dir.join("encoder.int8.onnx"))),
                decoder: Some(path_string(&model_dir.join("decoder.int8.onnx"))),
            };
            config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
        }
        "moonshine-v2" => {
            config.model_config.moonshine = OfflineMoonshineModelConfig {
                encoder: Some(path_string(&model_dir.join("encoder_model.ort"))),
                merged_decoder: Some(path_string(&model_dir.join("decoder_model_merged.ort"))),
                ..Default::default()
            };
            config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
        }
        "nemo-parakeet" => {
            config.model_config.transducer.encoder =
                Some(path_string(&model_dir.join("encoder.int8.onnx")));
            config.model_config.transducer.decoder =
                Some(path_string(&model_dir.join("decoder.int8.onnx")));
            config.model_config.transducer.joiner =
                Some(path_string(&model_dir.join("joiner.int8.onnx")));
            config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
            config.model_config.model_type = Some("nemo_transducer".to_string());
        }
        "nemo-canary" => {
            let source_language = request
                .map(|value| value.source_language.as_str())
                .filter(|value| matches!(*value, "en" | "es" | "de" | "fr"))
                .unwrap_or("en");
            let target_language = request
                .map(|value| value.target_language.as_str())
                .filter(|value| matches!(*value, "en" | "es" | "de" | "fr"))
                .unwrap_or(source_language);
            config.model_config.canary = OfflineCanaryModelConfig {
                encoder: Some(path_string(&model_dir.join("encoder.int8.onnx"))),
                decoder: Some(path_string(&model_dir.join("decoder.int8.onnx"))),
                src_lang: Some(source_language.to_string()),
                tgt_lang: Some(target_language.to_string()),
                use_pnc: request.map(|value| value.punctuation).unwrap_or(true),
            };
            config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
        }
        "qwen3-asr" => {
            config.model_config.qwen3_asr = OfflineQwen3ASRModelConfig {
                conv_frontend: Some(path_string(&model_dir.join("conv_frontend.onnx"))),
                encoder: Some(path_string(&model_dir.join("encoder.int8.onnx"))),
                decoder: Some(path_string(&model_dir.join("decoder.int8.onnx"))),
                tokenizer: Some(path_string(&model_dir.join("tokenizer"))),
                hotwords: request
                    .map(|value| value.hotwords.trim())
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                ..Default::default()
            };
            config.model_config.tokens = Some(String::new());
        }
        _ => {
            config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                model: Some(path_string(&model_dir.join("model.int8.onnx"))),
                language: Some("auto".to_string()),
                use_itn: true,
            };
            config.model_config.tokens = Some(path_string(&model_dir.join("tokens.txt")));
        }
    }
    config.model_config.num_threads = inference_threads();
    config.model_config.provider = Some("cpu".to_string());
    config.decoding_method = Some("greedy_search".to_string());
    config
}

fn adapter_label(adapter: &str) -> &'static str {
    match adapter {
        "funasr-nano" => "FunASR Nano",
        "wenet-ctc" => "WeNet CTC",
        "fire-red-asr-ctc" => "FireRedASR CTC",
        "fire-red-asr" => "FireRedASR AED",
        "moonshine-v2" => "Moonshine v2",
        "nemo-parakeet" => "NVIDIA Parakeet TDT",
        "nemo-canary" => "NVIDIA Canary 180M Flash",
        "qwen3-asr" => "Qwen3-ASR",
        _ => "SenseVoice Small",
    }
}

fn adapter_engine(adapter: &str) -> &'static str {
    match adapter {
        "funasr-nano" => "sherpa-onnx · FunASR Nano",
        "wenet-ctc" => "sherpa-onnx · WeNet CTC",
        "fire-red-asr-ctc" => "sherpa-onnx · FireRedASR CTC",
        "fire-red-asr" => "sherpa-onnx · FireRedASR AED",
        "moonshine-v2" => "sherpa-onnx · Moonshine v2",
        "nemo-parakeet" => "sherpa-onnx · NVIDIA Parakeet TDT",
        "nemo-canary" => "sherpa-onnx · NVIDIA Canary 180M Flash",
        "qwen3-asr" => "sherpa-onnx · Qwen3-ASR",
        _ => "sherpa-onnx · SenseVoice Small int8",
    }
}

fn adapter_max_input_seconds(adapter: &str) -> Option<f32> {
    match adapter {
        // The exported encoder has a 5000-frame positional limit. Keep a small
        // margin so ONNX Runtime never reaches its non-recoverable broadcast error.
        "wenet-ctc" => Some(190.0),
        _ => None,
    }
}

fn is_canceled(cancel: Option<&AtomicBool>) -> bool {
    cancel
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn align_tokens(
    result: &OfflineRecognizerResult,
    segment_start: f32,
    segment_duration: f32,
) -> Vec<AsrToken> {
    let Some(timestamps) = result.timestamps.as_ref() else {
        return Vec::new();
    };
    let durations = result.durations.as_deref().unwrap_or(&[]);

    result
        .tokens
        .iter()
        .zip(timestamps)
        .enumerate()
        .filter_map(|(index, (token, timestamp))| {
            let text = clean_token(token);
            if text.is_empty() {
                return None;
            }

            let local_start = timestamp.clamp(0.0, segment_duration);
            let next_start = timestamps
                .get(index + 1)
                .copied()
                .unwrap_or(local_start + 0.24);
            let local_end = durations
                .get(index)
                .map(|duration| local_start + duration)
                .unwrap_or(next_start)
                .max(local_start + 0.04)
                .min(segment_duration);
            Some(AsrToken {
                text,
                start: segment_start + local_start,
                end: segment_start + local_end,
            })
        })
        .collect()
}

fn clean_token(token: &str) -> String {
    if token.starts_with("<|") && token.ends_with("|>") {
        String::new()
    } else {
        token.replace('▁', " ")
    }
}

fn detect_language(text: &str) -> String {
    if text
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
    {
        "zh".to_string()
    } else if text
        .chars()
        .any(|character| ('\u{3040}'..='\u{30ff}').contains(&character))
    {
        "ja".to_string()
    } else if text
        .chars()
        .any(|character| ('\u{ac00}'..='\u{d7af}').contains(&character))
    {
        "ko".to_string()
    } else {
        "en".to_string()
    }
}

fn model_directory(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("QWEN_AUDIO_SENSEVOICE_MODEL_DIR") {
        return Ok(PathBuf::from(path));
    }

    app.path()
        .app_data_dir()
        .map(|path| path.join("models").join(MODEL_DIRECTORY))
        .map_err(|error| format!("无法定位模型目录: {error}"))
}

fn model_is_installed(model_dir: &Path, adapter: &str) -> bool {
    match adapter {
        "funasr-nano" => {
            model_dir.join("encoder_adaptor.int8.onnx").is_file()
                && model_dir.join("embedding.int8.onnx").is_file()
                && (model_dir.join("llm.int8.onnx").is_file()
                    || model_dir.join("llm.fp16.onnx").is_file())
                && model_dir
                    .join("Qwen3-0.6B")
                    .join("tokenizer.json")
                    .is_file()
        }
        "moonshine-v2" => {
            model_dir.join("encoder_model.ort").is_file()
                && model_dir.join("decoder_model_merged.ort").is_file()
                && model_dir.join("tokens.txt").is_file()
        }
        "nemo-parakeet" => [
            "encoder.int8.onnx",
            "decoder.int8.onnx",
            "joiner.int8.onnx",
            "tokens.txt",
        ]
        .iter()
        .all(|file| model_dir.join(file).is_file()),
        "nemo-canary" | "fire-red-asr" => ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"]
            .iter()
            .all(|file| model_dir.join(file).is_file()),
        "qwen3-asr" => {
            [
                "conv_frontend.onnx",
                "encoder.int8.onnx",
                "decoder.int8.onnx",
            ]
            .iter()
            .all(|file| model_dir.join(file).is_file())
                && model_dir.join("tokenizer").is_dir()
        }
        _ => model_dir.join("model.int8.onnx").is_file() && model_dir.join("tokens.txt").is_file(),
    }
}

fn inference_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|threads| threads.get().clamp(2, 4) as i32)
        .unwrap_or(2)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn emit_progress(app: &AppHandle, stage: &'static str, progress: u8, detail: &str) {
    let _ = app.emit(
        "asr-transcription-progress",
        AsrProgress {
            stage,
            progress,
            detail: detail.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_io::{decode_wav_bytes, resample_audio};
    use std::fs;

    #[test]
    #[ignore = "requires QWEN_AUDIO_ASR_PLUGIN_ADAPTER, QWEN_AUDIO_ASR_PLUGIN_MODEL_DIR and QWEN_AUDIO_ASR_SMOKE_INPUT"]
    fn recognizes_with_plugin_adapter() {
        let adapter = env::var("QWEN_AUDIO_ASR_PLUGIN_ADAPTER")
            .expect("QWEN_AUDIO_ASR_PLUGIN_ADAPTER is required");
        let model_dir = env::var("QWEN_AUDIO_ASR_PLUGIN_MODEL_DIR")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_ASR_PLUGIN_MODEL_DIR is required");
        let input =
            env::var("QWEN_AUDIO_ASR_SMOKE_INPUT").expect("QWEN_AUDIO_ASR_SMOKE_INPUT is required");
        assert!(model_is_installed(&model_dir, &adapter));

        let bytes = fs::read(input).expect("failed to read smoke-test WAV");
        let decoded = decode_wav_bytes(&bytes).expect("failed to decode smoke-test WAV");
        let resampled = resample_audio(&decoded, SAMPLE_RATE as u32).expect("failed to resample");
        let recognizer =
            OfflineRecognizer::create(&offline_recognizer_config(&model_dir, &adapter, None))
                .expect("failed to create recognizer");
        let stream = recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE, &resampled.mono_samples());
        recognizer.decode(&stream);
        let result = stream.get_result().expect("recognizer returned no result");
        assert!(
            !result.text.trim().is_empty(),
            "recognizer returned empty text"
        );
    }

    #[test]
    #[ignore = "requires QWEN_AUDIO_SENSEVOICE_MODEL_DIR and QWEN_AUDIO_ASR_SMOKE_INPUT"]
    fn recognizes_chinese_wav_with_timestamps() {
        let model_dir = env::var("QWEN_AUDIO_SENSEVOICE_MODEL_DIR")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_SENSEVOICE_MODEL_DIR is required");
        let input =
            env::var("QWEN_AUDIO_ASR_SMOKE_INPUT").expect("QWEN_AUDIO_ASR_SMOKE_INPUT is required");
        let bytes = fs::read(input).expect("read input wav");
        let decoded = decode_wav_bytes(&bytes).expect("decode input wav");
        let audio = resample_audio(&decoded, SAMPLE_RATE as u32).expect("resample input");
        let samples = audio.mono_samples();
        let runtime = AsrRuntime::default();
        let request = AsrTranscribeRequest::new(String::new(), String::new());
        let recognizer = runtime
            .recognizer(&model_dir, "sensevoice", &request)
            .expect("load SenseVoice");
        assert!(!samples.is_empty());

        let stream = recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE, &samples);
        recognizer.decode(&stream);
        let result = stream.get_result().expect("recognition result");

        assert!(!result.text.trim().is_empty());
        assert!(result
            .timestamps
            .as_ref()
            .is_some_and(|items| !items.is_empty()));
        println!("text={} timestamps={:?}", result.text, result.timestamps);
    }

    #[test]
    #[ignore = "requires QWEN_AUDIO_STREAMING_ASR_MODEL_DIR and QWEN_AUDIO_ASR_SMOKE_INPUT"]
    fn streaming_asr_emits_text_before_finish() {
        let model_dir = env::var("QWEN_AUDIO_STREAMING_ASR_MODEL_DIR")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_STREAMING_ASR_MODEL_DIR is required");
        let adapter = env::var("QWEN_AUDIO_STREAMING_ASR_ADAPTER")
            .unwrap_or_else(|_| "streaming-zipformer".into());
        let input =
            env::var("QWEN_AUDIO_ASR_SMOKE_INPUT").expect("QWEN_AUDIO_ASR_SMOKE_INPUT is required");
        let bytes = fs::read(input).expect("read input wav");
        let decoded = decode_wav_bytes(&bytes).expect("decode input wav");
        let audio = resample_audio(&decoded, SAMPLE_RATE as u32).expect("resample input");
        let samples = audio.mono_samples();
        let mut recognizer =
            create_streaming_asr_recognizer(&model_dir, &adapter).expect("load streaming ASR");
        let mut incremental = Vec::new();
        for chunk in samples.chunks(SAMPLE_RATE as usize / 10) {
            if let Some(update) = recognizer.accept_samples(chunk) {
                if !update.text.is_empty() && incremental.last() != Some(&update.text) {
                    incremental.push(update.text);
                }
            }
        }
        let final_result = recognizer.finish().expect("final streaming result");
        assert!(!final_result.text.is_empty());
        assert!(
            !incremental.is_empty(),
            "streaming recognizer only returned text after finish"
        );
    }
}
