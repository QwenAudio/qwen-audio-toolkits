use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot},
};
use uuid::Uuid;

const ACP_EVENT: &str = "acp-session-event";
const INITIALIZE_TIMEOUT_SECONDS: u64 = 120;
const SESSION_NEW_TIMEOUT_SECONDS: u64 = 30;

#[derive(Clone, Serialize)]
pub struct AcpModelInfo {
    id: String,
    name: String,
}

fn model_config(value: &Value) -> Option<&Value> {
    value
        .get("configOptions")?
        .as_array()?
        .iter()
        .find(|option| {
            option.get("type").and_then(Value::as_str) == Some("select")
                && (option.get("category").and_then(Value::as_str) == Some("model")
                    || option.get("id").and_then(Value::as_str) == Some("model"))
        })
}

fn collect_model_options(options: &[Value], result: &mut Vec<AcpModelInfo>) {
    for option in options {
        if let Some(group) = option.get("options").and_then(Value::as_array) {
            collect_model_options(group, result);
        } else if let Some(id) = option.get("value").and_then(Value::as_str) {
            if !result.iter().any(|model| model.id == id) {
                result.push(AcpModelInfo {
                    id: id.to_string(),
                    name: option
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(id)
                        .to_string(),
                });
            }
        }
    }
}

