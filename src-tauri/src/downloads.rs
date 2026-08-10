use reqwest::{
    blocking::{Client, Response},
    header::{CONTENT_RANGE, RANGE},
    StatusCode,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

const BUFFER_BYTES: usize = 1024 * 1024;
const PARALLEL_DOWNLOAD_BYTES: u64 = 32 * 1024 * 1024;
const PARALLEL_PARTS: u64 = 4;
const DOWNLOAD_CANCELED: &str = "模型下载已取消";

#[derive(Clone, Copy)]
pub(crate) struct DownloadProgressRange {
    pub(crate) base: u8,
    pub(crate) span: u8,
}

impl DownloadProgressRange {
    fn end(self) -> u8 {
        self.base.saturating_add(self.span).min(100)
    }
}

#[derive(Default)]
struct DownloadControl {
    paused: bool,
    canceled: bool,
}

static DOWNLOAD_CONTROL: OnceLock<(Mutex<DownloadControl>, Condvar)> = OnceLock::new();

fn download_control() -> &'static (Mutex<DownloadControl>, Condvar) {
    DOWNLOAD_CONTROL.get_or_init(|| (Mutex::new(DownloadControl::default()), Condvar::new()))
}

pub(crate) fn begin_download_task() -> Result<(), String> {
    let (state, wake) = download_control();
    let mut state = state
        .lock()
        .map_err(|_| "模型下载控制状态不可用".to_string())?;
    state.paused = false;
    state.canceled = false;
    wake.notify_all();
    Ok(())
}

pub(crate) fn clear_completed_downloads(app: &AppHandle) -> Result<usize, String> {
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位下载缓存: {error}"))?
        .join("download-cache");
    clear_completed_downloads_in(&cache)
}

