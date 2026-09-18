//! Generic local Python Agent UI launcher. Websites supply IDs, never paths or commands.
static SDK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

struct WarmAgent {
    session: Session,
    child: Child,
    fingerprint: String,
    last_used: Instant,
}
#[derive(Default, Clone)]
pub struct AgentUiRuntime(
    Arc<Mutex<BTreeMap<String, WarmAgent>>>,
    Arc<Mutex<BTreeMap<String, Arc<Mutex<()>>>>>,
);
impl AgentUiRuntime {
    fn agent_lock(&self, id: &str) -> Result<Arc<Mutex<()>>, String> {
        let mut locks = self.1.lock().map_err(|e| e.to_string())?;
        Ok(locks.entry(id.to_owned()).or_default().clone())
    }

    pub fn stop(&self) {
        if let Ok(mut agents) = self.0.lock() {
            for (_, mut agent) in std::mem::take(&mut *agents) {
                let _ = agent.child.kill();
                let _ = agent.child.wait();
            }
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
            let _ = child.kill();
            let _ = child.wait();
            return Err("环境准备超时，请检查网络后重试".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}
fn launch(
    root: &Path, project: &Path, id: &str, runtime: AgentUiRuntime,
    prepare: bool, provider_env: Vec<(String, String)>, app: &tauri::AppHandle,
) -> Result<Session, String> {
    let lock = runtime.agent_lock(id)?;
    let _operation = lock.lock().map_err(|e| e.to_string())?;
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
        ("ui-streaming.js", include_str!("../../toolkits/ui-streaming.js")),
        (
            "__init__.py",
            include_str!("../../toolkits/__init__.py"),
        ),
        (
            "__main__.py",
            include_str!("../../toolkits/__main__.py"),
        ),
        (
            "server.py",
            include_str!("../../toolkits/server.py"),
        ),
        (
            "ui.html",
            include_str!("../../toolkits/ui.html"),
        ),
        (
            "ui.css",
            include_str!("../../toolkits/ui.css"),
        ),
        (
            "ui-content.js",
            include_str!("../../toolkits/ui-content.js"),
        ),
        (
            "ui.js",
            include_str!("../../toolkits/ui.js"),
        ),
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
        ("docs/python-sdk.md", include_str!("../../docs/python-sdk.md")),
        ("toolkits/py.typed", ""),
    ] {
        let path = sdk.join(name);
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
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
        let _ = agent.child.kill();
        let _ = agent.child.wait();
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
            checked(&mut command, &log)?;
        }
        fs::write(marker, fingerprint).map_err(|e| e.to_string())?;
    }
    if prepare {
        progress("下载并校验模型与运行资源");
        checked_timeout(
            Command::new(&python)
                .arg("-m")
                .arg("toolkits")
                .arg(project)
                .arg("--prepare")
                .arg("--ui-cache")
                .arg(env.join("ui-definition.json"))
                .envs(provider_env.iter().cloned())
                .env("PYTHONPATH", &sdk),
            &log,
            Duration::from_secs(1800),
        )?;
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
    let mut child = Command::new(python)
        .env("TOOLKITS_STARTUP_PROGRESS", &progress_path)
        .envs(provider_env)
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
        .stderr(output)
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let result = loop {
        if let Ok(raw) = fs::read_to_string(&progress_path) {
            if raw.len() < 32768 {
                let lines: Vec<_> = raw.lines().collect();
                for line in lines.iter().skip(progress_lines) {
                    if let Ok(message) = serde_json::from_str::<String>(line) {
                        progress(&message);
                    }
                }
                progress_lines = lines.len();
            }
        }
        if let Ok(Some(_)) = child.try_wait() {
            break Err(format!("Agent 启动失败，请查看 {}", log.display()));
        }
        if let Ok(raw) = fs::read_to_string(&ready) {
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
        if start.elapsed() > Duration::from_secs(30) {
            break Err(format!("Agent 启动超时，请查看 {}", log.display()));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if let Ok(session) = &result {
        runtime.0.lock().map_err(|e| e.to_string())?.insert(
            id.to_string(),
            WarmAgent {
                session: session.clone(),
                child,
                fingerprint: runtime_fingerprint,
                last_used: Instant::now(),
            },
        );
    } else {
        let _ = child.kill();
        let _ = child.wait();
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
        let links = root.join("agent-project-links.json");
        let mut projects: BTreeMap<String, PathBuf> = match fs::read(&links) {
            Ok(raw) => {
                serde_json::from_slice(&raw).map_err(|e| format!("本地项目记录无效：{e}"))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e.to_string()),
        };
        let project = match projects
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
                fs::write(
                    &links,
                    serde_json::to_vec(&projects).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                path
            }
        };
        launch(&root, &project, &id, state, false, provider_env, &app)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_ui_stop(
    runtime: tauri::State<'_, AgentUiRuntime>,
    url: String,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut guard) = runtime.0.lock() {
            let id = guard
                .iter()
                .find(|(_, agent)| agent.session.url == url)
                .map(|(id, _)| id.clone());
            if let Some(id) = id {
                if let Some(mut agent) = guard.remove(&id) {
                    let _ = agent.child.kill();
                    let _ = agent.child.wait();
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    #[test]
    fn agent_operations_are_isolated() {
        let runtime = super::AgentUiRuntime::default();
        let installing = runtime.agent_lock("installing").unwrap();
        let _held = installing.lock().unwrap();
        assert!(runtime.agent_lock("installing").unwrap().try_lock().is_err());
        assert!(runtime.agent_lock("ready").unwrap().try_lock().is_ok());
        assert!(runtime.0.try_lock().is_ok());
    }

    use super::*;
    #[test]
    fn ids_cannot_be_paths() {
        assert!(valid_id("author.audio-agent"));
        for id in ["", "..", "../agent", "a/b", "/tmp/agent", ".hidden", "a\\b"] {
            assert!(!valid_id(id));
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
    if let Some(record) = read_installed(&root)?.into_iter().find(|a| a.id == id && !update.unwrap_or(false)) {
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
        if let Some(record) = installed.iter().find(|a| a.id == id && !update.unwrap_or(false)) {
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
        let env_backup = root.join("agent-environments").join(format!(".previous-{id}"));
        if backup.exists() || env_backup.exists() { return Err("上一次更新备份仍存在，请先恢复安装".into()); }
        {
            let mut guard = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(mut agent) = guard.remove(&id) { let _ = agent.child.kill(); let _ = agent.child.wait(); }
        }
        if project.exists() { fs::rename(&project, &backup).map_err(|e| e.to_string())?; }
        if environment.exists() {
            if let Err(error) = fs::rename(&environment, &env_backup) {
                if backup.exists() { let _ = fs::rename(&backup, &project); }
                return Err(error.to_string());
            }
        }
        let result = (|| -> Result<Session, String> {
            fs::rename(&staging, &project).map_err(|e| e.to_string())?;
            launch_inner(&root, &project, &id, state.clone(), true, provider_env, &app)
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
                        error = error.replace(failed_log.to_string_lossy().as_ref(), retained_log.to_string_lossy().as_ref());
                    }
                }
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut agent) = guard.remove(&id) { let _ = agent.child.kill(); let _ = agent.child.wait(); }
                }
                let _ = fs::remove_dir_all(&project);
                let _ = fs::remove_dir_all(&environment);
                if backup.exists() { fs::rename(&backup, &project).map_err(|e| e.to_string())?; }
                if env_backup.exists() { fs::rename(&env_backup, &environment).map_err(|e| e.to_string())?; }
                return Err(error);
            }
        };
        {
            let mut guard = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(mut agent) = guard.remove(&id) {
                let _ = agent.child.kill();
                let _ = agent.child.wait();
            }
        }
        let links_path = root.join("agent-project-links.json");
        let previous_links = fs::read(&links_path).ok();
        let save = (|| -> Result<InstalledAgent, String> {
        let mut links: BTreeMap<String, PathBuf> = if links_path.exists() {
            serde_json::from_slice(&fs::read(&links_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            BTreeMap::new()
        };
        links.insert(id.clone(), project.clone());
        fs::write(
            &links_path,
            serde_json::to_vec(&links).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let record = InstalledAgent {
            revision: Some(Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
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
                if let Some(raw) = previous_links { let _ = fs::write(&links_path, raw); }
                else { let _ = fs::remove_file(&links_path); }
                let _ = fs::remove_dir_all(&project);
                let _ = fs::remove_dir_all(&environment);
                if backup.exists() { fs::rename(&backup, &project).map_err(|e| e.to_string())?; }
                if env_backup.exists() { fs::rename(&env_backup, &environment).map_err(|e| e.to_string())?; }
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
pub async fn agent_ui_uninstall(app: tauri::AppHandle, id: String, runtime: tauri::State<'_, AgentUiRuntime>) -> Result<(), String> {
    if !valid_id(&id) { return Err("Agent ID 无效".into()); }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let state = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let operation = state.agent_lock(&id)?;
        let _operation = operation.lock().map_err(|e| e.to_string())?;
        let _install = INSTALL_LOCK.lock().map_err(|e| e.to_string())?;
        let mut installed: Vec<InstalledAgent> = match fs::read(root.join("installed-python-agents.json")) {
            Ok(raw) => serde_json::from_slice(&raw).map_err(|e| e.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.to_string()),
        };
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut agent) = guard.remove(&id) { let _ = agent.child.kill(); let _ = agent.child.wait(); }
        // Delete only application-managed copies, never the author's source repository.
        for directory in [root.join("agent-projects").join(&id), root.join("agent-environments").join(&id)] {
            if directory.exists() { fs::remove_dir_all(directory).map_err(|e| e.to_string())?; }
        }
        let links_path = root.join("agent-project-links.json");
        if links_path.exists() {
            let mut links: BTreeMap<String, PathBuf> = serde_json::from_slice(&fs::read(&links_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            links.remove(&id);
            let temporary = links_path.with_extension("tmp");
            fs::write(&temporary, serde_json::to_vec(&links).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            fs::rename(temporary, links_path).map_err(|e| e.to_string())?;
        }
        installed.retain(|agent| agent.id != id);
        let path = root.join("installed-python-agents.json");
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec(&installed).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
