use crate::audio_io::{
    decode_wav_data_url, encode_wav_bytes, resample_audio, wav_data_url, PcmAudio,
};
use serde_json::{json, Value};
use sherpa_onnx::{
    AudioTagging, AudioTaggingConfig, KeywordSpotter, KeywordSpotterConfig, OfflinePunctuation,
    OfflinePunctuationConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig, SpokenLanguageIdentification,
    SpokenLanguageIdentificationConfig,
};
use std::{
    collections::HashMap,
    ffi::{c_char, c_void, CString},
    fs,
    path::{Path, PathBuf},
};

#[repr(C)]
struct SpleeterConfig {
    vocals: *const c_char,
    accompaniment: *const c_char,
}
#[repr(C)]
struct UvrConfig {
    model: *const c_char,
}
#[repr(C)]
struct SeparationModelConfig {
    spleeter: SpleeterConfig,
    uvr: UvrConfig,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}
#[repr(C)]
struct SeparationConfig {
    model: SeparationModelConfig,
}
#[repr(C)]
struct SeparationStem {
    samples: *const *const f32,
    num_channels: i32,
    n: i32,
}
#[repr(C)]
struct SeparationOutput {
    stems: *const SeparationStem,
    num_stems: i32,
    sample_rate: i32,
}

unsafe extern "C" {
    fn SherpaOnnxCreateOfflineSourceSeparation(config: *const SeparationConfig) -> *const c_void;
    fn SherpaOnnxDestroyOfflineSourceSeparation(runtime: *const c_void);
    fn SherpaOnnxOfflineSourceSeparationProcess(
        runtime: *const c_void,
        samples: *const *const f32,
        num_channels: i32,
        num_samples: i32,
        sample_rate: i32,
    ) -> *const SeparationOutput;
    fn SherpaOnnxDestroySourceSeparationOutput(output: *const SeparationOutput);
}

