mod advanced_models;
mod asr;
mod audio_io;
mod audio_processing;
mod downloads;
mod harness;
mod plugins;
mod system_audio;
mod tts;
mod vad;
mod wetext;

use asr::{asr_model_status, transcribe_audio, AsrRuntime};
use audio_io::MAX_AUDIO_BYTES;
use audio_processing::{audio_processor_status, process_audio, AudioProcessingRuntime};
use axum::{
    extract::{DefaultBodyLimit, Path as AxumPath, State as AxumState},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use harness::{
    harness_api_provider_settings, harness_bailian_provider_settings, harness_cancel_run,
    harness_catalog, harness_create_bailian_voice, harness_delete_bailian_voice,
    harness_delete_run, harness_finish_enhancement_stream, harness_finish_funasr_stream,
    harness_finish_vad_stream, harness_get_run, harness_get_run_output, harness_get_run_preview,
    harness_list_bailian_voices, harness_list_runs, harness_push_enhancement_stream,
    harness_push_funasr_stream, harness_push_vad_stream, harness_retry_run,
    harness_save_api_provider, harness_save_bailian_provider, harness_start_cosyvoice_stream,
    harness_start_enhancement_stream, harness_start_funasr_stream, harness_start_run,
    harness_start_vad_stream, ApiProviderSettings, ApiProviderUpdate, BailianProviderSettings,
    BailianProviderUpdate, HarnessCatalog, HarnessExecution, HarnessRun, HarnessRuntime,
    HarnessTaskRequest,
};
use plugins::{
    plugin_api_catalog, plugin_cancel_download, plugin_catalog, plugin_dependency_bindings,
    plugin_install_catalog, plugin_install_package, plugin_install_recommended_dependency,
    plugin_refresh_catalog, plugin_replace_dependency_bindings, plugin_set_catalog_source,
    plugin_set_dependency_binding, plugin_set_download_paused, plugin_set_sidebar_visible,
    plugin_uninstall, DependencyBindings, PluginDescriptor, PluginInstallRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Arc};
#[cfg(all(target_os = "macos", debug_assertions))]
use system_audio::run_process_tap_smoke_test;
use system_audio::{
    system_audio_flush_playback, system_audio_play_chunk, system_audio_start, system_audio_stop,
    SystemAudioRuntime,
};
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::{RunEvent, WindowEvent};
use tts::{generate_speech, tts_model_status, TtsRuntime};

const API_ADDRESS: &str = "127.0.0.1:3847";

#[cfg(target_os = "macos")]
fn restore_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("could not restore main window: window is unavailable");
        return;
    };

    if let Err(error) = window.unminimize() {
        log::warn!("could not unminimize main window: {error}");
    }
    if let Err(error) = window.show() {
        log::warn!("could not show main window: {error}");
    }
    if let Err(error) = window.set_focus() {
        log::warn!("could not focus main window: {error}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    api_url: &'static str,
    backend: &'static str,
    device: &'static str,
    platform: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedAudioFile {
    name: String,
    mime_type: &'static str,
    data_base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginRuntimeDescriptor {
    id: &'static str,
    label: &'static str,
    isolation: &'static str,
    extensions: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiHealth {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    platform: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelRecord {
    id: String,
    name: String,
    capabilities: Vec<String>,
    provider: String,
    installed: bool,
    enabled: bool,
}

#[derive(Clone)]
struct LocalApiState {
    app: tauri::AppHandle,
    harness: Arc<HarnessRuntime>,
    tts: Arc<TtsRuntime>,
    asr: Arc<AsrRuntime>,
    audio: Arc<AudioProcessingRuntime>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiError {
    error: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogPluginInstallRequest {
    plugin_id: String,
    variant_id: Option<String>,
}

type ApiResult<T> = Result<Json<T>, (StatusCode, Json<ApiError>)>;

#[tauri::command]
fn runtime_status() -> RuntimeStatus {
    RuntimeStatus {
        api_url: "127.0.0.1:3847",
        backend: "Rust + sherpa-onnx",
        device: accelerator_name(),
        platform: std::env::consts::OS,
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn read_dropped_audio_file(path: String) -> Result<DroppedAudioFile, String> {
    let path = PathBuf::from(path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "拖入的文件没有可识别的音频扩展名".to_string())?;
    let mime_type = match extension.as_str() {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "webm" => "audio/webm",
        "amr" => "audio/amr",
        _ => {
            return Err("请拖入 WAV、MP3、FLAC、M4A、AAC、OGG、OPUS、WEBM 或 AMR 音频".to_string())
        }
    };
    let metadata = fs::metadata(&path).map_err(|error| format!("无法读取拖入的音频: {error}"))?;
    if !metadata.is_file() {
        return Err("拖入的项目不是音频文件".to_string());
    }
    if metadata.len() as usize > MAX_AUDIO_BYTES {
        return Err("音频文件过大，请先裁剪后再处理".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("无法读取拖入的音频: {error}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("dropped-audio")
        .to_string();
    Ok(DroppedAudioFile {
        name,
        mime_type,
        data_base64: STANDARD.encode(bytes),
    })
}

#[tauri::command]
fn plugin_runtime_catalog() -> Vec<PluginRuntimeDescriptor> {
    vec![
        PluginRuntimeDescriptor {
            id: "kokoro",
            label: "Kokoro / sherpa-onnx",
            isolation: "process",
            extensions: vec![".onnx", ".bin", ".txt"],
        },
        PluginRuntimeDescriptor {
            id: "sensevoice",
            label: "SenseVoice / sherpa-onnx",
            isolation: "process",
            extensions: vec![".onnx", ".txt"],
        },
        PluginRuntimeDescriptor {
            id: "dpdfnet2",
            label: "DPDFNet2 / sherpa-onnx",
            isolation: "process",
            extensions: vec![".onnx"],
        },
        PluginRuntimeDescriptor {
            id: "deepfilternet",
            label: "DeepFilterNet / native",
            isolation: "process",
            extensions: vec![".tar.gz"],
        },
        PluginRuntimeDescriptor {
            id: "rnnoise",
            label: "RNNoise / native",
            isolation: "process",
            extensions: vec![],
        },
        PluginRuntimeDescriptor {
            id: "silero-vad",
            label: "Silero VAD / sherpa-onnx",
            isolation: "process",
            extensions: vec![".onnx"],
        },
        PluginRuntimeDescriptor {
            id: "web-audio",
            label: "Web Audio",
            isolation: "webview",
            extensions: vec![".json"],
        },
    ]
}

async fn api_health() -> Json<ApiHealth> {
    Json(ApiHealth {
        status: "ready",
        service: "qwenaudio-toolkits",
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    })
}

async fn api_plugin_runtimes() -> Json<Vec<PluginRuntimeDescriptor>> {
    Json(plugin_runtime_catalog())
}

async fn api_plugins(
    AxumState(state): AxumState<LocalApiState>,
) -> ApiResult<Vec<PluginDescriptor>> {
    plugins::catalog(&state.app)
        .map(Json)
        .map_err(api_internal_error)
}

async fn api_install_plugin(
    AxumState(state): AxumState<LocalApiState>,
    Json(request): Json<PluginInstallRequest>,
) -> ApiResult<PluginDescriptor> {
    plugins::install_from_path(state.app, request.path)
        .await
        .map(Json)
        .map_err(api_bad_request)
}

async fn api_install_catalog_plugin(
    AxumState(state): AxumState<LocalApiState>,
    Json(request): Json<CatalogPluginInstallRequest>,
) -> ApiResult<PluginDescriptor> {
    plugins::plugin_install_catalog(state.app, request.plugin_id, request.variant_id)
        .await
        .map(Json)
        .map_err(api_bad_request)
}

async fn api_uninstall_plugin(
    AxumState(state): AxumState<LocalApiState>,
    AxumPath(plugin_id): AxumPath<String>,
) -> ApiResult<Value> {
    plugins::uninstall(&state.app, &plugin_id)
        .and_then(|result| serde_json::to_value(result).map_err(|error| error.to_string()))
        .map(Json)
        .map_err(api_bad_request)
}

async fn api_dependency_bindings(
    AxumState(state): AxumState<LocalApiState>,
) -> ApiResult<DependencyBindings> {
    plugins::plugin_dependency_bindings(state.app)
        .map(Json)
        .map_err(api_internal_error)
}

async fn api_replace_dependency_bindings(
    AxumState(state): AxumState<LocalApiState>,
    Json(bindings): Json<DependencyBindings>,
) -> ApiResult<DependencyBindings> {
    plugins::plugin_replace_dependency_bindings(state.app, bindings)
        .map(Json)
        .map_err(api_bad_request)
}

async fn api_models(AxumState(state): AxumState<LocalApiState>) -> ApiResult<Vec<ModelRecord>> {
    plugins::catalog(&state.app)
        .map(|plugins| {
            Json(
                plugins
                    .into_iter()
                    .map(|plugin| ModelRecord {
                        id: plugin.id,
                        name: plugin.name,
                        capabilities: plugin.harness_capabilities,
                        provider: plugin
                            .provider_id
                            .unwrap_or_else(|| "shared-dependency".to_string()),
                        installed: plugin.installed,
                        enabled: plugin.enabled,
                    })
                    .collect(),
            )
        })
        .map_err(api_internal_error)
}

async fn api_harness_catalog(AxumState(state): AxumState<LocalApiState>) -> Json<HarnessCatalog> {
    let tts_status = tts_model_status(state.app.clone(), state.app.state::<Arc<TtsRuntime>>())
        .ok()
        .and_then(|status| serde_json::to_value(status).ok());
    let asr_status = asr_model_status(state.app.clone(), state.app.state::<Arc<AsrRuntime>>())
        .ok()
        .and_then(|status| serde_json::to_value(status).ok());
    let audio_status = audio_processor_status(
        state.app.clone(),
        state.app.state::<Arc<AudioProcessingRuntime>>(),
    )
    .ok()
    .and_then(|status| serde_json::to_value(status).ok());
    Json(harness::catalog_from_status(
        &state.app,
        tts_status,
        asr_status,
        audio_status,
    ))
}

async fn api_list_runs(AxumState(state): AxumState<LocalApiState>) -> ApiResult<Vec<HarnessRun>> {
    state
        .harness
        .list(&state.app)
        .map(Json)
        .map_err(api_internal_error)
}

async fn api_get_run(
    AxumState(state): AxumState<LocalApiState>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<HarnessRun> {
    state
        .harness
        .get(&state.app, &run_id)
        .map(Json)
        .map_err(api_not_found)
}

async fn api_get_run_output(
    AxumState(state): AxumState<LocalApiState>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<HarnessExecution> {
    harness::get_run_output(&state.app, &state.harness, &run_id)
        .map(Json)
        .map_err(api_not_found)
}

async fn api_get_run_preview(
    AxumState(state): AxumState<LocalApiState>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<HarnessExecution> {
    harness::get_run_preview(&state.app, &state.harness, &run_id)
        .map(Json)
        .map_err(api_not_found)
}

async fn api_start_run(
    AxumState(state): AxumState<LocalApiState>,
    Json(request): Json<HarnessTaskRequest>,
) -> ApiResult<HarnessRun> {
    harness::start_run(
        state.app,
        state.harness,
        state.tts,
        state.asr,
        state.audio,
        request,
    )
    .map(Json)
    .map_err(api_bad_request)
}

async fn api_cancel_run(
    AxumState(state): AxumState<LocalApiState>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<HarnessRun> {
    harness::cancel_run(&state.app, &state.harness, &run_id)
        .map(Json)
        .map_err(api_bad_request)
}

async fn api_retry_run(
    AxumState(state): AxumState<LocalApiState>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<HarnessRun> {
    harness::retry_run(
        state.app,
        state.harness,
        state.tts,
        state.asr,
        state.audio,
        &run_id,
    )
    .map(Json)
    .map_err(api_bad_request)
}

async fn api_delete_run(
    AxumState(state): AxumState<LocalApiState>,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<Value> {
    state
        .harness
        .remove(&state.app, &run_id)
        .map(|_| Json(json!({ "deleted": true, "runId": run_id })))
        .map_err(api_bad_request)
}

async fn api_provider_settings(
    AxumState(state): AxumState<LocalApiState>,
) -> ApiResult<ApiProviderSettings> {
    harness::provider_settings(&state.app)
        .map(Json)
        .map_err(api_internal_error)
}

async fn api_save_provider(
    AxumState(state): AxumState<LocalApiState>,
    Json(update): Json<ApiProviderUpdate>,
) -> ApiResult<ApiProviderSettings> {
    harness::harness_save_api_provider(state.app, update)
        .map(Json)
        .map_err(api_bad_request)
}

async fn api_bailian_provider_settings(
    AxumState(state): AxumState<LocalApiState>,
) -> ApiResult<BailianProviderSettings> {
    harness::bailian_provider_settings(&state.app)
        .map(Json)
        .map_err(api_internal_error)
}

async fn api_save_bailian_provider(
    AxumState(state): AxumState<LocalApiState>,
    Json(update): Json<BailianProviderUpdate>,
) -> ApiResult<BailianProviderSettings> {
    harness::harness_save_bailian_provider(state.app, update)
        .map(Json)
        .map_err(api_bad_request)
}

fn api_error(status: StatusCode, error: String) -> (StatusCode, Json<ApiError>) {
    (status, Json(ApiError { error }))
}

fn api_bad_request(error: String) -> (StatusCode, Json<ApiError>) {
    log::warn!("local API rejected request: {error}");
    api_error(StatusCode::BAD_REQUEST, error)
}

fn api_not_found(error: String) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::NOT_FOUND, error)
}

fn api_internal_error(error: String) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::INTERNAL_SERVER_ERROR, error)
}

fn start_local_api(state: LocalApiState) {
    tauri::async_runtime::spawn(async {
        let routes = Router::new()
            .route("/", get(api_health))
            .route("/v1/health", get(api_health))
            .route("/v1/plugins/runtimes", get(api_plugin_runtimes))
            .route("/v1/plugins", get(api_plugins).post(api_install_plugin))
            .route("/v1/plugins/catalog", post(api_install_catalog_plugin))
            .route("/v1/plugins/{plugin_id}", delete(api_uninstall_plugin))
            .route(
                "/v1/plugin-bindings",
                get(api_dependency_bindings).put(api_replace_dependency_bindings),
            )
            .route("/v1/models", get(api_models))
            .route("/v1/harness/catalog", get(api_harness_catalog))
            .route("/v1/runs", get(api_list_runs).post(api_start_run))
            .route("/v1/runs/{run_id}", get(api_get_run).delete(api_delete_run))
            .route("/v1/runs/{run_id}/preview", get(api_get_run_preview))
            .route("/v1/runs/{run_id}/output", get(api_get_run_output))
            .route("/v1/runs/{run_id}/cancel", post(api_cancel_run))
            .route("/v1/runs/{run_id}/retry", post(api_retry_run))
            .route(
                "/v1/providers/openai-compatible",
                get(api_provider_settings).put(api_save_provider),
            )
            .route(
                "/v1/providers/bailian",
                get(api_bailian_provider_settings).put(api_save_bailian_provider),
            )
            .layer(DefaultBodyLimit::max(700 * 1024 * 1024))
            .with_state(state);

        match tokio::net::TcpListener::bind(API_ADDRESS).await {
            Ok(listener) => {
                log::info!("local API listening on http://{API_ADDRESS}");
                if let Err(error) = axum::serve(listener, routes).await {
                    log::error!("local API stopped: {error}");
                }
            }
            Err(error) => {
                log::warn!("local API could not bind to {API_ADDRESS}: {error}");
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn accelerator_name() -> &'static str {
    "Apple Metal"
}

#[cfg(target_os = "windows")]
fn accelerator_name() -> &'static str {
    "DirectML / CUDA (auto)"
}

#[cfg(target_os = "linux")]
fn accelerator_name() -> &'static str {
    "CUDA / CPU (auto)"
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn accelerator_name() -> &'static str {
    "CPU"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let audio_processing_runtime = Arc::new(AudioProcessingRuntime::default());
    let asr_runtime = Arc::new(AsrRuntime::default());
    let tts_runtime = Arc::new(TtsRuntime::default());
    let harness_runtime = Arc::new(HarnessRuntime::default());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .manage(audio_processing_runtime)
        .manage(asr_runtime)
        .manage(tts_runtime)
        .manage(harness_runtime)
        .manage(SystemAudioRuntime::new())
        .setup(|app| {
            if let Err(error) = downloads::clear_completed_downloads(app.handle()) {
                log::warn!("could not clear completed model downloads: {error}");
            }
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            #[cfg(all(target_os = "macos", debug_assertions))]
            if std::env::var_os("QWEN_AUDIO_TAP_SMOKE_TEST").is_some() {
                run_process_tap_smoke_test()
                    .map_err(|error| format!("Process Tap smoke test failed: {error}"))?;
                log::info!("Process Tap smoke test passed all cycles");
            }
            let harness = app.state::<Arc<HarnessRuntime>>().inner().clone();
            if let Err(error) = harness.initialize(app.handle()) {
                log::warn!("could not load harness history: {error}");
            }
            if let Err(error) = vad::ensure_model_install(app.handle()) {
                log::warn!("could not migrate Silero VAD model: {error}");
            }
            start_local_api(LocalApiState {
                app: app.handle().clone(),
                harness,
                tts: app.state::<Arc<TtsRuntime>>().inner().clone(),
                asr: app.state::<Arc<AsrRuntime>>().inner().clone(),
                audio: app.state::<Arc<AudioProcessingRuntime>>().inner().clone(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        log::warn!("could not hide main window: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            read_dropped_audio_file,
            plugin_runtime_catalog,
            audio_processor_status,
            process_audio,
            asr_model_status,
            transcribe_audio,
            tts_model_status,
            generate_speech,
            harness_catalog,
            harness_list_runs,
            harness_get_run,
            harness_get_run_output,
            harness_get_run_preview,
            harness_start_run,
            harness_cancel_run,
            harness_retry_run,
            harness_delete_run,
            harness_api_provider_settings,
            harness_save_api_provider,
            harness_bailian_provider_settings,
            harness_save_bailian_provider,
            harness_list_bailian_voices,
            harness_create_bailian_voice,
            harness_delete_bailian_voice,
            harness_start_funasr_stream,
            harness_push_funasr_stream,
            harness_finish_funasr_stream,
            harness_start_vad_stream,
            harness_push_vad_stream,
            harness_finish_vad_stream,
            harness_start_enhancement_stream,
            harness_push_enhancement_stream,
            harness_finish_enhancement_stream,
            harness_start_cosyvoice_stream,
            system_audio_start,
            system_audio_play_chunk,
            system_audio_flush_playback,
            system_audio_stop,
            plugin_catalog,
            plugin_api_catalog,
            plugin_refresh_catalog,
            plugin_set_catalog_source,
            plugin_install_catalog,
            plugin_install_package,
            plugin_install_recommended_dependency,
            plugin_set_download_paused,
            plugin_cancel_download,
            plugin_dependency_bindings,
            plugin_replace_dependency_bindings,
            plugin_set_dependency_binding,
            plugin_set_sidebar_visible,
            plugin_uninstall
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            restore_main_window(app);
        }
    });
}
