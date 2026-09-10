use crate::{
    advanced_models::{run_audio_tagging, run_diarization, run_source_separation},
    onnx_audio::separate_mossformer2,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};
use uuid::Uuid;

const WORKER_ARGUMENT: &str = "--qwen-native-worker";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWorkerRequest {
    operation: String,
    model_dir: PathBuf,
    audio_data_url: String,
    adapter: Option<String>,
}

struct TemporaryWorkerFiles {
    paths: Vec<PathBuf>,
}

impl Drop for TemporaryWorkerFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = fs::remove_file(path);
        }
    }
}

fn execute(request: NativeWorkerRequest) -> Result<Value, String> {
    match request.operation.as_str() {
        "audio-tagging" => run_audio_tagging(&request.model_dir, &request.audio_data_url),
        "speaker-diarization" => run_diarization(&request.model_dir, &request.audio_data_url),
        "source-separation" if request.adapter.as_deref() == Some("mossformer2-separation") => {
            separate_mossformer2(&request.model_dir, &request.audio_data_url)
        }
        "source-separation" => run_source_separation(&request.model_dir, &request.audio_data_url),
        operation => Err(format!("不支持的原生 worker 操作: {operation}")),
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

pub(crate) fn run_isolated_audio_model(
    operation: &str,
    model_dir: &Path,
    audio_data_url: &str,
    adapter: Option<&str>,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let stamp = Uuid::new_v4();
    let directory = std::env::temp_dir();
    let request_path = directory.join(format!("qwen-native-worker-{stamp}.request.json"));
    let output_path = directory.join(format!("qwen-native-worker-{stamp}.output.json"));
    let error_path = directory.join(format!("qwen-native-worker-{stamp}.stderr.log"));
    let _temporary_files = TemporaryWorkerFiles {
        paths: vec![
            request_path.clone(),
            output_path.clone(),
            error_path.clone(),
        ],
    };
    let request = NativeWorkerRequest {
        operation: operation.to_string(),
        model_dir: model_dir.to_path_buf(),
        audio_data_url: audio_data_url.to_string(),
        adapter: adapter.map(str::to_string),
    };
    write_private(
        &request_path,
        &serde_json::to_vec(&request)
            .map_err(|error| format!("无法序列化原生 worker 请求: {error}"))?,
    )
    .map_err(|error| format!("无法写入原生 worker 请求: {error}"))?;
    write_private(&error_path, &[])
        .map_err(|error| format!("无法准备原生 worker 日志: {error}"))?;

    let executable = std::env::current_exe()
        .map_err(|error| format!("无法定位原生 worker 可执行文件: {error}"))?;
    let error_file = fs::OpenOptions::new()
        .append(true)
        .open(&error_path)
        .map_err(|error| format!("无法打开原生 worker 日志: {error}"))?;
    let mut child = Command::new(executable)
        .arg(WORKER_ARGUMENT)
        .arg(&request_path)
        .arg(&output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(error_file))
        .spawn()
        .map_err(|error| format!("无法启动原生 worker: {error}"))?;
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("任务已取消".to_string());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("无法检查原生 worker 状态: {error}"))?
        {
            break status;
        }
        thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        let error = fs::read_to_string(&error_path).unwrap_or_default();
        let detail = error
            .trim()
            .lines()
            .last()
            .unwrap_or("原生运行时异常退出")
            .to_string();
        return Err(format!(
            "原生模型 worker 失败（{}）：{detail}",
            status
                .code()
                .map(|code| format!("exit {code}"))
                .unwrap_or_else(|| "可能被原生库中止".to_string())
        ));
    }
    let bytes =
        fs::read(&output_path).map_err(|error| format!("无法读取原生 worker 输出: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("原生 worker 输出无效: {error}"))
}

pub fn run_from_arguments(arguments: &[String]) -> Option<i32> {
    if arguments.first().map(String::as_str) != Some(WORKER_ARGUMENT) {
        return None;
    }
    let result = (|| {
        let request_path = arguments
            .get(1)
            .ok_or_else(|| "原生 worker 缺少请求路径".to_string())?;
        let output_path = arguments
            .get(2)
            .ok_or_else(|| "原生 worker 缺少输出路径".to_string())?;
        let request = serde_json::from_slice::<NativeWorkerRequest>(
            &fs::read(request_path)
                .map_err(|error| format!("无法读取原生 worker 请求: {error}"))?,
        )
        .map_err(|error| format!("原生 worker 请求无效: {error}"))?;
        let output = execute(request)?;
        write_private(
            Path::new(output_path),
            &serde_json::to_vec(&output)
                .map_err(|error| format!("无法序列化原生 worker 输出: {error}"))?,
        )
        .map_err(|error| format!("无法写入原生 worker 输出: {error}"))?;
        Ok::<(), String>(())
    })();
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_regular_application_arguments() {
        assert_eq!(run_from_arguments(&[]), None);
        assert_eq!(run_from_arguments(&["--version".to_string()]), None);
    }

    #[test]
    fn rejects_incomplete_worker_arguments() {
        assert_eq!(run_from_arguments(&[WORKER_ARGUMENT.to_string()]), Some(1));
    }
}
