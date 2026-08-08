use base64::{engine::general_purpose::STANDARD, Engine as _};
use sherpa_onnx::LinearResampler;
use std::{borrow::Cow, io::Cursor};

pub const MAX_AUDIO_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct PcmAudio {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

impl PcmAudio {
    pub fn frame_count(&self) -> usize {
        self.samples.len() / self.channels.max(1) as usize
    }

    pub fn duration(&self) -> f32 {
        self.frame_count() as f32 / self.sample_rate.max(1) as f32
    }

    pub fn mono_samples(&self) -> Vec<f32> {
        let channels = self.channels.max(1) as usize;
        self.samples
            .chunks(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
            .collect()
    }

    pub fn channel_samples(&self, channel: usize) -> Vec<f32> {
        let channels = self.channels.max(1) as usize;
        self.samples
            .chunks(channels)
            .map(|frame| frame[channel.min(frame.len().saturating_sub(1))])
            .collect()
    }
}

pub fn decode_wav_data_url(data_url: &str) -> Result<PcmAudio, String> {
    if data_url.len() > MAX_AUDIO_BYTES * 2 {
        return Err("音频过大，请先裁剪后再处理".to_string());
    }

    let encoded = data_url
        .split_once(',')
        .map(|(_, encoded)| encoded)
        .ok_or_else(|| "无法读取音频数据".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("音频 Base64 解码失败: {error}"))?;
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("音频过大，请先裁剪后再处理".to_string());
    }

    decode_wav_bytes(&bytes)
}

pub fn decode_wav_bytes(bytes: &[u8]) -> Result<PcmAudio, String> {
    let mut reader = hound::WavReader::new(Cursor::new(bytes))
        .map_err(|error| format!("仅支持有效的 WAV 处理缓存: {error}"))?;
    let spec = reader.spec();
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("WAV 浮点采样读取失败: {error}"))?,
        hound::SampleFormat::Int if spec.bits_per_sample <= 8 => reader
            .samples::<i8>()
            .map(|sample| sample.map(|value| value as f32 / i8::MAX as f32))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("WAV 采样读取失败: {error}"))?,
        hound::SampleFormat::Int if spec.bits_per_sample <= 16 => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| value as f32 / i16::MAX as f32))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("WAV 采样读取失败: {error}"))?,
        hound::SampleFormat::Int => {
            let scale = ((1_i64 << (spec.bits_per_sample - 1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("WAV 采样读取失败: {error}"))?
        }
    };

    Ok(PcmAudio {
        samples,
        sample_rate: spec.sample_rate,
        channels: spec.channels.max(1),
    })
}

pub fn encode_wav_bytes(audio: &PcmAudio) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    {
        let spec = hound::WavSpec {
            channels: audio.channels.max(1),
            sample_rate: audio.sample_rate.max(1),
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::new(&mut cursor, spec)
            .map_err(|error| format!("无法创建 WAV 输出: {error}"))?;
        for sample in &audio.samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let value = if clamped < 0.0 {
                clamped * 32_768.0
            } else {
                clamped * i16::MAX as f32
            };
            writer
                .write_sample(value.round() as i16)
                .map_err(|error| format!("无法写入 WAV 采样: {error}"))?;
        }
        writer
            .finalize()
            .map_err(|error| format!("无法完成 WAV 输出: {error}"))?;
    }
    Ok(cursor.into_inner())
}

pub fn webview_safe_wav_bytes(bytes: &[u8]) -> Result<Cow<'_, [u8]>, String> {
    let spec = hound::WavReader::new(Cursor::new(bytes))
        .map_err(|error| format!("无法检查 WAV 音频格式: {error}"))?
        .spec();
    if spec.sample_format == hound::SampleFormat::Int && spec.bits_per_sample == 16 {
        return Ok(Cow::Borrowed(bytes));
    }

    let audio = decode_wav_bytes(bytes)?;
    encode_wav_bytes(&audio).map(Cow::Owned)
}

pub fn wav_data_url(bytes: &[u8]) -> String {
    format!("data:audio/wav;base64,{}", STANDARD.encode(bytes))
}

pub fn resample_audio(audio: &PcmAudio, target_rate: u32) -> Result<PcmAudio, String> {
    if audio.sample_rate == target_rate {
        return Ok(audio.clone());
    }

    let channels = audio.channels.max(1) as usize;
    let mut planar = Vec::with_capacity(channels);
    for channel in 0..channels {
        let source = audio.channel_samples(channel);
        let samples = LinearResampler::create(audio.sample_rate as i32, target_rate as i32)
            .ok_or_else(|| {
                format!(
                    "无法创建 {} Hz 到 {} Hz 的重采样器",
                    audio.sample_rate, target_rate
                )
            })?
            .resample(&source, true);
        planar.push(samples);
    }

    Ok(interleave_channels(planar, target_rate))
}