fn session_models(value: &Value) -> (Vec<AcpModelInfo>, Option<String>) {
    if let Some(config) = model_config(value) {
        let mut models = Vec::new();
        if let Some(options) = config.get("options").and_then(Value::as_array) {
            collect_model_options(options, &mut models);
        }
        return (
            models,
            config
                .get("currentValue")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
    }
    let models = value
        .pointer("/models/availableModels")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("modelId").or_else(|| model.get("id"))?.as_str()?;
                    Some(AcpModelInfo {
                        id: id.to_string(),
                        name: model
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(id)
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (
        models,
        value
            .pointer("/models/currentModelId")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

fn model_selection_request(
    value: &Value,
    session_id: &str,
    model_id: &str,
    _provider_kind: AcpProviderKind,
) -> Result<Option<(&'static str, Value)>, String> {
    let (models, current) = session_models(value);
    if !models.iter().any(|model| model.id == model_id) {
        return Err("Agent 未提供所选模型，请重新选择".to_string());
    }
    if current.as_deref() == Some(model_id) {
        return Ok(None);
    }
    if let Some(config) = model_config(value) {
        let config_id = config
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Agent 模型配置缺少 ID".to_string())?;
        Ok(Some((
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": model_id }),
        )))
    } else {
        Ok(Some((
            "session/set_model",
            json!({ "sessionId": session_id, "modelId": model_id }),
        )))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AcpProviderKind {
    External,
}

impl AcpProviderKind {
    fn as_str(self) -> &'static str {
        "external"
    }
}

struct AcpProviderSpec {
    id: &'static str,
    name: &'static str,
    kind: AcpProviderKind,
    requires_api_provider: bool,
    command: &'static [&'static str],
    env: &'static [(&'static str, &'static str)],
    cwd_flag: Option<&'static str>,
}

const ACP_PROVIDERS: &[AcpProviderSpec] = &[
    AcpProviderSpec {
        id: "qoder",
        name: "Qoder",
        kind: AcpProviderKind::External,
        requires_api_provider: false,
        command: &["qoder", "--acp"],
        env: &[],
        cwd_flag: None,
    },
    AcpProviderSpec {
        id: "opencode",
        name: "opencode",
        kind: AcpProviderKind::External,
        requires_api_provider: false,
        command: &["opencode", "acp"],
        env: &[("OPENCODE_DISABLE_AUTOUPDATE", "1")],
        cwd_flag: Some("--cwd"),
    },
    AcpProviderSpec {
        id: "kimi",
        name: "Kimi Code",
        kind: AcpProviderKind::External,
        requires_api_provider: false,
        command: &["kimi", "acp"],
        env: &[],
        cwd_flag: None,
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProviderInfo {
    id: String,
    name: String,
    available: bool,
    kind: &'static str,
    requires_api_provider: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionStartRequest {
    provider_id: String,
    cwd: Option<String>,
    model_id: Option<String>,
    api_provider_id: Option<String>,
    enable_tools: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionStartResponse {
    session_id: String,
    provider_id: String,
    provider_name: String,
    models: Vec<String>,
    model_options: Vec<AcpModelInfo>,
    current_model_id: Option<String>,
    modes: Vec<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionEvent {
    session_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plan: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    questions: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phases: Option<Vec<Value>>,
}

impl AcpSessionEvent {
    fn base(session_id: &str, kind: &'static str) -> Self {
        Self {
            session_id: session_id.to_string(),
            kind,
            message_id: None,
            text: None,
            tool_call_id: None,
            tool_title: None,
            tool_kind: None,
            status: None,
            content: None,
            plan: None,
            stop_reason: None,
            error: None,
            request_id: None,
            title: None,
            options: None,
            questions: None,
            phases: None,
        }
    }
}

enum AcpCommand {
    Prompt { text: String },
}

pub struct AcpRuntime {
    state: StdMutex<AcpRuntimeState>,
    stopping: AtomicBool,
}

struct AcpRuntimeState {
    sessions: HashMap<String, AcpSessionHandle>,
    initializing: HashMap<String, AcpInitializingHandle>,
}

impl Default for AcpRuntime {
    fn default() -> Self {
        Self {
            state: StdMutex::new(AcpRuntimeState {
                sessions: HashMap::new(),
                initializing: HashMap::new(),
            }),
            stopping: AtomicBool::new(false),
        }
    }
}

struct AcpSessionHandle {
    state: Arc<AcpSessionState>,
    command_tx: mpsc::Sender<AcpCommand>,
    child: Child,
}

struct AcpInitializingHandle {
    state: Arc<AcpSessionState>,
    child: Child,
}

enum AcpOwnedSession {
    Initializing(AcpInitializingHandle),
    Registered(AcpSessionHandle),
}

impl AcpOwnedSession {
    fn state(&self) -> &Arc<AcpSessionState> {
        match self {
            Self::Initializing(handle) => &handle.state,
            Self::Registered(handle) => &handle.state,
        }
    }
}

impl AcpRuntime {
    fn track_initializing(
        &self,
        session_id: String,
        state: Arc<AcpSessionState>,
        child: Child,
    ) -> Result<(), Child> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(child);
        }
        let Ok(mut runtime) = self.state.lock() else {
            return Err(child);
        };
        if self.stopping.load(Ordering::SeqCst)
            || runtime.initializing.contains_key(&session_id)
            || runtime.sessions.contains_key(&session_id)
        {
            return Err(child);
        }
        runtime
            .initializing
            .insert(session_id, AcpInitializingHandle { state, child });
        Ok(())
    }

    fn take_initializing_io(
        &self,
        session_id: &str,
    ) -> Result<
        (
            tokio::process::ChildStdin,
            tokio::process::ChildStdout,
            tokio::process::ChildStderr,
        ),
        String,
    > {
        let mut runtime = self
            .state
            .lock()
            .map_err(|_| "Agent 会话状态不可用".to_string())?;
        let handle = runtime
            .initializing
            .get_mut(session_id)
            .ok_or_else(|| "Agent 进程在会话建立前退出".to_string())?;
        let stdin = handle
            .child
            .stdin
            .take()
            .ok_or_else(|| "无法连接 Agent 进程输入".to_string())?;
        let stdout = handle
            .child
            .stdout
            .take()
            .ok_or_else(|| "无法连接 Agent 进程输出".to_string())?;
        let stderr = handle
            .child
            .stderr
            .take()
            .ok_or_else(|| "无法连接 Agent 进程错误输出".to_string())?;
        Ok((stdin, stdout, stderr))
    }

    fn promote_initializing(
        &self,
        session_id: &str,
        command_tx: mpsc::Sender<AcpCommand>,
    ) -> Result<(), String> {
        let mut runtime = self
            .state
            .lock()
            .map_err(|_| "Agent 会话状态不可用".to_string())?;
        if self.stopping.load(Ordering::SeqCst) {
            return Err("应用正在退出，无法建立 Agent 会话".to_string());
        }
        let session_state = runtime
            .initializing
            .get(session_id)
            .map(|handle| handle.state.clone())
            .ok_or_else(|| "Agent 进程在会话建立前退出".to_string())?;
        if session_state.closed.load(Ordering::SeqCst) {
            return Err("Agent 进程在会话建立前退出".to_string());
        }
        let initializing = runtime
            .initializing
            .remove(session_id)
            .expect("initializing session was checked above");
        runtime.sessions.insert(
            session_id.to_string(),
            AcpSessionHandle {
                state: initializing.state,
                command_tx,
                child: initializing.child,
            },
        );
        Ok(())
    }

    fn session_state(&self, session_id: &str) -> Result<Arc<AcpSessionState>, String> {
        self.state
            .lock()
            .map_err(|_| "Agent 会话状态不可用".to_string())?
            .sessions
            .get(session_id)
            .map(|handle| handle.state.clone())
            .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())
    }

    fn session_sender(&self, session_id: &str) -> Result<mpsc::Sender<AcpCommand>, String> {
        self.state
            .lock()
            .map_err(|_| "Agent 会话状态不可用".to_string())?
            .sessions
            .get(session_id)
            .map(|handle| handle.command_tx.clone())
            .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())
    }

    fn take_registered(&self, session_id: &str) -> Option<AcpSessionHandle> {
        self.state
            .lock()
            .ok()
            .and_then(|mut runtime| runtime.sessions.remove(session_id))
    }

    fn take_owned_session(&self, session_id: &str) -> Option<AcpOwnedSession> {
        self.state.lock().ok().and_then(|mut runtime| {
            runtime
                .sessions
                .remove(session_id)
                .map(AcpOwnedSession::Registered)
                .or_else(|| {
                    runtime
                        .initializing
                        .remove(session_id)
                        .map(AcpOwnedSession::Initializing)
                })
        })
    }

    async fn shutdown_all(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let handles = self
            .state
            .lock()
            .map(|mut runtime| {
                let mut handles = runtime
                    .sessions
                    .drain()
                    .map(|(_, handle)| AcpOwnedSession::Registered(handle))
                    .collect::<Vec<_>>();
                handles.extend(
                    runtime
                        .initializing
                        .drain()
                        .map(|(_, handle)| AcpOwnedSession::Initializing(handle)),
                );
                handles
            })
            .unwrap_or_default();
        for handle in &handles {
            close_session_state(handle.state(), "Agent 会话已关闭", None);
        }
        for handle in handles {
            reap_owned_session(handle).await;
        }
    }
}

struct AcpSessionState {
    app: Option<AppHandle>,
    runtime: Arc<AcpRuntime>,
    session_id: String,
    agent_session_id: StdMutex<Option<String>>,
    writer_tx: mpsc::Sender<Value>,
    next_request_id: AtomicU64,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    permissions: StdMutex<HashMap<String, oneshot::Sender<Option<String>>>>,
    questions: StdMutex<HashMap<String, oneshot::Sender<Value>>>,
    plan_approvals: StdMutex<HashMap<String, oneshot::Sender<Value>>>,
    turn_active: AtomicBool,
    closed: AtomicBool,
}

fn augmented_path_entries_from(
    inherited_path: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(home) = home {
        for relative in [
            ".local/bin",
            ".qoder/entry",
            ".cargo/bin",
            ".volta/bin",
            ".npm-global/bin",
            "bin",
        ] {
            entries.push(home.join(relative));
        }
    }
    // Preserve the macOS locations that make installed CLIs available outside a login shell.
    entries.push(PathBuf::from("/opt/homebrew/bin"));
    entries.push(PathBuf::from("/usr/local/bin"));
    entries.push(PathBuf::from("/usr/bin"));
    entries.push(PathBuf::from("/bin"));
    entries.push(PathBuf::from("/usr/sbin"));
    entries.push(PathBuf::from("/sbin"));
    if let Some(path) = inherited_path {
        entries.extend(env::split_paths(path).filter(|entry| !entry.as_os_str().is_empty()));
    }
    let mut seen = std::collections::HashSet::new();
    entries.retain(|entry| seen.insert(entry.clone()));
    entries
}

fn augmented_path_entries() -> Vec<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let inherited_path = env::var_os("PATH");
    augmented_path_entries_from(inherited_path.as_deref(), home.as_deref())
}

fn join_path_entries(
    entries: impl IntoIterator<Item = PathBuf>,
) -> Result<OsString, env::JoinPathsError> {
    env::join_paths(entries)
}

fn acp_process_env(extra: &[(&str, &str)]) -> HashMap<OsString, OsString> {
    let mut env_map: HashMap<OsString, OsString> = env::vars_os().collect();
    let entries = augmented_path_entries()
        .into_iter()
        .filter(|entry| entry.is_dir())
        .collect::<Vec<_>>();
    if let Ok(path) = join_path_entries(entries) {
        if !path.is_empty() {
            env_map.insert(OsString::from("PATH"), path);
        }
    }
    for (key, value) in extra {
        env_map.insert(OsString::from(key), OsString::from(value));
    }
    env_map
}

fn executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(path) {
            Ok(metadata) => metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

const WINDOWS_DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

fn command_candidate_names_for_platform(
    command: &std::ffi::OsStr,
    pathext: Option<&std::ffi::OsStr>,
    windows: bool,
) -> Vec<OsString> {
    if !windows || Path::new(command).extension().is_some() {
        return vec![command.to_owned()];
    }
    let extensions = pathext
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| std::ffi::OsStr::new(WINDOWS_DEFAULT_PATHEXT))
        .to_string_lossy();
    let candidates = extensions
        .split(';')
        .map(str::trim)
        .filter(|extension| !extension.is_empty())
        .map(|extension| {
            let mut candidate = command.to_owned();
            candidate.push(extension);
            candidate
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        command_candidate_names_for_platform(
            command,
            Some(std::ffi::OsStr::new(WINDOWS_DEFAULT_PATHEXT)),
            true,
        )
    } else {
        candidates
    }
}

fn command_candidates(
    command: &std::ffi::OsStr,
    pathext: Option<&std::ffi::OsStr>,
) -> Vec<OsString> {
    command_candidate_names_for_platform(command, pathext, cfg!(windows))
}

fn resolve_command_from_paths(
    command: &std::ffi::OsStr,
    path_entries: &[PathBuf],
    pathext: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    let command_path = Path::new(command);
    let candidates = command_candidates(command, pathext);
    let has_explicit_parent = command_path
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty());
    if command_path.is_absolute() || has_explicit_parent {
        return candidates
            .into_iter()
            .map(PathBuf::from)
            .find(|candidate| executable_file(candidate));
    }
    path_entries.iter().find_map(|directory| {
        candidates
            .iter()
            .map(|candidate| directory.join(candidate))
            .find(|candidate| executable_file(candidate))
    })
}

fn resolve_command(command: &str) -> Option<PathBuf> {
    let pathext = env::var_os("PATHEXT");
    resolve_command_from_paths(
        std::ffi::OsStr::new(command),
        &augmented_path_entries(),
        pathext.as_deref(),
    )
}

fn command_available(command: &str) -> bool {
    resolve_command(command).is_some()
}

struct AcpCommandPlan {
    executable: PathBuf,
    args: Vec<OsString>,
    env: HashMap<OsString, OsString>,
    augment_path: bool,
}

fn external_command_plan_with_executable(
    spec: &AcpProviderSpec,
    cwd: &Path,
    executable: PathBuf,
) -> AcpCommandPlan {
    debug_assert_eq!(spec.kind, AcpProviderKind::External);
    let mut args = spec.command[1..]
        .iter()
        .map(OsString::from)
        .collect::<Vec<_>>();
    if let Some(cwd_flag) = spec.cwd_flag {
        args.push(OsString::from(cwd_flag));
        args.push(cwd.as_os_str().to_owned());
    }
    AcpCommandPlan {
        executable,
        args,
        env: spec
            .env
            .iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect(),
        augment_path: true,
    }
}

#[cfg(test)]
fn external_command_plan(spec: &AcpProviderSpec, cwd: &Path) -> AcpCommandPlan {
    external_command_plan_with_executable(spec, cwd, PathBuf::from(spec.command[0]))
}

fn resolved_external_command_plan(spec: &AcpProviderSpec, cwd: &Path) -> Option<AcpCommandPlan> {
    resolve_command(spec.command[0])
        .map(|executable| external_command_plan_with_executable(spec, cwd, executable))
}

fn configure_command_environment(command: &mut Command, plan: &AcpCommandPlan) {
    if plan.augment_path {
        command.envs(acp_process_env(&[]));
    }
    command.envs(&plan.env);
}

fn provider_info(spec: &AcpProviderSpec, available: bool) -> AcpProviderInfo {
    AcpProviderInfo {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        available,
        kind: spec.kind.as_str(),
        requires_api_provider: spec.requires_api_provider,
    }
}

#[tauri::command]
pub fn acp_list_providers() -> Vec<AcpProviderInfo> {
    ACP_PROVIDERS
        .iter()
        .map(|spec| provider_info(spec, command_available(spec.command[0])))
        .collect()
}

impl AcpSessionState {
    fn emit(&self, mut event: AcpSessionEvent) {
        event.session_id = self.session_id.clone();
        if let Some(app) = &self.app {
            let _ = app.emit(ACP_EVENT, event);
        }
    }

    fn send_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Agent 会话已关闭".to_string());
        }
        let request_id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "Agent 会话状态不可用".to_string())?
            .insert(request_id, tx);
        let message = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        if self.writer_tx.try_send(message).is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            return Err("Agent 进程写入失败".to_string());
        }
        Ok(rx)
    }

    fn fail_pending(&self, error: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(error.to_string()));
            }
        }
        resolve_pending_permissions(&self.permissions);
        resolve_pending_interactions(&self.questions);
        resolve_pending_interactions(&self.plan_approvals);
    }
}

