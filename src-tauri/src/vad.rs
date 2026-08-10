use crate::audio_io::{decode_wav_data_url, resample_audio, waveform_envelope};
use serde::{Deserialize, Serialize};
use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};
use std::{
    env,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::{AppHandle, Manager};

const MODEL_ID: &str = "silero-vad";
const MODEL_DIRECTORY: &str = "silero-vad";
const MODEL_FILE: &str = "silero_vad.onnx";
const SAMPLE_RATE: u32 = 16_000;
const WINDOW_SIZE: usize = 512;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadModelStatus {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) installed: bool,
    pub(crate) loaded: bool,
    pub(crate) path: String,
    pub(crate) sample_rate: u32,
    pub(crate) runtime: &'static str,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VadDetectRequest {
    audio_data_url: String,
    clip_name: String,
    threshold: Option<f32>,
    min_speech_duration: Option<f32>,
    min_silence_duration: Option<f32>,
}

impl VadDetectRequest {
    pub(crate) fn new(
        audio_data_url: String,
        clip_name: String,
        threshold: Option<f32>,
        min_speech_duration: Option<f32>,
        min_silence_duration: Option<f32>,
    ) -> Self {
        Self {
            audio_data_url,
            clip_name,
            threshold,
            min_speech_duration,
            min_silence_duration,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadSegment {
    id: String,
    start: f32,
    end: f32,
    duration: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadDetectionResult {
    clip_name: String,
    duration: f32,
    speech_seconds: f32,
    silence_seconds: f32,
    segments: Vec<VadSegment>,
    waveform: Vec<f32>,
    inference_seconds: f32,
    real_time_factor: f32,
    threshold: f32,
    engine: &'static str,
}

pub struct StreamingVad {
    detector: VoiceActivityDetector,
    pending: Vec<f32>,
    detected: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingVadUpdate {
    speech_detected: bool,
    speech_started: bool,
    speech_ended: bool,
}

pub(crate) fn create_streaming_vad(
    app: &AppHandle,
    threshold: Option<f32>,
    min_speech_duration: Option<f32>,
    min_silence_duration: Option<f32>,
) -> Result<StreamingVad, String> {
    let model = ensure_model_install(app)?;
    if !model.is_file() {
        return Err("Silero VAD 尚未安装".to_string());
    }
    let config = VadModelConfig {
        silero_vad: SileroVadModelConfig {
            model: Some(path_string(&model)),
            threshold: threshold.unwrap_or(0.25).clamp(0.05, 0.95),
            min_silence_duration: min_silence_duration.unwrap_or(0.55).clamp(0.1, 5.0),
            min_speech_duration: min_speech_duration.unwrap_or(0.18).clamp(0.05, 5.0),
            window_size: WINDOW_SIZE as i32,
            max_speech_duration: 30.0,
        },
        sample_rate: SAMPLE_RATE as i32,
        num_threads: 1,
        provider: Some("cpu".to_string()),
        debug: false,
        ..Default::default()
    };
    let detector = VoiceActivityDetector::create(&config, 120.0)
        .ok_or_else(|| "无法加载 Silero VAD".to_string())?;
    Ok(StreamingVad {
        detector,
        pending: Vec::new(),
        detected: false,
    })
}

impl StreamingVad {
    pub(crate) fn accept_pcm16(&mut self, bytes: &[u8]) -> StreamingVadUpdate {
        self.pending.extend(
            bytes
                .chunks_exact(2)
                .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32),
        );
        let mut speech_started = false;
        let mut speech_ended = false;
        let complete = self.pending.len() / WINDOW_SIZE * WINDOW_SIZE;
        for window in self.pending[..complete].chunks_exact(WINDOW_SIZE) {
            self.detector.accept_waveform(window);
            let detected = self.detector.detected();
            speech_started |= detected && !self.detected;
            speech_ended |= !detected && self.detected;
            self.detected = detected;
            while !self.detector.is_empty() {
                speech_ended = true;
                self.detector.pop();
            }
        }
        self.pending.drain(..complete);
        StreamingVadUpdate {
            speech_detected: self.detected,
            speech_started,
            speech_ended,
        }
    }
}

pub(crate) fn ensure_model_install(app: &AppHandle) -> Result<PathBuf, String> {
    model_path(app)
}

pub(crate) fn model_status(app: &AppHandle) -> Result<VadModelStatus, String> {
    let path = ensure_model_install(app)?;
    Ok(VadModelStatus {
        id: MODEL_ID,
        name: "Silero VAD",
        installed: path.is_file(),
        loaded: false,
        path: path_string(&path),
        sample_rate: SAMPLE_RATE,
        runtime: "sherpa-onnx 1.13.4",
    })
}

pub(crate) async fn detect_speech_with_model(
    app: AppHandle,
    request: VadDetectRequest,
    cancel: Option<Arc<AtomicBool>>,
    model_path_override: Option<PathBuf>,
) -> Result<VadDetectionResult, String> {
    if is_canceled(cancel.as_deref()) {
        return Err("任务已取消".to_string());
    }
    let model = match model_path_override {
        Some(path) => resolve_model_file(path),
        None => ensure_model_install(&app)?,
    };
    if !model.is_file() {
        return Err(format!(
            "Silero VAD 尚未安装，请将模型安装到 {}",
            path_string(&model)
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let decoded = decode_wav_data_url(&request.audio_data_url)?;
        let duration = decoded.duration();
        if duration < 0.05 {
            return Err("音频内容为空，无法检测".to_string());
        }
        let waveform = waveform_envelope(&decoded, 320);
        let resampled = resample_audio(&decoded, SAMPLE_RATE)?;
        let samples = resampled.mono_samples();
        let threshold = request.threshold.unwrap_or(0.25).clamp(0.05, 0.95);
        let min_speech_duration = request.min_speech_duration.unwrap_or(0.18).clamp(0.05, 5.0);
        let min_silence_duration = request.min_silence_duration.unwrap_or(0.2).clamp(0.05, 5.0);
        let config = VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: Some(path_string(&model)),
                threshold,
                min_silence_duration,
                min_speech_duration,
                window_size: WINDOW_SIZE as i32,
                max_speech_duration: 30.0,
            },
            sample_rate: SAMPLE_RATE as i32,
            num_threads: 1,
            provider: Some("cpu".to_string()),
            debug: false,
            ..Default::default()
        };
        let vad = VoiceActivityDetector::create(&config, 120.0)
            .ok_or_else(|| "无法加载 Silero VAD".to_string())?;
        let started = Instant::now();
        let mut segments = Vec::new();

        for window in samples.chunks(WINDOW_SIZE) {
            if is_canceled(cancel.as_deref()) {
                return Err("任务已取消".to_string());
            }
            if window.len() == WINDOW_SIZE {
                vad.accept_waveform(window);
            } else {
                let mut padded = [0.0_f32; WINDOW_SIZE];
                padded[..window.len()].copy_from_slice(window);
                vad.accept_waveform(&padded);
            }
            drain_segments(&vad, &mut segments);
        }
        vad.flush();
        drain_segments(&vad, &mut segments);

        let inference_seconds = started.elapsed().as_secs_f32();
        let speech_seconds = segments.iter().map(|segment| segment.duration).sum::<f32>();
        Ok(VadDetectionResult {
            clip_name: request.clip_name,
            duration,
            speech_seconds,
            silence_seconds: (duration - speech_seconds).max(0.0),
            segments,
            waveform,
            inference_seconds,
            real_time_factor: inference_seconds / duration.max(0.001),
            threshold,
            engine: "sherpa-onnx · Silero VAD",
        })
    })
    .await
    .map_err(|error| format!("Silero VAD 任务异常结束: {error}"))?
}

fn drain_segments(vad: &VoiceActivityDetector, segments: &mut Vec<VadSegment>) {
    while let Some(segment) = vad.front() {
        let start = segment.start() as f32 / SAMPLE_RATE as f32;
        let duration = segment.samples().len() as f32 / SAMPLE_RATE as f32;
        segments.push(VadSegment {
            id: format!("speech-{}", segments.len() + 1),
            start,
            end: start + duration,
            duration,
        });
        drop(segment);
        vad.pop();
    }
}

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("QWEN_AUDIO_SILERO_VAD_MODEL_PATH") {
        return Ok(PathBuf::from(path));
    }
    app.path()
        .app_data_dir()
        .map(|path| path.join("models").join(MODEL_DIRECTORY).join(MODEL_FILE))
        .map_err(|error| format!("无法定位模型目录: {error}"))
}

fn resolve_model_file(path: PathBuf) -> PathBuf {
    if path.is_file() {
        return path;
    }
    let named = path.join(MODEL_FILE);
    if named.is_file() {
        named
    } else {
        path.join("model.onnx")
    }
}

fn is_canceled(cancel: Option<&AtomicBool>) -> bool {
    cancel
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
