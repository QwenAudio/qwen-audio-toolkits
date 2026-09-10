use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const SUPPORTED_VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "webm", "mkv"];
const FRAME_WIDTH: usize = 64;
const FRAME_HEIGHT: usize = 36;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEditorStatus {
    available: bool,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedVideoMedia {
    source_path: String,
    source_name: String,
    audio_path: String,
    duration: f64,
    width: u32,
    height: u32,
    fps: f64,
    has_audio: bool,
    size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutBoundary {
    id: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutBoundaryAnalysis {
    id: String,
    similarity: f64,
    stable: bool,
    available: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepRange {
    start: f64,
    end: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    start: f64,
    end: f64,
    text: String,
}

fn srt_timestamp(seconds: f64) -> String {
    let milliseconds = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds % 3_600_000) / 60_000;
    let secs = (milliseconds % 60_000) / 1000;
    let millis = milliseconds % 1000;
    format!("{hours:02}:{minutes:02}:{secs:02},{millis:03}")
}

fn subtitle_srt(cues: &[SubtitleCue]) -> String {
    cues.iter()
        .filter(|cue| {
            cue.start.is_finite()
                && cue.end.is_finite()
                && cue.end > cue.start
                && !cue.text.trim().is_empty()
        })
        .take(500)
        .enumerate()
        .map(|(index, cue)| {
            let text = cue.text.replace(['\r', '\n'], " ");
            format!(
                "{}\n{} --> {}\n{}\n\n",
                index + 1,
                srt_timestamp(cue.start),
                srt_timestamp(cue.end),
                text.trim()
            )
        })
        .collect()
}

fn executable(name: &str) -> Option<PathBuf> {
    let candidates = if cfg!(target_os = "macos") {
        vec![
            PathBuf::from(format!("/opt/homebrew/bin/{name}")),
            PathBuf::from(format!("/usr/local/bin/{name}")),
        ]
    } else {
        Vec::new()
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| {
            std::env::var_os("PATH").and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|directory| directory.join(name))
                    .find(|path| path.is_file())
            })
        })
}

fn video_path(value: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(value).map_err(|error| format!("无法读取视频: {error}"))?;
    if !path.is_file() {
        return Err("选择的项目不是视频文件".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "视频文件没有扩展名".to_string())?;
    if !SUPPORTED_VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        return Err("当前支持 MP4、MOV、M4V、WebM 和 MKV 视频".to_string());
    }
    Ok(path)
}

fn parse_rate(value: Option<&str>) -> f64 {
    let Some(value) = value else { return 0.0 };
    let mut parts = value.split('/');
    let numerator = parts.next().and_then(|part| part.parse::<f64>().ok());
    let denominator = parts.next().and_then(|part| part.parse::<f64>().ok());
    match (numerator, denominator) {
        (Some(numerator), Some(denominator)) if denominator > 0.0 => numerator / denominator,
        (Some(rate), None) => rate,
        _ => 0.0,
    }
}

fn prepare_video_media_sync(
    app: AppHandle,
    source_path: String,
) -> Result<PreparedVideoMedia, String> {
    let source = video_path(&source_path)?;
    app.asset_protocol_scope()
        .allow_file(&source)
        .map_err(|error| format!("无法授权视频预览: {error}"))?;
    let ffmpeg = executable("ffmpeg").ok_or_else(|| {
        "未检测到 FFmpeg。请先安装 FFmpeg，口播剪辑需要它读取视频音轨。".to_string()
    })?;
    let ffprobe = executable("ffprobe")
        .ok_or_else(|| "未检测到 ffprobe。请重新安装完整的 FFmpeg。".to_string())?;
    let probe = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(&source)
        .output()
        .map_err(|error| format!("无法读取视频信息: {error}"))?;
    if !probe.status.success() {
        return Err(format!(
            "视频信息读取失败: {}",
            String::from_utf8_lossy(&probe.stderr).trim()
        ));
    }
    let metadata: Value = serde_json::from_slice(&probe.stdout)
        .map_err(|error| format!("视频信息格式无效: {error}"))?;
    let streams = metadata
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| "视频中没有可读取的媒体轨道".to_string())?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or_else(|| "文件中没有视频轨道".to_string())?;
    let has_audio = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));
    if !has_audio {
        return Err("视频中没有音轨，无法进行口播剪辑".to_string());
    }
    let duration = metadata
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| {
            video
                .get("duration")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<f64>().ok())
        })
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "无法确定视频时长".to_string())?;
    let width = video.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
    let height = video.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
    let fps = parse_rate(video.get("avg_frame_rate").and_then(Value::as_str));
    let project_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?
        .join("smart-cut")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&project_dir).map_err(|error| format!("无法创建剪辑缓存: {error}"))?;
    let audio_path = project_dir.join("source-audio.wav");
    let extraction = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(&source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&audio_path)
        .output()
        .map_err(|error| format!("无法提取视频音轨: {error}"))?;
    if !extraction.status.success() {
        let _ = fs::remove_dir_all(&project_dir);
        return Err(format!(
            "视频音轨提取失败: {}",
            String::from_utf8_lossy(&extraction.stderr).trim()
        ));
    }
    let source_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("video")
        .to_string();
    let size_bytes = fs::metadata(&source)
        .map_err(|error| format!("无法读取视频大小: {error}"))?
        .len();
    Ok(PreparedVideoMedia {
        source_path: source.to_string_lossy().into_owned(),
        source_name,
        audio_path: audio_path.to_string_lossy().into_owned(),
        duration,
        width,
        height,
        fps,
        has_audio,
        size_bytes,
    })
}

