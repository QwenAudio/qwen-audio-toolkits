use crate::audio_io::{
    decode_wav_bytes, decode_wav_data_url, encode_wav_bytes, interleave_channels, peak_dbfs,
    resample_audio, rms_dbfs, wav_data_url, waveform_envelope, PcmAudio,
};
use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::{Array2, ArrayView2};
use nnnoiseless::DenoiseState;
use serde::{Deserialize, Serialize};
use sherpa_onnx::{
    OfflineSpeechDenoiser, OfflineSpeechDenoiserConfig, OfflineSpeechDenoiserDpdfNetModelConfig,
    OfflineSpeechDenoiserGtcrnModelConfig, OfflineSpeechDenoiserModelConfig, SileroVadModelConfig,
    VadModelConfig, VoiceActivityDetector,
};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const DENOISER_MODEL_ID: &str = "dpdfnet2-48khz-hr";
const DENOISER_MODEL_NAME: &str = "DPDFNet2 48 kHz HR";
const DENOISER_MODEL_FILE: &str = "dpdfnet2_48khz_hr.onnx";
const VAD_SAMPLE_RATE: u32 = 16_000;
const VAD_WINDOW_SIZE: usize = 512;
pub(crate) const RNNOISE_SAMPLE_RATE: u32 = 48_000;
pub(crate) type AudioProgressCallback = Arc<dyn Fn(u8, String) + Send + Sync>;

pub(crate) struct StreamingRnnoise {
    state: Box<DenoiseState<'static>>,
    pending: Vec<f32>,
    delayed_dry: Option<Vec<f32>>,
    strength: f32,
}

pub(crate) struct StreamingDeepFilter {
    processor: DfTract,
    pending: Vec<f32>,
}

pub(crate) enum StreamingEnhancer {
    Rnnoise(StreamingRnnoise),
    DeepFilter(Box<StreamingDeepFilter>),
}

impl StreamingEnhancer {
    pub(crate) fn create(
        adapter: &str,
        model_path: Option<&Path>,
        strength: f32,
    ) -> Result<Self, String> {
        match adapter {
            "rnnoise" => Ok(Self::Rnnoise(StreamingRnnoise::new(strength))),
            "deepfilternet" => {
                let model_path =
                    model_path.ok_or_else(|| "DeepFilterNet 缺少模型目录".to_string())?;
                Ok(Self::DeepFilter(Box::new(StreamingDeepFilter::new(
                    model_path, strength,
                )?)))
            }
            _ => Err(format!("{adapter} 尚未接入帧级实时 runtime")),
        }
    }

    pub(crate) fn accept_pcm16(&mut self, bytes: &[u8]) -> Result<Vec<u8>, String> {
        match self {
            Self::Rnnoise(runtime) => Ok(runtime.accept_pcm16(bytes)),
            Self::DeepFilter(runtime) => runtime.accept_pcm16(bytes),
        }
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<u8>, String> {
        match self {
            Self::Rnnoise(runtime) => Ok(runtime.finish()),
            Self::DeepFilter(runtime) => runtime.finish(),
        }
    }
}

impl StreamingRnnoise {
    pub(crate) fn new(strength: f32) -> Self {
        Self {
            state: DenoiseState::new(),
            pending: Vec::new(),
            delayed_dry: None,
            strength: strength.clamp(0.0, 1.0),
        }
    }

    pub(crate) fn accept_pcm16(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.pending.extend(
            bytes
                .chunks_exact(2)
                .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32),
        );
        let complete = self.pending.len() / DenoiseState::FRAME_SIZE * DenoiseState::FRAME_SIZE;
        let frames = self.pending[..complete].to_vec();
        self.pending.drain(..complete);
        self.process_frames(&frames)
    }

    pub(crate) fn finish(&mut self) -> Vec<u8> {
        if !self.pending.is_empty() {
            self.pending.resize(DenoiseState::FRAME_SIZE, 0.0);
            let pending = std::mem::take(&mut self.pending);
            let mut output = self.process_frames(&pending);
            output.extend(self.flush_delayed());
            output
        } else {
            self.flush_delayed()
        }
    }

    fn process_frames(&mut self, samples: &[f32]) -> Vec<u8> {
        let mut encoded = Vec::new();
        for frame in samples.chunks_exact(DenoiseState::FRAME_SIZE) {
            let input = frame
                .iter()
                .map(|sample| sample * i16::MAX as f32)
                .collect::<Vec<_>>();
            let mut wet = vec![0.0; DenoiseState::FRAME_SIZE];
            self.state.process_frame(&mut wet, &input);
            if let Some(dry) = self.delayed_dry.replace(frame.to_vec()) {
                append_pcm16_mix(&mut encoded, &dry, &wet, self.strength);
            }
        }
        encoded
    }

    fn flush_delayed(&mut self) -> Vec<u8> {
        let Some(dry) = self.delayed_dry.take() else {
            return Vec::new();
        };
        let input = vec![0.0; DenoiseState::FRAME_SIZE];
        let mut wet = vec![0.0; DenoiseState::FRAME_SIZE];
        self.state.process_frame(&mut wet, &input);
        let mut encoded = Vec::with_capacity(DenoiseState::FRAME_SIZE * 2);
        append_pcm16_mix(&mut encoded, &dry, &wet, self.strength);
        encoded
    }
}

