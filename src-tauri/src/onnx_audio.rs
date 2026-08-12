use crate::{
    audio_io::{
        decode_wav_data_url, encode_wav_bytes, interleave_channels, resample_audio, wav_data_url,
        waveform_envelope, PcmAudio,
    },
    plugins::runtime_directory_for_model,
};
use ort::{session::Session, value::Tensor};
use rustfft::{num_complex::Complex32, FftPlanner};
use serde_json::{json, Value};
use std::{
    f32::consts::PI,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};

const ZIP_SAMPLE_RATE: u32 = 16_000;
const ZIP_N_FFT: usize = 400;
const ZIP_HOP: usize = 100;
const ZIP_FREQUENCIES: usize = ZIP_N_FFT / 2 + 1;
const ZIP_MIN_WINDOW: usize = ZIP_SAMPLE_RATE as usize * 2;
const ZIP_SEGMENT_THRESHOLD: usize = ZIP_SAMPLE_RATE as usize * 6;
const ZIP_SEGMENT_STRIDE: usize = ZIP_MIN_WINDOW * 3 / 4;

const MOSSFORMER_SAMPLE_RATE: u32 = 8_000;
const MOSSFORMER_WINDOW: usize = MOSSFORMER_SAMPLE_RATE as usize * 10;
const MOSSFORMER_OVERLAP: usize = MOSSFORMER_SAMPLE_RATE as usize;
const MOSSFORMER_STRIDE: usize = MOSSFORMER_WINDOW - MOSSFORMER_OVERLAP;

static ONNX_RUNTIME: OnceLock<Mutex<bool>> = OnceLock::new();

fn inference_threads() -> usize {
    std::thread::available_parallelism()
        .map(|threads| threads.get().clamp(1, 4))
        .unwrap_or(2)
}

fn runtime_library(model_dir: &Path) -> Result<PathBuf, String> {
    let runtime_dir = runtime_directory_for_model(model_dir);
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["onnxruntime.dll"]
    } else if cfg!(target_os = "macos") {
        &[
            "libonnxruntime.1.27.0.dylib",
            "libonnxruntime.1.dylib",
            "libonnxruntime.dylib",
        ]
    } else {
        &[
            "libonnxruntime.so.1.27.0",
            "libonnxruntime.so.1",
            "libonnxruntime.so",
        ]
    };
    names
        .iter()
        .map(|name| runtime_dir.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| format!("模型缺少当前平台的 ONNX Runtime: {}", runtime_dir.display()))
}

fn ensure_runtime(model_dir: &Path) -> Result<(), String> {
    let initialized = ONNX_RUNTIME.get_or_init(|| Mutex::new(false));
    let mut initialized = initialized
        .lock()
        .map_err(|_| "ONNX Runtime 初始化状态不可用".to_string())?;
    if *initialized {
        return Ok(());
    }
    let library = runtime_library(model_dir)?;
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ort::init_from(library.to_string_lossy())
            .with_name("QwenAudio Toolkits")
            .commit()
    }))
    .map_err(|panic| {
        let detail = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("未知错误");
        format!("无法加载 ONNX Runtime: {detail}")
    })?
    .map_err(|error| format!("无法加载 ONNX Runtime: {error}"))?;
    *initialized = true;
    Ok(())
}