fn extract_frame(ffmpeg: &Path, source: &Path, timestamp: f64) -> Option<Vec<u8>> {
    let timestamp = format!("{:.3}", timestamp.max(0.0));
    let output = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            &timestamp,
            "-i",
        ])
        .arg(source)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=64:36,format=gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() < FRAME_WIDTH * FRAME_HEIGHT {
        return None;
    }
    Some(output.stdout[..FRAME_WIDTH * FRAME_HEIGHT].to_vec())
}

fn analyze_cut_boundaries_sync(
    source_path: String,
    boundaries: Vec<CutBoundary>,
) -> Result<Vec<CutBoundaryAnalysis>, String> {
    let source = video_path(&source_path)?;
    let ffmpeg = executable("ffmpeg").ok_or_else(|| "未检测到 FFmpeg".to_string())?;
    let mut analyses = Vec::with_capacity(boundaries.len().min(120));
    for boundary in boundaries.into_iter().take(120) {
        let before = extract_frame(&ffmpeg, &source, (boundary.start - 0.05).max(0.0));
        let after = extract_frame(&ffmpeg, &source, boundary.end + 0.05);
        let similarity = match (before, after) {
            (Some(before), Some(after)) => {
                let difference = before
                    .iter()
                    .zip(after.iter())
                    .map(|(left, right)| (*left as f64 - *right as f64).abs())
                    .sum::<f64>()
                    / before.len() as f64
                    / 255.0;
                (1.0 - difference).clamp(0.0, 1.0)
            }
            _ => {
                analyses.push(CutBoundaryAnalysis {
                    id: boundary.id,
                    similarity: 0.0,
                    stable: false,
                    available: false,
                });
                continue;
            }
        };
        analyses.push(CutBoundaryAnalysis {
            id: boundary.id,
            similarity,
            stable: similarity >= 0.90,
            available: true,
        });
    }
    Ok(analyses)
}

