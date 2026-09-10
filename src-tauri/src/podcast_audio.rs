use crate::audio_io::{
    decode_wav_bytes, encode_wav_bytes, normalize_generated_speech, resample_audio,
    waveform_envelope, PcmAudio,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const TARGET_SAMPLE_RATE: u32 = 24_000;
const MAX_PODCAST_SEGMENTS: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastAudioSegment {
    file_path: String,
    pause_after_ms: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastAudioResult {
    file_name: String,
    file_path: String,
    data_url: String,
    duration: f32,
    sample_rate: u32,
    channels: u16,
    size_bytes: u64,
    waveform: Vec<f32>,
    segment_count: usize,
}

fn append_with_fades(output: &mut Vec<f32>, samples: &[f32], sample_rate: u32) {
    let fade_frames = ((sample_rate as f32 * 0.006).round() as usize)
        .min(samples.len() / 2)
        .max(1);
    for (index, sample) in samples.iter().copied().enumerate() {
        let fade_in = (index + 1) as f32 / fade_frames as f32;
        let fade_out = (samples.len() - index) as f32 / fade_frames as f32;
        output.push(sample * fade_in.min(fade_out).min(1.0));
    }
}

fn assemble_segments(segments: &[PodcastAudioSegment]) -> Result<PcmAudio, String> {
    if segments.is_empty() {
        return Err("PODCAST_NO_SEGMENTS".to_string());
    }
    if segments.len() > MAX_PODCAST_SEGMENTS {
        return Err("PODCAST_TOO_MANY_SEGMENTS".to_string());
    }
    let mut samples = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        let bytes = fs::read(&segment.file_path)
            .map_err(|error| format!("PODCAST_AUDIO_READ:{}:{error}", index + 1))?;
        let audio = decode_wav_bytes(&bytes)
            .map_err(|error| format!("PODCAST_AUDIO_INVALID:{}:{error}", index + 1))?;
        let resampled = resample_audio(&audio, TARGET_SAMPLE_RATE)?;
        append_with_fades(&mut samples, &resampled.mono_samples(), TARGET_SAMPLE_RATE);
        if index + 1 < segments.len() {
            let pause_frames = (segment.pause_after_ms.min(2_000) as usize)
                .saturating_mul(TARGET_SAMPLE_RATE as usize)
                / 1_000;
            samples.resize(samples.len() + pause_frames, 0.0);
        }
    }
    let mut audio = PcmAudio {
        samples,
        sample_rate: TARGET_SAMPLE_RATE,
        channels: 1,
    };
    normalize_generated_speech(&mut audio);
    Ok(audio)
}

fn safe_file_stem(value: &str) -> String {
    let mut stem = value
        .chars()
        .filter_map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | ' ') {
                Some(character)
            } else {
                None
            }
        })
        .take(60)
        .collect::<String>()
        .trim()
        .replace(' ', "-");
    if stem.is_empty() {
        stem = "ai-podcast".to_string();
    }
    stem
}

#[tauri::command]
pub fn compose_podcast_audio(
    app: tauri::AppHandle,
    segments: Vec<PodcastAudioSegment>,
    title: String,
) -> Result<PodcastAudioResult, String> {
    let audio = assemble_segments(&segments)?;
    let bytes = encode_wav_bytes(&audio)?;
    let output_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("PODCAST_OUTPUT_DIR:{error}"))?
        .join("generated");
    fs::create_dir_all(&output_dir).map_err(|error| format!("PODCAST_OUTPUT_DIR:{error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_name = format!("{}-{timestamp}.wav", safe_file_stem(&title));
    let file_path: PathBuf = output_dir.join(&file_name);
    fs::write(&file_path, &bytes).map_err(|error| format!("PODCAST_OUTPUT_WRITE:{error}"))?;
    Ok(PodcastAudioResult {
        file_name,
        file_path: file_path.to_string_lossy().into_owned(),
        // The UI reads the local file URL directly. Avoid serializing a very large
        // base64 payload for a multi-minute episode across the Tauri bridge.
        data_url: String::new(),
        duration: audio.duration(),
        sample_rate: audio.sample_rate,
        channels: audio.channels,
        size_bytes: bytes.len() as u64,
        waveform: waveform_envelope(&audio, 360),
        segment_count: segments.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_fixture(samples: Vec<f32>, sample_rate: u32) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "qwenaudio-podcast-audio-{}-{}.wav",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let bytes = encode_wav_bytes(&PcmAudio {
            samples,
            sample_rate,
            channels: 1,
        })
        .expect("encode fixture");
        fs::write(&path, bytes).expect("write fixture");
        path
    }

    #[test]
    fn safe_names_do_not_escape_output_directory() {
        assert_eq!(safe_file_stem("../My: Podcast?"), "My-Podcast");
        assert_eq!(safe_file_stem("***"), "ai-podcast");
    }

    #[test]
    fn fades_short_segments_without_changing_length() {
        let source = vec![1.0; 1_000];
        let mut output = Vec::new();
        append_with_fades(&mut output, &source, 24_000);
        assert_eq!(output.len(), source.len());
        assert!(output[0] < 0.1);
        assert!(output[500] > 0.9);
        assert!(output[999] < 0.1);
    }

    #[test]
    fn joins_and_resamples_generated_segments() {
        let first = write_fixture(vec![0.25; 16_000], 16_000);
        let second = write_fixture(vec![0.25; 24_000], 24_000);
        let result = assemble_segments(&[
            PodcastAudioSegment {
                file_path: first.to_string_lossy().into_owned(),
                pause_after_ms: 250,
            },
            PodcastAudioSegment {
                file_path: second.to_string_lossy().into_owned(),
                pause_after_ms: 0,
            },
        ])
        .expect("assemble podcast");
        assert_eq!(result.sample_rate, TARGET_SAMPLE_RATE);
        assert_eq!(result.channels, 1);
        assert!((result.duration() - 2.25).abs() < 0.02);
        fs::remove_file(first).expect("remove first fixture");
        fs::remove_file(second).expect("remove second fixture");
    }
}
