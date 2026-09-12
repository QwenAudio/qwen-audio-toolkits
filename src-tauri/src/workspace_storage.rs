use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

const MAX_WORKSPACE_BYTES: usize = 16 * 1024 * 1024;
const WORKSPACE_VERSION: u64 = 1;

#[derive(Default)]
pub struct WorkspaceStorageRuntime {
    io: Mutex<()>,
    close_guard: Mutex<Option<String>>,
}

impl WorkspaceStorageRuntime {
    pub fn close_guard_ready(&self) -> bool {
        self.close_guard
            .lock()
            .map(|owner| owner.is_some())
            .unwrap_or(false)
    }

    pub fn clear_close_guard(&self) {
        if let Ok(mut owner) = self.close_guard.lock() {
            *owner = None;
        }
    }

    fn set_close_guard(&self, owner: String, enabled: bool) -> Result<(), String> {
        if !valid_key(&owner) {
            return Err("关闭监听标识无效。".into());
        }
        let mut current = self.close_guard.lock().map_err(|_| "无法注册关闭监听。")?;
        if enabled {
            *current = Some(owner);
        } else if current.as_ref() == Some(&owner) {
            *current = None;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn workspace_set_close_guard(
    runtime: tauri::State<'_, WorkspaceStorageRuntime>,
    owner: String,
    enabled: bool,
) -> Result<(), String> {
    runtime.set_close_guard(owner, enabled)
}

#[tauri::command]
pub fn workspace_finish_close(app: tauri::AppHandle, quit: bool) -> Result<(), String> {
    let runtime = app.state::<WorkspaceStorageRuntime>();
    if quit {
        runtime.clear_close_guard();
        app.exit(0);
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::Ordering;
        if app
            .state::<crate::CloseBehavior>()
            .0
            .load(Ordering::Relaxed)
        {
            runtime.clear_close_guard();
            app.exit(0);
        } else if let Some(window) = app.get_webview_window("main") {
            window.hide().map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        runtime.clear_close_guard();
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn workspace_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(directory.join("workspace").join("workspace-v1.json"))
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 160
        && key.as_bytes()[0].is_ascii_alphanumeric()
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn validate_document(payload: &str) -> Result<Value, String> {
    if payload.len() > MAX_WORKSPACE_BYTES {
        return Err("工作区超过 16 MB 大小限制，原文件已保留。".into());
    }
    let value: Value = serde_json::from_str(payload)
        .map_err(|error| format!("工作区数据损坏，原文件已保留：{error}"))?;
    if value.get("version").and_then(Value::as_u64) != Some(WORKSPACE_VERSION) {
        return Err("工作区版本不受支持，原文件已保留。".into());
    }
    if value.get("revision").and_then(Value::as_u64).is_none()
        || value.get("updatedAt").and_then(Value::as_u64).is_none()
    {
        return Err("工作区版本信息无效，原文件已保留。".into());
    }
    let metadata = value
        .get("metadata")
        .and_then(Value::as_object)
        .ok_or("工作区任务数据无效。")?;
    for key in ["conversations", "generalTasks"] {
        let tasks = metadata
            .get(key)
            .and_then(Value::as_array)
            .ok_or("工作区任务列表无效。")?;
        if tasks.len() > 2_000
            || tasks.iter().any(|task| {
                !task
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(valid_key)
            })
        {
            return Err("工作区任务列表超过限制或标识无效。".into());
        }
    }
    if !metadata
        .get("selectedId")
        .is_some_and(|id| id.is_null() || id.as_str().is_some_and(valid_key))
    {
        return Err("工作区选中任务标识无效。".into());
    }
    let projects = value
        .get("projects")
        .and_then(Value::as_object)
        .ok_or("项目快照列表无效。")?;
    if projects.len() > 8_000 {
        return Err("项目快照数量超过限制。".into());
    }
    for (key, snapshot) in projects {
        let id = snapshot
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or("项目快照标识无效。")?;
        let kind = snapshot
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("项目快照类型无效。")?;
        if !valid_key(id)
            || !valid_key(kind)
            || key != &format!("{id}:{kind}")
            || snapshot.get("version").and_then(Value::as_u64) != Some(1)
            || snapshot.get("updatedAt").and_then(Value::as_u64).is_none()
            || !snapshot.get("state").is_some_and(Value::is_object)
        {
            return Err("项目快照无效或版本不受支持，原文件已保留。".into());
        }
    }
    Ok(value)
}

fn read_workspace(path: &Path) -> Result<Option<String>, String> {
    match fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取工作区：{error}")),
        Ok(metadata) if !metadata.is_file() || metadata.len() > MAX_WORKSPACE_BYTES as u64 => {
            return Err("工作区文件无效或超过大小限制，原文件已保留。".into())
        }
        Ok(_) => {}
    }
    let payload = fs::read_to_string(path).map_err(|error| format!("无法读取工作区：{error}"))?;
    validate_document(&payload)?;
    Ok(Some(payload))
}

fn write_workspace(path: &Path, payload: &str) -> Result<(), String> {
    let next = validate_document(payload)?;
    // Never overwrite a corrupt/unsupported file, or let an older request win.
    if let Some(previous_payload) = read_workspace(path)? {
        let previous = validate_document(&previous_payload)?;
        let previous_revision = previous["revision"].as_u64().unwrap_or_default();
        let revision = next["revision"].as_u64().unwrap_or_default();
        if revision < previous_revision || (revision == previous_revision && next != previous) {
            return Err("检测到更新的工作区数据，请重新打开应用后再保存。".into());
        }
        if next == previous {
            return Ok(());
        }
    }
    let directory = path.parent().ok_or("工作区目录无效。")?;
    fs::create_dir_all(directory).map_err(|error| format!("无法创建工作区目录：{error}"))?;
    let temporary = directory.join(format!(".workspace-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建工作区临时文件：{error}"))?;
        file.write_all(payload.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法保存工作区：{error}"))?;
        drop(file);
        fs::rename(&temporary, path).map_err(|error| format!("无法更新工作区文件：{error}"))?;
        #[cfg(unix)]
        if let Ok(directory) = fs::File::open(directory) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub fn workspace_load(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, WorkspaceStorageRuntime>,
) -> Result<Option<String>, String> {
    let _lock = runtime
        .io
        .lock()
        .map_err(|_| "工作区存储正忙，请重新打开应用。")?;
    read_workspace(&workspace_path(&app)?)
}

#[tauri::command]
pub fn workspace_save(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, WorkspaceStorageRuntime>,
    payload: String,
) -> Result<(), String> {
    let _lock = runtime
        .io
        .lock()
        .map_err(|_| "工作区存储正忙，请重新打开应用。")?;
    write_workspace(&workspace_path(&app)?, &payload)
}

#[derive(Serialize)]
pub struct RestoredWorkspaceMedia {
    available: Vec<String>,
    missing: Vec<String>,
}

#[tauri::command]
pub fn workspace_restore_media(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<RestoredWorkspaceMedia, String> {
    if paths.len() > 256 || paths.iter().any(|path| path.len() > 32_768) {
        return Err("恢复素材请求超过限制。".into());
    }
    let mut result = RestoredWorkspaceMedia {
        available: Vec::new(),
        missing: Vec::new(),
    };
    for path in paths {
        let source = Path::new(&path);
        if !source.is_absolute() || !source.is_file() {
            result.missing.push(path);
            continue;
        }
        app.asset_protocol_scope()
            .allow_file(source)
            .map_err(|error| format!("无法恢复素材访问权限：{error}"))?;
        result.available.push(path);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document(revision: u64) -> String {
        json!({ "version": 1, "revision": revision, "updatedAt": 10, "metadata": { "conversations": [], "generalTasks": [], "selectedId": null }, "projects": {} }).to_string()
    }

    #[test]
    fn stale_unmount_cannot_disable_a_new_close_listener() {
        let runtime = WorkspaceStorageRuntime::default();
        assert!(!runtime.close_guard_ready());
        runtime.set_close_guard("first-mount".into(), true).unwrap();
        runtime.set_close_guard("next-mount".into(), true).unwrap();
        runtime
            .set_close_guard("first-mount".into(), false)
            .unwrap();
        assert!(runtime.close_guard_ready());
        runtime.set_close_guard("next-mount".into(), false).unwrap();
        assert!(!runtime.close_guard_ready());
        runtime.set_close_guard("last-mount".into(), true).unwrap();
        runtime.clear_close_guard();
        assert!(!runtime.close_guard_ready());
    }

    #[test]
    fn workspace_roundtrip_and_stale_write_protection() {
        let root = std::env::temp_dir().join(format!("workspace-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("workspace-v1.json");
        assert_eq!(read_workspace(&path).unwrap(), None);
        write_workspace(&path, &document(2)).unwrap();
        assert_eq!(read_workspace(&path).unwrap(), Some(document(2)));
        assert!(write_workspace(&path, &document(1)).is_err());
        assert_eq!(read_workspace(&path).unwrap(), Some(document(2)));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn damaged_and_unknown_version_files_are_never_replaced() {
        let root = std::env::temp_dir().join(format!("workspace-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("workspace-v1.json");
        for payload in ["{invalid", "{\"version\": 99}"] {
            fs::write(&path, payload).unwrap();
            assert!(read_workspace(&path).is_err());
            assert!(write_workspace(&path, &document(1)).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), payload);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