fn export_smart_cut_sync(
    source_path: String,
    destination_path: String,
    keep_ranges: Vec<KeepRange>,
    subtitle_cues: Vec<SubtitleCue>,
) -> Result<u64, String> {
    let source = video_path(&source_path)?;
    let ffmpeg = executable("ffmpeg").ok_or_else(|| "未检测到 FFmpeg".to_string())?;
    let destination = PathBuf::from(destination_path);
    let parent = destination
        .parent()
        .ok_or_else(|| "导出目录无效".to_string())?;
    if !parent.is_dir() {
        return Err("导出目录不存在".to_string());
    }
    let ranges = keep_ranges
        .into_iter()
        .filter(|range| {
            range.start.is_finite() && range.end.is_finite() && range.end - range.start >= 0.04
        })
        .take(120)
        .collect::<Vec<_>>();
    if ranges.is_empty() {
        return Err("剪辑方案没有可保留的视频片段".to_string());
    }
    let mut filter = String::new();
    let mut concat_inputs = String::new();
    for (index, range) in ranges.iter().enumerate() {
        filter.push_str(&format!(
            "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2[v{index}];",
            range.start, range.end
        ));
        filter.push_str(&format!(
            "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,apad,atrim=duration={:.3}[a{index}];",
            range.start,
            range.end,
            range.end - range.start
        ));
        concat_inputs.push_str(&format!("[v{index}][a{index}]"));
    }
    filter.push_str(&format!(
        "{concat_inputs}concat=n={}:v=1:a=1[vout][aout]",
        ranges.len()
    ));
    let srt = subtitle_srt(&subtitle_cues);
    let subtitle_path = parent.join(format!(".qwenaudio-subtitles-{}.srt", Uuid::new_v4()));
    if !srt.is_empty() {
        fs::write(&subtitle_path, srt.as_bytes())
            .map_err(|error| format!("无法生成字幕轨道: {error}"))?;
    }
    let mut command = Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(&source);
    if !srt.is_empty() {
        command.args(["-f", "srt", "-i"]).arg(&subtitle_path);
    }
    command.args([
        "-filter_complex",
        &filter,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
    ]);
    if !srt.is_empty() {
        command.args([
            "-map",
            "1:0",
            "-c:s",
            "mov_text",
            "-metadata:s:s:0",
            "language=und",
            "-disposition:s:0",
            "default",
        ]);
    }
    let output = command
        .args([
            "-c:v",
            "h264_videotoolbox",
            "-q:v",
            "60",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
        ])
        .arg(&destination)
        .output()
        .map_err(|error| format!("无法启动视频导出: {error}"))?;
    if !srt.is_empty() {
        let _ = fs::remove_file(&subtitle_path);
    }
    if !output.status.success() {
        let _ = fs::remove_file(&destination);
        return Err(format!(
            "视频导出失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    fs::metadata(&destination)
        .map(|metadata| metadata.len())
        .map_err(|error| format!("无法读取导出文件: {error}"))
}

#[tauri::command]
pub fn video_editor_status() -> VideoEditorStatus {
    let ffmpeg = executable("ffmpeg");
    let ffprobe = executable("ffprobe");
    let available = ffmpeg.is_some() && ffprobe.is_some();
    VideoEditorStatus {
        available,
        ffmpeg_path: ffmpeg.map(|path| path.to_string_lossy().into_owned()),
        ffprobe_path: ffprobe.map(|path| path.to_string_lossy().into_owned()),
        message: if available {
            "视频引擎已就绪".to_string()
        } else {
            "未检测到完整的 FFmpeg，暂时无法分析和导出视频".to_string()
        },
    }
}

#[tauri::command]
pub async fn prepare_video_media(
    app: AppHandle,
    source_path: String,
) -> Result<PreparedVideoMedia, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_video_media_sync(app, source_path))
        .await
        .map_err(|error| format!("视频准备任务异常退出: {error}"))?
}

#[tauri::command]
pub async fn analyze_cut_boundaries(
    source_path: String,
    boundaries: Vec<CutBoundary>,
) -> Result<Vec<CutBoundaryAnalysis>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analyze_cut_boundaries_sync(source_path, boundaries)
    })
    .await
    .map_err(|error| format!("画面分析任务异常退出: {error}"))?
}

#[tauri::command]
pub async fn export_smart_cut(
    source_path: String,
    destination_path: String,
    keep_ranges: Vec<KeepRange>,
    subtitle_cues: Option<Vec<SubtitleCue>>,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_smart_cut_sync(
            source_path,
            destination_path,
            keep_ranges,
            subtitle_cues.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| format!("视频导出任务异常退出: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fractional_frame_rates() {
        assert!((parse_rate(Some("30000/1001")) - 29.970).abs() < 0.001);
        assert_eq!(parse_rate(Some("25/1")), 25.0);
        assert_eq!(parse_rate(None), 0.0);
    }

    #[test]
    fn analyzes_and_exports_a_generated_video() {
        let Some(ffmpeg) = executable("ffmpeg") else {
            return;
        };
        let directory =
            std::env::temp_dir().join(format!("qwenaudio-smart-cut-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test directory");
        let source = directory.join("source.mp4");
        let destination = directory.join("rough-cut.mp4");
        let generated = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=0x3f7662:s=320x180:r=25:d=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=16000:duration=2",
                "-shortest",
                "-c:v",
                "h264_videotoolbox",
                "-c:a",
                "aac",
            ])
            .arg(&source)
            .output()
            .expect("generate test video");
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );

        let analysis = analyze_cut_boundaries_sync(
            source.to_string_lossy().into_owned(),
            vec![CutBoundary {
                id: "stable-cut".into(),
                start: 0.55,
                end: 0.95,
            }],
        )
        .expect("analyze stable boundary");
        assert!(analysis[0].available && analysis[0].stable);
        assert!(analysis[0].similarity > 0.98);

        let bytes = export_smart_cut_sync(
            source.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
            vec![
                KeepRange {
                    start: 0.0,
                    end: 0.55,
                },
                KeepRange {
                    start: 0.95,
                    end: 1.8,
                },
            ],
            vec![SubtitleCue {
                start: 0.0,
                end: 0.5,
                text: "Smart cut subtitle".into(),
            }],
        )
        .expect("export rough cut");
        assert!(bytes > 0 && destination.is_file());
        let _ = fs::remove_dir_all(directory);
    }
}
