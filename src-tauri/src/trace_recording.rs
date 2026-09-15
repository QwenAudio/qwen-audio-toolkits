use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::Manager;

const MAX_RECORDING_BYTES: usize = 64 * 1024 * 1024;

fn recordings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(directory.join("recordings"))
}

fn valid_scenario_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[tauri::command]
pub fn list_recordings(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let directory = recordings_dir(&app)?;
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    let entries = fs::read_dir(&directory).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        if entry.path().join("trace.json").is_file() {
            if let Some(name) = entry.file_name().to_str() {
                if valid_scenario_id(name) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub fn read_recording(app: tauri::AppHandle, scenario_id: String) -> Result<Value, String> {
    if !valid_scenario_id(&scenario_id) {
        return Err("录制标识无效。".into());
    }
    let base = recordings_dir(&app)?.join(&scenario_id);
    let manifest =
        fs::read_to_string(base.join("manifest.json")).map_err(|error| error.to_string())?;
    let trace = fs::read_to_string(base.join("trace.json")).map_err(|error| error.to_string())?;
    let manifest: Value = serde_json::from_str(&manifest).map_err(|error| error.to_string())?;
    let trace: Value = serde_json::from_str(&trace).map_err(|error| error.to_string())?;
    let entries = trace
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(serde_json::json!({ "manifest": manifest, "entries": entries }))
}

#[tauri::command]
pub fn write_recording(
    app: tauri::AppHandle,
    scenario_id: String,
    payload: Value,
) -> Result<(), String> {
    if !valid_scenario_id(&scenario_id) {
        return Err("录制标识无效。".into());
    }
    let serialized = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    if serialized.len() > MAX_RECORDING_BYTES {
        return Err("录制数据超过 64 MB 限制。".into());
    }
    let base = recordings_dir(&app)?.join(&scenario_id);
    fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    fs::write(base.join("trace.json"), serialized).map_err(|error| error.to_string())?;
    let manifest = payload.get("manifest").cloned().unwrap_or(Value::Null);
    let manifest_serialized =
        serde_json::to_string(&manifest).map_err(|error| error.to_string())?;
    fs::write(base.join("manifest.json"), manifest_serialized)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_recording(app: tauri::AppHandle, scenario_id: String) -> Result<(), String> {
    if !valid_scenario_id(&scenario_id) {
        return Err("录制标识无效。".into());
    }
    let base = recordings_dir(&app)?.join(&scenario_id);
    if base.is_dir() {
        fs::remove_dir_all(&base).map_err(|error| error.to_string())?;
    }
    Ok(())
}