fn resolve_pending_permissions(
    permissions: &StdMutex<HashMap<String, oneshot::Sender<Option<String>>>>,
) {
    if let Ok(mut permissions) = permissions.lock() {
        for (_, sender) in permissions.drain() {
            let _ = sender.send(None);
        }
    }
}

fn resolve_permission_response(
    permissions: &StdMutex<HashMap<String, oneshot::Sender<Option<String>>>>,
    request_id: &str,
    option_id: Option<String>,
) -> Result<(), String> {
    let sender = permissions
        .lock()
        .map_err(|_| "Agent 权限状态不可用".to_string())?
        .remove(request_id)
        .ok_or_else(|| "权限请求已失效".to_string())?;
    sender
        .send(option_id)
        .map_err(|_| "权限请求已结束".to_string())
}

fn resolve_pending_interactions(interactions: &StdMutex<HashMap<String, oneshot::Sender<Value>>>) {
    if let Ok(mut interactions) = interactions.lock() {
        for (_, sender) in interactions.drain() {
            let _ = sender.send(json!({ "outcome": "cancelled" }));
        }
    }
}

fn resolve_interaction_response(
    interactions: &StdMutex<HashMap<String, oneshot::Sender<Value>>>,
    request_id: &str,
    outcome: Value,
    expired_error: &str,
    ended_error: &str,
) -> Result<(), String> {
    let sender = interactions
        .lock()
        .map_err(|_| expired_error.to_string())?
        .remove(request_id)
        .ok_or_else(|| expired_error.to_string())?;
    sender.send(outcome).map_err(|_| ended_error.to_string())
}

fn permission_response_outcome(option_id: Option<String>) -> Value {
    match option_id {
        Some(option_id) => json!({
            "outcome": { "outcome": "selected", "optionId": option_id }
        }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

fn cancel_session(
    writer_tx: &mpsc::Sender<Value>,
    agent_session_id: &str,
    permissions: &StdMutex<HashMap<String, oneshot::Sender<Option<String>>>>,
    questions: &StdMutex<HashMap<String, oneshot::Sender<Value>>>,
    plan_approvals: &StdMutex<HashMap<String, oneshot::Sender<Value>>>,
) -> Result<(), String> {
    resolve_pending_permissions(permissions);
    resolve_pending_interactions(questions);
    resolve_pending_interactions(plan_approvals);
    writer_tx
        .try_send(json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": agent_session_id },
        }))
        .map_err(|_| "Agent 进程写入失败".to_string())
}

const ACP_TERMINATE_WAIT: Duration = Duration::from_secs(1);
const ACP_KILL_WAIT: Duration = Duration::from_secs(1);

async fn terminate_and_reap_child(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let _ = crate::process_tree::terminate_process_group(pid);
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();

    if tokio::time::timeout(ACP_TERMINATE_WAIT, child.wait())
        .await
        .is_ok()
    {
        return;
    }

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let _ = crate::process_tree::kill_process_group(pid);
    }
    #[cfg(not(unix))]
    let _ = child.start_kill();

    if tokio::time::timeout(ACP_KILL_WAIT, child.wait())
        .await
        .is_err()
    {
        log::warn!("timed out waiting for terminated ACP child after SIGKILL");
    }
}

async fn cleanup_unregistered_child(child: &mut Child) {
    terminate_and_reap_child(child).await;
}

fn emit_closed_state(state: &AcpSessionState, pending_error: &str, closed_error: Option<&str>) {
    state.fail_pending(pending_error);
    if state.turn_active.swap(false, Ordering::SeqCst) {
        let mut event = AcpSessionEvent::base(&state.session_id, "turn_failed");
        event.error = Some(pending_error.to_string());
        state.emit(event);
    }
    let mut event = AcpSessionEvent::base(&state.session_id, "closed");
    event.error = closed_error.map(str::to_string);
    state.emit(event);
}

fn close_session_state(
    state: &AcpSessionState,
    pending_error: &str,
    closed_error: Option<&str>,
) -> bool {
    if state.closed.swap(true, Ordering::SeqCst) {
        return false;
    }
    emit_closed_state(state, pending_error, closed_error);
    true
}

fn close_reader_session(state: &Arc<AcpSessionState>) -> Option<AcpOwnedSession> {
    let already_closed = state.closed.swap(true, Ordering::SeqCst);
    let handle = state.runtime.take_owned_session(&state.session_id);
    if !already_closed {
        emit_closed_state(state, "Agent 进程已退出", Some("Agent 进程已退出"));
    }
    handle
}

async fn reap_owned_session(handle: AcpOwnedSession) {
    match handle {
        AcpOwnedSession::Initializing(mut handle) => {
            terminate_and_reap_child(&mut handle.child).await;
        }
        AcpOwnedSession::Registered(mut handle) => {
            drop(handle.command_tx);
            terminate_and_reap_child(&mut handle.child).await;
        }
    }
}

async fn shutdown_session_handle(
    handle: AcpSessionHandle,
    pending_error: &'static str,
    closed_error: Option<&'static str>,
) {
    close_session_state(&handle.state, pending_error, closed_error);
    reap_owned_session(AcpOwnedSession::Registered(handle)).await;
}