impl StreamingDeepFilter {
    fn new(model_path: &Path, strength: f32) -> Result<Self, String> {
        let model_path = resolve_deepfilter_model(model_path)?;
        let params = DfParams::new(model_path)
            .map_err(|error| format!("无法读取 DeepFilterNet 实时模型: {error}"))?;
        let runtime_params =
            RuntimeParams::default_with_ch(1).with_atten_lim(strength.clamp(0.0, 1.0) * 100.0);
        let processor = DfTract::new(params, &runtime_params)
            .map_err(|error| format!("无法加载 DeepFilterNet 实时 runtime: {error}"))?;
        if processor.sr != RNNOISE_SAMPLE_RATE as usize {
            return Err(format!(
                "DeepFilterNet 实时模型采样率为 {} Hz，当前只支持 48 kHz",
                processor.sr
            ));
        }
        Ok(Self {
            processor,
            pending: Vec::new(),
        })
    }

    fn accept_pcm16(&mut self, bytes: &[u8]) -> Result<Vec<u8>, String> {
        self.pending.extend(
            bytes
                .chunks_exact(2)
                .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32),
        );
        let frame_size = self.processor.hop_size;
        let complete = self.pending.len() / frame_size * frame_size;
        let frames = self.pending[..complete].to_vec();
        self.pending.drain(..complete);
        self.process_frames(&frames)
    }

    fn finish(&mut self) -> Result<Vec<u8>, String> {
        let frame_size = self.processor.hop_size;
        let mut output = Vec::new();
        if !self.pending.is_empty() {
            self.pending.resize(frame_size, 0.0);
            let pending = std::mem::take(&mut self.pending);
            output.extend(self.process_frames(&pending)?);
        }
        let flush_frames = self.processor.lookahead + self.processor.df_order;
        output.extend(self.process_frames(&vec![0.0; flush_frames * frame_size])?);
        Ok(output)
    }

    fn process_frames(&mut self, samples: &[f32]) -> Result<Vec<u8>, String> {
        let frame_size = self.processor.hop_size;
        let mut encoded = Vec::with_capacity(samples.len() * 2);
        for frame in samples.chunks_exact(frame_size) {
            let input = ArrayView2::from_shape((1, frame_size), frame)
                .map_err(|error| format!("DeepFilterNet 输入帧无效: {error}"))?;
            let mut output = Array2::<f32>::zeros((1, frame_size));
            self.processor
                .process(input, output.view_mut())
                .map_err(|error| format!("DeepFilterNet 实时推理失败: {error}"))?;
            for sample in output.iter() {
                encoded.extend_from_slice(
                    &((sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16).to_le_bytes(),
                );
            }
        }
        Ok(encoded)
    }
}

