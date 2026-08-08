use crate::audio_io::{
    decode_wav_data_url, encode_wav_bytes, normalize_generated_speech, PcmAudio,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKittenModelConfig,
    OfflineTtsKokoroModelConfig, OfflineTtsMatchaModelConfig, OfflineTtsModelConfig,
    OfflineTtsPocketModelConfig, OfflineTtsSupertonicModelConfig, OfflineTtsVitsModelConfig,
    OfflineTtsZipvoiceModelConfig,
};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const MODEL_ID: &str = "kokoro-int8-multi-lang-v1_1";
const MODEL_DIRECTORY: &str = "kokoro-int8-multi-lang-v1_1";
const MODEL_DISPLAY_NAME: &str = "Kokoro v1.1 中文";
const SPEAKER_COUNT: i32 = 103;

#[derive(Default)]
pub struct TtsRuntime {
    engine: Mutex<Option<LoadedTts>>,
}

struct LoadedTts {
    model_dir: PathBuf,
    family: TtsFamily,
    engine: Arc<OfflineTts>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TtsFamily {
    Kokoro,
    Vits,
    Matcha,
    Kitten,
    ZipVoice,
    Pocket,
    Supertonic,
}

impl TtsFamily {
    fn label(self) -> &'static str {
        match self {
            Self::Kokoro => "Kokoro",
            Self::Vits => "VITS",
            Self::Matcha => "Matcha",
            Self::Kitten => "KittenTTS",
            Self::ZipVoice => "ZipVoice",
            Self::Pocket => "PocketTTS",
            Self::Supertonic => "SupertonicTTS",
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Kokoro => "kokoro",
            Self::Vits => "vits",
            Self::Matcha => "matcha",
            Self::Kitten => "kitten",
            Self::ZipVoice => "zipvoice",
            Self::Pocket => "pocket",
            Self::Supertonic => "supertonic",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsProgress {
    stage: &'static str,
    progress: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsModelStatus {
    id: &'static str,
    name: &'static str,
    installed: bool,
    loaded: bool,
    path: String,
    sample_rate: i32,
    speaker_count: i32,
    runtime: &'static str,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGenerateRequest {
    text: String,
    sid: i32,
    speed: f32,
    silence_scale: Option<f32>,
    reference_audio_data_url: Option<String>,
    reference_text: Option<String>,
    num_steps: Option<i32>,
    language: Option<String>,
}

impl TtsGenerateRequest {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        text: String,
        sid: i32,
        speed: f32,
        silence_scale: Option<f32>,
        reference_audio_data_url: Option<String>,
        reference_text: Option<String>,
        num_steps: Option<i32>,
        language: Option<String>,
    ) -> Self {
        Self {
            text,
            sid,
            speed,
            silence_scale,
            reference_audio_data_url,
            reference_text,
            num_steps,
            language,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsGenerateResult {
    file_name: String,
    file_path: String,
    data_url: String,
    duration: f32,
    sample_rate: i32,
    channels: i32,
    size_bytes: u64,
    waveform: Vec<f32>,
    inference_seconds: f32,
    real_time_factor: f32,
    sid: i32,
    engine: String,
}

impl TtsRuntime {
    fn loaded(&self) -> bool {
        self.engine
            .lock()
            .map(|engine| engine.is_some())
            .unwrap_or(false)
    }

    fn engine(&self, model_dir: &Path) -> Result<(Arc<OfflineTts>, TtsFamily), String> {
        let mut engine = self
            .engine
            .lock()
            .map_err(|_| "TTS 运行时状态不可用".to_string())?;

        if let Some(loaded) = engine.as_ref() {
            if loaded.model_dir == model_dir {
                return Ok((loaded.engine.clone(), loaded.family));
            }
        }

        let family = detect_tts_family(model_dir)?;
        let mut model = OfflineTtsModelConfig {
            num_threads: inference_threads(),
            debug: false,
            provider: Some("cpu".to_string()),
            ..Default::default()
        };
        match family {
            TtsFamily::Kokoro => {
                let lexicon = [
                    model_dir.join("lexicon-us-en.txt"),
                    model_dir.join("lexicon-zh.txt"),
                ]
                .iter()
                .filter(|path| path.is_file())
                .map(|path| path_string(path))
                .collect::<Vec<_>>()
                .join(",");
                model.kokoro = OfflineTtsKokoroModelConfig {
                    model: Some(path_string(&find_first_file(
                        model_dir,
                        &["model.int8.onnx", "model.onnx"],
                    )?)),
                    voices: Some(path_string(&model_dir.join("voices.bin"))),
                    tokens: Some(path_string(&model_dir.join("tokens.txt"))),
                    data_dir: Some(path_string(&model_dir.join("espeak-ng-data"))),
                    dict_dir: existing_path(model_dir.join("dict")),
                    lexicon: (!lexicon.is_empty()).then_some(lexicon),
                    ..Default::default()
                };
            }
            TtsFamily::Vits => {
                model.vits = OfflineTtsVitsModelConfig {
                    model: Some(path_string(&model_dir.join("model.onnx"))),
                    lexicon: existing_path(model_dir.join("lexicon.txt")),
                    tokens: Some(path_string(&model_dir.join("tokens.txt"))),
                    data_dir: existing_path(model_dir.join("espeak-ng-data")),
                    dict_dir: existing_path(model_dir.join("dict")),
                    ..Default::default()
                };
            }
            TtsFamily::Matcha => {
                model.matcha = OfflineTtsMatchaModelConfig {
                    acoustic_model: Some(path_string(&find_first_file(
                        model_dir,
                        &["model-steps-3.onnx", "model.onnx"],
                    )?)),
                    vocoder: Some(path_string(&find_first_file(
                        model_dir,
                        &[
                            "vocos-16khz-univ.onnx",
                            "vocos-22khz-univ.onnx",
                            "vocos_24khz.onnx",
                        ],
                    )?)),
                    lexicon: existing_path(model_dir.join("lexicon.txt")),
                    tokens: Some(path_string(&model_dir.join("tokens.txt"))),
                    data_dir: existing_path(model_dir.join("espeak-ng-data")),
                    dict_dir: existing_path(model_dir.join("dict")),
                    ..Default::default()
                };
            }
            TtsFamily::Kitten => {
                model.kitten = OfflineTtsKittenModelConfig {
                    model: Some(path_string(&find_first_file(
                        model_dir,
                        &[
                            "model.int8.onnx",
                            "model.fp16.onnx",
                            "model.fp32.onnx",
                            "model.onnx",
                        ],
                    )?)),
                    voices: Some(path_string(&model_dir.join("voices.bin"))),
                    tokens: Some(path_string(&model_dir.join("tokens.txt"))),
                    data_dir: Some(path_string(&model_dir.join("espeak-ng-data"))),
                    ..Default::default()
                };
            }
            TtsFamily::ZipVoice => {
                model.zipvoice = OfflineTtsZipvoiceModelConfig {
                    tokens: Some(path_string(&model_dir.join("tokens.txt"))),
                    encoder: Some(path_string(&find_first_file(
                        model_dir,
                        &["encoder.int8.onnx", "encoder.onnx"],
                    )?)),
                    decoder: Some(path_string(&find_first_file(
                        model_dir,
                        &["decoder.int8.onnx", "decoder.onnx"],
                    )?)),
                    vocoder: Some(path_string(&model_dir.join("vocos_24khz.onnx"))),
                    data_dir: Some(path_string(&model_dir.join("espeak-ng-data"))),
                    lexicon: Some(path_string(&model_dir.join("lexicon.txt"))),
                    feat_scale: 0.1,
                    t_shift: 0.5,
                    target_rms: 0.1,
                    guidance_scale: 1.0,
                };
            }
            TtsFamily::Pocket => {
                model.pocket = OfflineTtsPocketModelConfig {
                    lm_flow: Some(path_string(&model_dir.join("lm_flow.int8.onnx"))),
                    lm_main: Some(path_string(&model_dir.join("lm_main.int8.onnx"))),
                    encoder: Some(path_string(&model_dir.join("encoder.onnx"))),
                    decoder: Some(path_string(&model_dir.join("decoder.int8.onnx"))),
                    text_conditioner: Some(path_string(&model_dir.join("text_conditioner.onnx"))),
                    vocab_json: Some(path_string(&model_dir.join("vocab.json"))),
                    token_scores_json: Some(path_string(&model_dir.join("token_scores.json"))),
                    voice_embedding_cache_capacity: 8,
                };
            }
            TtsFamily::Supertonic => {
                model.supertonic = OfflineTtsSupertonicModelConfig {
                    duration_predictor: Some(path_string(
                        &model_dir.join("duration_predictor.int8.onnx"),
                    )),
                    text_encoder: Some(path_string(&model_dir.join("text_encoder.int8.onnx"))),
                    vector_estimator: Some(path_string(
                        &model_dir.join("vector_estimator.int8.onnx"),
                    )),
                    vocoder: Some(path_string(&model_dir.join("vocoder.int8.onnx"))),
                    tts_json: Some(path_string(&model_dir.join("tts.json"))),
                    unicode_indexer: Some(path_string(&model_dir.join("unicode_indexer.bin"))),
                    voice_style: Some(path_string(&model_dir.join("voice.bin"))),
                };
            }
        }

        let config = OfflineTtsConfig {
            model,
            rule_fsts: rule_fsts(model_dir),
            max_num_sentences: 1,
            silence_scale: 0.2,
            ..Default::default()
        };

        let loaded = OfflineTts::create(&config)
            .ok_or_else(|| format!("无法加载 {} 模型，请检查模型文件是否完整", family.label()))?;
        let loaded = Arc::new(loaded);
        *engine = Some(LoadedTts {
            model_dir: model_dir.to_path_buf(),
            family,
            engine: loaded.clone(),
        });
        Ok((loaded, family))
    }
}

#[tauri::command]
pub fn tts_model_status(
    app: AppHandle,
    runtime: State<'_, Arc<TtsRuntime>>,
) -> Result<TtsModelStatus, String> {
    let model_dir = model_directory(&app)?;
    Ok(TtsModelStatus {
        id: MODEL_ID,
        name: MODEL_DISPLAY_NAME,
        installed: model_is_installed(&model_dir),
        loaded: runtime.loaded(),
        path: path_string(&model_dir),
        sample_rate: 24_000,
        speaker_count: SPEAKER_COUNT,
        runtime: "sherpa-onnx 1.13.4",
    })
}

#[tauri::command]
pub async fn generate_speech(
    app: AppHandle,
    runtime: State<'_, Arc<TtsRuntime>>,
    request: TtsGenerateRequest,
) -> Result<TtsGenerateResult, String> {
    generate_speech_with_runtime(app, runtime.inner().clone(), request, None, None, None).await
}

pub(crate) type TtsProgressCallback = Arc<dyn Fn(u8, String) + Send + Sync>;

pub(crate) async fn generate_speech_with_runtime(
    app: AppHandle,
    runtime: Arc<TtsRuntime>,
    request: TtsGenerateRequest,
    cancel: Option<Arc<AtomicBool>>,
    model_dir_override: Option<PathBuf>,
    progress_callback: Option<TtsProgressCallback>,
) -> Result<TtsGenerateResult, String> {
    validate_request(&request)?;
    if is_canceled(cancel.as_deref()) {
        return Err("任务已取消".to_string());
    }

    let model_dir = model_dir_override.unwrap_or(model_directory(&app)?);
    if !model_is_installed(&model_dir) {
        return Err(format!(
            "Kokoro 模型尚未安装，请将模型安装到 {}",
            path_string(&model_dir)
        ));
    }

    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("generated");
    let progress_app = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if is_canceled(cancel.as_deref()) {
            return Err("任务已取消".to_string());
        }
        emit_progress(&progress_app, "loading", 8);
        if let Some(callback) = progress_callback.as_ref() {
            callback(8, "正在加载语音模型".to_string());
        }
        let (engine, family) = runtime.engine(&model_dir)?;
        validate_family_request(family, &request)?;
        let speaker_count = engine.num_speakers();
        if speaker_count > 0 && request.sid >= speaker_count {
            return Err(format!(
                "{} 仅支持音色 ID 0 到 {}",
                family.label(),
                speaker_count - 1
            ));
        }
        emit_progress(&progress_app, "generating", 18);
        if let Some(callback) = progress_callback.as_ref() {
            callback(18, format!("正在使用 {} 生成语音", family.label()));
        }

        let reference_audio = request
            .reference_audio_data_url
            .as_deref()
            .map(decode_wav_data_url)
            .transpose()?;
        let mut extra = HashMap::new();
        if family == TtsFamily::ZipVoice {
            extra.insert("min_char_in_sentence".to_string(), serde_json::json!(10));
        }
        if let Some(language) = request
            .language
            .as_deref()
            .map(str::trim)
            .filter(|language| !language.is_empty() && *language != "auto")
        {
            extra.insert("lang".to_string(), serde_json::json!(language));
        }
        let generation = GenerationConfig {
            sid: request.sid,
            speed: request.speed,
            silence_scale: request.silence_scale.unwrap_or(0.2),
            reference_audio: reference_audio.as_ref().map(|audio| audio.mono_samples()),
            reference_sample_rate: reference_audio
                .as_ref()
                .map(|audio| audio.sample_rate as i32)
                .unwrap_or_default(),
            reference_text: request.reference_text.clone(),
            num_steps: request.num_steps.unwrap_or(match family {
                TtsFamily::Pocket => 2,
                TtsFamily::ZipVoice => 4,
                TtsFamily::Supertonic => 8,
                _ => 5,
            }),
            extra: (!extra.is_empty()).then_some(extra),
        };
        let started = Instant::now();
        let callback_app = progress_app.clone();
        let callback_cancel = cancel.clone();
        let generation_progress = progress_callback.clone();
        let generated_audio = engine
            .generate_with_config(
                request.text.trim(),
                &generation,
                Some(move |_samples: &[f32], progress: f32| {
                    let value = 18 + (progress.clamp(0.0, 1.0) * 78.0).round() as u8;
                    emit_progress(&callback_app, "generating", value);
                    if let Some(callback) = generation_progress.as_ref() {
                        callback(value, "正在生成语音".to_string());
                    }
                    !is_canceled(callback_cancel.as_deref())
                }),
            )
            .ok_or_else(|| {
                if is_canceled(cancel.as_deref()) {
                    "任务已取消".to_string()
                } else {
                    format!("{} 没有生成音频，请检查输入参数", family.label())
                }
            })?;

        let mut audio = PcmAudio {
            samples: generated_audio.samples().to_vec(),
            sample_rate: generated_audio.sample_rate() as u32,
            channels: 1,
        };
        normalize_generated_speech(&mut audio);

        if is_canceled(cancel.as_deref()) {
            return Err("任务已取消".to_string());
        }

        fs::create_dir_all(&output_dir)
            .map_err(|error| format!("无法创建音频输出目录: {error}"))?;
        if let Some(callback) = progress_callback.as_ref() {
            callback(96, "正在保存生成音频".to_string());
        }
        let file_name = format!(
            "{}-{}-sid-{}.wav",
            family.slug(),
            timestamp_millis(),
            request.sid
        );
        let file_path = output_dir.join(&file_name);
        let file_path_string = path_string(&file_path);
        // sherpa-onnx's own audio.save() writes 32-bit float PCM, which some WebKit builds
        // fail to decode for the in-app Mel spectrogram/waveform preview. Re-encode through
        // the shared 16-bit int WAV writer instead, for both the saved file and the data URL.
        let bytes = encode_wav_bytes(&audio)?;
        fs::write(&file_path, &bytes)
            .map_err(|error| format!("生成成功，但 WAV 文件写入失败: {error}"))?;
        let inference_seconds = started.elapsed().as_secs_f32();
        let duration = audio.duration();
        let real_time_factor = if duration > 0.0 {
            inference_seconds / duration
        } else {
            0.0
        };
        emit_progress(&progress_app, "complete", 100);

        Ok(TtsGenerateResult {
            file_name,
            file_path: file_path_string,
            data_url: format!("data:audio/wav;base64,{}", STANDARD.encode(&bytes)),
            duration,
            sample_rate: audio.sample_rate as i32,
            channels: 1,
            size_bytes: bytes.len() as u64,
            waveform: waveform_envelope(&audio.samples, 240),
            inference_seconds,
            real_time_factor,
            sid: request.sid,
            engine: format!("sherpa-onnx · {}", family.label()),
        })
    })
    .await
    .map_err(|error| format!("TTS 推理任务异常结束: {error}"))?
}

fn is_canceled(cancel: Option<&AtomicBool>) -> bool {
    cancel
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn validate_request(request: &TtsGenerateRequest) -> Result<(), String> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err("请输入要生成的文字".to_string());
    }
    if text.chars().count() > 1_200 {
        return Err("单次生成最多支持 1,200 个字符".to_string());
    }
    if !(0..1024).contains(&request.sid) {
        return Err("音色编号必须在 0 到 1023 之间".to_string());
    }
    if !(0.5..=2.0).contains(&request.speed) {
        return Err("语速必须在 0.5 到 2.0 之间".to_string());
    }
    if let Some(silence_scale) = request.silence_scale {
        if !(0.0..=2.0).contains(&silence_scale) {
            return Err("停顿比例必须在 0 到 2.0 之间".to_string());
        }
    }
    Ok(())
}

fn validate_family_request(family: TtsFamily, request: &TtsGenerateRequest) -> Result<(), String> {
    if matches!(family, TtsFamily::ZipVoice | TtsFamily::Pocket)
        && request.reference_audio_data_url.is_none()
    {
        return Err(format!("{} 需要一段参考音频", family.label()));
    }
    if family == TtsFamily::ZipVoice
        && request
            .reference_text
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    {
        return Err("ZipVoice 需要与参考音频完全对应的参考文本".to_string());
    }
    if let Some(num_steps) = request.num_steps {
        if !(1..=100).contains(&num_steps) {
            return Err("生成步数必须在 1 到 100 之间".to_string());
        }
    }
    Ok(())
}

fn model_directory(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("QWEN_AUDIO_KOKORO_MODEL_DIR") {
        return Ok(PathBuf::from(path));
    }

    app.path()
        .app_data_dir()
        .map(|path| path.join("models").join(MODEL_DIRECTORY))
        .map_err(|error| format!("无法定位模型目录: {error}"))
}

fn model_is_installed(model_dir: &Path) -> bool {
    detect_tts_family(model_dir).is_ok()
}

fn find_first_file(model_dir: &Path, candidates: &[&str]) -> Result<PathBuf, String> {
    candidates
        .iter()
        .map(|name| model_dir.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| format!("缺少模型文件：{}", candidates.join(" / ")))
}

fn detect_tts_family(model_dir: &Path) -> Result<TtsFamily, String> {
    let has = |path: &str| model_dir.join(path).is_file();
    let has_dir = |path: &str| model_dir.join(path).is_dir();

    if (has("encoder.int8.onnx") || has("encoder.onnx"))
        && (has("decoder.int8.onnx") || has("decoder.onnx"))
        && has("vocos_24khz.onnx")
        && has("tokens.txt")
        && has("lexicon.txt")
        && has_dir("espeak-ng-data")
    {
        return Ok(TtsFamily::ZipVoice);
    }
    if has("lm_flow.int8.onnx")
        && has("lm_main.int8.onnx")
        && has("encoder.onnx")
        && has("decoder.int8.onnx")
        && has("text_conditioner.onnx")
        && has("vocab.json")
        && has("token_scores.json")
    {
        return Ok(TtsFamily::Pocket);
    }
    if has("duration_predictor.int8.onnx")
        && has("text_encoder.int8.onnx")
        && has("vector_estimator.int8.onnx")
        && has("vocoder.int8.onnx")
        && has("tts.json")
        && has("unicode_indexer.bin")
        && has("voice.bin")
    {
        return Ok(TtsFamily::Supertonic);
    }
    if (has("model-steps-3.onnx") || has("model-steps-2.onnx"))
        && (has("vocos-16khz-univ.onnx") || has("vocos-22khz-univ.onnx") || has("vocos_24khz.onnx"))
        && has("tokens.txt")
    {
        return Ok(TtsFamily::Matcha);
    }
    if has("voices.bin")
        && has("tokens.txt")
        && has_dir("espeak-ng-data")
        && (has("model.fp16.onnx")
            || has("model.fp32.onnx")
            || (has("model.int8.onnx") && !has("lexicon-zh.txt") && !has("lexicon-us-en.txt")))
    {
        return Ok(TtsFamily::Kitten);
    }
    if has("voices.bin")
        && has("tokens.txt")
        && has_dir("espeak-ng-data")
        && (has("model.int8.onnx") || has("model.onnx"))
    {
        return Ok(TtsFamily::Kokoro);
    }
    if has("model.onnx") && has("tokens.txt") {
        return Ok(TtsFamily::Vits);
    }
    Err("无法识别 sherpa-onnx TTS 模型家族，模型文件可能不完整".to_string())
}

fn existing_path(path: PathBuf) -> Option<String> {
    path.exists().then(|| path_string(&path))
}

fn rule_fsts(model_dir: &Path) -> Option<String> {
    let paths = ["date-zh.fst", "phone-zh.fst", "number-zh.fst"]
        .iter()
        .map(|name| model_dir.join(name))
        .filter(|path| path.is_file())
        .map(|path| path_string(&path))
        .collect::<Vec<_>>()
        .join(",");
    (!paths.is_empty()).then_some(paths)
}

fn inference_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|threads| threads.get().clamp(2, 4) as i32)
        .unwrap_or(2)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn waveform_envelope(samples: &[f32], points: usize) -> Vec<f32> {
    if samples.is_empty() || points == 0 {
        return Vec::new();
    }

    let chunk_size = samples.len().div_ceil(points);
    let mut envelope = samples
        .chunks(chunk_size)
        .take(points)
        .map(|chunk| {
            let energy = chunk
                .iter()
                .filter(|sample| sample.is_finite())
                .map(|sample| sample * sample)
                .sum::<f32>()
                / chunk.len() as f32;
            energy.sqrt()
        })
        .collect::<Vec<_>>();
    let peak = envelope.iter().copied().fold(0.0_f32, f32::max);
    if peak > 0.0 {
        for sample in &mut envelope {
            *sample = if sample.is_finite() {
                (*sample / peak).clamp(0.025, 1.0)
            } else {
                0.025
            };
        }
    }
    envelope
}

fn emit_progress(app: &AppHandle, stage: &'static str, progress: u8) {
    let _ = app.emit("tts-generation-progress", TtsProgress { stage, progress });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires QWEN_AUDIO_KOKORO_MODEL_DIR and the local Kokoro model"]
    fn generates_chinese_wav() {
        let model_dir = env::var("QWEN_AUDIO_KOKORO_MODEL_DIR")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_KOKORO_MODEL_DIR is required");
        let output = env::var("QWEN_AUDIO_KOKORO_SMOKE_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::temp_dir().join("qwenaudio-toolkits-kokoro-smoke.wav"));
        let runtime = TtsRuntime::default();
        let (engine, _) = runtime.engine(&model_dir).expect("load Kokoro");
        let started = Instant::now();
        let audio = engine
            .generate_with_config(
                "声音从文字开始，也应该在本地安全地变成可以编辑的音频。",
                &GenerationConfig {
                    sid: 3,
                    speed: 0.96,
                    silence_scale: 0.2,
                    ..Default::default()
                },
                None::<fn(&[f32], f32) -> bool>,
            )
            .expect("generate speech");
        let inference_seconds = started.elapsed().as_secs_f32();
        let duration = audio.samples().len() as f32 / audio.sample_rate() as f32;

        assert_eq!(audio.sample_rate(), 24_000);
        assert!(duration > 1.0);
        assert!(audio.save(&path_string(&output)));
        println!(
            "saved={} inference={:.3}s duration={:.3}s rtf={:.3}",
            output.display(),
            inference_seconds,
            duration,
            inference_seconds / duration
        );
    }
}
