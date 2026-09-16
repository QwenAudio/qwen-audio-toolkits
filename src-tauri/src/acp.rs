use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fmt,
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
    provider_kind: AcpProviderKind,
) -> Result<Option<(&'static str, Value)>, String> {
    if provider_kind == AcpProviderKind::Bundled {
        return Ok(None);
    }
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
    Bundled,
}

impl AcpProviderKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::External => "external",
            Self::Bundled => "bundled",
        }
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
        id: "opencode-bundled",
        name: "OpenCode（内置）",
        kind: AcpProviderKind::Bundled,
        requires_api_provider: true,
        command: &[],
        env: &[],
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
    AcpProviderSpec {
        id: "codex",
        name: "Codex",
        kind: AcpProviderKind::External,
        requires_api_provider: false,
        command: &["npx", "-y", "@agentclientprotocol/codex-acp"],
        env: &[],
        cwd_flag: None,
    },
    AcpProviderSpec {
        id: "qwen-code",
        name: "Qwen Code",
        kind: AcpProviderKind::External,
        requires_api_provider: false,
        command: &["npx", "-y", "@qwen-code/qwen-code", "--acp"],
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
    #[serde(skip_serializing_if = "Option::is_none")]
    panel: Option<String>,
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
            panel: None,
        }
    }
}

pub fn emit_panel_requested(app: &AppHandle, session_id: &str, panel: &str) {
    let mut event = AcpSessionEvent::base(session_id, "panel_requested");
    event.panel = Some(panel.to_string());
    if let Err(error) = app.emit(ACP_EVENT, event) {
        log::warn!("could not emit panel requested event: {error}");
    }
}

enum AcpCommand {
    Prompt { text: String },
}

pub struct AcpRuntime {
    sessions: StdMutex<HashMap<String, AcpSessionHandle>>,
}

impl Default for AcpRuntime {
    fn default() -> Self {
        Self {
            sessions: StdMutex::new(HashMap::new()),
        }
    }
}

struct AcpSessionHandle {
    state: Arc<AcpSessionState>,
    command_tx: mpsc::Sender<AcpCommand>,
    child: Arc<tokio::sync::Mutex<Child>>,
}

struct AcpSessionState {
    app: AppHandle,
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

fn augmented_path_entries() -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
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
    entries.push(PathBuf::from("/opt/homebrew/bin"));
    entries.push(PathBuf::from("/usr/local/bin"));
    entries.push(PathBuf::from("/usr/bin"));
    entries.push(PathBuf::from("/bin"));
    entries.push(PathBuf::from("/usr/sbin"));
    entries.push(PathBuf::from("/sbin"));
    if let Ok(path) = env::var("PATH") {
        for dir in path.split(':') {
            if !dir.is_empty() {
                entries.push(PathBuf::from(dir));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    entries.retain(|entry| seen.insert(entry.clone()));
    entries
}

fn acp_process_env(extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut env_map: HashMap<String, String> = env::vars().collect();
    let path = augmented_path_entries()
        .into_iter()
        .filter(|entry| entry.is_dir())
        .map(|entry| entry.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(":");
    if !path.is_empty() {
        env_map.insert("PATH".to_string(), path);
    }
    for (key, value) in extra {
        env_map.insert(key.to_string(), value.to_string());
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

fn command_available(command: &str) -> bool {
    augmented_path_entries()
        .iter()
        .map(|dir| dir.join(command))
        .any(|candidate| executable_file(&candidate))
}

fn bundled_sidecar_path_from_resource_dir(resource_dir: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        resource_dir
            .parent()
            .unwrap_or(resource_dir)
            .join("MacOS")
            .join("opencode")
    }
    #[cfg(not(target_os = "macos"))]
    {
        resource_dir.join("opencode")
    }
}

fn resolve_bundled_sidecar_from_paths(
    resource_dir: Option<&Path>,
    executable_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let resource_candidate = resource_dir.map(bundled_sidecar_path_from_resource_dir);
    let executable_candidate = executable_dir.map(|dir| dir.join("opencode"));
    resource_candidate
        .into_iter()
        .chain(executable_candidate)
        .find(|candidate| executable_file(candidate))
        .ok_or_else(|| "未找到内置 OpenCode，请重新安装应用".to_string())
}

fn resolve_bundled_sidecar(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().ok();
    let executable_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    resolve_bundled_sidecar_from_paths(resource_dir.as_deref(), executable_dir.as_deref())
}

struct AcpCommandPlan {
    executable: PathBuf,
    args: Vec<OsString>,
    env: HashMap<String, String>,
    augment_path: bool,
}

impl fmt::Debug for AcpCommandPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcpCommandPlan")
            .field("executable", &self.executable)
            .field("args", &self.args)
            .field("augment_path", &self.augment_path)
            .finish_non_exhaustive()
    }
}

fn external_command_plan(spec: &AcpProviderSpec, cwd: &Path) -> AcpCommandPlan {
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
        executable: PathBuf::from(spec.command[0]),
        args,
        env: spec
            .env
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect(),
        augment_path: true,
    }
}

fn opencode_config_content(
    launch: &crate::harness::OpenCodeLaunchConfig,
    model_id: &str,
) -> Result<String, String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("内置 OpenCode 需要选择 API 模型".to_string());
    }
    let provider_slug = &launch.provider_slug;
    let fully_qualified_model = format!("{provider_slug}/{model_id}");
    serde_json::to_string(&json!({
        "$schema": "https://opencode.ai/config.json",
        "model": fully_qualified_model,
        "provider": {
            (provider_slug): {
                "npm": "@ai-sdk/openai-compatible",
                "name": "QwenAudio OpenAI-compatible",
                "options": {
                    "baseURL": launch.base_url,
                    "apiKey": launch.api_key,
                },
                "models": {
                    (model_id): { "name": model_id }
                }
            }
        }
    }))
    .map_err(|_| "无法配置内置 OpenCode".to_string())
}