fn append_pcm16_mix(target: &mut Vec<u8>, dry: &[f32], wet: &[f32], strength: f32) {
    for (dry, wet) in dry.iter().zip(wet) {
        let wet = wet / i16::MAX as f32;
        let sample = dry * (1.0 - strength) + wet * strength;
        target.extend_from_slice(
            &((sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16).to_le_bytes(),
        );
    }
}

#[derive(Default)]
pub struct AudioProcessingRuntime {
    denoiser: Mutex<Option<LoadedDenoiser>>,
}

struct LoadedDenoiser {
    model_path: PathBuf,
    denoiser: Arc<OfflineSpeechDenoiser>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessingProgress {
    operation: String,
    stage: &'static str,
    progress: u8,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessorStatus {
    id: &'static str,
    name: &'static str,
    installed: bool,
    loaded: bool,
    path: String,
    sample_rate: i32,
    vad_installed: bool,
    runtime: &'static str,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessRequest {
    audio_data_url: String,
    clip_name: String,
    operations: Vec<String>,
    selection_start: Option<f32>,
    selection_end: Option<f32>,
    denoise_strength: Option<f32>,
    target_loudness_db: Option<f32>,
    silence_padding_ms: Option<u32>,
    fade_ms: Option<u32>,
}

impl AudioProcessRequest {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        audio_data_url: String,
        clip_name: String,
        operations: Vec<String>,
        selection_start: Option<f32>,
        selection_end: Option<f32>,
        denoise_strength: Option<f32>,
        target_loudness_db: Option<f32>,
        silence_padding_ms: Option<u32>,
        fade_ms: Option<u32>,
    ) -> Self {
        Self {
            audio_data_url,
            clip_name,
            operations,
            selection_start,
            selection_end,
            denoise_strength,
            target_loudness_db,
            silence_padding_ms,
            fade_ms,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessResult {
    file_name: String,
    file_path: String,
    data_url: String,
    duration: f32,
    input_duration: f32,
    sample_rate: u32,
    channels: u16,
    size_bytes: u64,
    waveform: Vec<f32>,
    inference_seconds: f32,
    operation: String,
    engine: String,
    detail: String,
    peak_before_db: f32,
    peak_after_db: f32,
    loudness_before_db: f32,
    loudness_after_db: f32,
    removed_seconds: f32,
}

impl AudioProcessingRuntime {
    fn loaded(&self) -> bool {
        self.denoiser
            .lock()
            .map(|denoiser| denoiser.is_some())
            .unwrap_or(false)
    }

    fn denoiser(&self, model_path: &Path) -> Result<Arc<OfflineSpeechDenoiser>, String> {
        let model_path = resolve_denoiser_model(model_path)?;
        let mut denoiser = self
            .denoiser
            .lock()
            .map_err(|_| "降噪运行时状态不可用".to_string())?;
        if let Some(loaded) = denoiser.as_ref() {
            if loaded.model_path == model_path {
                return Ok(loaded.denoiser.clone());
            }
        }

        let gtcrn = model_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains("gtcrn"));
        let config = OfflineSpeechDenoiserConfig {
            model: OfflineSpeechDenoiserModelConfig {
                gtcrn: OfflineSpeechDenoiserGtcrnModelConfig {
                    model: gtcrn.then(|| path_string(&model_path)),
                },
                dpdfnet: OfflineSpeechDenoiserDpdfNetModelConfig {
                    model: (!gtcrn).then(|| path_string(&model_path)),
                },
                num_threads: inference_threads(),
                provider: Some("cpu".to_string()),
                ..Default::default()
            },
        };
        let loaded = OfflineSpeechDenoiser::create(&config)
            .ok_or_else(|| "无法加载 DPDFNet2，请检查模型文件是否完整".to_string())?;
        let loaded = Arc::new(loaded);
        *denoiser = Some(LoadedDenoiser {
            model_path,
            denoiser: loaded.clone(),
        });
        Ok(loaded)
    }
}

#[tauri::command]
pub fn audio_processor_status(
    app: AppHandle,
    runtime: State<'_, Arc<AudioProcessingRuntime>>,
) -> Result<AudioProcessorStatus, String> {
    let model_path = denoiser_model_path(&app)?;
    let vad_path = vad_model_path(&app)?;
    Ok(AudioProcessorStatus {
        id: DENOISER_MODEL_ID,
        name: DENOISER_MODEL_NAME,
        installed: model_path.is_file(),
        loaded: runtime.loaded(),
        path: path_string(&model_path),
        sample_rate: 48_000,
        vad_installed: vad_path.is_file(),
        runtime: "sherpa-onnx 1.13.4",
    })
}

#[tauri::command]
pub async fn process_audio(
    app: AppHandle,
    runtime: State<'_, Arc<AudioProcessingRuntime>>,
    request: AudioProcessRequest,
) -> Result<AudioProcessResult, String> {
    process_audio_with_runtime(
        app,
        runtime.inner().clone(),
        request,
        None,
        None,
        None,
        None,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn process_audio_with_runtime(
    app: AppHandle,
    runtime: Arc<AudioProcessingRuntime>,
    request: AudioProcessRequest,
    cancel: Option<Arc<AtomicBool>>,
    model_path_override: Option<PathBuf>,
    vad_path_override: Option<PathBuf>,
    denoiser_adapter: Option<String>,
    progress_callback: Option<AudioProgressCallback>,
) -> Result<AudioProcessResult, String> {
    validate_request(&request)?;
    if is_canceled(cancel.as_deref()) {
        return Err("任务已取消".to_string());
    }

    let model_path = model_path_override.unwrap_or(denoiser_model_path(&app)?);
    let vad_path = vad_path_override.unwrap_or(vad_model_path(&app)?);
    let denoiser_ready = match denoiser_adapter.as_deref() {
        Some("rnnoise") => true,
        Some("deepfilternet") => {
            resolve_deepfilter_model(&model_path).is_ok()
                && resolve_deepfilter_runtime(&model_path).is_ok()
        }
        _ => resolve_denoiser_model(&model_path).is_ok(),
    };
    if request.operations.iter().any(|item| item == "denoise") && !denoiser_ready {
        return Err(format!(
            "降噪模型尚未安装，请将模型安装到 {}",
            path_string(&model_path)
        ));
    }
    if request.operations.iter().any(|item| item == "silence") && !vad_path.is_file() {
        return Err(format!(
            "Silero VAD 尚未安装，请将模型安装到 {}",
            path_string(&vad_path)
        ));
    }

    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("processed");
    let progress_app = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if is_canceled(cancel.as_deref()) {
            return Err("任务已取消".to_string());
        }
        let report = |stage: &'static str, progress: u8, detail: &str| {
            emit_progress(&progress_app, &request.operations, stage, progress, detail);
            if let Some(callback) = progress_callback.as_ref() {
                callback(progress, detail.to_string());
            }
        };
        report("preparing", 3, "正在读取全质量 WAV");
        let mut audio = decode_wav_data_url(&request.audio_data_url)?;
        if audio.frame_count() == 0 || audio.duration() < 0.05 {
            return Err("音频内容为空，无法处理".to_string());
        }

        let input_duration = audio.duration();
        let peak_before_db = peak_dbfs(&audio.samples);
        let loudness_before_db = speech_loudness_db(&audio);
        let started = Instant::now();
        let mut details = Vec::new();
        let total = request.operations.len().max(1);

        for (index, operation) in request.operations.iter().enumerate() {
            if is_canceled(cancel.as_deref()) {
                return Err("任务已取消".to_string());
            }
            let progress = 8 + ((index as f32 / total as f32) * 78.0).round() as u8;
            match operation.as_str() {
                "trim" => {
                    report("trimming", progress, "正在裁剪选区");
                    let start = request.selection_start.unwrap_or(0.0);
                    let end = request.selection_end.unwrap_or(audio.duration());
                    audio = trim_audio(&audio, start, end)?;
                    details.push(format!("{start:.1}s - {end:.1}s"));
                }
                "denoise" => {
                    let engine = match denoiser_adapter.as_deref() {
                        Some("deepfilternet") => "DeepFilterNet3",
                        Some("rnnoise") => "RNNoise",
                        _ => "DPDFNet2",
                    };
                    report(
                        "denoising",
                        progress,
                        &format!("{engine} 正在分离语音与噪声"),
                    );
                    let strength = request.denoise_strength.unwrap_or(0.72).clamp(0.05, 1.0);
                    audio = match denoiser_adapter.as_deref() {
                        Some("deepfilternet") => denoise_deepfilter(&audio, &model_path, strength)?,
                        Some("rnnoise") => denoise_rnnoise(&audio, strength)?,
                        _ => {
                            let denoiser = runtime.denoiser(&model_path)?;
                            denoise_audio(&audio, &denoiser, strength)?
                        }
                    };
                    details.push(engine.to_string());
                    details.push(format!("降噪 {}%", (strength * 100.0).round()));
                }
                "silence" => {
                    report("vad", progress, "Silero VAD 正在定位停顿");
                    let before = audio.duration();
                    audio = compact_silence(
                        &audio,
                        &vad_path,
                        request.silence_padding_ms.unwrap_or(120),
                    )?;
                    details.push(format!(
                        "压缩静音 {:.1}s",
                        (before - audio.duration()).max(0.0)
                    ));
                }
                "normalize" => {
                    report("normalizing", progress, "正在分析语音响度与峰值");
                    let target = request
                        .target_loudness_db
                        .unwrap_or(-16.0)
                        .clamp(-24.0, -12.0);
                    let gain = normalize_speech_loudness(&mut audio, target);
                    details.push(format!("响度增益 {gain:+.1} dB"));
                }
                "fade" => {
                    report("fading", progress, "正在平滑片段边缘");
                    let milliseconds = request.fade_ms.unwrap_or(20).clamp(2, 200);
                    apply_edge_fades(&mut audio, milliseconds);
                    details.push(format!("边缘淡化 {milliseconds} ms"));
                }
                _ => unreachable!("validated operation"),
            }
        }

        report("encoding", 90, "正在创建新的 WAV Take");
        if is_canceled(cancel.as_deref()) {
            return Err("任务已取消".to_string());
        }
        fs::create_dir_all(&output_dir)
            .map_err(|error| format!("无法创建处理结果目录: {error}"))?;
        let operation_slug = request.operations.join("-");
        let stem = safe_file_stem(&request.clip_name);
        let file_name = format!("{stem}-{operation_slug}-{}.wav", timestamp_millis());
        let file_path = output_dir.join(&file_name);
        let bytes = encode_wav_bytes(&audio)?;
        fs::write(&file_path, &bytes).map_err(|error| format!("无法保存处理后的 WAV: {error}"))?;

        let duration = audio.duration();
        let inference_seconds = started.elapsed().as_secs_f32();
        let result = AudioProcessResult {
            file_name,
            file_path: path_string(&file_path),
            data_url: wav_data_url(&bytes),
            duration,
            input_duration,
            sample_rate: audio.sample_rate,
            channels: audio.channels,
            size_bytes: bytes.len() as u64,
            waveform: waveform_envelope(&audio, 320),
            inference_seconds,
            operation: operation_label(&request.operations),
            engine: match denoiser_adapter.as_deref() {
                Some("deepfilternet") => "DeepFilterNet3 · Local".to_string(),
                Some("rnnoise") => "RNNoise · Local Rust".to_string(),
                Some("gtcrn") => "GTCRN · sherpa-onnx".to_string(),
                Some("dpdfnet2") => "DPDFNet2 48 kHz · sherpa-onnx".to_string(),
                _ => engine_label(&request.operations),
            },
            detail: details.join(" · "),
            peak_before_db,
            peak_after_db: peak_dbfs(&audio.samples),
            loudness_before_db,
            loudness_after_db: speech_loudness_db(&audio),
            removed_seconds: (input_duration - duration).max(0.0),
        };
        report("complete", 100, "新的 Take 已创建");
        Ok(result)
    })
    .await
    .map_err(|error| format!("音频处理任务异常结束: {error}"))?
}

fn resolve_denoiser_model(path: &Path) -> Result<PathBuf, String> {
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    for name in [
        "gtcrn_simple.onnx",
        "dpdfnet2_48khz_hr.onnx",
        "dpdfnet2.onnx",
    ] {
        let candidate = path.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "降噪模型目录中没有可用的 ONNX 文件: {}",
        path.display()
    ))
}

pub(crate) fn resolve_deepfilter_model(path: &Path) -> Result<PathBuf, String> {
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    for name in [
        "DeepFilterNet3_onnx.tar.gz",
        "DeepFilterNet3_ll_onnx.tar.gz",
    ] {
        let candidate = path.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "DeepFilterNet 模型目录中没有可用权重: {}",
        path.display()
    ))
}

fn resolve_deepfilter_runtime(path: &Path) -> Result<PathBuf, String> {
    let directory = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };
    let runtime_directory = crate::plugins::runtime_directory_for_model(directory);
    for name in ["deep-filter", "deep-filter.exe"] {
        for candidate in [runtime_directory.join(name), directory.join(name)] {
            if candidate.is_file() {
                crate::plugins::ensure_executable_permission(&candidate, "DeepFilterNet")?;
                return Ok(candidate);
            }
        }
    }
    Err(format!(
        "DeepFilterNet 模型目录中没有当前平台运行时: {}",
        directory.display()
    ))
}