fn clear_completed_downloads_in(cache: &Path) -> Result<usize, String> {
    if !cache.is_dir() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(cache).map_err(|error| format!("无法读取下载缓存: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("无法读取下载缓存文件: {error}"))?
            .path();
        let extension = path.extension().and_then(|value| value.to_str());
        let empty_partial = extension == Some("part")
            && fs::metadata(&path).is_ok_and(|metadata| metadata.len() == 0);
        if extension == Some("download") || empty_partial {
            fs::remove_file(&path).map_err(|error| format!("无法清理下载缓存: {error}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

pub(crate) fn set_download_paused(paused: bool) -> Result<(), String> {
    let (state, wake) = download_control();
    let mut state = state
        .lock()
        .map_err(|_| "模型下载控制状态不可用".to_string())?;
    if state.canceled {
        return Err(DOWNLOAD_CANCELED.to_string());
    }
    state.paused = paused;
    if !paused {
        wake.notify_all();
    }
    Ok(())
}

pub(crate) fn cancel_download() -> Result<(), String> {
    let (state, wake) = download_control();
    let mut state = state
        .lock()
        .map_err(|_| "模型下载控制状态不可用".to_string())?;
    state.canceled = true;
    state.paused = false;
    wake.notify_all();
    Ok(())
}

fn wait_for_download_permission() -> Result<(), String> {
    let (state, wake) = download_control();
    let mut state = state
        .lock()
        .map_err(|_| "模型下载控制状态不可用".to_string())?;
    while state.paused && !state.canceled {
        state = wake
            .wait(state)
            .map_err(|_| "模型下载控制状态不可用".to_string())?;
    }
    if state.canceled {
        Err(DOWNLOAD_CANCELED.to_string())
    } else {
        Ok(())
    }
}

fn download_was_canceled(error: &str) -> bool {
    error.contains(DOWNLOAD_CANCELED)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    stage: &'static str,
    progress: u8,
    detail: String,
}

pub(crate) fn download_cached(
    app: &AppHandle,
    source: &str,
    sha256: &str,
    progress: DownloadProgressRange,
    label: &str,
) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位下载缓存: {error}"))?
        .join("download-cache");
    fs::create_dir_all(&cache).map_err(|error| format!("无法创建下载缓存: {error}"))?;

    let key = cache_key(source);
    let complete = cache.join(format!("{key}.download"));
    if complete.is_file() {
        if sha256.is_empty() || verify_sha256(&complete, sha256)? {
            emit_progress(app, progress.end(), &format!("{label}已从缓存恢复"));
            return Ok(complete);
        }
        let _ = fs::remove_file(&complete);
    }

    let client = download_client()?;
    let total = probe_range_size(&client, source);
    if total.is_some_and(|bytes| bytes >= PARALLEL_DOWNLOAD_BYTES) {
        let parallel_result = download_parallel(
            app,
            &client,
            source,
            &cache,
            &key,
            total.unwrap_or_default(),
            progress,
            label,
        );
        if let Err(parallel_error) = parallel_result {
            if download_was_canceled(&parallel_error) {
                return Err(parallel_error);
            }
            emit_progress(
                app,
                progress.base,
                &format!("{label}分片连接不稳定，正在切换断点续传"),
            );
            let partial = cache.join(format!("{key}.part"));
            download_sequential(app, &client, source, &partial, total, progress, label).map_err(
                |fallback_error| format!("{parallel_error}；单连接重试也失败: {fallback_error}"),
            )?;
            fs::rename(partial, &complete).map_err(|error| format!("无法保存下载缓存: {error}"))?;
        }
    } else {
        download_sequential(
            app,
            &client,
            source,
            &cache.join(format!("{key}.part")),
            total,
            progress,
            label,
        )?;
        fs::rename(cache.join(format!("{key}.part")), &complete)
            .map_err(|error| format!("无法保存下载缓存: {error}"))?;
    }

    if !sha256.is_empty() && !verify_sha256(&complete, sha256)? {
        let _ = fs::remove_file(&complete);
        return Err("模型 SHA-256 校验失败，下载缓存已清理".to_string());
    }
    Ok(complete)
}

#[allow(clippy::too_many_arguments)]
fn download_parallel(
    app: &AppHandle,
    client: &Client,
    source: &str,
    cache: &Path,
    key: &str,
    total: u64,
    progress: DownloadProgressRange,
    label: &str,
) -> Result<(), String> {
    let downloaded = AtomicU64::new(0);
    let emitted_percent = AtomicU64::new(u64::MAX);
    let started = Instant::now();
    let chunk_size = total.div_ceil(PARALLEL_PARTS);
    let mut parts = Vec::new();

    for index in 0..PARALLEL_PARTS {
        let start = index * chunk_size;
        if start >= total {
            break;
        }
        let end = ((index + 1) * chunk_size).min(total) - 1;
        let path = cache.join(format!("{key}.part-{index}"));
        let expected = end - start + 1;
        let existing = part_size(&path, expected)?;
        downloaded.fetch_add(existing, Ordering::Relaxed);
        parts.push((path, start, end, existing));
    }

    emit_download_progress(
        app,
        downloaded.load(Ordering::Relaxed),
        Some(total),
        started,
        progress,
        label,
    );

    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for (path, start, end, existing) in &parts {
            if start + existing > *end {
                continue;
            }
            let client = client.clone();
            let path = path.clone();
            let source = source.to_string();
            let app = app.clone();
            let label = label.to_string();
            let downloaded = &downloaded;
            let emitted_percent = &emitted_percent;
            handles.push(scope.spawn(move || {
                let expected = end - start + 1;
                let mut last_error = None;
                for attempt in 0..3 {
                    let current = fs::metadata(&path).map(|value| value.len()).unwrap_or(0);
                    if current == expected {
                        return Ok(());
                    }
                    let response = match client
                        .get(&source)
                        .header(RANGE, format!("bytes={}-{}", start + current, end))
                        .send()
                    {
                        Ok(response) => response,
                        Err(error) => {
                            last_error = Some(format!("模型分片下载失败: {error}"));
                            std::thread::sleep(Duration::from_millis(400 * (attempt + 1)));
                            continue;
                        }
                    };
                    if response.status() != StatusCode::PARTIAL_CONTENT {
                        return Err(format!("下载源未返回分片内容 ({})", response.status()));
                    }
                    match stream_response(
                        response,
                        &path,
                        true,
                        downloaded,
                        emitted_percent,
                        Some(total),
                        started,
                        progress,
                        &app,
                        &label,
                    ) {
                        Ok(())
                            if fs::metadata(&path).map(|value| value.len()).unwrap_or(0)
                                == expected =>
                        {
                            return Ok(());
                        }
                        Ok(()) => {
                            last_error = Some("模型分片提前结束".to_string());
                        }
                        Err(error) => {
                            last_error = Some(error);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(400 * (attempt + 1)));
                }
                Err(last_error.unwrap_or_else(|| "模型分片下载失败".to_string()))
            }));
        }
        for handle in handles {
            handle
                .join()
                .map_err(|_| "模型下载线程异常退出".to_string())??;
        }
        Ok::<(), String>(())
    })?;

    let temporary = cache.join(format!("{key}.merging"));
    let complete = cache.join(format!("{key}.download"));
    let mut output =
        fs::File::create(&temporary).map_err(|error| format!("无法合并模型分片: {error}"))?;
    for (path, _, _, _) in &parts {
        let input = fs::File::open(path).map_err(|error| format!("无法读取模型分片: {error}"))?;
        io::copy(
            &mut BufReader::with_capacity(BUFFER_BYTES, input),
            &mut output,
        )
        .map_err(|error| format!("无法合并模型分片: {error}"))?;
    }
    output
        .sync_all()
        .map_err(|error| format!("无法完成模型分片合并: {error}"))?;
    drop(output);
    fs::rename(&temporary, &complete).map_err(|error| format!("无法保存模型下载: {error}"))?;
    for (path, _, _, _) in parts {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn download_sequential(
    app: &AppHandle,
    client: &Client,
    source: &str,
    partial: &Path,
    probed_total: Option<u64>,
    progress: DownloadProgressRange,
    label: &str,
) -> Result<(), String> {
    let mut existing = fs::metadata(partial).map(|value| value.len()).unwrap_or(0);
    if probed_total.is_some_and(|total| existing > total) {
        fs::remove_file(partial).map_err(|error| format!("无法重置下载缓存: {error}"))?;
        existing = 0;
    }
    if probed_total == Some(existing) && existing > 0 {
        return Ok(());
    }

    let mut request = client.get(source);
    if existing > 0 {
        request = request.header(RANGE, format!("bytes={existing}-"));
    }
    let response = request
        .send()
        .map_err(|error| format!("模型下载失败: {error}"))?;
    let append = existing > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
    if !response.status().is_success() {
        return Err(format!("模型下载失败: HTTP {}", response.status()));
    }
    if !append {
        existing = 0;
    }
    let response_total = response
        .content_length()
        .map(|length| length.saturating_add(existing));
    let total = probed_total.or(response_total);
    let downloaded = AtomicU64::new(existing);
    let emitted_percent = AtomicU64::new(u64::MAX);
    stream_response(
        response,
        partial,
        append,
        &downloaded,
        &emitted_percent,
        total,
        Instant::now(),
        progress,
        app,
        label,
    )
}

#[allow(clippy::too_many_arguments)]
fn stream_response(
    mut response: Response,
    destination: &Path,
    append: bool,
    downloaded: &AtomicU64,
    emitted_percent: &AtomicU64,
    total: Option<u64>,
    started: Instant,
    progress: DownloadProgressRange,
    app: &AppHandle,
    label: &str,
) -> Result<(), String> {
    let mut output = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(destination)
        .map_err(|error| format!("无法创建下载缓存文件: {error}"))?;
    let mut buffer = vec![0_u8; BUFFER_BYTES];
    loop {
        wait_for_download_permission()?;
        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("读取模型下载内容失败: {error}"))?;
        if count == 0 {
            break;
        }
        wait_for_download_permission()?;
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("写入模型下载缓存失败: {error}"))?;
        let current = downloaded.fetch_add(count as u64, Ordering::Relaxed) + count as u64;
        let percent = total
            .filter(|value| *value > 0)
            .map(|value| current.saturating_mul(100) / value)
            .unwrap_or(current / (4 * 1024 * 1024));
        let previous = emitted_percent.swap(percent, Ordering::Relaxed);
        if previous != percent {
            emit_download_progress(app, current, total, started, progress, label);
        }
    }
    output
        .sync_all()
        .map_err(|error| format!("无法完成模型下载: {error}"))
}

fn emit_download_progress(
    app: &AppHandle,
    downloaded: u64,
    total: Option<u64>,
    started: Instant,
    progress: DownloadProgressRange,
    label: &str,
) {
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    let speed = downloaded as f64 / elapsed;
    let progress = total
        .filter(|value| *value > 0)
        .map(|value| {
            progress
                .base
                .saturating_add(
                    ((downloaded.saturating_mul(progress.span as u64) / value)
                        .min(progress.span as u64)) as u8,
                )
                .min(100)
        })
        .unwrap_or(progress.base.min(100));
    let detail = if let Some(total) = total {
        format!(
            "{label} {}% · {}/s",
            downloaded.saturating_mul(100) / total.max(1),
            format_size(speed)
        )
    } else {
        format!(
            "{label} {} · {}/s",
            format_size(downloaded as f64),
            format_size(speed)
        )
    };
    emit_progress(app, progress, &detail);
}

fn emit_progress(app: &AppHandle, progress: u8, detail: &str) {
    let _ = app.emit(
        "plugin-install-progress",
        DownloadProgress {
            stage: "downloading",
            progress,
            detail: detail.to_string(),
        },
    );
}

fn probe_range_size(client: &Client, source: &str) -> Option<u64> {
    let response = client.get(source).header(RANGE, "bytes=0-0").send().ok()?;
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return None;
    }
    parse_content_range(response.headers().get(CONTENT_RANGE)?.to_str().ok()?)
}

fn parse_content_range(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.parse().ok()
}

fn part_size(path: &Path, expected: u64) -> Result<u64, String> {
    let size = fs::metadata(path).map(|value| value.len()).unwrap_or(0);
    if size <= expected {
        return Ok(size);
    }
    fs::remove_file(path).map_err(|error| format!("无法重置模型分片: {error}"))?;
    Ok(0)
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool, String> {
    let file = fs::File::open(path).map_err(|error| format!("无法读取下载缓存: {error}"))?;
    let mut reader = BufReader::with_capacity(BUFFER_BYTES, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; BUFFER_BYTES];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("无法校验下载缓存: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected))
}

fn cache_key(source: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(source.as_bytes()));
    digest[..24].to_string()
}

fn download_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("QwenAudio-Toolkits/0.1")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30 * 60))
        .tcp_keepalive(Duration::from_secs(30))
        .pool_max_idle_per_host(PARALLEL_PARTS as usize)
        .build()
        .map_err(|error| format!("无法创建模型下载客户端: {error}"))
}

fn format_size(bytes: f64) -> String {
    if bytes >= 1024_f64.powi(3) {
        format!("{:.1} GB", bytes / 1024_f64.powi(3))
    } else if bytes >= 1024_f64.powi(2) {
        format!("{:.1} MB", bytes / 1024_f64.powi(2))
    } else {
        format!("{:.0} KB", bytes / 1024_f64)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        begin_download_task, cache_key, cancel_download, clear_completed_downloads_in,
        parse_content_range, set_download_paused, wait_for_download_permission,
    };
    use std::{env, fs, sync::mpsc, thread, time::Duration};

    #[test]
    fn parses_range_total() {
        assert_eq!(parse_content_range("bytes 0-0/123456"), Some(123456));
        assert_eq!(parse_content_range("invalid"), None);
    }

    #[test]
    fn cache_key_is_stable_and_path_safe() {
        let key = cache_key("https://example.com/model.tar.bz2");
        assert_eq!(key.len(), 24);
        assert!(key.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn completed_and_empty_downloads_are_removed_but_resumable_parts_survive() {
        let cache =
            env::temp_dir().join(format!("qwen-audio-download-cache-{}", cache_key("test")));
        fs::create_dir_all(&cache).expect("create cache");
        fs::write(cache.join("model.download"), b"complete").expect("write complete cache");
        fs::write(cache.join("model.part"), b"partial").expect("write partial cache");
        fs::write(cache.join("empty.part"), b"").expect("write empty partial cache");

        assert_eq!(
            clear_completed_downloads_in(&cache).expect("clear cache"),
            2
        );
        assert!(!cache.join("model.download").exists());
        assert!(!cache.join("empty.part").exists());
        assert!(cache.join("model.part").is_file());
        let _ = fs::remove_dir_all(cache);
    }

    #[test]
    fn download_control_pauses_resumes_and_cancels() {
        begin_download_task().expect("reset download control");
        set_download_paused(true).expect("pause download");
        let (sender, receiver) = mpsc::channel();
        let waiter = thread::spawn(move || {
            sender
                .send(wait_for_download_permission())
                .expect("send wait result");
        });
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        set_download_paused(false).expect("resume download");
        assert!(receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("receive resumed result")
            .is_ok());
        waiter.join().expect("join download waiter");

        cancel_download().expect("cancel download");
        assert!(wait_for_download_permission()
            .expect_err("canceled download must stop")
            .contains("已取消"));
        begin_download_task().expect("reset canceled download");
    }
}