fn content_blocks_text(blocks: &Value) -> Option<String> {
    let items: Vec<&Value> = match blocks {
        Value::Array(array) => array.iter().collect(),
        block @ Value::Object(_) => vec![block],
        _ => return None,
    };
    let mut text = String::new();
    for item in items {
        let block = match item.get("type").and_then(Value::as_str) {
            Some("content") => item.get("content").unwrap_or(&Value::Null),
            _ => item,
        };
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(chunk) = block.get("text").and_then(Value::as_str) {
                text.push_str(chunk);
            }
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn translate_session_update(state: &AcpSessionState, session_id: &str, update: &Value) {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or("");
    match kind {
        "agent_message_chunk" => {
            let mut event = AcpSessionEvent::base(session_id, "agent_message_chunk");
            event.message_id = update
                .get("messageId")
                .and_then(Value::as_str)
                .map(str::to_string);
            event.text = content_blocks_text(update.get("content").unwrap_or(&Value::Null));
            state.emit(event);
        }
        "agent_thought_chunk" => {
            let mut event = AcpSessionEvent::base(session_id, "agent_thought_chunk");
            event.text = content_blocks_text(update.get("content").unwrap_or(&Value::Null));
            state.emit(event);
        }
        "tool_call" | "tool_call_update" => {
            let event_kind = if kind == "tool_call" {
                "tool_call"
            } else {
                "tool_call_update"
            };
            let mut event = AcpSessionEvent::base(session_id, event_kind);
            event.tool_call_id = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_string);
            event.tool_title = update
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string);
            event.tool_kind = update
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_string);
            event.status = update
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(content) = update.get("content") {
                event.content = content_blocks_text(content);
            }
            let raw_input = ["raw", "rawInput"]
                .iter()
                .find_map(|key| update.get(*key))
                .and_then(|raw| raw.get("input"));
            if let Some(input) = raw_input {
                if let Some(text) = input.as_str() {
                    if !text.trim().is_empty() {
                        event.content = Some(text.to_string());
                    }
                } else if !input.is_null() {
                    event.content = Some(input.to_string());
                }
            }
            state.emit(event);
        }
        "plan" => {
            let mut event = AcpSessionEvent::base(session_id, "plan");
            event.plan = update.get("plan").and_then(Value::as_array).map(|entries| {
                entries
                    .iter()
                    .map(|entry| {
                        json!({
                            "content": entry.get("content").cloned().unwrap_or(Value::Null),
                            "status": entry.get("status").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect()
            });
            state.emit(event);
        }
        "user_message_chunk" => {}
        _ => {}
    }
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn normalize_question_options(question: &Value) -> Vec<Value> {
    question
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .enumerate()
                .map(|(index, option)| {
                    let id = value_string(option.get("id"))
                        .or_else(|| value_string(option.get("optionId")))
                        .unwrap_or_else(|| format!("option-{index}"));
                    let label = value_string(option.get("label"))
                        .or_else(|| value_string(option.get("name")))
                        .unwrap_or_else(|| id.clone());
                    json!({ "id": id, "label": label })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_questions(params: &Value) -> Option<Vec<Value>> {
    params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .enumerate()
                .map(|(index, question)| {
                    let id = value_string(question.get("id"))
                        .unwrap_or_else(|| format!("question-{index}"));
                    let prompt = value_string(question.get("prompt"))
                        .or_else(|| value_string(question.get("title")))
                        .unwrap_or_else(|| id.clone());
                    json!({
                        "id": id,
                        "prompt": prompt,
                        "options": normalize_question_options(question),
                        "allowMultiple": question
                            .get("allowMultiple")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
}

fn normalize_plan_entries(value: Option<&Value>) -> Option<Vec<Value>> {
    value.and_then(Value::as_array).map(|entries| {
        entries
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let content = value_string(entry.get("content"))
                    .or_else(|| value_string(entry.get("title")))
                    .or_else(|| value_string(entry.get("name")))
                    .unwrap_or_else(|| format!("步骤 {}", index + 1));
                json!({
                    "id": value_string(entry.get("id")),
                    "content": content,
                    "status": value_string(entry.get("status")),
                })
            })
            .collect()
    })
}

fn normalize_plan_phases(params: &Value) -> Option<Vec<Value>> {
    params
        .get("phases")
        .or_else(|| params.pointer("/plan/phases"))
        .and_then(Value::as_array)
        .map(|phases| {
            phases
                .iter()
                .enumerate()
                .map(|(index, phase)| {
                    json!({
                        "id": value_string(phase.get("id")),
                        "name": value_string(phase.get("name"))
                            .or_else(|| value_string(phase.get("title")))
                            .unwrap_or_else(|| format!("阶段 {}", index + 1)),
                        "todos": normalize_plan_entries(phase.get("todos"))
                            .or_else(|| normalize_plan_entries(phase.get("items")))
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
}

fn handle_server_request(state: Arc<AcpSessionState>, id: &Value, method: &str, params: &Value) {
    if method == "session/request_permission" {
        let request_key = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Option<String>>();
        if let Ok(mut permissions) = state.permissions.lock() {
            permissions.insert(request_key.clone(), tx);
        } else {
            return;
        }
        let mut event = AcpSessionEvent::base(&state.session_id, "permission_requested");
        event.request_id = Some(request_key.clone());
        event.title = params
            .get("title")
            .or_else(|| params.pointer("/toolCall/title"))
            .and_then(Value::as_str)
            .map(str::to_string);
        event.options = params
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .map(|option| {
                        json!({
                            "optionId": option.get("optionId").cloned().unwrap_or(Value::Null),
                            "name": option.get("name").cloned().unwrap_or(Value::Null),
                            "kind": option.get("kind").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect()
            });
        state.emit(event);
        let state_for_response = state.clone();
        let request_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = permission_response_outcome(rx.await.ok().flatten());
            if let Ok(mut permissions) = state_for_response.permissions.lock() {
                permissions.remove(&request_key);
            }
            let mut resolved =
                AcpSessionEvent::base(&state_for_response.session_id, "permission_resolved");
            resolved.request_id = Some(request_key);
            state_for_response.emit(resolved);
            let _ = state_for_response.writer_tx.try_send(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": outcome,
            }));
        });
        return;
    }
    if method == "cursor/ask_question" {
        let request_key = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Value>();
        if let Ok(mut questions) = state.questions.lock() {
            questions.insert(request_key.clone(), tx);
        } else {
            return;
        }
        let mut event = AcpSessionEvent::base(&state.session_id, "question_requested");
        event.request_id = Some(request_key.clone());
        event.tool_call_id = params
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string);
        event.title = value_string(params.get("title"))
            .or_else(|| value_string(params.pointer("/toolCall/title")));
        event.questions = normalize_questions(params);
        state.emit(event);
        let state_for_response = state.clone();
        let request_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = rx
                .await
                .unwrap_or_else(|_| json!({ "outcome": "cancelled" }));
            if let Ok(mut questions) = state_for_response.questions.lock() {
                questions.remove(&request_key);
            }
            let mut resolved =
                AcpSessionEvent::base(&state_for_response.session_id, "question_resolved");
            resolved.request_id = Some(request_key);
            state_for_response.emit(resolved);
            let _ = state_for_response.writer_tx.try_send(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": { "outcome": outcome },
            }));
        });
        return;
    }
    if method == "cursor/create_plan" {
        let request_key = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<Value>();
        if let Ok(mut plan_approvals) = state.plan_approvals.lock() {
            plan_approvals.insert(request_key.clone(), tx);
        } else {
            return;
        }
        let mut event = AcpSessionEvent::base(&state.session_id, "plan_approval_requested");
        event.request_id = Some(request_key.clone());
        event.tool_call_id = params
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_string);
        event.title = value_string(params.get("title"))
            .or_else(|| value_string(params.get("name")))
            .or_else(|| value_string(params.pointer("/plan/title")))
            .or_else(|| value_string(params.pointer("/plan/name")));
        event.content = value_string(params.get("overview"))
            .or_else(|| value_string(params.get("description")))
            .or_else(|| value_string(params.get("planMarkdown")))
            .or_else(|| value_string(params.get("plan")));
        event.plan = normalize_plan_entries(params.get("todos"))
            .or_else(|| normalize_plan_entries(params.pointer("/plan/todos")))
            .or_else(|| normalize_plan_entries(params.get("plan")));
        event.phases = normalize_plan_phases(params);
        state.emit(event);
        let state_for_response = state.clone();
        let request_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = rx
                .await
                .unwrap_or_else(|_| json!({ "outcome": "cancelled" }));
            if let Ok(mut plan_approvals) = state_for_response.plan_approvals.lock() {
                plan_approvals.remove(&request_key);
            }
            let mut resolved =
                AcpSessionEvent::base(&state_for_response.session_id, "plan_approval_resolved");
            resolved.request_id = Some(request_key);
            state_for_response.emit(resolved);
            let _ = state_for_response.writer_tx.try_send(json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": { "outcome": outcome },
            }));
        });
        return;
    }
    let _ = state.writer_tx.try_send(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32601, "message": "method not found" },
    }));
}

