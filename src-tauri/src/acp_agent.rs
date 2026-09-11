use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const DEFAULT_MODEL: &str = "qwen3.8-flash";
const DEFAULT_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_IDLE_ACP_CLIENTS: usize = 2;

static ACP_CLIENT_POOL: OnceLock<Mutex<Vec<AcpClient>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentPromptRequest {
    pub messages: Vec<AcpAgentMessage>,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentPromptResponse {
    pub text: String,
    pub stop_reason: String,
    pub session_id: String,
    pub model: String,
    pub provider: String,
    pub tool_calls: Vec<AcpToolCallSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCallSummary {
    pub title: String,
    pub status: String,
}

#[derive(Debug)]
struct JsonRpcResponse {
    result: Option<Value>,
    error: Option<Value>,
}

#[derive(Debug)]
struct AcpClient {
    child: Child,
    stdin: ChildStdin,
    receiver: mpsc::Receiver<String>,
    cwd: PathBuf,
    model: String,
    base_url: String,
    next_id: u64,
}

fn parse_env_file(path: &PathBuf) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let Ok(content) = fs::read_to_string(path) else {
        return values;
    };
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let mut value = value.trim().to_string();
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len().saturating_sub(1)].to_string();
        }
        values.insert(name.to_string(), value);
    }
    values
}

fn reference_env_path() -> Option<PathBuf> {
    if let Some(path) = env::var_os("QWEN_AUDIO_AGENT_ENV") {
        return Some(PathBuf::from(path));
    }
    let home = env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("workspace/gitlab/qwen-audio-agent/examples/smart-cockpit/.env.local"),
    )
}

fn merged_agent_env() -> HashMap<String, String> {
    let mut values = HashMap::new();
    if let Some(path) = reference_env_path() {
        values.extend(parse_env_file(&path));
    }
    for name in [
        "DASHSCOPE_API_KEY",
        "DASHSCOPE_BASE_URL",
        "DASHSCOPE_MODEL",
        "OPENCODE_PATH",
    ] {
        if let Ok(value) = env::var(name) {
            if !value.trim().is_empty() {
                values.insert(name.to_string(), value);
            }
        }
    }
    values
}

fn opencode_path(values: &HashMap<String, String>) -> PathBuf {
    if let Some(path) = values
        .get("OPENCODE_PATH")
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(path);
    }
    let homebrew = PathBuf::from("/opt/homebrew/bin/opencode");
    if homebrew.exists() {
        return homebrew;
    }
    PathBuf::from("opencode")
}

fn opencode_config(model: &str, base_url: &str) -> String {
    json!({
        "$schema": "https://opencode.ai/config.json",
        "model": format!("dashscope/{model}"),
        "provider": {
            "dashscope": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "DashScope",
                "options": {
                    "baseURL": base_url,
                    "apiKey": "{env:DASHSCOPE_API_KEY}"
                },
                "models": {
                    model: { "name": model }
                }
            }
        },
        "tools": {
            "bash": false,
            "edit": false,
            "write": false
        }
    })
    .to_string()
}

fn prompt_text(messages: &[AcpAgentMessage]) -> Result<String, String> {
    let current = messages
        .iter()
        .rev()
        .find(|message| message.role == "user" && !message.content.trim().is_empty())
        .ok_or_else(|| "请输入要发送给 Agent 的内容".to_string())?;
    let mut transcript = String::new();
    for message in messages.iter().take(messages.len().saturating_sub(1)) {
        let content = message.content.trim();
        if content.is_empty() {
            continue;
        }
        let label = if message.role == "assistant" {
            "Assistant"
        } else {
            "User"
        };
        transcript.push_str(label);
        transcript.push_str(": ");
        transcript.push_str(content);
        transcript.push('\n');
    }
    Ok(format!(
        "你是 QwenAudio Toolkits 的通用音视频创作 Agent。\n\
         你的职责是理解用户目标、规划音视频 workflow、识别所需模型能力，并给出可审阅的下一步。\n\
         当前阶段只进行对话、规划和建议；不要修改仓库文件，不要运行命令，不要假装已经执行音视频处理。\n\
         如果用户只是寒暄、确认或追问一句很短的问题，请用一到两句话简短回复，不要展开完整 workflow。\n\
         默认用 120 到 180 个中文字回答，先给高层计划和最关键的确认点；只有用户明确要求详细方案时再展开。\n\
         如果用户需要具体处理，请输出清晰的计划、所需模型能力、需要用户确认的地方。\n\n\
         历史对话：\n{transcript}\n\
         当前用户请求：\n{}\n",
        current.content.trim()
    ))
}

