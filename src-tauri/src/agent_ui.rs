//! Generic local Python Agent UI launcher. Websites supply IDs, never paths or commands.
static SDK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const PYTHON_AGENT_PROVIDER_ENV_NAMES: [&str; 9] = [
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_HTTP_BASE_URL",
    "DASHSCOPE_WEBSOCKET_BASE_URL",
    "DASHSCOPE_BASE_URL",
    "DASHSCOPE_MODEL",
    "QWEN_AUDIO_BAILIAN_API_KEY",
    "QWEN_AUDIO_BAILIAN_BASE_URL",
    "QWEN_AUDIO_BAILIAN_TTS_MODEL",
    "QWEN_AUDIO_BAILIAN_ASR_MODEL",
];

fn configure_python_agent_install_env(command: &mut Command) {
    for name in PYTHON_AGENT_PROVIDER_ENV_NAMES {
        command.env_remove(name);
    }
}

fn configure_python_agent_provider_env(command: &mut Command, provider_env: &[(String, String)]) {
    configure_python_agent_install_env(command);
    command.envs(provider_env.iter().map(|(key, value)| (key, value)));
}

const MAX_WARM_AGENTS: usize = 3;

fn terminate_agent_process(child: &mut Child) {
    if let Err(error) = crate::process_tree::terminate(child) {
        log::warn!("could not terminate Python Agent process tree: {error}");
    }
}

struct WarmAgent {
    session: Session,
    child: Child,
    fingerprint: String,
    last_used: Instant,
}

fn insert_warm_agent(
    runtime: &AgentUiRuntime,
    id: String,
    mut agent: WarmAgent,
) -> Result<(), String> {
    let (previous, evicted) = {
        let mut agents = runtime.0.lock().map_err(|e| e.to_string())?;
        if runtime.2.load(Ordering::Acquire) {
            drop(agents);
            terminate_agent_process(&mut agent.child);
            return Err("应用正在退出，无法启动 Agent".to_string());
        }
        let previous = agents.remove(&id);
        let evicted_id = (agents.len() >= MAX_WARM_AGENTS)
            .then(|| {
                agents
                    .iter()
                    .min_by_key(|(_, candidate)| candidate.last_used)
                    .map(|(id, _)| id.clone())
            })
            .flatten();
        let evicted = evicted_id.and_then(|id| agents.remove(&id));
        agents.insert(id, agent);
        (previous, evicted)
    };
    for mut agent in previous.into_iter().chain(evicted) {
        terminate_agent_process(&mut agent.child);
    }
    Ok(())
}

#[derive(Default, Clone)]
pub struct AgentUiRuntime(
    Arc<Mutex<BTreeMap<String, WarmAgent>>>,
    Arc<Mutex<BTreeMap<String, Arc<Mutex<()>>>>>,
    Arc<AtomicBool>,
    Arc<Mutex<()>>,
    Arc<Mutex<BTreeMap<String, Child>>>,
);
impl AgentUiRuntime {
    fn agent_lock(&self, id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut locks = self.1.lock().map_err(|e| e.to_string())?;
        Ok(locks.entry(id.to_owned()).or_default().clone())
    }

    fn project_links_lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.3.lock().map_err(|e| e.to_string())
    }

    fn ensure_running(&self) -> Result<(), String> {
        if self.2.load(Ordering::Acquire) {
            Err("应用正在退出，无法启动 Agent".to_string())
        } else {
            Ok(())
        }
    }

    pub fn stop(&self) {
        self.2.store(true, Ordering::Release);
        let pending = self
            .4
            .lock()
            .map(|mut agents| std::mem::take(&mut *agents))
            .unwrap_or_default();
        let warm = self
            .0
            .lock()
            .map(|mut agents| std::mem::take(&mut *agents))
            .unwrap_or_default();
        for (_, mut child) in pending {
            terminate_agent_process(&mut child);
        }
        for (_, mut agent) in warm {
            terminate_agent_process(&mut agent.child);
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Session {
    url: String,
    title: String,
}

fn hash_project_sources(directory: &Path, hash: &mut Sha256) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir()
            && !name.starts_with('.')
            && !["models", "assets", "venv", "node_modules", "__pycache__"].contains(&name.as_str())
        {
            hash_project_sources(&entry.path(), hash)?;
        } else if kind.is_file() && name.ends_with(".py") {
            hash.update(entry.path().to_string_lossy().as_bytes());
            hash.update(fs::read(entry.path()).map_err(|e| e.to_string())?);
        }
    }
    Ok(())
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
        && !id.starts_with('.')
        && !id.contains("..")
}