fn spawn_reader_task(state: Arc<AcpSessionState>, stdout: tokio::process::ChildStdout) {
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                log::warn!("ACP 非 JSON 输出: {trimmed}");
                continue;
            };
            if let Some(id) = message.get("id") {
                if message.get("method").is_some() && message.get("result").is_none() {
                    let method = message
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    handle_server_request(
                        state.clone(),
                        id,
                        &method,
                        message.get("params").unwrap_or(&Value::Null),
                    );
                    continue;
                }
                let request_id = id
                    .as_u64()
                    .or_else(|| id.as_str().and_then(|value| value.parse::<u64>().ok()));
                let Some(request_id) = request_id else {
                    continue;
                };
                let sender = state
                    .pending
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&request_id));
                let Some(sender) = sender else {
                    continue;
                };
                if let Some(error) = message.get("error") {
                    let text = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("未知错误");
                    let _ = sender.send(Err(format!("Agent 返回错误: {text}")));
                } else {
                    let _ = sender.send(Ok(message.get("result").cloned().unwrap_or(Value::Null)));
                }
                continue;
            }
            let method = message
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if method == "session/update" {
                let event_session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let agent_session_id = state
                    .agent_session_id
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone());
                if let Some(expected) = agent_session_id {
                    if !event_session_id.is_empty() && event_session_id != expected {
                        continue;
                    }
                }
                if let Some(update) = params.get("update") {
                    translate_session_update(&state, &state.session_id, update);
                }
            }
        }
        if let Some(handle) = close_reader_session(&state) {
            tauri::async_runtime::spawn(async move {
                reap_owned_session(handle).await;
            });
        }
    });
}

fn spawn_stderr_task(stderr: tokio::process::ChildStderr, provider: &str) {
    let provider = provider.to_string();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                log::info!("[{provider}] {trimmed}");
            }
        }
    });
}

