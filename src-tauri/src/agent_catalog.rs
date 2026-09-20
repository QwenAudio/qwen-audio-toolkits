use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, time::Duration};
use tauri::{AppHandle, Manager};

const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
const MAX_AGENT_COUNT: usize = 200;
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MODEL_REPOSITORY_RESOLVE: &str =
    "https://www.modelscope.cn/models/funaudio_public/QwenAudio-Toolkits/resolve/master";
const CATALOG_PATH: &str = "agents/catalog.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCatalog {
    pub schema_version: u32,
    pub agents: Vec<AgentCatalogEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCatalogEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub provider: Option<String>,
    pub archive: String,
    pub sha256: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
        && !id.starts_with('.')
        && !id.contains("..")
}

fn safe_repository_path(path: &str) -> bool {
    !path.is_empty()
        && path.starts_with("agents/")
        && path.ends_with(".tar")
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && !segment.contains('\\')
        })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_catalog(mut catalog: AgentCatalog) -> Result<AgentCatalog, String> {
    if catalog.schema_version != 1 {
        return Err("不支持的 Agent 目录版本".into());
    }
    if catalog.agents.len() > MAX_AGENT_COUNT {
        return Err("Agent 目录条目过多".into());
    }
    let mut ids = std::collections::HashSet::new();
    for entry in &mut catalog.agents {
        entry.id = entry.id.trim().to_owned();
        entry.name = entry.name.trim().to_owned();
        entry.version = entry.version.trim().to_owned();
        entry.publisher = entry.publisher.trim().to_owned();
        entry.description = entry.description.trim().to_owned();
        entry.category = entry.category.trim().to_owned();
        entry.provider = entry.provider.take().map(|value| value.trim().to_owned());
        entry.archive = entry.archive.trim().to_owned();
        entry.sha256 = entry.sha256.trim().to_ascii_lowercase();
        if !valid_id(&entry.id)
            || entry.name.is_empty()
            || entry.name.len() > 80
            || entry.version.is_empty()
            || entry.version.len() > 80
            || entry.publisher.is_empty()
            || entry.publisher.len() > 80
            || entry.description.len() > 500
            || entry.category.is_empty()
            || entry.category.len() > 40
            || !matches!(entry.provider.as_deref(), None | Some("bailian"))
            || !safe_repository_path(&entry.archive)
            || !valid_sha256(&entry.sha256)
            || !ids.insert(entry.id.clone())
        {
            return Err("Agent 目录包含无效条目".into());
        }
    }
    catalog.agents.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(catalog)
}

fn bundled_catalog() -> Result<AgentCatalog, String> {
    serde_json::from_str(include_str!("../../catalog/agent-catalog.json"))
        .map_err(|error| format!("内置 Agent 目录格式无效: {error}"))
        .and_then(validate_catalog)
}

fn repository_url(path: &str) -> Result<reqwest::Url, String> {
    if !safe_repository_path(path) && path != CATALOG_PATH {
        return Err("ModelScope Agent 文件路径无效".into());
    }
    let mut url = reqwest::Url::parse(MODEL_REPOSITORY_RESOLVE)
        .map_err(|error| format!("ModelScope Agent 地址无效: {error}"))?;
    let mut segments = url
        .path_segments_mut()
        .map_err(|_| "ModelScope Agent 地址不支持追加文件路径".to_string())?;
    for segment in path.split('/') {
        segments.push(segment);
    }
    drop(segments);
    Ok(url)
}

async fn download_limited(url: reqwest::Url, limit: u64) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .user_agent("QwenAudio-Toolkits/0.1")
        .build()
        .map_err(|error| format!("无法创建 ModelScope Agent 连接: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("无法读取 ModelScope Agent 文件: {error}"))?
        .error_for_status()
        .map_err(|error| format!("ModelScope Agent 请求失败: {error}"))?;
    if response.content_length().is_some_and(|length| length > limit) {
        return Err("Agent 文件超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > limit as usize {
            return Err("Agent 文件超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn remote_catalog() -> Result<AgentCatalog, String> {
    let bytes = download_limited(repository_url(CATALOG_PATH)?, MAX_CATALOG_BYTES).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("ModelScope Agent 目录格式无效: {error}"))
        .and_then(validate_catalog)
}

fn cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("agent-catalog.json"))
        .map_err(|error| error.to_string())
}

fn cached_catalog(app: &AppHandle) -> Result<AgentCatalog, String> {
    let path = cache_path(app)?;
    let mut file = fs::File::open(&path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err("缓存的 Agent 目录超过大小限制".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("缓存的 Agent 目录格式无效: {error}"))
        .and_then(validate_catalog)
}

fn cache_catalog(app: &AppHandle, catalog: &AgentCatalog) -> Result<(), String> {
    let path = cache_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec(catalog).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

/// The repository is the only Agent source. A missing or temporarily unavailable remote
/// catalog leaves the bundled catalog usable, so the desktop remains offline-capable.
#[tauri::command]
pub async fn agent_catalog_list(app: AppHandle) -> Result<AgentCatalog, String> {
    match remote_catalog().await {
        Ok(catalog) => {
            if let Err(error) = cache_catalog(&app, &catalog) {
                log::warn!("could not cache ModelScope Agent catalog: {error}");
            }
            Ok(catalog)
        }
        Err(error) => {
            log::warn!("could not refresh ModelScope Agent catalog: {error}");
            cached_catalog(&app).or_else(|_| bundled_catalog())
        }
    }
}

pub async fn download_agent_package(
    app: &AppHandle,
    id: &str,
) -> Result<(AgentCatalogEntry, Vec<u8>), String> {
    if !valid_id(id) {
        return Err("Agent ID 无效".into());
    }
    let catalog = agent_catalog_list(app.clone()).await?;
    let entry = catalog
        .agents
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or("该 Agent 不在受信任的 ModelScope 目录中")?;
    let bytes = download_limited(repository_url(&entry.archive)?, MAX_PACKAGE_BYTES).await?;
    let digest = Sha256::digest(&bytes);
    let actual = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if actual != entry.sha256 {
        return Err("Agent 包校验失败，下载内容与目录声明不一致".into());
    }
    Ok((entry, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_is_valid() {
        assert_eq!(bundled_catalog().unwrap().schema_version, 1);
    }

    #[test]
    fn rejects_unsafe_entries() {
        let invalid = AgentCatalog {
            schema_version: 1,
            agents: vec![AgentCatalogEntry {
                id: "meeting.notes".into(),
                name: "Meeting notes".into(),
                version: "1".into(),
                publisher: "QwenAudio".into(),
                description: "".into(),
                category: "Text".into(),
                provider: None,
                archive: "agents/../escape.tar".into(),
                sha256: "0".repeat(64),
            }],
        };
        assert!(validate_catalog(invalid).is_err());
    }
}