fn bundled_opencode_command_plan<F>(
    executable: PathBuf,
    cwd: &Path,
    api_provider_id: Option<&str>,
    model_id: Option<&str>,
    resolve_launch_config: F,
) -> Result<AcpCommandPlan, String>
where
    F: FnOnce(&str) -> Result<crate::harness::OpenCodeLaunchConfig, String>,
{
    let api_provider_id = api_provider_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "内置 OpenCode 需要选择 API Provider".to_string())?;
    let launch = resolve_launch_config(api_provider_id)
        .map_err(|_| "内置 OpenCode 的 API Provider 不可用或不兼容".to_string())?;
    let config_content = opencode_config_content(&launch, model_id.unwrap_or_default())?;
    Ok(AcpCommandPlan {
        executable,
        args: vec![
            OsString::from("acp"),
            OsString::from("--cwd"),
            cwd.as_os_str().to_owned(),
        ],
        env: HashMap::from([
            ("OPENCODE_DISABLE_AUTOUPDATE".to_string(), "1".to_string()),
            ("OPENCODE_CONFIG_CONTENT".to_string(), config_content),
        ]),
        augment_path: false,
    })
}

const BUNDLED_SIDECAR_RUNTIME_ENV_KEYS: &[&str] = &[
    "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "USER", "USERNAME",
];
#[cfg(windows)]
const BUNDLED_SIDECAR_SYSTEM_PATH: &str = r"C:\Windows\System32;C:\Windows";
#[cfg(not(windows))]
const BUNDLED_SIDECAR_SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

fn bundled_sidecar_runtime_env() -> Vec<(&'static str, OsString)> {
    let mut variables = BUNDLED_SIDECAR_RUNTIME_ENV_KEYS
        .iter()
        .filter_map(|key| env::var_os(key).map(|value| (*key, value)))
        .collect::<Vec<_>>();
    variables.push(("PATH", OsString::from(BUNDLED_SIDECAR_SYSTEM_PATH)));
    variables
}

