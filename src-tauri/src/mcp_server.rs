use std::{
    io::{BufRead, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

const MCP_ARGUMENT: &str = "--mcp-server";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const RUN_POLL_INTERVAL_MS: u64 = 1000;
const RUN_TIMEOUT_POLLS: usize = 600;

pub fn is_mcp_server_arguments(arguments: &[String]) -> bool {
    arguments.first().map(String::as_str) == Some(MCP_ARGUMENT)
}

pub fn run() -> i32 {
    match serve() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("MCP server error: {error}");
            1
        }
    }
}

fn api_base_url() -> String {
    let address = std::env::var("QWEN_AUDIO_API").unwrap_or_else(|_| "127.0.0.1:3847".to_string());
    format!("http://{address}")
}

fn acp_session_id() -> Option<String> {
    std::env::var("QWEN_AUDIO_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn http_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .expect("could not build MCP HTTP client")
}

fn serve() -> Result<(), String> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    let client = http_client();
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| format!("could not read MCP input: {error}"))?;
        if bytes == 0 {
            return Ok(());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            log::warn!("MCP 非 JSON 输入: {trimmed}");
            continue;
        };
        if message.get("id").is_none() {
            continue;
        }
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let result = match method.as_str() {
            "initialize" => Some(handle_initialize(&params)),
            "ping" => Some(json!({})),
            "tools/list" => Some(json!({ "tools": tool_definitions() })),
            "tools/call" => Some(handle_tools_call(&client, &params)),
            _ => None,
        };
        let Some(result) = result else {
            let response = json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "method not found" },
            });
            write_response(&mut writer, &response)?;
            continue;
        };
        let response = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        write_response(&mut writer, &response)?;
    }
}

fn write_response(writer: &mut std::io::StdoutLock<'_>, response: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(response)
        .map_err(|error| format!("could not serialize MCP response: {error}"))?;
    line.push('\n');
    writer
        .write_all(line.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("could not write MCP response: {error}"))
}

fn handle_initialize(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(MCP_PROTOCOL_VERSION);
    json!({
        "protocolVersion": requested,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "qwenaudio-toolkits",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "list_installed_models",
            "description": "列出本机 QwenAudio Toolkits 已安装的音频模型（语音识别、语音合成等），包含 id、名称和能力。",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "transcribe_audio",
            "description": "转录一个音频文件（支持 WAV/MP3/M4A/FLAC 等常见格式），返回带时间戳的分段文本。需要本机已安装语音识别模型。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "音频文件的绝对路径" },
                    "language": { "type": "string", "description": "音频语言代码，例如 zh、en、auto（默认 auto）" },
                    "model_id": { "type": "string", "description": "可选，指定使用的语音识别模型 id（从 list_installed_models 获取）" },
                },
                "required": ["file_path"],
            },
        }),
        json!({
            "name": "synthesize_speech",
            "description": "把文本合成为语音，返回生成的音频文件路径和时长。需要本机已安装语音合成模型或配置云端 API。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "要合成的文本" },
                    "voice": { "type": "string", "description": "可选，音色名称（由具体模型决定）" },
                    "speed": { "type": "number", "description": "可选，语速 0.5-2.0，默认 1.0" },
                    "model_id": { "type": "string", "description": "可选，指定使用的语音合成模型 id" },
                },
                "required": ["text"],
            },
        }),
        json!({
            "name": "start_meeting_capture",
            "description": "在用户界面右侧打开会议纪要面板并准备开始录音转写。调用后告知用户面板已打开，等待用户在面板中点击开始录音。",
            "inputSchema": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "get_meeting_transcript",
            "description": "读取当前会议纪要面板的实时转写内容（分段文本和时间戳）。用户开始录音后可随时调用。",
            "inputSchema": { "type": "object", "properties": {} },
        }),
    ]
}

fn handle_tools_call(client: &reqwest::blocking::Client, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    let outcome = match name {
        "list_installed_models" => list_installed_models(client),
        "transcribe_audio" => transcribe_audio(client, &arguments),
        "synthesize_speech" => synthesize_speech(client, &arguments),
        "start_meeting_capture" => start_meeting_capture(client),
        "get_meeting_transcript" => get_meeting_transcript(client),
        _ => Err(format!("未知工具: {name}")),
    };
    match outcome {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }],
            "isError": false,
        }),
        Err(error) => json!({
            "content": [{ "type": "text", "text": error }],
            "isError": true,
        }),
    }
}

fn api_get(client: &reqwest::blocking::Client, path: &str) -> Result<Value, String> {
    client
        .get(format!("{}{path}", api_base_url()))
        .send()
        .map_err(|error| format!("无法连接 QwenAudio 本地服务: {error}"))?
        .error_for_status()
        .map_err(|error| format!("QwenAudio 本地服务请求失败: {error}"))?
        .json::<Value>()
        .map_err(|error| format!("QwenAudio 本地服务返回无效数据: {error}"))
}