fn find_named_file(root: &Path, name: &str) -> Result<PathBuf, String> {
    fn visit(root: &Path, name: &str) -> Result<Option<PathBuf>, String> {
        for entry in fs::read_dir(root).map_err(|error| format!("无法读取模型目录: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("无法读取模型文件: {error}"))?
                .path();
            if path.is_dir() {
                if let Some(found) = visit(&path, name)? {
                    return Ok(Some(found));
                }
            } else if path.file_name().and_then(|value| value.to_str()) == Some(name) {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }
    visit(root, name)?.ok_or_else(|| format!("模型目录 {} 缺少 {name}", root.display()))
}

pub(crate) fn validate_onnx_audio_model(model_dir: &Path, model_name: &str) -> Result<(), String> {
    find_named_file(model_dir, model_name)?;
    runtime_library(model_dir)?;
    Ok(())
}

fn session(model_dir: &Path, model_name: &str) -> Result<Session, String> {
    ensure_runtime(model_dir)?;
    let model = find_named_file(model_dir, model_name)?;
    Session::builder()
        .and_then(|builder| builder.with_intra_threads(inference_threads()))
        .and_then(|builder| builder.commit_from_file(model))
        .map_err(|error| format!("无法加载 {model_name}: {error}"))
}

pub(crate) fn enhance_zipenhancer(
    model_dir: &Path,
    source: &PcmAudio,
    strength: f32,
) -> Result<PcmAudio, String> {
    let working = resample_audio(source, ZIP_SAMPLE_RATE)?;
    let mut runtime = session(model_dir, "zipenhancer.onnx")?;
    let channels = working.channels.max(1) as usize;
    let mut enhanced = Vec::with_capacity(channels);
    for channel in 0..channels {
        let dry = working.channel_samples(channel);
        let wet = zip_channel(&mut runtime, &dry)?;
        let amount = strength.clamp(0.0, 1.0);
        enhanced.push(
            dry.iter()
                .zip(wet)
                .map(|(dry, wet)| dry * (1.0 - amount) + wet * amount)
                .collect(),
        );
    }
    let enhanced = interleave_channels(enhanced, ZIP_SAMPLE_RATE);
    resample_audio(&enhanced, source.sample_rate)
}

fn zip_channel(runtime: &mut Session, samples: &[f32]) -> Result<Vec<f32>, String> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    if samples.len() <= ZIP_SEGMENT_THRESHOLD {
        let mut padded = samples.to_vec();
        let target = padded.len().max(ZIP_MIN_WINDOW).div_ceil(ZIP_HOP) * ZIP_HOP;
        padded.resize(target, 0.0);
        let mut output = zip_window(runtime, &padded)?;
        output.truncate(samples.len());
        return Ok(output);
    }

    let mut output = vec![0.0_f32; samples.len()];
    let mut weights = vec![0.0_f32; samples.len()];
    let mut start = 0;
    loop {
        let end = (start + ZIP_MIN_WINDOW).min(samples.len());
        let actual = end - start;
        let mut window = samples[start..end].to_vec();
        window.resize(ZIP_MIN_WINDOW, 0.0);
        let enhanced = zip_window(runtime, &window)?;
        for index in 0..actual {
            let mut weight = 1.0_f32;
            let overlap = ZIP_MIN_WINDOW - ZIP_SEGMENT_STRIDE;
            if start > 0 && index < overlap {
                weight *= (index + 1) as f32 / (overlap + 1) as f32;
            }
            if end < samples.len() && index + overlap >= actual {
                weight *= (actual - index) as f32 / (overlap + 1) as f32;
            }
            output[start + index] += enhanced[index] * weight;
            weights[start + index] += weight;
        }
        if end == samples.len() {
            break;
        }
        start += ZIP_SEGMENT_STRIDE;
    }
    for (sample, weight) in output.iter_mut().zip(weights) {
        if weight > f32::EPSILON {
            *sample /= weight;
        }
    }
    Ok(output)
}

fn zip_window(runtime: &mut Session, samples: &[f32]) -> Result<Vec<f32>, String> {
    let energy = samples.iter().map(|sample| sample * sample).sum::<f32>();
    if energy <= f32::EPSILON {
        return Ok(vec![0.0; samples.len()]);
    }
    let normalization = (samples.len() as f32 / energy).sqrt();
    let normalized = samples
        .iter()
        .map(|sample| sample * normalization)
        .collect::<Vec<_>>();
    let (magnitude, phase, frames) = zip_stft(&normalized);
    let magnitude = Tensor::from_array(([1usize, ZIP_FREQUENCIES, frames], magnitude))
        .map_err(|error| format!("无法创建 ZipEnhancer 幅度输入: {error}"))?;
    let phase = Tensor::from_array(([1usize, ZIP_FREQUENCIES, frames], phase))
        .map_err(|error| format!("无法创建 ZipEnhancer 相位输入: {error}"))?;
    let outputs = runtime
        .run(
            ort::inputs![
                "noisy_mag" => magnitude,
                "noisy_pha" => phase
            ]
            .map_err(|error| format!("无法创建 ZipEnhancer 输入: {error}"))?,
        )
        .map_err(|error| format!("ZipEnhancer 推理失败: {error}"))?;
    let (magnitude_shape, enhanced_magnitude) = outputs["amp_g"]
        .try_extract_raw_tensor::<f32>()
        .map_err(|error| format!("ZipEnhancer 幅度输出无效: {error}"))?;
    let (phase_shape, enhanced_phase) = outputs["pha_g"]
        .try_extract_raw_tensor::<f32>()
        .map_err(|error| format!("ZipEnhancer 相位输出无效: {error}"))?;
    let expected_shape = [1_i64, ZIP_FREQUENCIES as i64, frames as i64];
    if magnitude_shape != expected_shape || phase_shape != expected_shape {
        return Err(format!(
            "ZipEnhancer 输出形状无效: {magnitude_shape:?} / {phase_shape:?}"
        ));
    }
    let mut output = zip_istft(enhanced_magnitude, enhanced_phase, frames, samples.len())?;
    for sample in &mut output {
        *sample /= normalization;
        if !sample.is_finite() {
            return Err("ZipEnhancer 输出包含无效数值".to_string());
        }
    }
    Ok(output)
}

fn hann_window() -> Vec<f32> {
    (0..ZIP_N_FFT)
        .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / ZIP_N_FFT as f32).cos())
        .collect()
}