fn configure_command_environment(
    command: &mut Command,
    provider_kind: AcpProviderKind,
    plan: &AcpCommandPlan,
) {
    match provider_kind {
        AcpProviderKind::Bundled => {
            command.env_clear();
            command.envs(bundled_sidecar_runtime_env());
        }
        AcpProviderKind::External if plan.augment_path => {
            command.envs(acp_process_env(&[]));
        }
        AcpProviderKind::External => {}
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
pub fn acp_list_providers(app: AppHandle) -> Vec<AcpProviderInfo> {
    ACP_PROVIDERS
        .iter()
        .map(|spec| {
            let available = match spec.kind {
                AcpProviderKind::External => command_available(spec.command[0]),
                AcpProviderKind::Bundled => resolve_bundled_sidecar(&app).is_ok(),
            };
            provider_info(spec, available)
        })
        .collect()
}

impl AcpSessionState {
    fn emit(&self, mut event: AcpSessionEvent) {
        event.session_id = self.session_id.clone();
        let _ = self.app.emit(ACP_EVENT, event);
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
        self.writer_tx
            .try_send(message)
            .map_err(|_| "Agent 进程写入失败".to_string())?;
        Ok(rx)
    }

    fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Agent 会话已关闭".to_string());
        }
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.writer_tx
            .try_send(message)
            .map_err(|_| "Agent 进程写入失败".to_string())
    }

    fn fail_pending(&self, error: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(error.to_string()));
            }
        }
        if let Ok(mut permissions) = self.permissions.lock() {
            for (_, sender) in permissions.drain() {
                let _ = sender.send(None);
            }
        }
        if let Ok(mut questions) = self.questions.lock() {
            for (_, sender) in questions.drain() {
                let _ = sender.send(json!({ "outcome": "cancelled" }));
            }
        }
        if let Ok(mut plan_approvals) = self.plan_approvals.lock() {
            for (_, sender) in plan_approvals.drain() {
                let _ = sender.send(json!({ "outcome": "cancelled" }));
            }
        }
    }
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
            let outcome = match rx.await {
                Ok(option_id) => match option_id {
                    Some(option_id) => json!({
                        "outcome": { "outcome": "selected", "optionId": option_id }
                    }),
                    None => json!({ "outcome": { "outcome": "cancelled" } }),
                },
                Err(_) => json!({ "outcome": { "outcome": "cancelled" } }),
            };
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
        state.closed.store(true, Ordering::SeqCst);
        state.fail_pending("Agent 进程已退出");
        if state.turn_active.swap(false, Ordering::SeqCst) {
            let mut event = AcpSessionEvent::base(&state.session_id, "turn_failed");
            event.error = Some("Agent 进程意外退出".to_string());
            state.emit(event);
        }
        let mut event = AcpSessionEvent::base(&state.session_id, "closed");
        event.error = Some("Agent 进程已退出".to_string());
        state.emit(event);
        if let Ok(mut sessions) = state.runtime.sessions.lock() {
            sessions.remove(&state.session_id);
        }
        cleanup_bridge(&state.app, &state.session_id);
    });
}

fn cleanup_bridge(app: &AppHandle, session_id: &str) {
    if let Some(bridge) = app.try_state::<Arc<crate::AgentBridgeRuntime>>() {
        bridge.remove_session(session_id);
    }
}