fn is_canceled(cancel: Option<&AtomicBool>) -> bool {
    cancel
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn validate_request(request: &AudioProcessRequest) -> Result<(), String> {
    if request.operations.is_empty() {
        return Err("请至少选择一个处理器".to_string());
    }
    for operation in &request.operations {
        if !matches!(
            operation.as_str(),
            "trim" | "denoise" | "silence" | "normalize" | "fade"
        ) {
            return Err(format!("不支持的音频处理器: {operation}"));
        }
    }
    if request.operations.iter().any(|item| item == "trim") {
        let start = request
            .selection_start
            .ok_or_else(|| "裁剪缺少选区起点".to_string())?;
        let end = request
            .selection_end
            .ok_or_else(|| "裁剪缺少选区终点".to_string())?;
        if !start.is_finite() || !end.is_finite() || end - start < 0.05 {
            return Err("选区至少需要 50 毫秒".to_string());
        }
    }
    Ok(())
}

fn denoise_deepfilter(
    source: &PcmAudio,
    model_path: &Path,
    strength: f32,
) -> Result<PcmAudio, String> {
    let model_path = resolve_deepfilter_model(model_path)?;
    let runtime = resolve_deepfilter_runtime(&model_path)?;
    let temporary = env::temp_dir().join(format!(
        "qwenaudio-deepfilter-{}-{}",
        std::process::id(),
        timestamp_millis()
    ));
    let output_dir = temporary.join("output");
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("无法创建 DeepFilterNet 临时目录: {error}"))?;
    let input_path = temporary.join("input.wav");
    fs::write(&input_path, encode_wav_bytes(source)?)
        .map_err(|error| format!("无法写入 DeepFilterNet 输入: {error}"))?;

    let result = Command::new(&runtime)
        .arg("--model")
        .arg(&model_path)
        .arg("--output-dir")
        .arg(&output_dir)
        .arg("--compensate-delay")
        .arg("--atten-lim-db")
        .arg(format!("{:.1}", strength * 100.0))
        .arg(&input_path)
        .output()
        .map_err(|error| format!("无法启动 DeepFilterNet3: {error}"))
        .and_then(|output| {
            if !output.status.success() {
                let detail = String::from_utf8_lossy(&output.stderr);
                return Err(format!(
                    "DeepFilterNet3 推理失败: {}",
                    detail.trim().lines().last().unwrap_or("未知错误")
                ));
            }
            let output_path = output_dir.join("input.wav");
            let bytes = fs::read(&output_path)
                .map_err(|error| format!("无法读取 DeepFilterNet3 输出: {error}"))?;
            decode_wav_bytes(&bytes)
        });
    let _ = fs::remove_dir_all(&temporary);
    result
}

