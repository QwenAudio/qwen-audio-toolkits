//! Read-only connection to the Agent website. Remote pages receive no Tauri capabilities.
use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
pub struct AgentServerStatus {
    url: String,
    available: bool,
    error: Option<String>,
}

pub(crate) fn server_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Agent Server 地址无效")?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Agent Server 需要 HTTPS 站点地址或本机 HTTP 地址，不包含凭据或路径".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn agent_server_status() -> Result<AgentServerStatus, String> {
    let configured = std::env::var("QWEN_AUDIO_AGENT_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    let url = server_url(&configured)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let result = client
        .get(url.join("health").map_err(|e| e.to_string())?)
        .send()
        .await;
    let error = match result {
        Ok(response) if response.status().is_success() => None,
        Ok(response) => Some(format!("服务返回 {}", response.status())),
        Err(_) => Some("暂时无法连接 Agent Server".into()),
    };
    Ok(AgentServerStatus {
        url: url.to_string(),
        available: error.is_none(),
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_website_origins() {
        assert!(server_url("http://127.0.0.1:8787").is_ok());
        assert!(server_url("https://agents.example.com").is_ok());
        for value in [
            "file:///tmp/site",
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com?token=secret",
        ] {
            assert!(server_url(value).is_err(), "{value}");
        }
    }
}