fn send_json(stdin: &mut ChildStdin, id: u64, method: &str, params: Value) -> Result<(), String> {
    let message = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    writeln!(stdin, "{message}").map_err(|error| format!("写入 ACP 请求失败：{error}"))
}

fn read_response(
    receiver: &mpsc::Receiver<String>,
    id: u64,
    text: &mut String,
    tool_calls: &mut Vec<AcpToolCallSummary>,
) -> Result<JsonRpcResponse, String> {
    loop {
        let line = receiver
            .recv_timeout(PROMPT_TIMEOUT)
            .map_err(|_| "等待 opencode ACP 响应超时".to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            return Ok(JsonRpcResponse {
                result: message.get("result").cloned(),
                error: message.get("error").cloned(),
            });
        }
        if message.get("method").and_then(Value::as_str) != Some("session/update") {
            continue;
        }
        let Some(update) = message.pointer("/params/update") else {
            continue;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(chunk) = update.pointer("/content/text").and_then(Value::as_str) {
                    text.push_str(chunk);
                }
            }
            Some("tool_call") => {
                tool_calls.push(AcpToolCallSummary {
                    title: update
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Tool call")
                        .to_string(),
                    status: update
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending")
                        .to_string(),
                });
            }
            Some("tool_call_update") => {
                if let Some(status) = update.get("status").and_then(Value::as_str) {
                    if let Some(last) = tool_calls.last_mut() {
                        last.status = status.to_string();
                    }
                }
            }
            _ => {}
        }
    }
}

fn take_result(response: JsonRpcResponse, method: &str) -> Result<Value, String> {
    if let Some(error) = response.error {
        return Err(format!("{method} 返回错误：{error}"));
    }
    response
        .result
        .ok_or_else(|| format!("{method} 没有返回 result"))
}

fn spawn_stdout_reader(child: &mut Child) -> Result<mpsc::Receiver<String>, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 opencode ACP stdout".to_string())?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
    Ok(receiver)
}

fn spawn_stderr_collector(child: &mut Child) {
    let Some(stderr) = child.stderr.take() else {
        return;
    };
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                log::debug!("opencode acp stderr: {line}");
            }
        }
    });
}

fn acp_client_pool() -> &'static Mutex<Vec<AcpClient>> {
    ACP_CLIENT_POOL.get_or_init(|| Mutex::new(Vec::new()))
}