fn denoise_rnnoise(source: &PcmAudio, strength: f32) -> Result<PcmAudio, String> {
    let working = resample_audio(source, RNNOISE_SAMPLE_RATE)?;
    let channels = working.channels.max(1) as usize;
    let mut enhanced_channels = Vec::with_capacity(channels);

    for channel in 0..channels {
        let dry = working.channel_samples(channel);
        let padded_frames = dry.len().div_ceil(DenoiseState::FRAME_SIZE);
        let mut state = DenoiseState::new();
        let mut wet = Vec::with_capacity(padded_frames * DenoiseState::FRAME_SIZE);
        let mut output = vec![0.0; DenoiseState::FRAME_SIZE];
        let mut input = vec![0.0; DenoiseState::FRAME_SIZE];
        let mut first = true;
        for frame in 0..padded_frames {
            input.fill(0.0);
            let start = frame * DenoiseState::FRAME_SIZE;
            let end = (start + DenoiseState::FRAME_SIZE).min(dry.len());
            for (target, sample) in input.iter_mut().zip(&dry[start..end]) {
                *target = *sample * i16::MAX as f32;
            }
            state.process_frame(&mut output, &input);
            if !first {
                wet.extend(output.iter().map(|sample| sample / i16::MAX as f32));
            }
            first = false;
        }
        input.fill(0.0);
        state.process_frame(&mut output, &input);
        wet.extend(output.iter().map(|sample| sample / i16::MAX as f32));
        wet.truncate(dry.len());
        enhanced_channels.push(
            dry.iter()
                .zip(wet)
                .map(|(dry, wet)| dry * (1.0 - strength) + wet * strength)
                .collect(),
        );
    }

    let enhanced = interleave_channels(enhanced_channels, RNNOISE_SAMPLE_RATE);
    resample_audio(&enhanced, source.sample_rate)
}

fn denoise_audio(
    source: &PcmAudio,
    denoiser: &OfflineSpeechDenoiser,
    strength: f32,
) -> Result<PcmAudio, String> {
    let model_rate = denoiser.sample_rate();
    if model_rate <= 0 {
        return Err("DPDFNet2 返回了无效采样率".to_string());
    }
    let working = resample_audio(source, model_rate as u32)?;
    let channels = working.channels.max(1) as usize;
    let mut enhanced_channels = Vec::with_capacity(channels);

    for channel in 0..channels {
        let dry = working.channel_samples(channel);
        let enhanced = denoiser.run(&dry, model_rate);
        if enhanced.samples.is_empty() {
            return Err("DPDFNet2 没有返回增强音频".to_string());
        }
        let frame_count = dry.len().min(enhanced.samples.len());
        let mixed = dry
            .iter()
            .zip(enhanced.samples.iter())
            .take(frame_count)
            .map(|(dry, wet)| dry * (1.0 - strength) + wet * strength)
            .collect::<Vec<_>>();
        enhanced_channels.push(mixed);
    }

    Ok(interleave_channels(enhanced_channels, model_rate as u32))
}