fn agent_session_id_of(state: &AcpSessionState) -> String {
    state
        .agent_session_id
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

async fn run_command_loop(state: Arc<AcpSessionState>, mut command_rx: mpsc::Receiver<AcpCommand>) {
    while let Some(command) = command_rx.recv().await {
        let internal_session_id = state.session_id.clone();
        let agent_session_id = agent_session_id_of(&state);
        match command {
            AcpCommand::Prompt { text } => {
                if state.closed.load(Ordering::SeqCst) || agent_session_id.is_empty() {
                    let mut event = AcpSessionEvent::base(&internal_session_id, "turn_failed");
                    event.error = Some("Agent 会话已关闭".to_string());
                    state.emit(event);
                    continue;
                }
                state.turn_active.store(true, Ordering::SeqCst);
                let request = state.send_request(
                    "session/prompt",
                    json!({
                        "sessionId": agent_session_id,
                        "prompt": [{ "type": "text", "text": text }],
                    }),
                );
                match request {
                    Ok(receiver) => match receiver.await {
                        Ok(Ok(result)) => {
                            state.turn_active.store(false, Ordering::SeqCst);
                            let mut event =
                                AcpSessionEvent::base(&internal_session_id, "turn_completed");
                            event.stop_reason = result
                                .get("stopReason")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            state.emit(event);
                        }
                        Ok(Err(error)) => {
                            state.turn_active.store(false, Ordering::SeqCst);
                            let mut event =
                                AcpSessionEvent::base(&internal_session_id, "turn_failed");
                            event.error = Some(error);
                            state.emit(event);
                        }
                        Err(_) => {
                            if state.turn_active.swap(false, Ordering::SeqCst) {
                                let mut event =
                                    AcpSessionEvent::base(&internal_session_id, "turn_failed");
                                event.error = Some("Agent 会话已中断".to_string());
                                state.emit(event);
                            }
                        }
                    },
                    Err(error) => {
                        state.turn_active.store(false, Ordering::SeqCst);
                        let mut event = AcpSessionEvent::base(&internal_session_id, "turn_failed");
                        event.error = Some(error);
                        state.emit(event);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn acp_start_session(
    app: AppHandle,
    runtime: State<'_, Arc<AcpRuntime>>,
    request: AcpSessionStartRequest,
) -> Result<AcpSessionStartResponse, String> {
    let spec = ACP_PROVIDERS
        .iter()
        .find(|spec| spec.id == request.provider_id)
        .ok_or_else(|| "未知的 Agent 提供方".to_string())?;
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var("HOME").ok().map(PathBuf::from))
        .ok_or_else(|| "无法确定 Agent 工作目录".to_string())?;
    let _ = request.api_provider_id.as_deref();
    let _ = request.enable_tools;
    let plan = resolved_external_command_plan(spec, &cwd)
        .ok_or_else(|| format!("未找到 {} 命令，请先安装 {}", spec.command[0], spec.name))?;

    let (writer_tx, mut writer_rx) = mpsc::channel::<Value>(256);
    let session_id = Uuid::new_v4().to_string();
    let runtime_handle = runtime.inner().clone();
    let state = Arc::new(AcpSessionState {
        app: Some(app.clone()),
        runtime: runtime_handle,
        session_id: session_id.clone(),
        agent_session_id: StdMutex::new(None),
        writer_tx,
        next_request_id: AtomicU64::new(1),
        pending: StdMutex::new(HashMap::new()),
        permissions: StdMutex::new(HashMap::new()),
        questions: StdMutex::new(HashMap::new()),
        plan_approvals: StdMutex::new(HashMap::new()),
        turn_active: AtomicBool::new(false),
        closed: AtomicBool::new(false),
    });

    let mut command = Command::new(&plan.executable);
    command
        .args(&plan.args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::process_tree::configure_command(command.as_std_mut());
    configure_command_environment(&mut command, &plan);
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动 {}: {error}", spec.name))?;
    if let Err(mut child) = runtime.track_initializing(session_id.clone(), state.clone(), child) {
        let error = "应用正在退出，无法建立 Agent 会话".to_string();
        close_session_state(&state, &error, Some(&error));
        cleanup_unregistered_child(&mut child).await;
        return Err(error);
    }

    let startup_result = async {
        let (mut stdin, stdout, stderr) = runtime.take_initializing_io(&session_id)?;
        spawn_stderr_task(stderr, spec.id);
        tauri::async_runtime::spawn(async move {
            while let Some(message) = writer_rx.recv().await {
                let mut line = serde_json::to_string(&message).unwrap_or_default();
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        spawn_reader_task(state.clone(), stdout);

        let initialize_rx = state.send_request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false }
                },
                "clientInfo": {
                    "name": "qwenaudio-toolkits",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
        )?;
        let initialize = tokio::time::timeout(
            Duration::from_secs(INITIALIZE_TIMEOUT_SECONDS),
            initialize_rx,
        )
        .await
        .map_err(|_| "Agent 启动超时，请确认已安装并登录".to_string())?
        .map_err(|_| "Agent 会话已中断".to_string())?
        .map_err(|error| error)?;
        let agent_name = initialize
            .pointer("/agentInfo/name")
            .and_then(Value::as_str)
            .unwrap_or(spec.name);

        let mcp_servers: Vec<Value> = Vec::new();
        let session_new_rx = state.send_request(
            "session/new",
            json!({
                "cwd": cwd.to_string_lossy(),
                "mcpServers": mcp_servers,
            }),
        )?;
        let session_new = tokio::time::timeout(
            Duration::from_secs(SESSION_NEW_TIMEOUT_SECONDS),
            session_new_rx,
        )
        .await
        .map_err(|_| "Agent 会话创建超时".to_string())?
        .map_err(|_| "Agent 会话已中断".to_string())?
        .map_err(|error| error)?;
        let agent_session_id = session_new
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Agent 未返回会话 ID".to_string())?
            .to_string();
        if let Ok(mut guard) = state.agent_session_id.lock() {
            *guard = Some(agent_session_id.clone());
        }
        let (model_options, mut current_model_id) = session_models(&session_new);
        if let Some(model_id) = request.model_id.as_deref().filter(|id| !id.is_empty()) {
            if let Some((method, params)) =
                model_selection_request(&session_new, &agent_session_id, model_id, spec.kind)?
            {
                let receiver = state.send_request(method, params)?;
                let result = tokio::time::timeout(Duration::from_secs(30), receiver)
                    .await
                    .map_err(|_| "Agent 模型切换超时".to_string())?
                    .map_err(|_| "Agent 会话已中断".to_string())??;
                if let Some(actual) = session_models(&result).1 {
                    if actual != model_id {
                        return Err("Agent 未应用所选模型".to_string());
                    }
                }
            }
            current_model_id = Some(model_id.to_string());
        }
        let models = model_options.iter().map(|model| model.id.clone()).collect();
        let modes = session_new
            .pointer("/modes/availableModes")
            .or_else(|| session_new.get("modes"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let (command_tx, command_rx) = mpsc::channel::<AcpCommand>(64);
        runtime.promote_initializing(&session_id, command_tx)?;
        tauri::async_runtime::spawn({
            let state = state.clone();
            async move {
                run_command_loop(state, command_rx).await;
            }
        });

        log::info!(
            "ACP 会话已建立: provider={} internal={} agent_session={}",
            spec.id,
            session_id,
            agent_session_id
        );

        Ok(AcpSessionStartResponse {
            session_id: session_id.clone(),
            provider_id: spec.id.to_string(),
            provider_name: agent_name.to_string(),
            models,
            model_options,
            current_model_id,
            modes,
        })
    }
    .await;

    match startup_result {
        Ok(response) => Ok(response),
        Err(error) => {
            close_session_state(&state, &error, Some(&error));
            if let Some(handle) = runtime.take_owned_session(&session_id) {
                reap_owned_session(handle).await;
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn acp_send_prompt(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    prompt: String,
) -> Result<(), String> {
    let text = prompt.trim().to_string();
    if text.is_empty() {
        return Err("对话内容不能为空".to_string());
    }
    let sender = runtime.session_sender(&session_id)?;
    sender
        .try_send(AcpCommand::Prompt { text })
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => "Agent 正在处理上一条消息".to_string(),
            mpsc::error::TrySendError::Closed(_) => "Agent 会话已经关闭".to_string(),
        })
}

#[tauri::command]
pub fn acp_cancel_turn(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
) -> Result<(), String> {
    let state = runtime.session_state(&session_id)?;
    if state.closed.load(Ordering::SeqCst) {
        return Err("Agent 会话已关闭".to_string());
    }
    cancel_session(
        &state.writer_tx,
        &agent_session_id_of(&state),
        &state.permissions,
        &state.questions,
        &state.plan_approvals,
    )
}

#[tauri::command]
pub fn acp_respond_permission(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let state = runtime.session_state(&session_id)?;
    resolve_permission_response(&state.permissions, &request_id, option_id)
}

#[tauri::command]
pub fn acp_respond_question(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    request_id: String,
    outcome: Value,
) -> Result<(), String> {
    let state = runtime.session_state(&session_id)?;
    resolve_interaction_response(
        &state.questions,
        &request_id,
        outcome,
        "问题请求已失效",
        "问题请求已结束",
    )
}

#[tauri::command]
pub fn acp_respond_plan_approval(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    request_id: String,
    outcome: Value,
) -> Result<(), String> {
    let state = runtime.session_state(&session_id)?;
    resolve_interaction_response(
        &state.plan_approvals,
        &request_id,
        outcome,
        "计划确认请求已失效",
        "计划确认请求已结束",
    )
}

#[tauri::command]
pub async fn acp_finish_session(
    _app: AppHandle,
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
) -> Result<(), String> {
    if let Some(handle) = runtime.take_registered(&session_id) {
        shutdown_session_handle(handle, "Agent 会话已关闭", None).await;
    }
    Ok(())
}

pub async fn acp_shutdown_all(app: &AppHandle) {
    let Some(runtime) = app.try_state::<Arc<AcpRuntime>>() else {
        return;
    };
    runtime.shutdown_all().await;
}

#[cfg(test)]
fn test_session_state_with_writer(
    runtime: Arc<AcpRuntime>,
    session_id: &str,
    writer_tx: mpsc::Sender<Value>,
) -> Arc<AcpSessionState> {
    Arc::new(AcpSessionState {
        app: None,
        runtime,
        session_id: session_id.to_string(),
        agent_session_id: StdMutex::new(None),
        writer_tx,
        next_request_id: AtomicU64::new(1),
        pending: StdMutex::new(HashMap::new()),
        permissions: StdMutex::new(HashMap::new()),
        questions: StdMutex::new(HashMap::new()),
        plan_approvals: StdMutex::new(HashMap::new()),
        turn_active: AtomicBool::new(false),
        closed: AtomicBool::new(false),
    })
}

#[cfg(test)]
fn test_session_state(runtime: Arc<AcpRuntime>, session_id: &str) -> Arc<AcpSessionState> {
    let (writer_tx, _writer_rx) = mpsc::channel(1);
    test_session_state_with_writer(runtime, session_id, writer_tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn providers() -> &'static [AcpProviderSpec] {
        ACP_PROVIDERS
    }

    #[test]
    fn send_request_removes_pending_sender_when_writer_is_full() {
        let runtime = Arc::new(AcpRuntime::default());
        let (writer_tx, _writer_rx) = mpsc::channel(1);
        writer_tx
            .try_send(json!({ "already": "queued" }))
            .expect("fill writer channel");
        let state = test_session_state_with_writer(runtime, "full-writer", writer_tx);

        assert!(state.send_request("test/request", Value::Null).is_err());
        assert!(state.pending.lock().expect("inspect pending").is_empty());
    }

    #[test]
    fn send_request_removes_pending_sender_when_writer_is_closed() {
        let runtime = Arc::new(AcpRuntime::default());
        let (writer_tx, writer_rx) = mpsc::channel(1);
        drop(writer_rx);
        let state = test_session_state_with_writer(runtime, "closed-writer", writer_tx);

        assert!(state.send_request("test/request", Value::Null).is_err());
        assert!(state.pending.lock().expect("inspect pending").is_empty());
    }

    #[test]
    fn send_request_enqueues_message_and_preserves_response_flow() {
        tauri::async_runtime::block_on(async {
            let runtime = Arc::new(AcpRuntime::default());
            let (writer_tx, mut writer_rx) = mpsc::channel(1);
            let state = test_session_state_with_writer(runtime, "successful-writer", writer_tx);

            let response = state
                .send_request("test/request", json!({ "value": true }))
                .expect("send request");

            assert_eq!(
                writer_rx.recv().await,
                Some(json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "test/request",
                    "params": { "value": true },
                }))
            );
            state
                .pending
                .lock()
                .expect("inspect pending")
                .remove(&1)
                .expect("pending request")
                .send(Ok(json!({ "accepted": true })))
                .expect("deliver response");
            assert_eq!(
                response.await.expect("receive response"),
                Ok(json!({ "accepted": true }))
            );
        });
    }

    #[test]
    fn provider_registry_excludes_bundled_opencode() {
        assert!(providers()
            .iter()
            .all(|provider| provider.id != "opencode-bundled"));
    }

    #[test]
    fn advertised_config_models_take_precedence_and_use_config_id() {
        let value = json!({ "configOptions": [{ "id": "model-selector", "category": "model", "type": "select", "currentValue": "fast", "options": [
            { "value": "fast", "name": "Fast" },
            { "group": "Other", "options": [{ "value": "deep", "name": "Deep" }] }
        ] }], "models": { "currentModelId": "old", "availableModels": [{ "modelId": "old", "name": "Old" }] } });
        let (models, current) = session_models(&value);
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["fast", "deep"]
        );
        assert_eq!(current.as_deref(), Some("fast"));
        let (method, params) =
            model_selection_request(&value, "session", "deep", AcpProviderKind::External)
                .unwrap()
                .unwrap();
        assert_eq!(method, "session/set_config_option");
        assert_eq!(
            params,
            json!({ "sessionId": "session", "configId": "model-selector", "value": "deep" })
        );
        assert!(
            model_selection_request(&value, "session", "old", AcpProviderKind::External).is_err()
        );
        assert!(
            model_selection_request(&value, "session", "fast", AcpProviderKind::External)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn legacy_model_state_uses_set_model_without_inventing_choices() {
        let value = json!({ "models": { "currentModelId": "a", "availableModels": [{ "modelId": "a", "name": "A" }, { "modelId": "b", "name": "B" }] } });
        assert_eq!(session_models(&value).0[1].name, "B");
        let (method, params) =
            model_selection_request(&value, "session", "b", AcpProviderKind::External)
                .unwrap()
                .unwrap();
        assert_eq!(method, "session/set_model");
        assert_eq!(params["modelId"], "b");
        assert!(session_models(&json!({})).0.is_empty());
        assert!(model_selection_request(
            &json!({}),
            "session",
            "guessed",
            AcpProviderKind::External,
        )
        .is_err());
    }

    #[test]
    fn qoder_uses_the_acp_entry_point() {
        assert_eq!(
            ACP_PROVIDERS
                .iter()
                .find(|provider| provider.id == "qoder")
                .unwrap()
                .command,
            &["qoder", "--acp"]
        );
    }

    #[test]
    fn opencode_uses_acp_with_explicit_cwd() {
        let provider = ACP_PROVIDERS
            .iter()
            .find(|provider| provider.id == "opencode")
            .unwrap();
        assert_eq!(provider.command, &["opencode", "acp"]);
        assert_eq!(provider.cwd_flag, Some("--cwd"));
        assert_eq!(provider.env, &[("OPENCODE_DISABLE_AUTOUPDATE", "1")]);
    }

    #[test]
    fn external_opencode_argv_stays_unchanged() {
        let external = ACP_PROVIDERS
            .iter()
            .find(|provider| provider.id == "opencode")
            .expect("external OpenCode provider");
        let plan = external_command_plan(external, std::path::Path::new("/tmp/acp-workspace"));
        assert!(plan.augment_path);
        assert_eq!(plan.executable, std::path::PathBuf::from("opencode"));
        assert_eq!(
            plan.args
                .iter()
                .map(|argument| argument.to_string_lossy())
                .collect::<Vec<_>>(),
            vec!["acp", "--cwd", "/tmp/acp-workspace"]
        );
        assert_eq!(
            plan.env[std::ffi::OsStr::new("OPENCODE_DISABLE_AUTOUPDATE")],
            std::ffi::OsStr::new("1")
        );
    }

    #[test]
    fn external_launch_command_keeps_injected_parent_environment() {
        let external = ACP_PROVIDERS
            .iter()
            .find(|provider| provider.id == "opencode")
            .expect("external OpenCode provider");
        let plan = external_command_plan(external, std::path::Path::new("/tmp/acp-workspace"));
        let mut command = Command::new(&plan.executable);
        command.env("UNRELATED_PARENT_SECRET", "external-provider-keeps-it");
        configure_command_environment(&mut command, &plan);

        assert!(command.as_std().get_envs().any(|(key, value)| {
            key == "UNRELATED_PARENT_SECRET"
                && value == Some(std::ffi::OsStr::new("external-provider-keeps-it"))
        }));
    }

    #[test]
    fn provider_registry_allows_only_installed_external_clis() {
        assert_eq!(
            providers()
                .iter()
                .map(|provider| provider.id)
                .collect::<Vec<_>>(),
            vec!["qoder", "opencode", "kimi"]
        );
        assert!(providers().iter().all(|provider| {
            provider.command.first() != Some(&"npx")
                && !provider.command.iter().any(|argument| *argument == "-y")
        }));
    }

    #[test]
    fn cancel_resolves_pending_interactions_and_enqueues_cancel_notification() {
        tauri::async_runtime::block_on(async {
            let (writer_tx, mut writer_rx) = mpsc::channel(1);
            let permissions = StdMutex::new(HashMap::new());
            let questions = StdMutex::new(HashMap::new());
            let plan_approvals = StdMutex::new(HashMap::new());
            let (permission_tx, permission_rx) = oneshot::channel();
            let (question_tx, question_rx) = oneshot::channel();
            let (plan_tx, plan_rx) = oneshot::channel();
            permissions
                .lock()
                .unwrap()
                .insert("permission-1".to_string(), permission_tx);
            questions
                .lock()
                .unwrap()
                .insert("question-1".to_string(), question_tx);
            plan_approvals
                .lock()
                .unwrap()
                .insert("plan-1".to_string(), plan_tx);

            cancel_session(
                &writer_tx,
                "agent-session",
                &permissions,
                &questions,
                &plan_approvals,
            )
            .unwrap();

            assert_eq!(permission_rx.await.unwrap(), None);
            assert_eq!(
                question_rx.await.unwrap(),
                json!({ "outcome": "cancelled" })
            );
            assert_eq!(plan_rx.await.unwrap(), json!({ "outcome": "cancelled" }));
            assert_eq!(
                writer_rx.recv().await,
                Some(json!({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": { "sessionId": "agent-session" },
                }))
            );
        });
    }

    #[test]
    fn permission_response_outcomes_match_acp_protocol() {
        assert_eq!(
            permission_response_outcome(Some("allow-once".to_string())),
            json!({ "outcome": { "outcome": "selected", "optionId": "allow-once" } })
        );
        assert_eq!(
            permission_response_outcome(None),
            json!({ "outcome": { "outcome": "cancelled" } })
        );
    }

    #[test]
    fn permission_responder_delivers_selected_option_once() {
        tauri::async_runtime::block_on(async {
            let permissions = StdMutex::new(HashMap::new());
            let (permission_tx, permission_rx) = oneshot::channel();
            permissions
                .lock()
                .expect("register permission")
                .insert("permission".to_string(), permission_tx);

            resolve_permission_response(&permissions, "permission", Some("allow-once".to_string()))
                .expect("resolve permission");

            assert_eq!(
                permission_rx.await.expect("permission response"),
                Some("allow-once".to_string())
            );
            assert!(resolve_permission_response(&permissions, "permission", None).is_err());
        });
    }

    #[test]
    fn cursor_question_normalization_preserves_protocol_choices() {
        let questions = normalize_questions(&json!({
            "questions": [
                {
                    "id": "scope",
                    "prompt": "  Which scope?  ",
                    "allowMultiple": true,
                    "options": [
                        { "optionId": "small", "name": "Small" },
                        { "id": "large", "label": "Large" }
                    ]
                },
                { "title": "Fallback title" }
            ]
        }))
        .expect("questions are present");

        assert_eq!(
            questions,
            vec![
                json!({
                    "id": "scope",
                    "prompt": "Which scope?",
                    "options": [
                        { "id": "small", "label": "Small" },
                        { "id": "large", "label": "Large" }
                    ],
                    "allowMultiple": true
                }),
                json!({
                    "id": "question-1",
                    "prompt": "Fallback title",
                    "options": [],
                    "allowMultiple": false
                })
            ]
        );
    }

    #[test]
    fn cursor_plan_normalization_accepts_nested_phases_and_todos() {
        let params = json!({
            "plan": {
                "phases": [
                    {
                        "title": "Prepare",
                        "items": [{ "name": "Inspect", "status": "pending" }]
                    }
                ],
                "todos": [{ "id": "ship", "title": "Ship" }]
            }
        });

        assert_eq!(
            normalize_plan_entries(params.pointer("/plan/todos")),
            Some(vec![
                json!({ "id": "ship", "content": "Ship", "status": null })
            ])
        );
        assert_eq!(
            normalize_plan_phases(&params),
            Some(vec![json!({
                "id": null,
                "name": "Prepare",
                "todos": [{ "id": null, "content": "Inspect", "status": "pending" }]
            })])
        );
    }

    #[test]
    fn response_maps_deliver_question_and_plan_outcomes_once() {
        tauri::async_runtime::block_on(async {
            let questions = StdMutex::new(HashMap::new());
            let plans = StdMutex::new(HashMap::new());
            let (question_tx, question_rx) = oneshot::channel();
            let (plan_tx, plan_rx) = oneshot::channel();
            questions
                .lock()
                .unwrap()
                .insert("question".to_string(), question_tx);
            plans.lock().unwrap().insert("plan".to_string(), plan_tx);

            resolve_interaction_response(
                &questions,
                "question",
                json!({ "answers": [{ "questionId": "scope", "optionIds": ["small"] }] }),
                "问题请求已失效",
                "问题请求已结束",
            )
            .expect("resolve question");
            resolve_interaction_response(
                &plans,
                "plan",
                json!({ "approved": true }),
                "计划确认请求已失效",
                "计划确认请求已结束",
            )
            .expect("resolve plan");

            assert_eq!(
                question_rx.await.unwrap(),
                json!({ "answers": [{ "questionId": "scope", "optionIds": ["small"] }] })
            );
            assert_eq!(plan_rx.await.unwrap(), json!({ "approved": true }));
            assert!(resolve_interaction_response(
                &plans,
                "plan",
                json!({ "approved": false }),
                "计划确认请求已失效",
                "计划确认请求已结束",
            )
            .is_err());
        });
    }

    #[test]
    fn augmented_path_round_trips_platform_path_separator() {
        let inherited = env::join_paths([PathBuf::from("project-bin"), PathBuf::from("tool-bin")])
            .expect("join test path");
        let entries = augmented_path_entries_from(
            Some(inherited.as_os_str()),
            Some(Path::new("/home/acp-test")),
        );

        assert!(entries.contains(&PathBuf::from("project-bin")));
        assert!(entries.contains(&PathBuf::from("tool-bin")));
        let joined = join_path_entries([PathBuf::from("project-bin"), PathBuf::from("tool-bin")])
            .expect("join paths");
        assert_eq!(
            env::split_paths(&joined).collect::<Vec<_>>(),
            vec![PathBuf::from("project-bin"), PathBuf::from("tool-bin")]
        );
    }

    #[test]
    fn windows_command_candidates_use_pathext_defaults_and_keep_suffixes() {
        assert_eq!(
            command_candidate_names_for_platform(std::ffi::OsStr::new("qoder"), None, true),
            vec![
                OsString::from("qoder.COM"),
                OsString::from("qoder.EXE"),
                OsString::from("qoder.BAT"),
                OsString::from("qoder.CMD"),
            ]
        );
        assert_eq!(
            command_candidate_names_for_platform(
                std::ffi::OsStr::new("qoder.exe"),
                Some(std::ffi::OsStr::new(".BAT;.CMD")),
                true,
            ),
            vec![OsString::from("qoder.exe")]
        );
    }

    #[cfg(unix)]
    async fn spawn_process_group_fixture() -> (Child, u32, u32) {
        let mut command = Command::new("sh");
        command
            .args([
                "-c",
                "sleep 60 & descendant=$!; printf '%s\\n' \"$descendant\"; wait",
            ])
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true);
        crate::process_tree::configure_command(command.as_std_mut());
        let mut child = command.spawn().expect("spawn process group fixture");
        let root_pid = child.id().expect("fixture root pid");
        let stdout = child.stdout.take().expect("fixture stdout");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("read descendant pid");
        let descendant_pid = line.trim().parse().expect("numeric descendant pid");
        (child, root_pid, descendant_pid)
    }

    #[cfg(unix)]
    fn process_exists(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(unix)]
    async fn assert_processes_gone(pids: &[u32]) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if pids.iter().all(|pid| !process_exists(*pid)) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("process group should be terminated and reaped");
    }

    #[cfg(unix)]
    #[test]
    fn startup_failure_cleanup_terminates_and_reaps_process_group() {
        tauri::async_runtime::block_on(async {
            let (mut child, root_pid, descendant_pid) = spawn_process_group_fixture().await;

            cleanup_unregistered_child(&mut child).await;

            assert_processes_gone(&[root_pid, descendant_pid]).await;
            assert!(child.try_wait().expect("inspect reaped child").is_some());
        });
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_cleanup_terminates_and_reaps_process_group() {
        tauri::async_runtime::block_on(async {
            let (mut child, root_pid, descendant_pid) = spawn_process_group_fixture().await;

            terminate_and_reap_child(&mut child).await;

            assert_processes_gone(&[root_pid, descendant_pid]).await;
            assert!(child.try_wait().expect("inspect reaped child").is_some());
        });
    }

    #[cfg(unix)]
    #[test]
    fn runtime_shutdown_drains_initializing_and_registered_processes_idempotently() {
        tauri::async_runtime::block_on(async {
            let runtime = Arc::new(AcpRuntime::default());
            let initializing_state = test_session_state(runtime.clone(), "initializing");
            let registered_state = test_session_state(runtime.clone(), "registered");
            let (initializing_child, initializing_root, initializing_descendant) =
                spawn_process_group_fixture().await;
            let (registered_child, registered_root, registered_descendant) =
                spawn_process_group_fixture().await;

            runtime
                .track_initializing(
                    "initializing".to_string(),
                    initializing_state.clone(),
                    initializing_child,
                )
                .expect("track initializing child");
            runtime
                .track_initializing(
                    "registered".to_string(),
                    registered_state.clone(),
                    registered_child,
                )
                .expect("track registered child");
            let (command_tx, _command_rx) = mpsc::channel(1);
            runtime
                .promote_initializing("registered", command_tx)
                .expect("promote registered child");

            runtime.shutdown_all().await;

            assert_processes_gone(&[
                initializing_root,
                initializing_descendant,
                registered_root,
                registered_descendant,
            ])
            .await;
            assert!(initializing_state.closed.load(Ordering::SeqCst));
            assert!(registered_state.closed.load(Ordering::SeqCst));

            runtime.shutdown_all().await;

            let late_state = test_session_state(runtime.clone(), "late");
            let (late_child, late_root, late_descendant) = spawn_process_group_fixture().await;
            let mut late_child =
                match runtime.track_initializing("late".to_string(), late_state, late_child) {
                    Ok(()) => panic!("stopping runtime must reject late registration"),
                    Err(child) => child,
                };
            terminate_and_reap_child(&mut late_child).await;
            assert_processes_gone(&[late_root, late_descendant]).await;
        });
    }
}