fn api_post(
    client: &reqwest::blocking::Client,
    path: &str,
    body: &Value,
) -> Result<Value, String> {
    client
        .post(format!("{}{path}", api_base_url()))
        .json(body)
        .send()
        .map_err(|error| format!("无法连接 QwenAudio 本地服务: {error}"))?
        .error_for_status()
        .map_err(|error| {
            let status = error.status().map(|code| code.to_string()).unwrap_or_default();
            format!("QwenAudio 本地服务请求失败 {status}: {error}")
        })?
        .json::<Value>()
        .map_err(|error| format!("QwenAudio 本地服务返回无效数据: {error}"))
}

fn installed_models(client: &reqwest::blocking::Client) -> Result<Vec<Value>, String> {
    let models = api_get(client, "/v1/models")?;
    let Some(list) = models.as_array() else {
        return Err("模型目录数据无效".to_string());
    };
    Ok(list
        .iter()
        .filter(|model| model.get("installed").and_then(Value::as_bool) == Some(true))
        .cloned()
        .collect())
}

fn pick_model(
    client: &reqwest::blocking::Client,
    capability: &str,
    model_id: Option<&str>,
) -> Result<Value, String> {
    let models = installed_models(client)?;
    let matching: Vec<&Value> = models
        .iter()
        .filter(|model| {
            model
                .get("capabilities")
                .and_then(Value::as_array)
                .map(|capabilities| {
                    capabilities
                        .iter()
                        .any(|item| item.as_str() == Some(capability))
                })
                .unwrap_or(false)
        })
        .collect();
    if let Some(requested) = model_id {
        return matching
            .into_iter()
            .find(|model| model.get("id").and_then(Value::as_str) == Some(requested))
            .cloned()
            .ok_or_else(|| format!("模型 {requested} 未安装或不支持 {capability}"));
    }
    matching
        .first()
        .copied()
        .cloned()
        .ok_or_else(|| format!("没有已安装的模型支持 {capability}，请先在模型商店安装"))
}