fn spawn_stderr_task(stderr: tokio::process::ChildStderr, provider: &str, suppress_content: bool) {
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
            if !suppress_content && !trimmed.is_empty() {
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

fn mcp_server_spec(app: &AppHandle, session_id: &str) -> Vec<Value> {
    let Ok(executable) = std::env::current_exe() else {
        return Vec::new();
    };
    vec![json!({
        "name": "qwenaudio",
        "command": executable.to_string_lossy(),
        "args": ["--mcp-server"],
        "env": [
            { "name": "QWEN_AUDIO_API", "value": crate::api_address(&app.config().identifier) },
            { "name": "QWEN_AUDIO_SESSION_ID", "value": session_id },
        ],
    })]
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
    let plan = match spec.kind {
        AcpProviderKind::External => {
            if !command_available(spec.command[0]) {
                return Err(format!(
                    "未找到 {} 命令，请先安装 {}",
                    spec.command[0], spec.name
                ));
            }
            external_command_plan(spec, &cwd)
        }
        AcpProviderKind::Bundled => bundled_opencode_command_plan(
            resolve_bundled_sidecar(&app)?,
            &cwd,
            request.api_provider_id.as_deref(),
            request.model_id.as_deref(),
            |provider_id| crate::harness::opencode_launch_config(&app, provider_id),
        )?,
    };

    let mut command = Command::new(&plan.executable);
    command
        .args(&plan.args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    configure_command_environment(&mut command, spec.kind, &plan);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {}: {error}", spec.name))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Agent 进程输入".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Agent 进程输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法连接 Agent 进程错误输出".to_string())?;
    spawn_stderr_task(stderr, spec.id, spec.kind == AcpProviderKind::Bundled);

    let (writer_tx, mut writer_rx) = mpsc::channel::<Value>(256);
    tauri::async_runtime::spawn(async move {
        while let Some(message) = writer_rx.recv().await {
            let mut line = serde_json::to_string(&message).unwrap_or_default();
            line.push('\n');
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let session_id = Uuid::new_v4().to_string();
    let runtime_handle = runtime.inner().clone();
    let state = Arc::new(AcpSessionState {
        app: app.clone(),
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

    let mcp_servers = if request.enable_tools == Some(false) {
        Vec::new()
    } else {
        mcp_server_spec(&app, &session_id)
    };
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
    let session_state = state.clone();

    let (command_tx, command_rx) = mpsc::channel::<AcpCommand>(64);
    tauri::async_runtime::spawn(async move {
        run_command_loop(state, command_rx).await;
    });

    log::info!(
        "ACP 会话已建立: provider={} internal={} agent_session={}",
        spec.id,
        session_id,
        agent_session_id
    );

    runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .insert(
            session_id.clone(),
            AcpSessionHandle {
                state: session_state,
                command_tx,
                child: Arc::new(tokio::sync::Mutex::new(child)),
            },
        );

    Ok(AcpSessionStartResponse {
        session_id,
        provider_id: spec.id.to_string(),
        provider_name: agent_name.to_string(),
        models,
        model_options,
        current_model_id,
        modes,
    })
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
    let sender = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|handle| handle.command_tx.clone())
        .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())?;
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
    let state = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|handle| handle.state.clone())
        .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())?;
    if let Ok(mut permissions) = state.permissions.lock() {
        for (_, sender) in permissions.drain() {
            let _ = sender.send(None);
        }
    }
    if let Ok(mut questions) = state.questions.lock() {
        for (_, sender) in questions.drain() {
            let _ = sender.send(json!({ "outcome": "cancelled" }));
        }
    }
    if let Ok(mut plan_approvals) = state.plan_approvals.lock() {
        for (_, sender) in plan_approvals.drain() {
            let _ = sender.send(json!({ "outcome": "cancelled" }));
        }
    }
    state.send_notification(
        "session/cancel",
        json!({ "sessionId": agent_session_id_of(&state) }),
    )
}

#[tauri::command]
pub fn acp_respond_permission(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let state = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|handle| handle.state.clone())
        .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())?;
    let sender = state
        .permissions
        .lock()
        .map_err(|_| "Agent 权限状态不可用".to_string())?
        .remove(&request_id)
        .ok_or_else(|| "权限请求已失效".to_string())?;
    sender
        .send(option_id)
        .map_err(|_| "权限请求已结束".to_string())
}

#[tauri::command]
pub fn acp_respond_question(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    request_id: String,
    outcome: Value,
) -> Result<(), String> {
    let state = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|handle| handle.state.clone())
        .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())?;
    let sender = state
        .questions
        .lock()
        .map_err(|_| "Agent 问题状态不可用".to_string())?
        .remove(&request_id)
        .ok_or_else(|| "问题请求已失效".to_string())?;
    sender
        .send(outcome)
        .map_err(|_| "问题请求已结束".to_string())
}

#[tauri::command]
pub fn acp_respond_plan_approval(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    request_id: String,
    outcome: Value,
) -> Result<(), String> {
    let state = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|handle| handle.state.clone())
        .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())?;
    let sender = state
        .plan_approvals
        .lock()
        .map_err(|_| "Agent 计划确认状态不可用".to_string())?
        .remove(&request_id)
        .ok_or_else(|| "计划确认请求已失效".to_string())?;
    sender
        .send(outcome)
        .map_err(|_| "计划确认请求已结束".to_string())
}

#[tauri::command]
pub async fn acp_finish_session(
    app: AppHandle,
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
) -> Result<(), String> {
    let handle = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .remove(&session_id);
    let Some(handle) = handle else {
        return Ok(());
    };
    drop(handle.command_tx);
    let mut child = handle.child.lock().await;
    let _ = child.kill().await;
    cleanup_bridge(&app, &session_id);
    let mut event = AcpSessionEvent::base(&session_id, "closed");
    event.error = None;
    let _ = app.emit(ACP_EVENT, event);
    Ok(())
}