fn files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(path: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(path).map_err(|error| format!("无法读取模型目录: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("无法读取模型文件: {error}"))?
                .path();
            if path.is_dir() {
                visit(&path, output)?;
            } else {
                output.push(path);
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(root, &mut output)?;
    Ok(output)
}

fn find(root: &Path, predicate: impl Fn(&str) -> bool) -> Result<PathBuf, String> {
    files(root)?
        .into_iter()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(&predicate)
        })
        .ok_or_else(|| format!("模型目录 {} 缺少所需文件", root.display()))
}

fn path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn audio(audio_data_url: &str) -> Result<(Vec<f32>, i32), String> {
    let decoded = decode_wav_data_url(audio_data_url)?;
    let resampled = resample_audio(&decoded, 16_000)?;
    Ok((resampled.mono_samples(), 16_000))
}

pub(crate) fn run_audio_tagging(model_dir: &Path, audio_data_url: &str) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let model = find(model_dir, |name| name.ends_with(".onnx"))?;
    let labels = find(model_dir, |name| {
        name.contains("label") && (name.ends_with(".csv") || name.ends_with(".txt"))
    })?;
    let mut config = AudioTaggingConfig::default();
    config.model.ced = Some(path(&model));
    config.labels = Some(path(&labels));
    config.top_k = 10;
    let tagger =
        AudioTagging::create(&config).ok_or_else(|| "无法加载 Audio Tagging 模型".to_string())?;
    let stream = tagger.create_stream();
    let (samples, sample_rate) = audio(audio_data_url)?;
    stream.accept_waveform(sample_rate, &samples);
    let tags = tagger
        .compute(&stream, 10)
        .into_iter()
        .map(|event| json!({"label": event.name, "probability": event.prob}))
        .collect::<Vec<_>>();
    Ok(json!({
        "tags": tags,
        "engine": "sherpa-onnx AudioTagging",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

pub(crate) fn run_language_id(model_dir: &Path, audio_data_url: &str) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let encoder = find(model_dir, |name| {
        name.contains("encoder") && name.ends_with(".int8.onnx")
    })
    .or_else(|_| {
        find(model_dir, |name| {
            name.contains("encoder") && name.ends_with(".onnx")
        })
    })?;
    let decoder = find(model_dir, |name| {
        name.contains("decoder") && name.ends_with(".int8.onnx")
    })
    .or_else(|_| {
        find(model_dir, |name| {
            name.contains("decoder") && name.ends_with(".onnx")
        })
    })?;
    let mut config = SpokenLanguageIdentificationConfig::default();
    config.whisper.encoder = Some(path(&encoder));
    config.whisper.decoder = Some(path(&decoder));
    let runtime = SpokenLanguageIdentification::create(&config)
        .ok_or_else(|| "无法加载 Whisper Language ID 模型".to_string())?;
    let stream = runtime.create_stream();
    let (samples, sample_rate) = audio(audio_data_url)?;
    stream.accept_waveform(sample_rate, &samples);
    let result = runtime
        .compute(&stream)
        .ok_or_else(|| "语言识别没有返回结果".to_string())?;
    Ok(json!({
        "language": result.lang,
        "engine": "sherpa-onnx Whisper",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

pub(crate) fn run_punctuation(model_dir: &Path, text: &str) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let model = find(model_dir, |name| name.ends_with(".onnx"))?;
    let mut config = OfflinePunctuationConfig::default();
    config.model.ct_transformer = Some(path(&model));
    let runtime =
        OfflinePunctuation::create(&config).ok_or_else(|| "无法加载标点恢复模型".to_string())?;
    let output = runtime
        .add_punctuation(text)
        .ok_or_else(|| "标点恢复没有返回结果".to_string())?;
    Ok(json!({
        "text": output,
        "originalText": text,
        "engine": "sherpa-onnx Punctuation",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

pub(crate) fn run_keyword_spotting(
    model_dir: &Path,
    audio_data_url: &str,
    keywords: &[String],
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let mut config = KeywordSpotterConfig::default();
    config.model_config.transducer.encoder = Some(path(&find(model_dir, |name| {
        name.starts_with("encoder") && name.ends_with(".onnx")
    })?));
    config.model_config.transducer.decoder = Some(path(&find(model_dir, |name| {
        name.starts_with("decoder") && name.ends_with(".onnx")
    })?));
    config.model_config.transducer.joiner = Some(path(&find(model_dir, |name| {
        name.starts_with("joiner") && name.ends_with(".onnx")
    })?));
    config.model_config.tokens = Some(path(&find(model_dir, |name| name == "tokens.txt")?));
    if keywords.is_empty() {
        config.keywords_file = Some(path(&find(model_dir, |name| name == "keywords.txt")?));
    } else {
        config.keywords_buf = Some(validated_keyword_tokens(model_dir, keywords)?);
    }
    let runtime =
        KeywordSpotter::create(&config).ok_or_else(|| "无法加载关键词检测模型".to_string())?;
    let stream = runtime.create_stream();
    let (mut samples, sample_rate) = audio(audio_data_url)?;
    samples.extend(std::iter::repeat(0.0).take(sample_rate as usize / 2));
    stream.accept_waveform(sample_rate, &samples);
    stream.input_finished();
    let mut matches = Vec::new();
    while runtime.is_ready(&stream) {
        runtime.decode(&stream);
        if let Some(result) = runtime
            .get_result(&stream)
            .filter(|result| !result.keyword.trim().is_empty())
        {
            matches.push(json!({
                "keyword": result.keyword,
                "start": result.start_time,
                "timestamps": result.timestamps
            }));
            runtime.reset(&stream);
        }
    }
    Ok(json!({
        "detected": !matches.is_empty(),
        "matches": matches,
        "engine": "sherpa-onnx KeywordSpotter",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

fn validated_keyword_tokens(model_dir: &Path, keywords: &[String]) -> Result<String, String> {
    let tokens_path = find(model_dir, |name| name == "tokens.txt")?;
    let token_lines = std::fs::read_to_string(tokens_path)
        .map_err(|error| format!("无法读取关键词模型词表: {error}"))?;
    let vocabulary = token_lines
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .collect::<std::collections::HashSet<_>>();
    let builtin_keywords = builtin_keyword_tokens(model_dir);
    let mut resolved = Vec::with_capacity(keywords.len());
    for keyword in keywords {
        let units = keyword
            .split_once('@')
            .map(|(units, _)| units)
            .unwrap_or(keyword)
            .split_whitespace()
            .collect::<Vec<_>>();
        if !units.is_empty() && units.iter().all(|unit| vocabulary.contains(unit)) {
            resolved.push(keyword.clone());
            continue;
        }
        if let Some(tokens) = builtin_keywords.get(&keyword.to_lowercase()) {
            resolved.push(tokens.clone());
        } else {
            return Err("自定义关键词需要先转换为模型 token；当前可暂用模型内置关键词".to_string());
        }
    }
    Ok(resolved.join("\n"))
}

fn builtin_keyword_tokens(model_dir: &Path) -> HashMap<String, String> {
    let Some(raw_path) = find(model_dir, |name| name == "keywords_raw.txt").ok() else {
        return HashMap::new();
    };
    let Some(tokens_path) = find(model_dir, |name| name == "keywords.txt").ok() else {
        return HashMap::new();
    };
    let Ok(raw) = fs::read_to_string(raw_path) else {
        return HashMap::new();
    };
    let Ok(tokens) = fs::read_to_string(tokens_path) else {
        return HashMap::new();
    };
    let by_label = tokens
        .lines()
        .filter_map(|line| {
            let (_, label) = line.rsplit_once('@')?;
            Some((label.trim().to_lowercase(), line.trim().to_string()))
        })
        .collect::<HashMap<_, _>>();
    raw.lines()
        .filter_map(|line| {
            let (phrase, label) = line.rsplit_once('@')?;
            let tokens = by_label.get(&label.trim().to_lowercase())?.clone();
            Some((phrase.trim().to_lowercase(), tokens))
        })
        .collect()
}

pub(crate) fn run_speaker_embedding(
    model_dir: &Path,
    audio_data_url: &str,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let model = find(model_dir, |name| name.ends_with(".onnx"))?;
    let config = SpeakerEmbeddingExtractorConfig {
        model: Some(path(&model)),
        ..Default::default()
    };
    let runtime =
        SpeakerEmbeddingExtractor::create(&config).ok_or_else(|| "无法加载声纹模型".to_string())?;
    let stream = runtime
        .create_stream()
        .ok_or_else(|| "无法创建声纹音频流".to_string())?;
    let (samples, sample_rate) = audio(audio_data_url)?;
    stream.accept_waveform(sample_rate, &samples);
    stream.input_finished();
    if !runtime.is_ready(&stream) {
        return Err("录音太短，无法提取稳定声纹".to_string());
    }
    let embedding = runtime
        .compute(&stream)
        .ok_or_else(|| "声纹提取没有返回结果".to_string())?;
    Ok(json!({
        "dimension": embedding.len(),
        "embedding": embedding,
        "engine": "sherpa-onnx SpeakerEmbedding",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

pub(crate) fn run_diarization(model_dir: &Path, audio_data_url: &str) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let segmentation = find(model_dir, |name| {
        name.ends_with(".onnx") && !name.contains("speaker") && !name.contains("campplus")
    })?;
    let embedding = find(model_dir, |name| {
        name.ends_with(".onnx") && (name.contains("speaker") || name.contains("campplus"))
    })?;
    let mut config = OfflineSpeakerDiarizationConfig::default();
    config.segmentation.pyannote.model = Some(path(&segmentation));
    config.embedding.model = Some(path(&embedding));
    let runtime = OfflineSpeakerDiarization::create(&config)
        .ok_or_else(|| "无法加载说话人分离模型".to_string())?;
    let decoded = decode_wav_data_url(audio_data_url)?;
    let resampled = resample_audio(&decoded, runtime.sample_rate() as u32)?;
    let samples = resampled.mono_samples();
    let result = runtime
        .process(&samples)
        .ok_or_else(|| "说话人分离没有返回结果".to_string())?;
    let ordered_segments = result.sort_by_start_time();
    let compact_ids = compact_speaker_ids(
        &ordered_segments
            .iter()
            .map(|segment| segment.speaker)
            .collect::<Vec<_>>(),
    );
    let speaker_count = compact_ids.iter().max().map_or(0, |value| value + 1);
    let segments = ordered_segments
        .into_iter()
        .zip(compact_ids)
        .map(|(segment, speaker_index)| {
            json!({
                "speaker": format!("SPK {}", speaker_index + 1),
                "speakerIndex": speaker_index,
                "rawSpeakerIndex": segment.speaker,
                "start": segment.start,
                "end": segment.end
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "speakerCount": speaker_count,
        "segments": segments,
        "engine": "sherpa-onnx SpeakerDiarization",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

fn compact_speaker_ids(raw_ids: &[i32]) -> Vec<usize> {
    let mut speaker_ids = HashMap::new();
    let mut next_id = 0;
    raw_ids
        .iter()
        .map(|raw_id| {
            *speaker_ids.entry(*raw_id).or_insert_with(|| {
                let id = next_id;
                next_id += 1;
                id
            })
        })
        .collect()
}

pub(crate) fn run_source_separation(
    model_dir: &Path,
    audio_data_url: &str,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let vocals = find(model_dir, |name| {
        name.contains("vocals") && name.ends_with(".onnx")
    })?;
    let accompaniment = find(model_dir, |name| {
        name.contains("accompaniment") && name.ends_with(".onnx")
    })?;
    let vocals = CString::new(path(&vocals)).map_err(|_| "人声模型路径无效".to_string())?;
    let accompaniment =
        CString::new(path(&accompaniment)).map_err(|_| "伴奏模型路径无效".to_string())?;
    let provider = CString::new("cpu").expect("static provider");
    let config = SeparationConfig {
        model: SeparationModelConfig {
            spleeter: SpleeterConfig {
                vocals: vocals.as_ptr(),
                accompaniment: accompaniment.as_ptr(),
            },
            uvr: UvrConfig {
                model: std::ptr::null(),
            },
            num_threads: 2,
            debug: 0,
            provider: provider.as_ptr(),
        },
    };
    let decoded = prepare_spleeter_audio(&decode_wav_data_url(audio_data_url)?)?;
    let channels = (0..decoded.channels as usize)
        .map(|channel| decoded.channel_samples(channel))
        .collect::<Vec<_>>();
    let pointers = channels
        .iter()
        .map(|channel| channel.as_ptr())
        .collect::<Vec<_>>();
    let runtime = unsafe { SherpaOnnxCreateOfflineSourceSeparation(&config) };
    if runtime.is_null() {
        return Err("无法加载 Spleeter 模型".to_string());
    }
    let output = unsafe {
        SherpaOnnxOfflineSourceSeparationProcess(
            runtime,
            pointers.as_ptr(),
            channels.len() as i32,
            decoded.frame_count() as i32,
            decoded.sample_rate as i32,
        )
    };
    if output.is_null() {
        unsafe { SherpaOnnxDestroyOfflineSourceSeparation(runtime) };
        return Err("人声分离没有返回结果".to_string());
    }
    let output_ref = unsafe { &*output };
    let mut tracks = Vec::new();
    for index in 0..output_ref.num_stems.max(0) as usize {
        let stem = unsafe { &*output_ref.stems.add(index) };
        let mut interleaved = Vec::with_capacity(stem.n as usize * stem.num_channels as usize);
        for frame in 0..stem.n.max(0) as usize {
            for channel in 0..stem.num_channels.max(0) as usize {
                let channel_samples = unsafe { *stem.samples.add(channel) };
                interleaved.push(unsafe { *channel_samples.add(frame) });
            }
        }
        let pcm = PcmAudio {
            samples: interleaved,
            sample_rate: output_ref.sample_rate as u32,
            channels: stem.num_channels as u16,
        };
        let wav = encode_wav_bytes(&pcm)?;
        tracks.push(json!({
            "id": if index == 0 { "vocals" } else { "accompaniment" },
            "name": if index == 0 { "人声" } else { "伴奏" },
            "dataUrl": wav_data_url(&wav),
            "duration": pcm.duration()
        }));
    }
    unsafe {
        SherpaOnnxDestroySourceSeparationOutput(output);
        SherpaOnnxDestroyOfflineSourceSeparation(runtime);
    }
    Ok(json!({
        "tracks": tracks,
        "engine": "sherpa-onnx Spleeter",
        "inferenceSeconds": started.elapsed().as_secs_f32()
    }))
}

fn prepare_spleeter_audio(source: &PcmAudio) -> Result<PcmAudio, String> {
    let resampled = resample_audio(source, 44_100)?;
    let left = resampled.channel_samples(0);
    let right = if resampled.channels > 1 {
        resampled.channel_samples(1)
    } else {
        left.clone()
    };
    let mut samples = Vec::with_capacity(left.len() * 2);
    for (left, right) in left.into_iter().zip(right) {
        samples.push(left);
        samples.push(right);
    }
    Ok(PcmAudio {
        samples,
        sample_rate: 44_100,
        channels: 2,
    })
}

#[cfg(test)]
mod tests {
    use super::{compact_speaker_ids, prepare_spleeter_audio, validated_keyword_tokens};
    use crate::audio_io::PcmAudio;
    use std::{env, fs};

    #[test]
    fn prepares_mono_audio_as_44khz_stereo() {
        let input = PcmAudio {
            samples: vec![0.25, -0.5, 0.75],
            sample_rate: 44_100,
            channels: 1,
        };
        let output = prepare_spleeter_audio(&input).expect("prepare audio");
        assert_eq!(output.sample_rate, 44_100);
        assert_eq!(output.channels, 2);
        assert_eq!(output.samples, vec![0.25, 0.25, -0.5, -0.5, 0.75, 0.75]);
    }

    #[test]
    fn compacts_sparse_speaker_ids_by_first_appearance() {
        assert_eq!(
            compact_speaker_ids(&[3, 3, 8, 3, 21, 8]),
            vec![0, 0, 1, 0, 2, 1]
        );
        assert_eq!(compact_speaker_ids(&[1, 1, 1]), vec![0, 0, 0]);
    }

    #[test]
    fn maps_builtin_raw_keywords_to_model_tokens() {
        let root = env::temp_dir().join("qwen-audio-keyword-mapping-test");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("test_wavs")).expect("create keyword fixtures");
        fs::write(root.join("tokens.txt"), "n 1\nǚ 2\nér 3\n").expect("write token vocabulary");
        fs::write(root.join("test_wavs/keywords.txt"), "n ǚ ér @女儿\n")
            .expect("write tokenized keywords");
        fs::write(root.join("test_wavs/keywords_raw.txt"), "女儿 @女儿\n")
            .expect("write raw keywords");

        assert_eq!(
            validated_keyword_tokens(&root, &["女儿".to_string()]).expect("map builtin keyword"),
            "n ǚ ér @女儿"
        );
        assert!(validated_keyword_tokens(&root, &["你好小助手".to_string()]).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