fn reflected(samples: &[f32]) -> Vec<f32> {
    let padding = ZIP_N_FFT / 2;
    let mut padded = Vec::with_capacity(samples.len() + padding * 2);
    padded.extend((1..=padding).rev().map(|index| samples[index]));
    padded.extend_from_slice(samples);
    padded.extend((1..=padding).map(|index| samples[samples.len() - 1 - index]));
    padded
}

fn zip_stft(samples: &[f32]) -> (Vec<f32>, Vec<f32>, usize) {
    let padded = reflected(samples);
    let frames = (padded.len() - ZIP_N_FFT) / ZIP_HOP + 1;
    let window = hann_window();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(ZIP_N_FFT);
    let mut magnitude = vec![0.0; ZIP_FREQUENCIES * frames];
    let mut phase = vec![0.0; ZIP_FREQUENCIES * frames];
    let mut buffer = vec![Complex32::default(); ZIP_N_FFT];
    for frame in 0..frames {
        let offset = frame * ZIP_HOP;
        for index in 0..ZIP_N_FFT {
            buffer[index] = Complex32::new(padded[offset + index] * window[index], 0.0);
        }
        fft.process(&mut buffer);
        for (frequency, value) in buffer.iter().take(ZIP_FREQUENCIES).enumerate() {
            let index = frequency * frames + frame;
            magnitude[index] = (value.norm_sqr() + 1e-9).sqrt().powf(0.3);
            phase[index] = value.im.atan2(value.re + 1e-5);
        }
    }
    (magnitude, phase, frames)
}

fn zip_istft(
    magnitude: &[f32],
    phase: &[f32],
    frames: usize,
    output_len: usize,
) -> Result<Vec<f32>, String> {
    if magnitude.len() != ZIP_FREQUENCIES * frames || phase.len() != magnitude.len() {
        return Err("ZipEnhancer 频谱长度无效".to_string());
    }
    let padded_len = (frames - 1) * ZIP_HOP + ZIP_N_FFT;
    let mut output = vec![0.0_f32; padded_len];
    let mut window_sum = vec![0.0_f32; padded_len];
    let window = hann_window();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_inverse(ZIP_N_FFT);
    let mut buffer = vec![Complex32::default(); ZIP_N_FFT];
    for frame in 0..frames {
        buffer.fill(Complex32::default());
        for (frequency, value) in buffer.iter_mut().take(ZIP_FREQUENCIES).enumerate() {
            let index = frequency * frames + frame;
            let amplitude = magnitude[index].max(0.0).powf(1.0 / 0.3);
            *value = Complex32::from_polar(amplitude, phase[index]);
        }
        for frequency in 1..ZIP_N_FFT / 2 {
            buffer[ZIP_N_FFT - frequency] = buffer[frequency].conj();
        }
        fft.process(&mut buffer);
        let offset = frame * ZIP_HOP;
        for index in 0..ZIP_N_FFT {
            let weight = window[index];
            output[offset + index] += buffer[index].re / ZIP_N_FFT as f32 * weight;
            window_sum[offset + index] += weight * weight;
        }
    }
    for (sample, weight) in output.iter_mut().zip(window_sum) {
        if weight > 1e-11 {
            *sample /= weight;
        }
    }
    let padding = ZIP_N_FFT / 2;
    let available = output.len().saturating_sub(padding * 2);
    let mut centered = output[padding..padding + available].to_vec();
    centered.resize(output_len, 0.0);
    centered.truncate(output_len);
    Ok(centered)
}