fn spawn_acp_client(
    values: &HashMap<String, String>,
    api_key: &str,
    model: &str,
    base_url: &str,
    cwd: &PathBuf,
) -> Result<AcpClient, String> {
    let started = Instant::now();
    let mut child = Command::new(opencode_path(values))
        .arg("acp")
        .arg("--cwd")
        .arg(cwd)
        .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
        .env("DASHSCOPE_API_KEY", api_key)
        .env("DASHSCOPE_BASE_URL", base_url)
        .env("DASHSCOPE_MODEL", model)
        .env(
            "OPENCODE_CONFIG_CONTENT",
            opencode_config(model, base_url),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 opencode ACP 失败：{error}"))?;

    let receiver = spawn_stdout_reader(&mut child)?;
    spawn_stderr_collector(&mut child);
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法写入 opencode ACP stdin".to_string())?;
    let mut text = String::new();
    let mut tool_calls = Vec::new();

    send_json(
        &mut stdin,
        1,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {
                "name": "qwen-audio-toolkits",
                "title": "QwenAudio Toolkits",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
    )?;
    let _ = take_result(
        read_response(&receiver, 1, &mut text, &mut tool_calls)?,
        "initialize",
    )?;
    log::info!(
        "opencode ACP client initialized in {}ms",
        started.elapsed().as_millis()
    );

    Ok(AcpClient {
        child,
        stdin,
        receiver,
        cwd: cwd.clone(),
        model: model.to_string(),
        base_url: base_url.to_string(),
        next_id: 2,
    })
}

fn acquire_acp_client(
    values: &HashMap<String, String>,
    api_key: &str,
    model: &str,
    base_url: &str,
    cwd: &PathBuf,
) -> Result<AcpClient, String> {
    let mut pool = acp_client_pool()
        .lock()
        .map_err(|_| "opencode ACP client pool 已不可用".to_string())?;
    let mut index = pool.len();
    while index > 0 {
        index -= 1;
        if pool[index].cwd != *cwd || pool[index].model != model || pool[index].base_url != base_url {
            continue;
        }
        let mut client = pool.remove(index);
        match client.child.try_wait() {
            Ok(Some(status)) => {
                log::debug!("discarding exited opencode ACP client: {status}");
                continue;
            }
            Ok(None) => {
                log::debug!("reusing warm opencode ACP client");
                return Ok(client);
            }
            Err(error) => {
                log::debug!("discarding invalid opencode ACP client: {error}");
                continue;
            }
        }
    }
    drop(pool);
    spawn_acp_client(values, api_key, model, base_url, cwd)
}

fn release_acp_client(mut client: AcpClient) {
    let Ok(mut pool) = acp_client_pool().lock() else {
        let _ = client.child.kill();
        let _ = client.child.wait();
        return;
    };
    if pool.len() < MAX_IDLE_ACP_CLIENTS {
        pool.push(client);
        return;
    }
    let _ = client.child.kill();
    let _ = client.child.wait();
}

fn shutdown_acp_client(mut client: AcpClient) {
    let _ = client.child.kill();
    let _ = client.child.wait();
}

fn request_acp(
    client: &mut AcpClient,
    method: &str,
    params: Value,
    text: &mut String,
    tool_calls: &mut Vec<AcpToolCallSummary>,
) -> Result<Value, String> {
    let id = client.next_id;
    client.next_id += 1;
    send_json(&mut client.stdin, id, method, params)?;
    take_result(
        read_response(&client.receiver, id, text, tool_calls)?,
        method,
    )
}

fn run_prompt_blocking(request: AcpAgentPromptRequest) -> Result<AcpAgentPromptResponse, String> {
    let total_started = Instant::now();
    let values = merged_agent_env();
    let api_key = values
        .get("DASHSCOPE_API_KEY")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "缺少 DASHSCOPE_API_KEY；请设置环境变量或提供 qwen-audio-agent smart-cockpit .env.local"
                .to_string()
        })?
        .to_string();
    let model = values
        .get("DASHSCOPE_MODEL")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let base_url = values
        .get("DASHSCOPE_BASE_URL")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let cwd = request
        .cwd
        .map(PathBuf::from)
        .or_else(|| env::current_dir().ok())
        .ok_or_else(|| "无法确定 Agent 工作目录".to_string())?;
    let prompt = prompt_text(&request.messages)?;

    let mut client = acquire_acp_client(&values, &api_key, &model, &base_url, &cwd)?;
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    let response_model = client.model.clone();

    let result = (|| {
        let session_started = Instant::now();
        let session = request_acp(
            &mut client,
            "session/new",
            json!({
                "cwd": cwd,
                "mcpServers": []
            }),
            &mut text,
            &mut tool_calls,
        )?;
        log::debug!(
            "opencode ACP session/new completed in {}ms",
            session_started.elapsed().as_millis()
        );
        let session_id = session
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "opencode ACP 没有返回 sessionId".to_string())?
            .to_string();
        let prompt_started = Instant::now();
        let prompt_result = request_acp(
            &mut client,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [
                    {
                        "type": "text",
                        "text": prompt
                    }
                ]
            }),
            &mut text,
            &mut tool_calls,
        )?;
        log::info!(
            "opencode ACP session/prompt completed in {}ms",
            prompt_started.elapsed().as_millis()
        );
        Ok::<_, String>(AcpAgentPromptResponse {
            text: text.trim().to_string(),
            stop_reason: prompt_result
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn")
                .to_string(),
            session_id,
            model: response_model,
            provider: "opencode-acp".to_string(),
            tool_calls,
        })
    })();

    match result {
        Ok(response) => {
            log::info!(
                "opencode ACP prompt finished in {}ms",
                total_started.elapsed().as_millis()
            );
            release_acp_client(client);
            Ok(response)
        }
        Err(error) => {
            shutdown_acp_client(client);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn agent_acp_prompt(
    request: AcpAgentPromptRequest,
) -> Result<AcpAgentPromptResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run_prompt_blocking(request))
        .await
        .map_err(|error| format!("Agent 任务调度失败：{error}"))?
}