pub fn interleave_channels(planar: Vec<Vec<f32>>, sample_rate: u32) -> PcmAudio {
    let channels = planar.len().max(1);
    let frame_count = planar.iter().map(Vec::len).min().unwrap_or(0);
    let mut samples = Vec::with_capacity(frame_count * channels);
    for frame in 0..frame_count {
        for channel in &planar {
            samples.push(channel[frame]);
        }
    }
    PcmAudio {
        samples,
        sample_rate,
        channels: channels as u16,
    }
}

pub fn waveform_envelope(audio: &PcmAudio, points: usize) -> Vec<f32> {
    let channels = audio.channels.max(1) as usize;
    let frame_count = audio.frame_count();
    if frame_count == 0 || points == 0 {
        return Vec::new();
    }

    let frames_per_point = frame_count.div_ceil(points);
    let mut envelope = (0..frame_count)
        .step_by(frames_per_point)
        .take(points)
        .map(|start| {
            let end = (start + frames_per_point).min(frame_count);
            let mut peak = 0.0_f32;
            for frame in start..end {
                for channel in 0..channels {
                    let sample = audio.samples[frame * channels + channel];
                    if sample.is_finite() {
                        peak = peak.max(sample.abs());
                    }
                }
            }
            peak
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

pub fn peak_dbfs(samples: &[f32]) -> f32 {
    let peak = samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0, f32::max);
    amplitude_to_db(peak)
}

pub fn rms_dbfs(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -120.0;
    }
    let mean_square =
        samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32;
    amplitude_to_db(mean_square.sqrt())
}

pub fn normalize_generated_speech(audio: &mut PcmAudio) -> f32 {
    let current_rms = rms_dbfs(&audio.samples);
    let current_peak = peak_dbfs(&audio.samples);
    if !current_rms.is_finite() || !current_peak.is_finite() || current_peak <= -120.0 {
        return 0.0;
    }

    let desired_gain = (-22.0 - current_rms).clamp(0.0, 42.0);
    let peak_limited_gain = (-3.0 - current_peak).max(0.0).min(desired_gain);
    if peak_limited_gain <= 0.05 {
        return 0.0;
    }
    let gain = 10.0_f32.powf(peak_limited_gain / 20.0);
    for sample in &mut audio.samples {
        *sample = (*sample * gain).clamp(-1.0, 1.0);
    }
    peak_limited_gain
}

fn amplitude_to_db(amplitude: f32) -> f32 {
    if amplitude <= 1e-6 {
        -120.0
    } else {
        20.0 * amplitude.log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_float_wav(samples: &[f32]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(
                &mut cursor,
                hound::WavSpec {
                    channels: 1,
                    sample_rate: 24_000,
                    bits_per_sample: 32,
                    sample_format: hound::SampleFormat::Float,
                },
            )
            .expect("create float wav");
            for sample in samples {
                writer.write_sample(*sample).expect("write float sample");
            }
            writer.finalize().expect("finalize float wav");
        }
        cursor.into_inner()
    }

    #[test]
    fn wav_round_trip_preserves_shape() {
        let audio = PcmAudio {
            samples: vec![0.0, 0.25, -0.5, 0.75],
            sample_rate: 48_000,
            channels: 2,
        };
        let bytes = encode_wav_bytes(&audio).expect("encode");
        let decoded = decode_wav_bytes(&bytes).expect("decode");

        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.frame_count(), 2);
        assert!((decoded.samples[3] - 0.75).abs() < 0.001);
    }

    #[test]
    fn webview_safe_wav_converts_float_audio_to_pcm16() {
        let float_wav = encode_float_wav(&[0.0, 0.25, -0.5, 0.75]);
        let converted = webview_safe_wav_bytes(&float_wav).expect("normalize");
        let spec = hound::WavReader::new(Cursor::new(converted.as_ref()))
            .expect("read normalized wav")
            .spec();

        assert!(matches!(converted, Cow::Owned(_)));
        assert_eq!(spec.sample_format, hound::SampleFormat::Int);
        assert_eq!(spec.bits_per_sample, 16);
        assert_eq!(spec.sample_rate, 24_000);
    }

    #[test]
    fn webview_safe_wav_keeps_pcm16_without_copying() {
        let bytes = encode_wav_bytes(&PcmAudio {
            samples: vec![0.0, 0.25, -0.5, 0.75],
            sample_rate: 24_000,
            channels: 1,
        })
        .expect("encode pcm16 wav");
        let normalized = webview_safe_wav_bytes(&bytes).expect("normalize");

        assert!(matches!(normalized, Cow::Borrowed(_)));
    }
}