fn list_installed_models(client: &reqwest::blocking::Client) -> Result<Value, String> {
    let models = installed_models(client)?;
    let summary: Vec<Value> = models
        .iter()
        .map(|model| {
            json!({
                "id": model.get("id").cloned().unwrap_or(Value::Null),
                "name": model.get("name").cloned().unwrap_or(Value::Null),
                "provider": model.get("provider").cloned().unwrap_or(Value::Null),
                "capabilities": model.get("capabilities").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(json!({ "models": summary }))
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

fn audio_file_to_wav_data_url(file_path: &str) -> Result<(String, String), String> {
    let path = PathBuf::from(file_path);
    if !path.is_file() {
        return Err(format!("音频文件不存在: {file_path}"));
    }
    let clip_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio".to_string());
    let is_wav = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);
    if is_wav {
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("无法读取音频文件: {error}"))?;
        let data_url = format!("data:audio/wav;base64,{}", STANDARD.encode(bytes));
        return Ok((data_url, clip_name));
    }
    let ffmpeg = executable("ffmpeg").ok_or_else(|| {
        "未检测到 FFmpeg，无法解码该音频格式。请安装 FFmpeg 或使用 WAV 文件".to_string()
    })?;
    let output = Command::new(ffmpeg)
        .args(["-i", file_path, "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"])
        .stderr(Stdio::null())
        .output()
        .map_err(|error| format!("无法启动 FFmpeg: {error}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err(format!("FFmpeg 无法解码音频文件: {clip_name}"));
    }
    let data_url = format!("data:audio/wav;base64,{}", STANDARD.encode(&output.stdout));
    Ok((data_url, clip_name))
}

fn start_run(
    client: &reqwest::blocking::Client,
    capability: &str,
    provider_id: &str,
    title: &str,
    input: Value,
    parameters: Value,
) -> Result<String, String> {
    let run = api_post(
        client,
        "/v1/runs",
        &json!({
            "capability": capability,
            "providerId": provider_id,
            "routing": "local",
            "title": title,
            "input": input,
            "parameters": parameters,
        }),
    )?;
    run.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "任务启动失败".to_string())
}

fn wait_for_run(
    client: &reqwest::blocking::Client,
    run_id: &str,
) -> Result<Value, String> {
    for _ in 0..RUN_TIMEOUT_POLLS {
        let run = api_get(client, &format!("/v1/runs/{run_id}"))?;
        match run.get("status").and_then(Value::as_str).unwrap_or_default() {
            "completed" => return Ok(run),
            "failed" | "canceled" => {
                let error = run
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("任务未完成");
                return Err(error.to_string());
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(RUN_POLL_INTERVAL_MS));
    }
    Err("任务超时，请在应用的运行记录中查看最终状态".to_string())
}

fn run_output(client: &reqwest::blocking::Client, run_id: &str) -> Result<Value, String> {
    let execution = api_get(client, &format!("/v1/runs/{run_id}/output"))?;
    execution
        .get("output")
        .cloned()
        .ok_or_else(|| "任务结果不可用".to_string())
}

fn transcribe_audio(client: &reqwest::blocking::Client, arguments: &Value) -> Result<Value, String> {
    let file_path = arguments
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| "缺少 file_path 参数".to_string())?;
    let language = arguments
        .get("language")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("auto")
        .to_string();
    let model_id = arguments.get("model_id").and_then(Value::as_str);
    let model = pick_model(client, "speech.transcribe", model_id)?;
    let provider_id = model
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| "模型缺少 provider 信息".to_string())?
        .to_string();
    let selected_model_id = model
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let (data_url, clip_name) = audio_file_to_wav_data_url(file_path)?;
    let run_id = start_run(
        client,
        "speech.transcribe",
        &provider_id,
        "Agent 转写",
        json!({ "audioDataUrl": data_url, "clipName": clip_name }),
        json!({
            "modelId": selected_model_id,
            "language": language,
            "sourceLanguage": language,
            "targetLanguage": language,
            "punctuation": true,
        }),
    )?;
    wait_for_run(client, &run_id)?;
    let output = run_output(client, &run_id)?;
    let segments: Vec<Value> = output
        .get("segments")
        .and_then(Value::as_array)
        .map(|segments| {
            segments
                .iter()
                .map(|segment| {
                    json!({
                        "start": segment.get("start").cloned().unwrap_or(Value::Null),
                        "end": segment.get("end").cloned().unwrap_or(Value::Null),
                        "text": segment.get("text").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "text": output.get("text").cloned().unwrap_or(Value::Null),
        "language": output.get("language").cloned().unwrap_or(Value::Null),
        "duration": output.get("duration").cloned().unwrap_or(Value::Null),
        "segments": segments,
    }))
}

fn synthesize_speech(client: &reqwest::blocking::Client, arguments: &Value) -> Result<Value, String> {
    let text = arguments
        .get("text")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "缺少 text 参数".to_string())?;
    let model_id = arguments.get("model_id").and_then(Value::as_str);
    let model = pick_model(client, "speech.synthesize", model_id)?;
    let provider_id = model
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| "模型缺少 provider 信息".to_string())?
        .to_string();
    let selected_model_id = model
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut parameters = json!({ "modelId": selected_model_id });
    if let Some(voice) = arguments.get("voice").and_then(Value::as_str) {
        parameters["voice"] = json!(voice);
    }
    if let Some(speed) = arguments.get("speed").and_then(Value::as_f64) {
        parameters["speed"] = json!(speed);
    }
    let run_id = start_run(
        client,
        "speech.synthesize",
        &provider_id,
        "Agent 语音合成",
        json!({ "text": text }),
        parameters,
    )?;
    wait_for_run(client, &run_id)?;
    let output = run_output(client, &run_id)?;
    Ok(json!({
        "filePath": output.get("filePath").cloned().unwrap_or(Value::Null),
        "fileName": output.get("fileName").cloned().unwrap_or(Value::Null),
        "duration": output.get("duration").cloned().unwrap_or(Value::Null),
        "sampleRate": output.get("sampleRate").cloned().unwrap_or(Value::Null),
        "sizeBytes": output.get("sizeBytes").cloned().unwrap_or(Value::Null),
    }))
}

fn bridge_session_id() -> Result<String, String> {
    acp_session_id().ok_or_else(|| "当前 Agent 会话不支持面板桥接".to_string())
}

fn start_meeting_capture(client: &reqwest::blocking::Client) -> Result<Value, String> {
    let session_id = bridge_session_id()?;
    api_post(
        client,
        &format!("/v1/agent/sessions/{session_id}/panel"),
        &json!({ "panel": "meeting-notes" }),
    )?;
    Ok(json!({
        "opened": true,
        "panel": "meeting-notes",
        "hint": "会议纪要面板已打开，请用户在面板中点击开始录音；之后可用 get_meeting_transcript 读取转写。",
    }))
}

fn get_meeting_transcript(client: &reqwest::blocking::Client) -> Result<Value, String> {
    let session_id = bridge_session_id()?;
    let state = api_get(client, &format!("/v1/agent/sessions/{session_id}/meeting-state"))?;
    let has_segments = state
        .get("segments")
        .and_then(Value::as_array)
        .map(|segments| !segments.is_empty())
        .unwrap_or(false);
    if state.get("recording").and_then(Value::as_bool) != Some(true) && !has_segments {
        return Ok(json!({
            "recording": false,
            "hint": "会议还没有开始录音。请提醒用户在会议纪要面板中点击开始。",
        }));
    }
    Ok(state)
}