fn trim_audio(source: &PcmAudio, start_seconds: f32, end_seconds: f32) -> Result<PcmAudio, String> {
    let duration = source.duration();
    let start = start_seconds.clamp(0.0, duration);
    let end = end_seconds.clamp(0.0, duration);
    if end - start < 0.05 {
        return Err("选区超出片段范围或过短".to_string());
    }

    let channels = source.channels.max(1) as usize;
    let start_frame = (start * source.sample_rate as f32).floor() as usize;
    let end_frame = ((end * source.sample_rate as f32).ceil() as usize).min(source.frame_count());
    let mut result = PcmAudio {
        samples: source.samples[start_frame * channels..end_frame * channels].to_vec(),
        sample_rate: source.sample_rate,
        channels: source.channels,
    };
    apply_edge_fades(&mut result, 5);
    Ok(result)
}

fn compact_silence(
    source: &PcmAudio,
    vad_model: &Path,
    padding_ms: u32,
) -> Result<PcmAudio, String> {
    let analysis = resample_audio(source, VAD_SAMPLE_RATE)?;
    let mono = analysis.mono_samples();
    let ranges = detect_speech_ranges(&mono, vad_model)?;
    if ranges.is_empty() {
        return Err("Silero VAD 没有检测到语音，已保留原片段".to_string());
    }

    let padding = padding_ms.clamp(40, 400) as f32 / 1000.0;
    let duration = source.duration();
    let mut padded = ranges
        .into_iter()
        .map(|(start, end)| ((start - padding).max(0.0), (end + padding).min(duration)))
        .collect::<Vec<_>>();
    padded.sort_by(|left, right| left.0.total_cmp(&right.0));

    let mut merged: Vec<(f32, f32)> = Vec::new();
    for range in padded {
        if let Some(last) = merged.last_mut() {
            if range.0 <= last.1 + 0.02 {
                last.1 = last.1.max(range.1);
                continue;
            }
        }
        merged.push(range);
    }

    let channels = source.channels.max(1) as usize;
    let mut samples = Vec::new();
    for (start, end) in merged {
        let start_frame = (start * source.sample_rate as f32).floor() as usize;
        let end_frame =
            ((end * source.sample_rate as f32).ceil() as usize).min(source.frame_count());
        if end_frame > start_frame {
            let mut segment = PcmAudio {
                samples: source.samples[start_frame * channels..end_frame * channels].to_vec(),
                sample_rate: source.sample_rate,
                channels: source.channels,
            };
            apply_edge_fades(&mut segment, 4);
            samples.extend_from_slice(&segment.samples);
        }
    }

    let result = PcmAudio {
        samples,
        sample_rate: source.sample_rate,
        channels: source.channels,
    };
    Ok(result)
}

fn detect_speech_ranges(samples: &[f32], model_path: &Path) -> Result<Vec<(f32, f32)>, String> {
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(path_string(model_path)),
            threshold: 0.25,
            min_silence_duration: 0.2,
            min_speech_duration: 0.18,
            window_size: VAD_WINDOW_SIZE as i32,
            max_speech_duration: 30.0,
        },
        sample_rate: VAD_SAMPLE_RATE as i32,
        num_threads: 1,
        provider: Some("cpu".to_string()),
        debug: false,
        ..Default::default()
    };
    let vad = VoiceActivityDetector::create(&config, 120.0)
        .ok_or_else(|| "无法加载 Silero VAD".to_string())?;
    let mut ranges = Vec::new();

    for window in samples.chunks(VAD_WINDOW_SIZE) {
        if window.len() == VAD_WINDOW_SIZE {
            vad.accept_waveform(window);
        } else {
            let mut padded = [0.0_f32; VAD_WINDOW_SIZE];
            padded[..window.len()].copy_from_slice(window);
            vad.accept_waveform(&padded);
        }
        drain_vad_ranges(&vad, &mut ranges);
    }
    vad.flush();
    drain_vad_ranges(&vad, &mut ranges);
    Ok(ranges)
}

fn drain_vad_ranges(vad: &VoiceActivityDetector, ranges: &mut Vec<(f32, f32)>) {
    while let Some(segment) = vad.front() {
        let start = segment.start() as f32 / VAD_SAMPLE_RATE as f32;
        let end = start + segment.samples().len() as f32 / VAD_SAMPLE_RATE as f32;
        ranges.push((start, end));
        drop(segment);
        vad.pop();
    }
}

fn normalize_speech_loudness(audio: &mut PcmAudio, target_db: f32) -> f32 {
    let current = speech_loudness_db(audio);
    let peak = peak_dbfs(&audio.samples);
    let desired_gain = (target_db - current).clamp(-24.0, 24.0);
    let peak_limited_gain = (-1.0 - peak).min(desired_gain);
    let gain = 10.0_f32.powf(peak_limited_gain / 20.0);
    for sample in &mut audio.samples {
        *sample = (*sample * gain).clamp(-1.0, 1.0);
    }
    peak_limited_gain
}