fn read_project_links(path: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    match fs::read(path) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|e| format!("本地项目记录无效：{e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn replace_file_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn write_project_links(path: &Path, projects: &BTreeMap<String, PathBuf>) -> Result<(), String> {
    let bytes = serde_json::to_vec(projects).map_err(|e| e.to_string())?;
    replace_file_atomically(path, &bytes)
}

fn read_agent_control_file(path: &Path, max_bytes: u64) -> Result<Option<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("Agent 控制文件超过大小限制".to_string());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn uv_path() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let candidate = PathBuf::from(home).join(".local/bin/uv");
        if candidate.is_file() {
            return candidate;
        }
    }
    for path in ["/opt/homebrew/bin/uv", "/usr/local/bin/uv"] {
        if Path::new(path).is_file() {
            return PathBuf::from(path);
        }
    }
    PathBuf::from("uv")
}
fn checked(command: &mut Command, log: &Path) -> Result<(), String> {
    checked_timeout(command, log, Duration::from_secs(300))
}
fn checked_timeout(command: &mut Command, log: &Path, timeout: Duration) -> Result<(), String> {
    let output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| e.to_string())?;
    crate::process_tree::configure_command(command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(output.try_clone().map_err(|e| e.to_string())?)
        .stderr(output)
        .spawn()
        .map_err(|e| format!("无法准备 Python 环境，请确认已安装 uv：{e}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return if status.success() {
                Ok(())
            } else {
                Err(format!("环境准备失败，请查看 {}", log.display()))
            };
        }
        if start.elapsed() > timeout {
            terminate_agent_process(&mut child);
            return Err("环境准备超时，请检查网络后重试".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn launch(
    root: &Path,
    project: &Path,
    id: &str,
    runtime: AgentUiRuntime,
    prepare: bool,
    provider_env: Vec<(String, String)>,
    app: &tauri::AppHandle,
) -> Result<Session, String> {
    let lock = runtime.agent_lock(id)?;
    let _operation = lock.lock().map_err(|e| e.to_string())?;
    runtime.ensure_running()?;
    launch_inner(root, project, id, runtime, prepare, provider_env, app)
}
fn launch_inner(
    root: &Path,
    project: &Path,
    id: &str,
    runtime: AgentUiRuntime,
    prepare: bool,
    provider_env: Vec<(String, String)>,
    app: &tauri::AppHandle,
) -> Result<Session, String> {
    let launched_at = Instant::now();
    let progress = |message: &str| {
        let _ = app.emit("agent-ui-progress", serde_json::json!({"id": id, "message": message, "elapsedMs": launched_at.elapsed().as_millis() as u64}));
    };
    progress("检查本地项目，等待运行环境");
    if !project.join("agent_ui.py").is_file() {
        return Err("项目根目录需要 agent_ui.py，并提供 create_ui()".into());
    }
    let env = root.join("agent-environments").join(id);
    fs::create_dir_all(&env).map_err(|e| e.to_string())?;
    let sdk_guard = SDK_LOCK.lock().map_err(|e| e.to_string())?;
    let sdk = root.join("agent-ui-sdk");
    let package = sdk.join("toolkits");
    fs::create_dir_all(&package).map_err(|e| e.to_string())?;
    progress("检查 UI SDK，复用未变化的文件");
    for (name, content) in [
        ("streaming.py", include_str!("../../toolkits/streaming.py")),
        (
            "ui-streaming.js",
            include_str!("../../toolkits/ui-streaming.js"),
        ),
        ("__init__.py", include_str!("../../toolkits/__init__.py")),
        ("__main__.py", include_str!("../../toolkits/__main__.py")),
        ("server.py", include_str!("../../toolkits/server.py")),
        ("ui.html", include_str!("../../toolkits/ui.html")),
        ("ui.css", include_str!("../../toolkits/ui.css")),
        (
            "ui-content.js",
            include_str!("../../toolkits/ui-content.js"),
        ),
        ("ui.js", include_str!("../../toolkits/ui.js")),
    ] {
        let path = package.join(name);
        if fs::read(&path).ok().as_deref() != Some(content.as_bytes()) {
            fs::write(path, content).map_err(|e| e.to_string())?;
        }
    }
    // Expose the bundled SDK as a real local pip distribution. Agent requirements
    // can depend on qwenaudio-toolkits without requiring a PyPI publication.
    for (name, content) in [
        ("pyproject.toml", include_str!("../../pyproject.toml")),
        (
            "docs/python-sdk.md",
            include_str!("../../docs/python-sdk.md"),
        ),
        ("toolkits/py.typed", ""),
    ] {
        let path = sdk.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if fs::read(&path).ok().as_deref() != Some(content.as_bytes()) {
            fs::write(path, content).map_err(|e| e.to_string())?;
        }
    }
    drop(sdk_guard);
    let venv = env.join("venv");
    let python = venv.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    });
    let log = env.join("runtime.log");
    progress(if python.is_file() {
        "复用已有 Python 环境"
    } else {
        "首次准备 Python 环境（可能下载 Python）"
    });
    if !python.is_file() {
        checked(
            Command::new(uv_path())
                .args(["venv", "--python", "3.12"])
                .arg(&venv),
            &log,
        )?;
    }
    let requirements = project.join("requirements.txt");
    let pyproject = project.join("pyproject.toml");
    let mut hash = Sha256::new();
    hash.update(project.to_string_lossy().as_bytes());
    hash.update(include_str!("../../pyproject.toml").as_bytes());
    for path in [&requirements, &pyproject, &project.join("uv.lock")] {
        if path.is_file() {
            hash.update(fs::read(path).map_err(|e| e.to_string())?);
        }
    }
    let fingerprint = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut runtime_hash = Sha256::new();
    runtime_hash.update(fingerprint.as_bytes());
    runtime_hash.update(serde_json::to_vec(&provider_env).map_err(|e| e.to_string())?);
    hash_project_sources(project, &mut runtime_hash)?;
    for file in [
        "__init__.py",
        "__main__.py",
        "server.py",
        "streaming.py",
        "ui-streaming.js",
        "ui-content.js",
        "ui.html",
        "ui.css",
        "ui.js",
    ] {
        runtime_hash.update(fs::read(package.join(file)).map_err(|e| e.to_string())?);
    }
    let runtime_fingerprint = runtime_hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut guard = runtime.0.lock().map_err(|e| e.to_string())?;
    if !prepare {
        if let Some(agent) = guard.get_mut(id) {
            if agent.fingerprint == runtime_fingerprint
                && matches!(agent.child.try_wait(), Ok(None))
            {
                agent.last_used = Instant::now();
                progress("复用已启动的 Agent，跳过初始化");
                return Ok(agent.session.clone());
            }
        }
    }
    let previous = guard.remove(id);
    drop(guard);
    if let Some(mut agent) = previous {
        terminate_agent_process(&mut agent.child);
    }
    // Installation and startup must never evict another Agent's active session.
    let marker = env.join("dependencies.sha256");
    let dependencies_changed = fs::read_to_string(&marker).unwrap_or_default() != fingerprint;
    progress(if dependencies_changed {
        "安装或更新项目依赖"
    } else {
        "依赖未变化，跳过安装"
    });
    if dependencies_changed {
        {
            let mut command = Command::new(uv_path());
            command
                .args(["pip", "install", "--python"])
                .arg(&python)
                .arg(&sdk)
                .current_dir(project);
            if requirements.is_file() {
                command.arg("-r").arg(&requirements);
            }
            if pyproject.is_file() {
                command.args(["-e", "."]);
            }
            configure_python_agent_install_env(&mut command);
            checked(&mut command, &log)?;
        }
        fs::write(marker, fingerprint).map_err(|e| e.to_string())?;
    }
    if prepare {
        progress("下载并校验模型与运行资源");
        let mut command = Command::new(&python);
        command
            .arg("-m")
            .arg("toolkits")
            .arg(project)
            .arg("--prepare")
            .arg("--ui-cache")
            .arg(env.join("ui-definition.json"))
            .env("PYTHONPATH", &sdk);
        configure_python_agent_provider_env(&mut command, &provider_env);
        checked_timeout(&mut command, &log, Duration::from_secs(1800))?;
    }
    progress("启动 Python，等待 Agent 初始化");
    let progress_path = env.join("startup-progress.jsonl");
    fs::write(&progress_path, "").map_err(|e| e.to_string())?;
    let mut progress_lines = 0usize;
    let ready = env.join("ready.json");
    if ready.exists() {
        fs::remove_file(&ready).map_err(|e| e.to_string())?;
    }
    let output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(python);
    command
        .env("TOOLKITS_STARTUP_PROGRESS", &progress_path)
        .arg("-m")
        .arg("toolkits")
        .arg(project)
        .arg("--no-browser")
        .arg("--desktop")
        .arg("--ui-cache")
        .arg(env.join("ui-definition.json"))
        .arg("--ready-file")
        .arg(&ready)
        .env("PYTHONPATH", sdk)
        .stdin(Stdio::null())
        .stdout(output.try_clone().map_err(|e| e.to_string())?)
        .stderr(output);
    configure_python_agent_provider_env(&mut command, &provider_env);
    crate::process_tree::configure_command(&mut command);
    {
        let mut pending = runtime.4.lock().map_err(|e| e.to_string())?;
        runtime.ensure_running()?;
        let child = command.spawn().map_err(|e| e.to_string())?;
        pending.insert(id.to_string(), child);
    }
    let start = Instant::now();
    let result = loop {
        match read_agent_control_file(&progress_path, 32 * 1024) {
            Ok(Some(raw)) => {
                let lines: Vec<_> = raw.lines().collect();
                for line in lines.iter().skip(progress_lines) {
                    if let Ok(message) = serde_json::from_str::<String>(line) {
                        progress(&message);
                    }
                }
                progress_lines = lines.len();
            }
            Ok(None) => {}
            Err(error) => break Err(format!("无法读取 Agent 启动进度: {error}")),
        }
        let child_exited = {
            let mut pending = runtime.4.lock().map_err(|e| e.to_string())?;
            match pending.get_mut(id) {
                Some(child) => child.try_wait().map_err(|e| e.to_string())?,
                None => break Err("Agent 启动已被终止".to_string()),
            }
        };
        if child_exited.is_some() {
            break Err(format!("Agent 启动失败，请查看 {}", log.display()));
        }
        match read_agent_control_file(&ready, 8 * 1024) {
            Ok(Some(raw)) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(url) = value["url"].as_str() {
                        if let Ok(parsed) = reqwest::Url::parse(url) {
                            if parsed.scheme() == "http"
                                && parsed.host_str() == Some("127.0.0.1")
                                && parsed.port().is_some()
                                && parsed.username().is_empty()
                                && parsed.password().is_none()
                            {
                                progress("本地服务已就绪，加载页面");
                                break Ok(Session {
                                    url: url.into(),
                                    title: value["title"].as_str().unwrap_or(id).into(),
                                });
                            }
                        }
                    }
                    break Err("Agent 返回了无效的本地界面地址".into());
                }
            }
            Ok(None) => {}
            Err(error) => break Err(format!("无法读取 Agent 就绪信息: {error}")),
        }
        if start.elapsed() > Duration::from_secs(30) {
            break Err(format!("Agent 启动超时，请查看 {}", log.display()));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let child = runtime.4.lock().map_err(|e| e.to_string())?.remove(id);
    if let Ok(session) = &result {
        let child = child.ok_or("Agent 启动已被终止")?;
        insert_warm_agent(
            &runtime,
            id.to_string(),
            WarmAgent {
                session: session.clone(),
                child,
                fingerprint: runtime_fingerprint,
                last_used: Instant::now(),
            },
        )?;
    } else if let Some(mut child) = child {
        terminate_agent_process(&mut child);
    }
    result
}
#[tauri::command]
pub async fn agent_ui_open(
    app: tauri::AppHandle,
    id: String,
    runtime: tauri::State<'_, AgentUiRuntime>,
) -> Result<Session, String> {
    if !valid_id(&id) {
        return Err("Agent ID 无效".into());
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let provider_env = crate::harness::python_agent_provider_env(&app, &id)?;
    let state = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let project = {
            let _links_guard = state.project_links_lock()?;
            let links = root.join("agent-project-links.json");
            let mut projects = read_project_links(&links)?;
            match projects
                .get(&id)
                .filter(|path| path.join("agent_ui.py").is_file())
            {
                Some(path) => path.clone(),
                None => {
                    let selected = app
                        .dialog()
                        .file()
                        .set_title("选择此 Agent 的本地项目目录")
                        .blocking_pick_folder()
                        .ok_or("已取消打开 Agent")?;
                    let path = selected
                        .into_path()
                        .map_err(|e| e.to_string())?
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                    if !path.join("agent_ui.py").is_file() {
                        return Err("项目根目录缺少 agent_ui.py".into());
                    }
                    projects.insert(id.clone(), path.clone());
                    write_project_links(&links, &projects)?;
                    path
                }
            }
        };
        launch(&root, &project, &id, state, false, provider_env, &app)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn stop_agent_session(runtime: &AgentUiRuntime, id: &str, url: &str) -> Result<(), String> {
    let operation = runtime.agent_lock(id)?;
    let _operation = operation.lock().map_err(|e| e.to_string())?;
    let agent = {
        let mut agents = runtime.0.lock().map_err(|e| e.to_string())?;
        if agents.get(id).is_some_and(|agent| agent.session.url == url) {
            agents.remove(id)
        } else {
            None
        }
    };
    if let Some(mut agent) = agent {
        terminate_agent_process(&mut agent.child);
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_ui_stop(
    runtime: tauri::State<'_, AgentUiRuntime>,
    id: String,
    url: String,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Agent ID 无效".into());
    }
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stop_agent_session(&runtime, &id, &url))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    #[test]
    fn agent_operations_are_isolated() {
        let runtime = super::AgentUiRuntime::default();
        let installing = runtime.agent_lock("installing").unwrap();
        let _held = installing.lock().unwrap();
        assert!(runtime
            .agent_lock("installing")
            .unwrap()
            .try_lock()
            .is_err());
        assert!(runtime.agent_lock("ready").unwrap().try_lock().is_ok());
        assert!(runtime.0.try_lock().is_ok());
    }

    #[test]
    fn stopped_runtime_rejects_new_agent_launches() {
        let runtime = super::AgentUiRuntime::default();
        runtime.stop();
        assert!(runtime.ensure_running().is_err());
    }

    #[test]
    fn project_link_registry_operations_are_serialized() {
        let runtime = super::AgentUiRuntime::default();
        let _held = runtime.project_links_lock().expect("lock project links");
        assert!(runtime.3.try_lock().is_err());
    }

    use super::*;

    #[cfg(unix)]
    fn process_exists(pid: libc::pid_t) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(unix)]
    fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        condition()
    }

    #[cfg(unix)]
    static NEXT_PROCESS_TREE_FIXTURE: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    #[cfg(unix)]
    fn spawn_process_tree(name: &str) -> (Child, libc::pid_t, libc::pid_t, PathBuf) {
        let fixture_id = NEXT_PROCESS_TREE_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let descendant_path = std::env::temp_dir().join(format!(
            "toolkits-{name}-descendant-{}-{fixture_id}",
            std::process::id(),
        ));
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "sleep 30 & child=$!; printf '%s' \"$child\" > \"$1.tmp\"; mv \"$1.tmp\" \"$1\"; wait \"$child\"",
                "sh",
            ])
            .arg(&descendant_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::process_tree::configure_command(&mut command);
        let child = command.spawn().expect("start process tree");
        let root_pid = libc::pid_t::try_from(child.id()).expect("root PID fits pid_t");
        let deadline = Instant::now() + Duration::from_secs(2);
        let descendant_pid = loop {
            if let Ok(value) = fs::read_to_string(&descendant_path) {
                break value
                    .trim()
                    .parse::<libc::pid_t>()
                    .expect("descendant PID is valid");
            }
            assert!(
                Instant::now() < deadline,
                "process tree did not report its descendant PID"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        (child, root_pid, descendant_pid, descendant_path)
    }

    #[cfg(unix)]
    fn cleanup_process_group(root_pid: libc::pid_t) {
        let _ = unsafe { libc::kill(-root_pid, libc::SIGKILL) };
    }

    #[cfg(unix)]
    fn assert_process_tree_stopped(root_pid: libc::pid_t, descendant_pid: libc::pid_t) {
        let root_stopped = wait_until(|| !process_exists(root_pid));
        let descendant_stopped = wait_until(|| !process_exists(descendant_pid));
        if !descendant_stopped {
            cleanup_process_group(root_pid);
            let _ = wait_until(|| !process_exists(descendant_pid));
        }
        assert!(root_stopped, "root process must be reaped");
        assert!(descendant_stopped, "descendant process must be terminated");
    }

    #[cfg(unix)]
    #[test]
    fn managed_process_tree_helper_terminates_and_reaps_root_and_descendant() {
        let (mut child, root_pid, descendant_pid, descendant_path) = spawn_process_tree("helper");

        crate::process_tree::terminate(&mut child).expect("terminate managed process tree");

        assert_process_tree_stopped(root_pid, descendant_pid);
        fs::remove_file(descendant_path).expect("remove descendant PID file");
    }

    #[cfg(unix)]
    #[test]
    fn stopping_runtime_terminates_starting_agent_processes() {
        let (child, root_pid, descendant_pid, descendant_path) = spawn_process_tree("pending");
        let runtime = AgentUiRuntime::default();
        runtime
            .4
            .lock()
            .expect("register pending agent")
            .insert("test-agent".to_string(), child);

        runtime.stop();

        assert!(runtime.4.lock().expect("read pending agents").is_empty());
        assert_process_tree_stopped(root_pid, descendant_pid);
        fs::remove_file(descendant_path).expect("remove descendant PID file");
    }

    #[cfg(unix)]
    #[test]
    fn stopping_runtime_terminates_warm_agent_processes() {
        let (child, root_pid, descendant_pid, descendant_path) = spawn_process_tree("warm");
        let runtime = AgentUiRuntime::default();
        runtime.0.lock().expect("register warm agent").insert(
            "test-agent".to_string(),
            WarmAgent {
                session: Session {
                    url: "http://127.0.0.1:1".to_string(),
                    title: "Test agent".to_string(),
                },
                child,
                fingerprint: "test".to_string(),
                last_used: Instant::now(),
            },
        );

        runtime.stop();

        assert!(runtime.0.lock().expect("read runtime").is_empty());
        assert_process_tree_stopped(root_pid, descendant_pid);
        fs::remove_file(descendant_path).expect("remove descendant PID file");
    }

    #[cfg(unix)]
    fn warm_agent(url: &str, last_used: Instant) -> (WarmAgent, libc::pid_t, libc::pid_t, PathBuf) {
        let (child, root_pid, descendant_pid, descendant_path) = spawn_process_tree("warm-agent");
        (
            WarmAgent {
                session: Session {
                    url: url.to_string(),
                    title: "Test agent".to_string(),
                },
                child,
                fingerprint: "test".to_string(),
                last_used,
            },
            root_pid,
            descendant_pid,
            descendant_path,
        )
    }

    #[cfg(unix)]
    #[test]
    fn adding_fourth_warm_agent_evicts_least_recently_used_process_tree() {
        let runtime = AgentUiRuntime::default();
        let now = Instant::now();
        let (oldest, oldest_root, oldest_descendant, oldest_path) =
            warm_agent("http://127.0.0.1:1", now - Duration::from_secs(3));
        let (middle, middle_root, _, middle_path) =
            warm_agent("http://127.0.0.1:2", now - Duration::from_secs(2));
        let (newest, newest_root, _, newest_path) =
            warm_agent("http://127.0.0.1:3", now - Duration::from_secs(1));
        {
            let mut agents = runtime.0.lock().expect("seed warm agents");
            agents.insert("oldest".to_string(), oldest);
            agents.insert("middle".to_string(), middle);
            agents.insert("newest".to_string(), newest);
        }
        let (fourth, fourth_root, _, fourth_path) = warm_agent("http://127.0.0.1:4", now);

        insert_warm_agent(&runtime, "fourth".to_string(), fourth)
            .expect("insert fourth warm agent");

        let agents = runtime.0.lock().expect("read warm agents");
        assert_eq!(agents.len(), 3);
        assert!(!agents.contains_key("oldest"));
        assert!(agents.contains_key("middle"));
        assert!(agents.contains_key("newest"));
        assert!(agents.contains_key("fourth"));
        drop(agents);
        assert_process_tree_stopped(oldest_root, oldest_descendant);
        fs::remove_file(oldest_path).expect("remove evicted descendant PID file");

        runtime.stop();
        for (root_pid, path) in [
            (middle_root, middle_path),
            (newest_root, newest_path),
            (fourth_root, fourth_path),
        ] {
            cleanup_process_group(root_pid);
            fs::remove_file(path).expect("remove descendant PID file");
        }
    }

    #[cfg(unix)]
    #[test]
    fn stopping_session_terminates_the_matching_agent_process_tree() {
        let (child, root_pid, descendant_pid, descendant_path) = spawn_process_tree("session");
        let runtime = AgentUiRuntime::default();
        runtime.0.lock().expect("register warm agent").insert(
            "test-agent".to_string(),
            WarmAgent {
                session: Session {
                    url: "http://127.0.0.1:1".to_string(),
                    title: "Test agent".to_string(),
                },
                child,
                fingerprint: "test".to_string(),
                last_used: Instant::now(),
            },
        );

        stop_agent_session(&runtime, "test-agent", "http://127.0.0.1:1")
            .expect("stop matching agent session");

        assert!(runtime.0.lock().expect("read runtime").is_empty());
        assert_process_tree_stopped(root_pid, descendant_pid);
        fs::remove_file(descendant_path).expect("remove descendant PID file");
    }

    #[test]
    fn ids_cannot_be_paths() {
        assert!(valid_id("author.audio-agent"));
        for id in ["", "..", "../agent", "a/b", "/tmp/agent", ".hidden", "a\\b"] {
            assert!(!valid_id(id));
        }
    }

    #[test]
    fn project_links_are_saved_atomically() {
        let root =
            std::env::temp_dir().join(format!("toolkits-agent-links-test-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create project-link directory");
        let path = root.join("agent-project-links.json");
        let mut projects = BTreeMap::new();
        projects.insert("test-agent".to_string(), PathBuf::from("/tmp/test-agent"));

        write_project_links(&path, &projects).expect("save project links");

        assert_eq!(
            read_project_links(&path).expect("load project links"),
            projects
        );
        assert!(!path.with_extension("tmp").exists());
        fs::remove_dir_all(root).expect("remove project-link directory");
    }

    #[test]
    fn control_file_reader_rejects_oversized_files() {
        let path = std::env::temp_dir().join(format!(
            "toolkits-agent-control-file-test-{}",
            std::process::id()
        ));
        fs::write(&path, "oversized").expect("write control file");

        assert!(read_agent_control_file(&path, 4).is_err());

        fs::remove_file(path).expect("remove control file");
    }

    #[test]
    fn python_commands_clear_inherited_provider_credentials() {
        let mut command = Command::new("python3");
        configure_python_agent_provider_env(&mut command, &[]);

        for name in PYTHON_AGENT_PROVIDER_ENV_NAMES {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }

        let mut allowed = Command::new("python3");
        configure_python_agent_provider_env(
            &mut allowed,
            &[(
                "DASHSCOPE_API_KEY".to_string(),
                "allowlisted-key".to_string(),
            )],
        );
        assert!(allowed.get_envs().any(|(key, value)| {
            key == "DASHSCOPE_API_KEY" && value.is_some_and(|value| value == "allowlisted-key")
        }));
    }

    #[test]
    fn dependency_install_commands_clear_provider_credentials() {
        let mut command = Command::new("uv");
        configure_python_agent_install_env(&mut command);

        for name in PYTHON_AGENT_PROVIDER_ENV_NAMES {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }
    }

    #[test]
    fn python_commands_clear_legacy_bailian_environment_aliases() {
        let mut command = Command::new("python3");
        configure_python_agent_provider_env(&mut command, &[]);

        for name in [
            "QWEN_AUDIO_BAILIAN_API_KEY",
            "QWEN_AUDIO_BAILIAN_BASE_URL",
            "QWEN_AUDIO_BAILIAN_TTS_MODEL",
            "QWEN_AUDIO_BAILIAN_ASR_MODEL",
        ] {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }
    }

    #[test]
    fn python_commands_clear_general_dashscope_configuration() {
        let mut command = Command::new("python3");
        configure_python_agent_provider_env(&mut command, &[]);

        for name in ["DASHSCOPE_BASE_URL", "DASHSCOPE_MODEL"] {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct InstalledAgent {
    #[serde(default)]
    revision: Option<String>,
    id: String,
    title: String,
}

#[tauri::command]
pub fn agent_ui_installed(app: tauri::AppHandle) -> Result<Vec<InstalledAgent>, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    read_installed(&root)
}
fn read_installed(root: &Path) -> Result<Vec<InstalledAgent>, String> {
    match fs::read(root.join("installed-python-agents.json")) {
        Ok(raw) => {
            let records: Vec<InstalledAgent> =
                serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            Ok(records
                .into_iter()
                .filter(|agent| {
                    valid_id(&agent.id)
                        && root
                            .join("agent-projects")
                            .join(&agent.id)
                            .join("agent_ui.py")
                            .is_file()
                })
                .collect())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn agent_ui_install(
    app: tauri::AppHandle,
    id: String,
    update: Option<bool>,
    runtime: tauri::State<'_, AgentUiRuntime>,
) -> Result<InstalledAgent, String> {
    if !valid_id(&id) {
        return Err("Agent ID 无效".into());
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(record) = read_installed(&root)?
        .into_iter()
        .find(|a| a.id == id && !update.unwrap_or(false))
    {
        return Ok(record);
    }
    let base = crate::agent_server::server_url(
        &std::env::var("QWEN_AUDIO_AGENT_SERVER_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8787".into()),
    )?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(
            base.join(&format!("v1/agents/{id}/download"))
                .map_err(|e| e.to_string())?,
        )
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 20 * 1024 * 1024 {
            return Err("Agent 项目包超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let provider_env = crate::harness::python_agent_provider_env(&app, &id)?;
    let state = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let operation = state.agent_lock(&id)?;
        let _operation = operation.lock().map_err(|e| e.to_string())?;
        let _install = INSTALL_LOCK.lock().map_err(|e| e.to_string())?;
        let mut installed = read_installed(&root)?;
        if let Some(record) = installed
            .iter()
            .find(|a| a.id == id && !update.unwrap_or(false))
        {
            return Ok(record.clone());
        }
        let project = root.join("agent-projects").join(&id);
        let staging = root.join("agent-projects").join(format!(".install-{id}"));
        if staging.exists() {
            fs::remove_dir_all(&staging).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        if let Err(error) = unpack_project(&bytes, &staging) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let backup = root.join("agent-projects").join(format!(".previous-{id}"));
        let environment = root.join("agent-environments").join(&id);
        let env_backup = root
            .join("agent-environments")
            .join(format!(".previous-{id}"));
        if backup.exists() || env_backup.exists() {
            return Err("上一次更新备份仍存在，请先恢复安装".into());
        }
        {
            let mut guard = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(mut agent) = guard.remove(&id) {
                terminate_agent_process(&mut agent.child);
            }
        }
        if project.exists() {
            fs::rename(&project, &backup).map_err(|e| e.to_string())?;
        }
        if environment.exists() {
            if let Err(error) = fs::rename(&environment, &env_backup) {
                if backup.exists() {
                    let _ = fs::rename(&backup, &project);
                }
                return Err(error.to_string());
            }
        }
        let result = (|| -> Result<Session, String> {
            fs::rename(&staging, &project).map_err(|e| e.to_string())?;
            launch_inner(
                &root,
                &project,
                &id,
                state.clone(),
                true,
                provider_env,
                &app,
            )
        })();
        let session = match result {
            Ok(session) => session,
            Err(mut error) => {
                // Rollback must not erase the diagnostic file referred to in the UI.
                let failed_log = environment.join("runtime.log");
                let log_directory = root.join("agent-logs");
                if failed_log.is_file() && fs::create_dir_all(&log_directory).is_ok() {
                    let retained_log = log_directory.join(format!("{id}-install.log"));
                    if fs::copy(&failed_log, &retained_log).is_ok() {
                        error = error.replace(
                            failed_log.to_string_lossy().as_ref(),
                            retained_log.to_string_lossy().as_ref(),
                        );
                    }
                }
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut agent) = guard.remove(&id) {
                        terminate_agent_process(&mut agent.child);
                    }
                }
                let _ = fs::remove_dir_all(&project);
                let _ = fs::remove_dir_all(&environment);
                if backup.exists() {
                    fs::rename(&backup, &project).map_err(|e| e.to_string())?;
                }
                if env_backup.exists() {
                    fs::rename(&env_backup, &environment).map_err(|e| e.to_string())?;
                }
                return Err(error);
            }
        };
        {
            let mut guard = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(mut agent) = guard.remove(&id) {
                terminate_agent_process(&mut agent.child);
            }
        }
        let _links_guard = state.project_links_lock()?;
        let links_path = root.join("agent-project-links.json");
        let previous_links = fs::read(&links_path).ok();
        let save = (|| -> Result<InstalledAgent, String> {
            let mut links = read_project_links(&links_path)?;
            links.insert(id.clone(), project.clone());
            write_project_links(&links_path, &links)?;
            let record = InstalledAgent {
                revision: Some(
                    Sha256::digest(&bytes)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>(),
                ),
                id,
                title: session.title,
            };
            installed.retain(|agent| agent.id != record.id);
            installed.push(record.clone());
            let path = root.join("installed-python-agents.json");
            let temporary = path.with_extension("tmp");
            fs::write(
                &temporary,
                serde_json::to_vec(&installed).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            fs::rename(temporary, path).map_err(|e| e.to_string())?;
            Ok(record)
        })();
        let record = match save {
            Ok(record) => record,
            Err(error) => {
                if let Some(raw) = previous_links {
                    let _ = replace_file_atomically(&links_path, &raw);
                } else {
                    let _ = fs::remove_file(&links_path);
                }
                let _ = fs::remove_dir_all(&project);
                let _ = fs::remove_dir_all(&environment);
                if backup.exists() {
                    fs::rename(&backup, &project).map_err(|e| e.to_string())?;
                }
                if env_backup.exists() {
                    fs::rename(&env_backup, &environment).map_err(|e| e.to_string())?;
                }
                return Err(error);
            }
        };
        let _ = fs::remove_dir_all(&backup);
        let _ = fs::remove_dir_all(&env_backup);
        Ok(record)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unpack_project(bytes: &[u8], project: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(std::io::Cursor::new(bytes));
    let mut total = 0u64;
    for (index, entry) in archive.entries().map_err(|e| e.to_string())?.enumerate() {
        let mut entry = entry.map_err(|e| e.to_string())?;
        total = total.checked_add(entry.size()).ok_or("项目包大小无效")?;
        if index >= 4096 || total > 20 * 1024 * 1024 {
            return Err("Agent 项目包超过大小限制".into());
        }
        let kind = entry.header().entry_type();
        if kind.is_pax_global_extensions() || kind.is_pax_local_extensions() {
            continue;
        }
        if !(kind.is_file() || kind.is_dir()) {
            return Err("项目包包含不支持的链接或特殊文件".into());
        }
        if !entry.unpack_in(project).map_err(|e| e.to_string())? {
            return Err("项目路径越界".into());
        }
    }
    if !project.join("agent_ui.py").is_file() {
        return Err("项目根目录缺少 agent_ui.py".into());
    }
    Ok(())
}

#[cfg(test)]
mod installation_tests {
    use super::*;
    #[test]
    fn archive_rejects_links_and_missing_entry() {
        let project =
            std::env::temp_dir().join(format!("toolkits-install-test-{}", std::process::id()));
        fs::create_dir_all(&project).unwrap();
        let mut archive = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        archive
            .append_link(&mut header, "agent_ui.py", "/etc/passwd")
            .unwrap();
        assert!(unpack_project(&archive.into_inner().unwrap(), &project).is_err());
        let empty = tar::Builder::new(Vec::new()).into_inner().unwrap();
        assert!(unpack_project(&empty, &project).is_err());
        let mut archive = tar::Builder::new(Vec::new());
        let content = b"def create_ui(): pass";
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "agent_ui.py", &content[..])
            .unwrap();
        unpack_project(&archive.into_inner().unwrap(), &project).unwrap();
        assert_eq!(fs::read(project.join("agent_ui.py")).unwrap(), content);
        fs::remove_dir_all(project).unwrap();
    }
}

#[tauri::command]
pub async fn agent_ui_uninstall(
    app: tauri::AppHandle,
    id: String,
    runtime: tauri::State<'_, AgentUiRuntime>,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Agent ID 无效".into());
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let operation = state.agent_lock(&id)?;
        let _operation = operation.lock().map_err(|e| e.to_string())?;
        let _install = INSTALL_LOCK.lock().map_err(|e| e.to_string())?;
        let mut installed: Vec<InstalledAgent> =
            match fs::read(root.join("installed-python-agents.json")) {
                Ok(raw) => serde_json::from_slice(&raw).map_err(|e| e.to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(error) => return Err(error.to_string()),
            };
        let agent = state.0.lock().map_err(|e| e.to_string())?.remove(&id);
        if let Some(mut agent) = agent {
            terminate_agent_process(&mut agent.child);
        }
        // Delete only application-managed copies, never the author's source repository.
        for directory in [
            root.join("agent-projects").join(&id),
            root.join("agent-environments").join(&id),
        ] {
            if directory.exists() {
                fs::remove_dir_all(directory).map_err(|e| e.to_string())?;
            }
        }
        let _links_guard = state.project_links_lock()?;
        let links_path = root.join("agent-project-links.json");
        if links_path.exists() {
            let mut links = read_project_links(&links_path)?;
            links.remove(&id);
            write_project_links(&links_path, &links)?;
        }
        installed.retain(|agent| agent.id != id);
        let path = root.join("installed-python-agents.json");
        let temporary = path.with_extension("tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(&installed).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