pub fn acp_shutdown_all(app: &AppHandle) {
    let Some(runtime) = app.try_state::<Arc<AcpRuntime>>() else {
        return;
    };
    let handles = runtime
        .sessions
        .lock()
        .map(|mut sessions| sessions.drain().collect::<Vec<_>>())
        .unwrap_or_default();
    for (session_id, handle) in handles {
        drop(handle.command_tx);
        let child = handle.child;
        tauri::async_runtime::spawn(async move {
            let mut child = child.lock().await;
            let _ = child.kill().await;
        });
        let _ = session_id;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn test_opencode_launch_config() -> crate::harness::OpenCodeLaunchConfig {
        crate::harness::OpenCodeLaunchConfig {
            id: "api.custom.example".to_string(),
            base_url: "https://api.example.test/v1".to_string(),
            api_key: "test-opencode-secret".to_string(),
            provider_slug: "qwenaudio-api-custom-example".to_string(),
            auth_type: "bearer".to_string(),
        }
    }

    #[test]
    fn bundled_opencode_registration_has_distinct_api_binding_metadata() {
        let bundled = ACP_PROVIDERS
            .iter()
            .find(|provider| provider.id == "opencode-bundled")
            .expect("register bundled OpenCode");
        assert_eq!(bundled.name, "OpenCode（内置）");
        assert_eq!(bundled.kind, AcpProviderKind::Bundled);
        assert!(bundled.requires_api_provider);

        let info = provider_info(bundled, true);
        assert_eq!(info.kind, "bundled");
        assert!(info.requires_api_provider);

        let external = ACP_PROVIDERS
            .iter()
            .find(|provider| provider.id == "opencode")
            .expect("retain external OpenCode");
        assert_eq!(external.kind, AcpProviderKind::External);
        assert!(!external.requires_api_provider);
        assert_eq!(external.command, &["opencode", "acp"]);
    }

    #[test]
    fn bundled_opencode_resolves_tauri_sidecar_without_augmented_path() {
        let root = std::env::temp_dir().join(format!("acp-sidecar-{}", Uuid::new_v4()));
        let resources = root.join("QwenAudio.app/Contents/Resources");
        let sidecar = root.join("QwenAudio.app/Contents/MacOS/opencode");
        std::fs::create_dir_all(&resources).expect("create resource fixture");
        std::fs::create_dir_all(sidecar.parent().expect("sidecar parent"))
            .expect("create sidecar fixture");
        std::fs::write(&sidecar, b"#!/bin/sh\nexit 0\n").expect("write sidecar fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&sidecar)
                .expect("read sidecar permissions")
                .permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(&sidecar, permissions).expect("make sidecar executable");
        }

        let resolved = resolve_bundled_sidecar_from_paths(Some(&resources), None)
            .expect("resolve Tauri sidecar");
        assert_eq!(resolved, sidecar);
        let plan = bundled_opencode_command_plan(
            resolved,
            std::path::Path::new("/tmp/acp-workspace"),
            Some("api.custom.example"),
            Some("remote-model"),
            |_| Ok(test_opencode_launch_config()),
        )
        .expect("build bundled launch plan");
        assert!(!plan.augment_path);
        assert_eq!(
            plan.args
                .iter()
                .map(|argument| argument.to_string_lossy())
                .collect::<Vec<_>>(),
            vec!["acp", "--cwd", "/tmp/acp-workspace"]
        );
        assert_eq!(plan.executable, sidecar);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bundled_opencode_rejects_missing_or_ineligible_api_binding_without_leaking_credentials() {
        let executable = std::path::PathBuf::from("/trusted/sidecar/opencode");
        let missing = bundled_opencode_command_plan(
            executable.clone(),
            std::path::Path::new("/tmp/acp-workspace"),
            None,
            Some("remote-model"),
            |_| Ok(test_opencode_launch_config()),
        )
        .expect_err("require an API Provider binding");
        assert_eq!(missing, "内置 OpenCode 需要选择 API Provider");

        let ineligible = bundled_opencode_command_plan(
            executable,
            std::path::Path::new("/tmp/acp-workspace"),
            Some("deleted-provider"),
            Some("remote-model"),
            |_| Err("connection failed: test-opencode-secret".to_string()),
        )
        .expect_err("reject deleted or disabled API Provider bindings");
        assert_eq!(ineligible, "内置 OpenCode 的 API Provider 不可用或不兼容");
        assert!(!ineligible.contains("test-opencode-secret"));
    }

    #[test]
    fn bundled_opencode_config_uses_selected_model_and_redacts_credentials() {
        let plan = bundled_opencode_command_plan(
            std::path::PathBuf::from("/trusted/sidecar/opencode"),
            std::path::Path::new("/tmp/acp-workspace"),
            Some("api.custom.example"),
            Some("remote-model"),
            |_| Ok(test_opencode_launch_config()),
        )
        .expect("build bundled launch plan");
        let config: Value = serde_json::from_str(
            plan.env
                .get("OPENCODE_CONFIG_CONTENT")
                .expect("pass native config only through the child environment"),
        )
        .expect("serialize OpenCode configuration");
        assert_eq!(config["model"], "qwenaudio-api-custom-example/remote-model");
        assert_eq!(
            config["provider"]["qwenaudio-api-custom-example"]["options"]["baseURL"],
            "https://api.example.test/v1"
        );
        assert_eq!(
            config["provider"]["qwenaudio-api-custom-example"]["options"]["apiKey"],
            "test-opencode-secret"
        );
        assert_eq!(plan.env["OPENCODE_DISABLE_AUTOUPDATE"], "1");
        assert!(!format!("{plan:?}").contains("test-opencode-secret"));
    }

    #[test]
    fn bundled_selected_model_does_not_require_session_new_advertisement() {
        let session_new = json!({ "sessionId": "agent-session" });
        assert!(model_selection_request(
            &session_new,
            "agent-session",
            "remote-model",
            AcpProviderKind::External,
        )
        .is_err());
        assert_eq!(
            model_selection_request(
                &session_new,
                "agent-session",
                "remote-model",
                AcpProviderKind::Bundled,
            )
            .expect("allow the model configured before bundled OpenCode starts"),
            None
        );
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
        assert_eq!(plan.env["OPENCODE_DISABLE_AUTOUPDATE"], "1");
    }

    #[test]
    fn bundled_launch_command_clears_injected_parent_environment() {
        let plan = bundled_opencode_command_plan(
            std::path::PathBuf::from("/trusted/sidecar/opencode"),
            std::path::Path::new("/tmp/acp-workspace"),
            Some("api.custom.example"),
            Some("remote-model"),
            |_| Ok(test_opencode_launch_config()),
        )
        .expect("build bundled launch plan");
        let mut command = Command::new(&plan.executable);
        command
            .env("UNRELATED_PARENT_SECRET", "must-not-reach-sidecar")
            .env("AWS_ACCESS_KEY_ID", "must-not-reach-sidecar");
        configure_command_environment(&mut command, AcpProviderKind::Bundled, &plan);

        let environment = command.as_std().get_envs().collect::<Vec<_>>();
        assert!(
            !environment
                .iter()
                .any(|(key, _)| *key == "UNRELATED_PARENT_SECRET" || *key == "AWS_ACCESS_KEY_ID"),
            "bundled sidecars must not inherit arbitrary parent environment variables"
        );
        assert!(environment.iter().all(|(key, _)| {
            BUNDLED_SIDECAR_RUNTIME_ENV_KEYS.contains(&key.to_str().unwrap_or_default())
                || *key == "PATH"
                || *key == "OPENCODE_CONFIG_CONTENT"
                || *key == "OPENCODE_DISABLE_AUTOUPDATE"
        }));
        assert!(environment.iter().any(|(key, value)| {
            *key == "PATH" && *value == Some(std::ffi::OsStr::new(BUNDLED_SIDECAR_SYSTEM_PATH))
        }));
        assert!(environment
            .iter()
            .any(|(key, _)| *key == "OPENCODE_CONFIG_CONTENT"));
        assert!(environment
            .iter()
            .any(|(key, _)| *key == "OPENCODE_DISABLE_AUTOUPDATE"));
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
        configure_command_environment(&mut command, AcpProviderKind::External, &plan);

        assert!(command.as_std().get_envs().any(|(key, value)| {
            key == "UNRELATED_PARENT_SECRET"
                && value == Some(std::ffi::OsStr::new("external-provider-keeps-it"))
        }));
    }
}