pub(crate) fn separate_mossformer2(
    model_dir: &Path,
    audio_data_url: &str,
) -> Result<Value, String> {
    let started = Instant::now();
    let decoded = decode_wav_data_url(audio_data_url)?;
    let working = resample_audio(&decoded, MOSSFORMER_SAMPLE_RATE)?;
    let samples = working.mono_samples();
    if samples.is_empty() {
        return Err("音频内容为空，无法进行说话人分离".to_string());
    }
    let mut runtime = session(model_dir, "mossformer2.onnx")?;
    let [mut speaker1, mut speaker2] = mossformer_tracks(&mut runtime, &samples)?;
    normalize_track(&mut speaker1);
    normalize_track(&mut speaker2);
    let mut tracks = Vec::with_capacity(2);
    for (index, samples) in [speaker1, speaker2].into_iter().enumerate() {
        let audio = PcmAudio {
            samples,
            sample_rate: MOSSFORMER_SAMPLE_RATE,
            channels: 1,
        };
        let wav = encode_wav_bytes(&audio)?;
        tracks.push(json!({
            "id": format!("speaker-{}", index + 1),
            "name": format!("说话人 {}", index + 1),
            "dataUrl": wav_data_url(&wav),
            "duration": audio.duration(),
            "sampleRate": audio.sample_rate,
            "channels": audio.channels,
            "waveform": waveform_envelope(&audio, 240)
        }));
    }
    Ok(json!({
        "tracks": tracks,
        "engine": "MossFormer2 8 kHz · ONNX Runtime",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

fn mossformer_tracks(runtime: &mut Session, samples: &[f32]) -> Result<[Vec<f32>; 2], String> {
    if samples.len() <= MOSSFORMER_WINDOW {
        return mossformer_window(runtime, samples);
    }
    let mut tracks = [Vec::new(), Vec::new()];
    let mut start = 0;
    loop {
        let end = (start + MOSSFORMER_WINDOW).min(samples.len());
        let mut chunk = mossformer_window(runtime, &samples[start..end])?;
        if start == 0 {
            tracks = chunk;
        } else {
            let overlap = MOSSFORMER_OVERLAP
                .min(chunk[0].len())
                .min(tracks[0].len().saturating_sub(start));
            let direct = correlation(&tracks[0][start..start + overlap], &chunk[0][..overlap])
                + correlation(&tracks[1][start..start + overlap], &chunk[1][..overlap]);
            let swapped = correlation(&tracks[0][start..start + overlap], &chunk[1][..overlap])
                + correlation(&tracks[1][start..start + overlap], &chunk[0][..overlap]);
            if swapped > direct {
                chunk.swap(0, 1);
            }
            for speaker in 0..2 {
                for index in 0..overlap {
                    let amount = (index + 1) as f32 / (overlap + 1) as f32;
                    tracks[speaker][start + index] = tracks[speaker][start + index]
                        * (1.0 - amount)
                        + chunk[speaker][index] * amount;
                }
                tracks[speaker].extend_from_slice(&chunk[speaker][overlap..]);
            }
        }
        if end == samples.len() {
            break;
        }
        start += MOSSFORMER_STRIDE;
    }
    for track in &mut tracks {
        track.resize(samples.len(), 0.0);
        track.truncate(samples.len());
    }
    Ok(tracks)
}

fn mossformer_window(runtime: &mut Session, samples: &[f32]) -> Result<[Vec<f32>; 2], String> {
    let input = Tensor::from_array(([1usize, samples.len()], samples.to_vec()))
        .map_err(|error| format!("无法创建 MossFormer2 输入: {error}"))?;
    let outputs = runtime
        .run(
            ort::inputs!["waveform" => input]
                .map_err(|error| format!("无法创建 MossFormer2 输入: {error}"))?,
        )
        .map_err(|error| format!("MossFormer2 推理失败: {error}"))?;
    let (shape, values) = outputs["speakers"]
        .try_extract_raw_tensor::<f32>()
        .map_err(|error| format!("MossFormer2 输出无效: {error}"))?;
    if shape.len() != 3 || shape[0] != 1 || shape[2] != 2 {
        return Err(format!("MossFormer2 输出形状无效: {shape:?}"));
    }
    let frames = shape[1].max(0) as usize;
    if values.len() != frames * 2 {
        return Err("MossFormer2 输出长度无效".to_string());
    }
    let mut tracks = [
        Vec::with_capacity(samples.len()),
        Vec::with_capacity(samples.len()),
    ];
    for frame in 0..frames {
        tracks[0].push(values[frame * 2]);
        tracks[1].push(values[frame * 2 + 1]);
    }
    for track in &mut tracks {
        let fill = track.last().copied().unwrap_or(0.0);
        track.resize(samples.len(), fill);
        track.truncate(samples.len());
        if track.iter().any(|sample| !sample.is_finite()) {
            return Err("MossFormer2 输出包含无效数值".to_string());
        }
    }
    Ok(tracks)
}

fn correlation(left: &[f32], right: &[f32]) -> f32 {
    if left.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    let dot = left.iter().zip(right).map(|(a, b)| a * b).sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>();
    dot / (left_norm * right_norm).sqrt().max(1e-12)
}

fn normalize_track(samples: &mut [f32]) {
    let peak = samples
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0.0_f32, f32::max);
    if peak > f32::EPSILON {
        let scale = 0.5 / peak;
        for sample in samples {
            *sample *= scale;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_io::decode_wav_bytes;

    #[test]
    fn zip_stft_round_trip_preserves_waveform() {
        let samples = (0..ZIP_MIN_WINDOW)
            .map(|index| (2.0 * PI * 440.0 * index as f32 / ZIP_SAMPLE_RATE as f32).sin() * 0.2)
            .collect::<Vec<_>>();
        let (magnitude, phase, frames) = zip_stft(&samples);
        let output = zip_istft(&magnitude, &phase, frames, samples.len()).unwrap();
        let max_error = samples
            .iter()
            .zip(output)
            .map(|(expected, actual)| (expected - actual).abs())
            .fold(0.0_f32, f32::max);
        assert!(max_error < 1e-3, "max error: {max_error}");
    }

    #[test]
    fn correlation_detects_matching_tracks() {
        let left = [0.1, -0.2, 0.3, -0.4];
        let right = [-0.3, 0.2, 0.1, -0.5];
        assert!(
            correlation(&left, &left) + correlation(&right, &right)
                > correlation(&left, &right) + correlation(&right, &left)
        );
    }

    #[test]
    #[ignore = "requires QWENAUDIO_ZIP_MODEL_DIR, QWENAUDIO_ZIP_TEST_WAV, and QWENAUDIO_ZIP_REFERENCE_WAV"]
    fn real_zipenhancer_model_smoke() {
        let model_dir = std::env::var("QWENAUDIO_ZIP_MODEL_DIR").expect("model directory");
        let input_path = std::env::var("QWENAUDIO_ZIP_TEST_WAV").expect("test wav");
        let reference_path = std::env::var("QWENAUDIO_ZIP_REFERENCE_WAV").expect("reference wav");
        let bytes = fs::read(input_path).expect("read test wav");
        let input = decode_wav_bytes(&bytes).expect("decode test wav");
        let output = enhance_zipenhancer(Path::new(&model_dir), &input, 1.0).expect("enhance");
        let reference = decode_wav_bytes(&fs::read(reference_path).expect("read reference wav"))
            .expect("decode reference wav");
        assert_eq!(output.sample_rate, input.sample_rate);
        assert_eq!(output.channels, input.channels);
        assert_eq!(output.frame_count(), input.frame_count());
        assert!(output.samples.iter().all(|sample| sample.is_finite()));
        assert!(
            correlation(&output.samples, &reference.samples) > 0.999,
            "Rust output diverges from the official PyTorch preprocessing reference"
        );
    }

    #[test]
    #[ignore = "requires QWENAUDIO_MOSS_MODEL_DIR and QWENAUDIO_MOSS_TEST_WAV"]
    fn real_mossformer2_model_smoke() {
        let model_dir = std::env::var("QWENAUDIO_MOSS_MODEL_DIR").expect("model directory");
        let input_path = std::env::var("QWENAUDIO_MOSS_TEST_WAV").expect("test wav");
        let bytes = fs::read(input_path).expect("read test wav");
        let output = separate_mossformer2(Path::new(&model_dir), &wav_data_url(&bytes))
            .expect("separate speakers");
        let tracks = output["tracks"].as_array().expect("tracks");
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().all(|track| track["dataUrl"]
            .as_str()
            .is_some_and(|value| value.starts_with("data:audio/wav;base64,"))));
    }
}
