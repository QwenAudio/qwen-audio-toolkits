use std::{
    collections::HashMap,
    env,
    path::PathBuf,
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

struct AcpProviderSpec {
    id: &'static str,
    name: &'static str,
    command: &'static [&'static str],
    env: &'static [(&'static str, &'static str)],
}

const ACP_PROVIDERS: &[AcpProviderSpec] = &[
    AcpProviderSpec {
        id: "kimi",
        name: "Kimi Code",
        command: &["kimi", "acp"],
        env: &[],
    },
    AcpProviderSpec {
        id: "qwen-code",
        name: "Qwen Code",
        command: &["npx", "-y", "@qwen-code/qwen-code", "--acp"],
        env: &[],
    },
    AcpProviderSpec {
        id: "codex",
        name: "Codex",
        command: &["npx", "-y", "@agentclientprotocol/codex-acp"],
        env: &[],
    },
    AcpProviderSpec {
        id: "gemini",
        name: "Gemini CLI",
        command: &["npx", "-y", "@google/gemini-cli", "--acp"],
        env: &[("NO_BROWSER", "1")],
    },
    AcpProviderSpec {
        id: "grok",
        name: "Grok",
        command: &["grok", "agent", "stdio"],
        env: &[],
    },
    AcpProviderSpec {
        id: "goose",
        name: "goose",
        command: &["goose", "acp"],
        env: &[],
    },
    AcpProviderSpec {
        id: "cursor",
        name: "Cursor",
        command: &["cursor-agent", "acp"],
        env: &[],
    },
    AcpProviderSpec {
        id: "copilot",
        name: "GitHub Copilot",
        command: &["copilot", "--acp"],
        env: &[],
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpProviderInfo {
    id: String,
    name: String,
    available: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionStartRequest {
    provider_id: String,
    cwd: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionStartResponse {
    session_id: String,
    provider_id: String,
    provider_name: String,
    models: Vec<String>,
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
    Prompt {
        text: String,
    },
    Cancel,
    RespondPermission {
        request_key: String,
        option_id: Option<String>,
    },
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
    turn_active: AtomicBool,
    closed: AtomicBool,
}

fn augmented_path_entries() -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        for relative in [
            ".local/bin",
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

fn command_available(command: &str) -> bool {
    augmented_path_entries().iter().any(|dir| {
        let candidate = dir.join(command);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            match std::fs::metadata(&candidate) {
                Ok(metadata) => metadata.is_file() && metadata.permissions().mode() & 0o111 != 0,
                Err(_) => false,
            }
        }
        #[cfg(not(unix))]
        {
            candidate.is_file()
        }
    })
}

#[tauri::command]
pub fn acp_list_providers() -> Vec<AcpProviderInfo> {
    ACP_PROVIDERS
        .iter()
        .map(|spec| AcpProviderInfo {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            available: command_available(spec.command[0]),
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
            AcpCommand::Cancel => {
                if state.turn_active.load(Ordering::SeqCst) {
                    if let Ok(mut permissions) = state.permissions.lock() {
                        for (_, sender) in permissions.drain() {
                            let _ = sender.send(None);
                        }
                    }
                    if !agent_session_id.is_empty() {
                        let _ = state.send_notification(
                            "session/cancel",
                            json!({ "sessionId": agent_session_id }),
                        );
                    }
                }
            }
            AcpCommand::RespondPermission {
                request_key,
                option_id,
            } => {
                if let Ok(mut permissions) = state.permissions.lock() {
                    if let Some(sender) = permissions.remove(&request_key) {
                        let _ = sender.send(option_id);
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
    if !command_available(spec.command[0]) {
        return Err(format!(
            "未找到 {} 命令，请先安装 {}",
            spec.command[0], spec.name
        ));
    }
    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::var("HOME").ok().map(PathBuf::from))
        .ok_or_else(|| "无法确定 Agent 工作目录".to_string())?;

    let mut child = Command::new(spec.command[0])
        .args(&spec.command[1..])
        .current_dir(&cwd)
        .envs(acp_process_env(spec.env))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
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
    spawn_stderr_task(stderr, spec.id);

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

    let mcp_servers = mcp_server_spec(&app, &session_id);
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
    let models = session_new
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let modes = session_new
        .get("modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

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
                command_tx,
                child: Arc::new(tokio::sync::Mutex::new(child)),
            },
        );

    Ok(AcpSessionStartResponse {
        session_id,
        provider_id: spec.id.to_string(),
        provider_name: agent_name.to_string(),
        models,
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
    let sender = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|handle| handle.command_tx.clone())
        .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())?;
    sender
        .try_send(AcpCommand::Cancel)
        .map_err(|_| "Agent 会话已经关闭".to_string())
}

#[tauri::command]
pub fn acp_respond_permission(
    runtime: State<'_, Arc<AcpRuntime>>,
    session_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let sender = runtime
        .sessions
        .lock()
        .map_err(|_| "Agent 会话状态不可用".to_string())?
        .get(&session_id)
        .map(|handle| handle.command_tx.clone())
        .ok_or_else(|| "Agent 会话不存在或已经结束".to_string())?;
    sender
        .try_send(AcpCommand::RespondPermission {
            request_key: request_id,
            option_id,
        })
        .map_err(|_| "Agent 会话已经关闭".to_string())
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
