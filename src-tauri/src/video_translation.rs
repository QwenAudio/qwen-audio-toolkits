use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use uuid::Uuid;

const EVENT_NAME: &str = "video-translation-progress";
const PROGRESS_PREFIX: &str = "@@QWEN_VIDEO_TRANSLATION@@";

#[derive(Clone, Default)]
pub struct VideoTranslationRuntime {
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoTranslationRequest {
    input_path: String,
    prompt: Option<String>,
    mode: Option<String>,
    output_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoTranslationResult {
    task_id: String,
    output_dir: String,
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

fn script_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let development =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/video-translation-demo.mjs");
    if development.is_file() {
        return Ok(development);
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("scripts/video-translation-demo.mjs");
    bundled
        .is_file()
        .then_some(bundled)
        .ok_or_else(|| "找不到视频翻译执行脚本，请重新安装应用".to_owned())
}

fn emit(app: &tauri::AppHandle, task_id: &str, mut payload: Value) {
    if let Some(object) = payload.as_object_mut() {
        object.insert("taskId".to_owned(), json!(task_id));
        object
            .entry("status".to_owned())
            .or_insert(json!("running"));
    }
    if let Err(error) = app.emit(EVENT_NAME, payload) {
        log::warn!("could not emit video translation progress: {error}");
    }
}

#[tauri::command]
pub fn start_video_translation(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, VideoTranslationRuntime>,
    request: StartVideoTranslationRequest,
) -> Result<StartVideoTranslationResult, String> {
    let input_path = PathBuf::from(&request.input_path);
    if !input_path.is_file() {
        return Err("选择的视频文件不存在".to_owned());
    }
    let node = executable("node").ok_or_else(|| "未找到 Node.js，无法启动视频翻译".to_owned())?;
    if executable("ffmpeg").is_none() || executable("ffprobe").is_none() {
        return Err("未找到 FFmpeg/FFprobe，无法处理视频".to_owned());
    }
    let script = script_path(&app)?;
    let task_id = format!("translation-{}", Uuid::new_v4());
    let output_dir = request.output_dir.map(PathBuf::from).unwrap_or(
        app.path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("video-translations")
            .join(&task_id),
    );
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;

    let cancellation = Arc::new(AtomicBool::new(false));
    runtime
        .cancellations
        .lock()
        .map_err(|_| "视频翻译运行状态不可用".to_owned())?
        .insert(task_id.clone(), cancellation.clone());

    let background_runtime = runtime.inner().clone();
    let background_task_id = task_id.clone();
    let background_output_dir = output_dir.clone();
    std::thread::spawn(move || {
        emit(
            &app,
            &background_task_id,
            json!({"stage":"preparing","progress":1,"message":"正在启动视频翻译"}),
        );
        let mut command = Command::new(node);
        command
            .arg(script)
            .arg(&input_path)
            .arg(&background_output_dir)
            .env("QWEN_AUDIO_TOOLKITS_API", "http://127.0.0.1:3847/v1")
            .env(
                "VIDEO_TRANSLATION_MODE",
                request.mode.as_deref().unwrap_or("local"),
            )
            .env(
                "VIDEO_TRANSLATION_PROMPT",
                request.prompt.unwrap_or_default(),
            )
            .env(
                "PATH",
                format!(
                    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                emit(
                    &app,
                    &background_task_id,
                    json!({"status":"failed","stage":"failed","progress":100,"message":"视频翻译启动失败","error":error.to_string()}),
                );
                if let Ok(mut tasks) = background_runtime.cancellations.lock() {
                    tasks.remove(&background_task_id);
                }
                return;
            }
        };
        let (sender, receiver) = mpsc::channel::<(bool, String)>();
        if let Some(stdout) = child.stdout.take() {
            let sender = sender.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let _ = sender.send((false, line));
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = sender.send((true, line));
                }
            });
        }

        let mut errors = VecDeque::with_capacity(12);
        let mut emitted_completion = false;
        loop {
            if cancellation.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                emit(
                    &app,
                    &background_task_id,
                    json!({"status":"canceled","stage":"canceled","progress":100,"message":"视频翻译已取消"}),
                );
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(120)) {
                Ok((is_error, line)) => {
                    if is_error {
                        if errors.len() == 12 {
                            errors.pop_front();
                        }
                        errors.push_back(line);
                    } else if let Some(raw) = line.strip_prefix(PROGRESS_PREFIX) {
                        if let Ok(payload) = serde_json::from_str::<Value>(raw) {
                            emitted_completion |=
                                payload.get("status").and_then(Value::as_str) == Some("completed");
                            emit(&app, &background_task_id, payload);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected)
                | Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if status.success() {
                        if !emitted_completion {
                            emit(
                                &app,
                                &background_task_id,
                                json!({"status":"completed","stage":"completed","progress":100,"message":"视频翻译已完成","outputDir":background_output_dir}),
                            );
                        }
                    } else {
                        while let Ok((is_error, line)) = receiver.try_recv() {
                            if is_error {
                                if errors.len() == 12 {
                                    errors.pop_front();
                                }
                                errors.push_back(line);
                            }
                        }
                        emit(
                            &app,
                            &background_task_id,
                            json!({"status":"failed","stage":"failed","progress":100,"message":"视频翻译失败","error":errors.into_iter().collect::<Vec<_>>().join("\n")}),
                        );
                    }
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    emit(
                        &app,
                        &background_task_id,
                        json!({"status":"failed","stage":"failed","progress":100,"message":"无法读取视频翻译状态","error":error.to_string()}),
                    );
                    break;
                }
            }
        }
        if let Ok(mut tasks) = background_runtime.cancellations.lock() {
            tasks.remove(&background_task_id);
        }
    });

    Ok(StartVideoTranslationResult {
        task_id,
        output_dir: output_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn cancel_video_translation(
    runtime: tauri::State<'_, VideoTranslationRuntime>,
    task_id: String,
) -> Result<(), String> {
    let tasks = runtime
        .cancellations
        .lock()
        .map_err(|_| "视频翻译运行状态不可用".to_owned())?;
    let cancellation = tasks
        .get(&task_id)
        .ok_or_else(|| "视频翻译任务已经结束".to_owned())?;
    cancellation.store(true, Ordering::Relaxed);
    Ok(())
}
