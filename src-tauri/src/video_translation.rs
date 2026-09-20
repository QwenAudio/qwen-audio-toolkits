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

struct VideoTranslationTask {
    cancellation: Arc<AtomicBool>,
    child: Option<std::process::Child>,
}

#[derive(Default)]
struct VideoTranslationTasks {
    stopping: bool,
    tasks: HashMap<String, VideoTranslationTask>,
}

#[derive(Clone, Default)]
pub struct VideoTranslationRuntime(Arc<Mutex<VideoTranslationTasks>>);

impl VideoTranslationRuntime {
    fn register_task(&self, task_id: String) -> Result<Arc<AtomicBool>, String> {
        let mut tasks = self
            .0
            .lock()
            .map_err(|_| "视频配音运行状态不可用".to_owned())?;
        if tasks.stopping {
            return Err("应用正在退出，无法启动视频配音".to_owned());
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        tasks.tasks.insert(
            task_id,
            VideoTranslationTask {
                cancellation: cancellation.clone(),
                child: None,
            },
        );
        Ok(cancellation)
    }

    /// Spawns and registers the root while holding the task registry lock. `stop()` and
    /// cancellation can therefore either take the registered child or prevent this spawn.
    fn spawn_child(&self, task_id: &str, command: &mut Command) -> Result<bool, String> {
        let mut tasks = self
            .0
            .lock()
            .map_err(|_| "视频配音运行状态不可用".to_owned())?;
        let can_spawn = !tasks.stopping
            && tasks
                .tasks
                .get(task_id)
                .is_some_and(|task| !task.cancellation.load(Ordering::Acquire));
        if !can_spawn {
            return Ok(false);
        }
        let child = command.spawn().map_err(|error| error.to_string())?;
        let task = tasks
            .tasks
            .get_mut(task_id)
            .expect("task must remain registered while the registry lock is held");
        task.child = Some(child);
        Ok(true)
    }

    fn take_output(
        &self,
        task_id: &str,
    ) -> Result<
        (
            Option<std::process::ChildStdout>,
            Option<std::process::ChildStderr>,
        ),
        String,
    > {
        let mut tasks = self
            .0
            .lock()
            .map_err(|_| "视频配音运行状态不可用".to_owned())?;
        let child = tasks
            .tasks
            .get_mut(task_id)
            .and_then(|task| task.child.as_mut())
            .ok_or_else(|| "视频配音任务已经结束".to_owned())?;
        Ok((child.stdout.take(), child.stderr.take()))
    }

    fn try_wait_child(&self, task_id: &str) -> Result<Option<std::process::ExitStatus>, String> {
        let mut tasks = self
            .0
            .lock()
            .map_err(|_| "视频配音运行状态不可用".to_owned())?;
        let status = tasks
            .tasks
            .get_mut(task_id)
            .and_then(|task| task.child.as_mut())
            .map(|child| child.try_wait())
            .transpose()
            .map_err(|error| error.to_string())?
            .flatten();
        if status.is_some() {
            tasks.tasks.remove(task_id);
        }
        Ok(status)
    }

    fn discard_task(&self, task_id: &str) {
        if let Ok(mut tasks) = self.0.lock() {
            tasks.tasks.remove(task_id);
        }
    }

    fn terminate_task(&self, task_id: &str) -> Result<bool, String> {
        let child = {
            let mut tasks = self
                .0
                .lock()
                .map_err(|_| "视频配音运行状态不可用".to_owned())?;
            let Some(mut task) = tasks.tasks.remove(task_id) else {
                return Ok(false);
            };
            task.cancellation.store(true, Ordering::Release);
            task.child.take()
        };
        if let Some(mut child) = child {
            crate::process_tree::terminate(&mut child).map_err(|error| error.to_string())?;
        }
        Ok(true)
    }

    pub fn stop(&self) {
        let children = match self.0.lock() {
            Ok(mut tasks) => {
                tasks.stopping = true;
                std::mem::take(&mut tasks.tasks)
                    .into_values()
                    .filter_map(|mut task| {
                        task.cancellation.store(true, Ordering::Release);
                        task.child.take()
                    })
                    .collect::<Vec<_>>()
            }
            Err(error) => {
                log::warn!("could not lock video translation runtime during shutdown: {error}");
                return;
            }
        };
        for mut child in children {
            if let Err(error) = crate::process_tree::terminate(&mut child) {
                log::warn!("could not terminate video translation process tree: {error}");
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoTranslationRequest {
    input_path: String,
    prompt: Option<String>,
    mode: Option<String>,
    dubbing_mode: Option<String>,
    source_language: Option<String>,
    target_language: Option<String>,
    dubbing_style: Option<String>,
    output_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVideoTranslationResult {
    task_id: String,
    output_dir: String,
}

fn video_translation_path(
    target_os: &str,
    inherited_path: Option<std::ffi::OsString>,
) -> Result<std::ffi::OsString, std::env::JoinPathsError> {
    let mut entries = Vec::new();
    if target_os == "macos" {
        entries.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    if let Some(inherited_path) = inherited_path {
        entries.extend(std::env::split_paths(&inherited_path));
    }
    std::env::join_paths(entries)
}

fn executable_candidates(
    target_os: &str,
    name: &str,
    inherited_directories: &[PathBuf],
) -> Vec<PathBuf> {
    let executable_name = if target_os == "windows" && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut directories = Vec::with_capacity(inherited_directories.len() + 2);
    if target_os == "macos" {
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    directories.extend_from_slice(inherited_directories);
    directories
        .into_iter()
        .map(|directory| directory.join(&executable_name))
        .collect()
}

fn executable(name: &str) -> Option<PathBuf> {
    let inherited_directories = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();
    executable_candidates(std::env::consts::OS, name, &inherited_directories)
        .into_iter()
        .find(|path| path.is_file())
}

const NODE_RUNTIME_REQUIREMENT: &str = "未找到可运行的 Node.js 20.19+。请安装 Node.js 20.19 或更高版本，确保 node 在 PATH 中，然后重启应用。";

fn parse_semver_number(value: &str) -> Option<u32> {
    (!value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0')))
    .then(|| value.parse().ok())
    .flatten()
}

fn valid_semver_identifiers(value: &str, reject_leading_zero_numbers: bool) -> bool {
    !value.is_empty()
        && value.split('.').all(|identifier| {
            !identifier.is_empty()
                && identifier
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && (!reject_leading_zero_numbers
                    || !identifier.bytes().all(|byte| byte.is_ascii_digit())
                    || identifier == "0"
                    || !identifier.starts_with('0'))
        })
}

fn parse_node_major_minor(version_output: &str) -> Option<(u32, u32)> {
    let version = version_output.trim().strip_prefix('v')?;
    let suffix_index = version.find(['-', '+']).unwrap_or(version.len());
    let (core, suffix) = version.split_at(suffix_index);
    let mut core_parts = core.split('.');
    let major = parse_semver_number(core_parts.next()?)?;
    let minor = parse_semver_number(core_parts.next()?)?;
    parse_semver_number(core_parts.next()?)?;
    if core_parts.next().is_some() {
        return None;
    }

    let suffix_is_valid = match suffix.strip_prefix('-') {
        Some(prerelease_and_build) => match prerelease_and_build.split_once('+') {
            Some((prerelease, build)) => {
                valid_semver_identifiers(prerelease, true) && valid_semver_identifiers(build, false)
            }
            None => valid_semver_identifiers(prerelease_and_build, true),
        },
        None => match suffix.strip_prefix('+') {
            Some(build) => valid_semver_identifiers(build, false),
            None => suffix.is_empty(),
        },
    };
    suffix_is_valid.then_some((major, minor))
}

fn node_version_is_supported(version_output: &str) -> bool {
    parse_node_major_minor(version_output)
        .is_some_and(|(major, minor)| major > 20 || (major == 20 && minor >= 19))
}

fn node_version_error(detected_version: &str) -> String {
    let detected_version = detected_version.trim();
    let detected_version = if detected_version.is_empty() {
        "(empty output)"
    } else {
        detected_version
    };
    format!(
        "检测到 Node.js 版本 {detected_version:?}，需要 Node.js 20.19+。请安装 Node.js 20.19 或更高版本，确保 node 在 PATH 中，然后重启应用。"
    )
}

fn node_preflight(
    node: Option<PathBuf>,
    version_output: impl FnOnce(&PathBuf) -> Result<String, String>,
) -> Result<PathBuf, String> {
    let node = node.ok_or_else(|| NODE_RUNTIME_REQUIREMENT.to_owned())?;
    let version = version_output(&node)
        .map_err(|error| format!("{NODE_RUNTIME_REQUIREMENT} (`node --version`: {error})"))?;
    if node_version_is_supported(&version) {
        Ok(node)
    } else {
        Err(node_version_error(&version))
    }
}

fn node_version_output(node: &PathBuf) -> Result<String, String> {
    let output = Command::new(node)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("exited with {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
        .ok_or_else(|| "找不到视频配音执行脚本，请重新安装应用".to_owned())
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
    let node = node_preflight(executable("node"), node_version_output)?;
    if executable("ffmpeg").is_none() || executable("ffprobe").is_none() {
        return Err("未找到 FFmpeg/FFprobe，无法处理视频配音".to_owned());
    }
    let mode = request.mode.clone().unwrap_or_else(|| "local".to_owned());
    let bailian_env = if mode == "bailian" {
        crate::harness::bailian_video_translation_env(&app)?
    } else {
        Vec::new()
    };
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
    let command_path = video_translation_path(std::env::consts::OS, std::env::var_os("PATH"))
        .map_err(|error| format!("无法配置视频配音 PATH: {error}"))?;

    let cancellation = runtime.inner().register_task(task_id.clone())?;

    let background_runtime = runtime.inner().clone();
    let background_task_id = task_id.clone();
    let background_output_dir = output_dir.clone();
    std::thread::spawn(move || {
        emit(
            &app,
            &background_task_id,
            json!({"stage":"preparing","progress":1,"message":"正在启动视频配音"}),
        );
        let mut command = Command::new(node);
        for name in [
            "DASHSCOPE_API_KEY",
            "DASHSCOPE_HTTP_BASE_URL",
            "DASHSCOPE_WEBSOCKET_BASE_URL",
            "DASHSCOPE_BASE_URL",
            "QWEN_AUDIO_BAILIAN_API_KEY",
            "QWEN_AUDIO_BAILIAN_BASE_URL",
        ] {
            command.env_remove(name);
        }
        command.envs(bailian_env);
        command
            .arg(script)
            .arg(&input_path)
            .arg(&background_output_dir)
            .env("QWEN_AUDIO_TOOLKITS_API", "http://127.0.0.1:3847/v1")
            .env("VIDEO_TRANSLATION_MODE", &mode)
            .env(
                "VIDEO_TRANSLATION_PROMPT",
                request.prompt.unwrap_or_default(),
            )
            .env(
                "VIDEO_DUBBING_MODE",
                request.dubbing_mode.as_deref().unwrap_or("translate"),
            )
            .env(
                "VIDEO_SOURCE_LANGUAGE",
                request.source_language.unwrap_or_default(),
            )
            .env(
                "VIDEO_TARGET_LANGUAGE",
                request.target_language.unwrap_or_default(),
            )
            .env(
                "VIDEO_DUBBING_STYLE",
                request.dubbing_style.unwrap_or_default(),
            )
            .env("PATH", command_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process_tree::configure_command(&mut command);

        if cancellation.load(Ordering::Acquire) {
            emit(
                &app,
                &background_task_id,
                json!({"status":"canceled","stage":"canceled","progress":100,"message":"视频配音已取消"}),
            );
            return;
        }
        match background_runtime.spawn_child(&background_task_id, &mut command) {
            Ok(true) => {}
            Ok(false) => {
                emit(
                    &app,
                    &background_task_id,
                    json!({"status":"canceled","stage":"canceled","progress":100,"message":"视频配音已取消"}),
                );
                return;
            }
            Err(error) => {
                background_runtime.discard_task(&background_task_id);
                emit(
                    &app,
                    &background_task_id,
                    json!({"status":"failed","stage":"failed","progress":100,"message":"视频配音启动失败","error":error}),
                );
                return;
            }
        }
        let (stdout, stderr) = match background_runtime.take_output(&background_task_id) {
            Ok(output) => output,
            Err(_) if cancellation.load(Ordering::Acquire) => {
                emit(
                    &app,
                    &background_task_id,
                    json!({"status":"canceled","stage":"canceled","progress":100,"message":"视频配音已取消"}),
                );
                return;
            }
            Err(error) => {
                let _ = background_runtime.terminate_task(&background_task_id);
                emit(
                    &app,
                    &background_task_id,
                    json!({"status":"failed","stage":"failed","progress":100,"message":"视频配音启动失败","error":error}),
                );
                return;
            }
        };
        let (sender, receiver) = mpsc::channel::<(bool, String)>();
        if let Some(stdout) = stdout {
            let sender = sender.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let _ = sender.send((false, line));
                }
            });
        }
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    let _ = sender.send((true, line));
                }
            });
        }

        let mut errors = VecDeque::with_capacity(12);
        let mut emitted_completion = false;
        loop {
            if cancellation.load(Ordering::Acquire) {
                if let Err(error) = background_runtime.terminate_task(&background_task_id) {
                    log::warn!(
                        "could not terminate canceled video translation process tree: {error}"
                    );
                }
                emit(
                    &app,
                    &background_task_id,
                    json!({"status":"canceled","stage":"canceled","progress":100,"message":"视频配音已取消"}),
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
            match background_runtime.try_wait_child(&background_task_id) {
                Ok(Some(status)) => {
                    if status.success() {
                        if !emitted_completion {
                            emit(
                                &app,
                                &background_task_id,
                                json!({"status":"completed","stage":"completed","progress":100,"message":"视频配音已完成","outputDir":background_output_dir}),
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
                            json!({"status":"failed","stage":"failed","progress":100,"message":"视频配音失败","error":errors.into_iter().collect::<Vec<_>>().join("\n")}),
                        );
                    }
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = background_runtime.terminate_task(&background_task_id);
                    emit(
                        &app,
                        &background_task_id,
                        json!({"status":"failed","stage":"failed","progress":100,"message":"无法读取视频配音状态","error":error}),
                    );
                    break;
                }
            }
        }
        background_runtime.discard_task(&background_task_id);
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
    runtime
        .inner()
        .terminate_task(&task_id)?
        .then_some(())
        .ok_or_else(|| "视频配音任务已经结束".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_translation_path_prepends_macos_ffmpeg_directories() {
        let inherited =
            std::env::join_paths([PathBuf::from("/existing/bin"), PathBuf::from("/opt/bin")])
                .expect("join inherited PATH");
        let planned = video_translation_path("macos", Some(inherited))
            .expect("build macOS video translation PATH");

        assert_eq!(
            std::env::split_paths(&planned).collect::<Vec<_>>(),
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/existing/bin"),
                PathBuf::from("/opt/bin"),
            ]
        );
    }

    #[test]
    fn video_translation_path_preserves_non_macos_path_entries() {
        let inherited =
            std::env::join_paths([PathBuf::from("existing-one"), PathBuf::from("existing-two")])
                .expect("join inherited PATH");

        for platform in ["windows", "linux"] {
            assert_eq!(
                video_translation_path(platform, Some(inherited.clone()))
                    .expect("build non-macOS video translation PATH"),
                inherited,
                "{platform} must not receive macOS PATH entries"
            );
        }
    }

    #[test]
    fn plans_macos_and_windows_executable_candidates() {
        let inherited = vec![PathBuf::from("/inherited/bin")];
        assert_eq!(
            executable_candidates("macos", "node", &inherited),
            vec![
                PathBuf::from("/opt/homebrew/bin/node"),
                PathBuf::from("/usr/local/bin/node"),
                PathBuf::from("/inherited/bin/node"),
            ]
        );
        for tool in ["ffmpeg", "ffprobe", "node"] {
            assert_eq!(
                executable_candidates("windows", tool, &inherited),
                vec![PathBuf::from("/inherited/bin").join(format!("{tool}.exe"))],
                "{tool} must use its ordinary Windows executable name"
            );
        }
    }

    #[test]
    fn node_version_requirement_accepts_minimum_and_newer_versions() {
        for version in ["v20.19.0", "v20.19.7-rc.1", "v21.0.0", "v26.0.0"] {
            assert!(
                node_version_is_supported(version),
                "{version} must satisfy the Node.js requirement"
            );
        }
    }

    #[test]
    fn node_version_requirement_rejects_older_versions() {
        for version in ["v19.99.99", "v20.18.0", "v20.18.99"] {
            assert!(
                !node_version_is_supported(version),
                "{version} must not satisfy the Node.js requirement"
            );
        }
    }

    #[test]
    fn node_version_requirement_rejects_malformed_versions() {
        for version in ["", "20.19.0", "v20", "v20.19", "v20.x.0", "v20.19.0 bad"] {
            assert!(
                !node_version_is_supported(version),
                "{version:?} must be rejected as malformed"
            );
        }
    }

    #[test]
    fn node_preflight_rejects_missing_unrunnable_and_unsupported_executables() {
        let missing = node_preflight(None, |_| Ok("v26.0.0".to_owned()))
            .expect_err("missing Node must fail preflight");
        assert!(missing.contains("Node.js 20.19+"));

        let unrunnable = node_preflight(Some(PathBuf::from("/not-runnable-node")), |_| {
            Err("could not execute".to_owned())
        })
        .expect_err("unrunnable Node must fail preflight");
        assert!(unrunnable.contains("Node.js 20.19+"));

        let unsupported = node_preflight(Some(PathBuf::from("/old-node")), |_| {
            Ok("v20.18.9".to_owned())
        })
        .expect_err("unsupported Node must fail preflight");
        assert!(unsupported.contains("v20.18.9"));
        assert!(unsupported.contains("Node.js 20.19+"));
    }

    #[cfg(unix)]
    #[test]
    fn stopping_runtime_terminates_the_registered_video_process_tree() {
        fn process_exists(pid: libc::pid_t) -> bool {
            let result = unsafe { libc::kill(pid, 0) };
            result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }

        let task_id = "video-process-tree-test".to_string();
        let descendant_path =
            std::env::temp_dir().join(format!("toolkits-video-descendant-{}", std::process::id()));
        let runtime = VideoTranslationRuntime::default();
        let cancellation = runtime
            .register_task(task_id.clone())
            .expect("register video task");
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait \"$child\"",
                "sh",
            ])
            .arg(&descendant_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::process_tree::configure_command(&mut command);
        runtime
            .spawn_child(&task_id, &mut command)
            .expect("spawn video process tree");
        let root_pid = {
            let tasks = runtime.0.lock().expect("read runtime tasks");
            libc::pid_t::try_from(
                tasks
                    .tasks
                    .get(&task_id)
                    .and_then(|task| task.child.as_ref())
                    .expect("registered task owns child")
                    .id(),
            )
            .expect("root PID fits pid_t")
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let descendant_pid = loop {
            if let Ok(value) = std::fs::read_to_string(&descendant_path) {
                break value
                    .trim()
                    .parse::<libc::pid_t>()
                    .expect("descendant PID is valid");
            }
            assert!(
                std::time::Instant::now() < deadline,
                "video process tree did not report its descendant PID"
            );
            std::thread::sleep(Duration::from_millis(10));
        };

        runtime.stop();

        assert!(cancellation.load(Ordering::Acquire));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline
            && (process_exists(root_pid) || process_exists(descendant_pid))
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!process_exists(root_pid), "video root must be reaped");
        assert!(
            !process_exists(descendant_pid),
            "video descendant must be terminated"
        );
        std::fs::remove_file(descendant_path).expect("remove descendant PID file");
    }
}