fn speech_loudness_db(audio: &PcmAudio) -> f32 {
    let mono = audio.mono_samples();
    if mono.is_empty() {
        return -120.0;
    }
    let block_frames = (audio.sample_rate as f32 * 0.4).round().max(1.0) as usize;
    let hop_frames = (block_frames / 4).max(1);
    let mut energies = Vec::new();
    for start in (0..mono.len()).step_by(hop_frames) {
        let end = (start + block_frames).min(mono.len());
        if end - start < block_frames / 2 {
            break;
        }
        let block = &mono[start..end];
        let db = rms_dbfs(block);
        if db > -50.0 {
            energies
                .push(block.iter().map(|sample| sample * sample).sum::<f32>() / block.len() as f32);
        }
    }
    if energies.is_empty() {
        return rms_dbfs(&mono);
    }
    let mean = energies.iter().sum::<f32>() / energies.len() as f32;
    if mean <= 1e-12 {
        -120.0
    } else {
        10.0 * mean.log10()
    }
}

fn apply_edge_fades(audio: &mut PcmAudio, milliseconds: u32) {
    let channels = audio.channels.max(1) as usize;
    let frame_count = audio.frame_count();
    let fade_frames = ((audio.sample_rate as u64 * milliseconds as u64) / 1000) as usize;
    let fade_frames = fade_frames.min(frame_count / 2);
    if fade_frames == 0 {
        return;
    }

    for frame in 0..fade_frames {
        let fade_in = frame as f32 / fade_frames as f32;
        let fade_out = (fade_frames - frame) as f32 / fade_frames as f32;
        for channel in 0..channels {
            audio.samples[frame * channels + channel] *= fade_in;
            let tail = (frame_count - fade_frames + frame) * channels + channel;
            audio.samples[tail] *= fade_out;
        }
    }
}

fn denoiser_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("QWEN_AUDIO_DENOISE_MODEL") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .app_data_dir()
        .map(|path| path.join("models").join(DENOISER_MODEL_FILE))
        .map_err(|error| format!("无法定位模型目录: {error}"))
}

fn vad_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::vad::ensure_model_install(app)
}

fn operation_label(operations: &[String]) -> String {
    operations
        .iter()
        .map(|operation| match operation.as_str() {
            "trim" => "裁剪",
            "denoise" => "AI 降噪",
            "silence" => "静音压缩",
            "normalize" => "响度标准化",
            "fade" => "边缘淡化",
            _ => operation,
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

fn engine_label(operations: &[String]) -> String {
    let mut engines = Vec::new();
    if operations.iter().any(|item| item == "denoise") {
        engines.push("DPDFNet2 48 kHz");
    }
    if operations.iter().any(|item| item == "silence") {
        engines.push("Silero VAD");
    }
    if operations.iter().any(|item| item == "normalize") {
        engines.push("Speech Level");
    }
    if operations.iter().any(|item| item == "trim") {
        engines.push("PCM");
    }
    if operations.iter().any(|item| item == "fade") {
        engines.push("Click Guard");
    }
    engines.join(" · ")
}

fn safe_file_stem(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("audio");
    let safe = stem
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "audio".to_string()
    } else {
        safe
    }
}

fn inference_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|threads| threads.get().clamp(1, 4) as i32)
        .unwrap_or(1)
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

fn emit_progress(
    app: &AppHandle,
    operations: &[String],
    stage: &'static str,
    progress: u8,
    detail: &str,
) {
    let _ = app.emit(
        "audio-processing-progress",
        AudioProcessingProgress {
            operation: operation_label(operations),
            stage,
            progress,
            detail: detail.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_io::decode_wav_bytes;

    fn test_audio(seconds: f32, amplitude: f32) -> PcmAudio {
        let sample_rate = 48_000;
        let frames = (seconds * sample_rate as f32) as usize;
        PcmAudio {
            samples: (0..frames)
                .map(|frame| {
                    let phase = frame as f32 / sample_rate as f32 * 440.0 * std::f32::consts::TAU;
                    phase.sin() * amplitude
                })
                .collect(),
            sample_rate,
            channels: 1,
        }
    }

    #[test]
    fn trim_uses_requested_range() {
        let audio = test_audio(2.0, 0.2);
        let trimmed = trim_audio(&audio, 0.4, 1.1).expect("trim");
        assert!((trimmed.duration() - 0.7).abs() < 0.001);
    }

    #[test]
    fn normalization_reaches_target_without_clipping() {
        let mut audio = test_audio(1.0, 0.05);
        let gain = normalize_speech_loudness(&mut audio, -16.0);
        assert!(gain > 0.0);
        assert!((speech_loudness_db(&audio) - -16.0).abs() < 0.2);
        assert!(peak_dbfs(&audio.samples) <= -1.0);
    }

    #[test]
    fn rnnoise_stream_preserves_samples_across_chunks() {
        let input = (0..DenoiseState::FRAME_SIZE * 2)
            .flat_map(|index| {
                let sample = ((index as f32 * 0.07).sin() * 4_000.0) as i16;
                sample.to_le_bytes()
            })
            .collect::<Vec<_>>();
        let split = DenoiseState::FRAME_SIZE * 2 + 160;
        let mut runtime = StreamingRnnoise::new(1.0);
        let mut output = runtime.accept_pcm16(&input[..split]);
        output.extend(runtime.accept_pcm16(&input[split..]));
        output.extend(runtime.finish());

        assert_eq!(output.len(), input.len());
    }

    #[test]
    fn rnnoise_stream_bypass_is_sample_aligned() {
        let input = (0..DenoiseState::FRAME_SIZE * 3)
            .flat_map(|index| {
                let sample = ((index as f32 * 0.031).sin() * 12_000.0) as i16;
                sample.to_le_bytes()
            })
            .collect::<Vec<_>>();
        let mut runtime = StreamingRnnoise::new(0.0);
        let mut output = runtime.accept_pcm16(&input[..1_314]);
        output.extend(runtime.accept_pcm16(&input[1_314..]));
        output.extend(runtime.finish());

        assert_eq!(output, input);
    }

    #[test]
    #[ignore = "requires QWEN_AUDIO_DEEPFILTER_MODEL"]
    fn deepfilter_stream_loads_installed_model() {
        let model = env::var("QWEN_AUDIO_DEEPFILTER_MODEL")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_DEEPFILTER_MODEL is required");
        let mut runtime = StreamingDeepFilter::new(&model, 0.8).expect("load DeepFilterNet");
        let input = vec![0_u8; RNNOISE_SAMPLE_RATE as usize / 10 * 2];
        let mut output = runtime.accept_pcm16(&input).expect("process PCM");
        output.extend(runtime.finish().expect("flush DeepFilterNet"));

        assert!(!output.is_empty());
        assert_eq!(output.len() % 2, 0);
    }

    #[test]
    #[ignore = "requires QWEN_AUDIO_DEEPFILTER_MODEL and QWEN_AUDIO_DENOISE_SMOKE_INPUT"]
    fn deepfilter_stream_preserves_audible_signal() {
        let model = env::var("QWEN_AUDIO_DEEPFILTER_MODEL")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_DEEPFILTER_MODEL is required");
        let input = env::var("QWEN_AUDIO_DENOISE_SMOKE_INPUT")
            .expect("QWEN_AUDIO_DENOISE_SMOKE_INPUT is required");
        let audio = decode_wav_bytes(&fs::read(input).expect("read input")).expect("decode input");
        assert_eq!(audio.sample_rate, RNNOISE_SAMPLE_RATE);
        assert_eq!(audio.channels, 1);
        let pcm = audio
            .samples
            .iter()
            .flat_map(|sample| {
                ((*sample).clamp(-1.0, 1.0) * i16::MAX as f32)
                    .round()
                    .to_le_bytes()
            })
            .collect::<Vec<_>>();
        let mut runtime = StreamingDeepFilter::new(&model, 1.0).expect("load DeepFilterNet");
        let mut output = Vec::new();
        for chunk in pcm.chunks(512 * 2) {
            output.extend(runtime.accept_pcm16(chunk).expect("process PCM"));
        }
        output.extend(runtime.finish().expect("flush DeepFilterNet"));
        let input_peak = pcm
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs())
            .max()
            .unwrap_or(0);
        let output_peak = output
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs())
            .max()
            .unwrap_or(0);
        println!("DeepFilter stream peaks: input={input_peak}, output={output_peak}");
        assert!(
            output_peak > 256,
            "DeepFilter stream output is effectively silent"
        );
    }

    #[test]
    #[ignore = "requires QWEN_AUDIO_DENOISE_MODEL and QWEN_AUDIO_DENOISE_SMOKE_INPUT"]
    fn denoises_wav_with_local_model() {
        let model = env::var("QWEN_AUDIO_DENOISE_MODEL")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_DENOISE_MODEL is required");
        let input = env::var("QWEN_AUDIO_DENOISE_SMOKE_INPUT")
            .expect("QWEN_AUDIO_DENOISE_SMOKE_INPUT is required");
        let output = env::var("QWEN_AUDIO_DENOISE_SMOKE_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::temp_dir().join("qwenaudio-toolkits-dpdfnet-smoke.wav"));
        let source = decode_wav_bytes(&fs::read(input).expect("read input")).expect("decode input");
        let runtime = AudioProcessingRuntime::default();
        let denoiser = runtime.denoiser(&model).expect("load DPDFNet2");
        let started = Instant::now();
        let result = denoise_audio(&source, &denoiser, 1.0).expect("denoise");
        fs::write(&output, encode_wav_bytes(&result).expect("encode output"))
            .expect("write output");

        assert_eq!(result.sample_rate, 48_000);
        assert!(result.duration() > 0.5);
        println!(
            "output={} duration={:.2}s elapsed={:.2}s",
            output.display(),
            result.duration(),
            started.elapsed().as_secs_f32()
        );
    }

    #[test]
    #[ignore = "requires QWEN_AUDIO_VAD_MODEL and QWEN_AUDIO_DENOISE_SMOKE_INPUT"]
    fn compacts_silence_with_local_vad() {
        let model = env::var("QWEN_AUDIO_VAD_MODEL")
            .map(PathBuf::from)
            .expect("QWEN_AUDIO_VAD_MODEL is required");
        let input = env::var("QWEN_AUDIO_DENOISE_SMOKE_INPUT")
            .expect("QWEN_AUDIO_DENOISE_SMOKE_INPUT is required");
        let source = decode_wav_bytes(&fs::read(input).expect("read input")).expect("decode input");
        let result = compact_silence(&source, &model, 120).expect("compact silence");

        assert!(result.duration() > 0.5);
        assert!(result.duration() <= source.duration());
        println!(
            "input={:.2}s output={:.2}s removed={:.2}s",
            source.duration(),
            result.duration(),
            source.duration() - result.duration()
        );
    }
}
