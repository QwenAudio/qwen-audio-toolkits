use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(target_os = "macos")]
use std::{
    ffi::{c_char, c_void, CStr},
    slice,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemAudioChunk {
    session_id: String,
    pcm_base64: String,
    sample_rate: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioSession {
    session_id: String,
    sample_rate: u32,
}

#[cfg(target_os = "macos")]
type ProcessTapCallback = unsafe extern "C" fn(*const i16, u32, u32, *mut c_void);

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn qwen_audio_process_tap_start(
        callback: ProcessTapCallback,
        context: *mut c_void,
        mute_original: bool,
        sample_rate: *mut u32,
        error: *mut c_char,
        error_capacity: usize,
    ) -> *mut c_void;
    fn qwen_audio_process_tap_stop(handle: *mut c_void);
    fn qwen_audio_process_tap_play_pcm(
        handle: *mut c_void,
        samples: *const i16,
        frame_count: u32,
        error: *mut c_char,
        error_capacity: usize,
    ) -> i32;
    fn qwen_audio_process_tap_flush_playback(handle: *mut c_void) -> i32;
    fn qwen_audio_process_tap_pause(
        handle: *mut c_void,
        error: *mut c_char,
        error_capacity: usize,
    ) -> i32;
    fn qwen_audio_process_tap_resume(
        handle: *mut c_void,
        mute_original: bool,
        error: *mut c_char,
        error_capacity: usize,
    ) -> i32;
}

#[cfg(target_os = "macos")]
struct TapCallbackContext {
    app: AppHandle,
    session_id: String,
    callback_count: AtomicU64,
    received_signal: AtomicBool,
}

#[cfg(target_os = "macos")]
struct ActiveCapture {
    session_id: String,
    handle: *mut c_void,
    _context: Box<TapCallbackContext>,
    playback_count: AtomicU64,
    playback_received_signal: AtomicBool,
    running: bool,
}

#[cfg(target_os = "macos")]
unsafe impl Send for ActiveCapture {}

#[cfg(target_os = "macos")]
impl Drop for ActiveCapture {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { qwen_audio_process_tap_stop(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

pub struct SystemAudioRuntime {
    #[cfg(target_os = "macos")]
    active: Mutex<Option<ActiveCapture>>,
}

impl SystemAudioRuntime {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            #[cfg(target_os = "macos")]
            active: Mutex::new(None),
        })
    }
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub fn run_process_tap_smoke_test() -> Result<(), String> {
    unsafe extern "C" fn discard_audio(
        _samples: *const i16,
        _frame_count: u32,
        _sample_rate: u32,
        _context: *mut c_void,
    ) {
    }

    fn native_error(buffer: &[c_char], fallback: String) -> String {
        let message = unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .trim()
            .to_string();
        if message.is_empty() {
            fallback
        } else {
            message
        }
    }

    let mut sample_rate = 0_u32;
    let mut error = [0 as c_char; 512];
    let handle = unsafe {
        qwen_audio_process_tap_start(
            discard_audio,
            std::ptr::null_mut(),
            false,
            &mut sample_rate,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if handle.is_null() {
        return Err(native_error(
            &error,
            "Process Tap smoke test could not start".to_string(),
        ));
    }
    let result = (|| {
        for cycle in 1..=3 {
            error.fill(0);
            let status =
                unsafe { qwen_audio_process_tap_pause(handle, error.as_mut_ptr(), error.len()) };
            if status != 0 {
                return Err(native_error(
                    &error,
                    format!("Process Tap smoke test pause {cycle} failed ({status})"),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            error.fill(0);
            let status = unsafe {
                qwen_audio_process_tap_resume(handle, false, error.as_mut_ptr(), error.len())
            };
            if status != 0 {
                return Err(native_error(
                    &error,
                    format!("Process Tap smoke test resume {cycle} failed ({status})"),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            log::info!("Process Tap smoke test cycle {cycle}/3 passed");
        }
        Ok(())
    })();
    unsafe { qwen_audio_process_tap_stop(handle) };
    result
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn process_tap_callback(
    samples: *const i16,
    frame_count: u32,
    sample_rate: u32,
    context: *mut c_void,
) {
    if samples.is_null() || context.is_null() || frame_count == 0 {
        return;
    }
    let context = unsafe { &*(context as *const TapCallbackContext) };
    let samples = unsafe { slice::from_raw_parts(samples, frame_count as usize) };
    let callback_count = context.callback_count.fetch_add(1, Ordering::Relaxed);
    let peak = samples
        .iter()
        .map(|sample| sample.unsigned_abs())
        .max()
        .unwrap_or(0);
    if callback_count == 0 {
        log::info!(
            "Core Audio Process Tap received first buffer: frames={}, rate={}, peak={}",
            frame_count,
            sample_rate,
            peak
        );
    }
    if peak > 256 && !context.received_signal.swap(true, Ordering::Relaxed) {
        log::info!(
            "Core Audio Process Tap received audible signal: callback={}, peak={}",
            callback_count + 1,
            peak
        );
    }
    let mut pcm = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        pcm.extend_from_slice(&sample.to_le_bytes());
    }
    let _ = context.app.emit(
        "system-audio-chunk",
        SystemAudioChunk {
            session_id: context.session_id.clone(),
            pcm_base64: STANDARD.encode(pcm),
            sample_rate,
        },
    );
}

#[tauri::command]
pub fn system_audio_start(
    app: AppHandle,
    runtime: State<'_, Arc<SystemAudioRuntime>>,
    mute_original: bool,
) -> Result<SystemAudioSession, String> {
    #[cfg(target_os = "macos")]
    {
        let mut active = runtime
            .active
            .lock()
            .map_err(|_| "电脑音频接管状态不可用".to_string())?;
        if let Some(capture) = active.as_mut() {
            if capture.running {
                return Err("电脑音频已在监听中".to_string());
            }
            let mut error = [0 as c_char; 512];
            let status = unsafe {
                qwen_audio_process_tap_resume(
                    capture.handle,
                    mute_original,
                    error.as_mut_ptr(),
                    error.len(),
                )
            };
            if status != 0 {
                let message = unsafe { CStr::from_ptr(error.as_ptr()) }
                    .to_string_lossy()
                    .trim()
                    .to_string();
                log::error!("Core Audio Process Tap resume failed: {message}");
                return Err(if message.is_empty() {
                    format!("无法恢复电脑音频监听 ({status})")
                } else {
                    message
                });
            }
            capture.running = true;
            capture.playback_count.store(0, Ordering::Relaxed);
            capture
                .playback_received_signal
                .store(false, Ordering::Relaxed);
            capture._context.callback_count.store(0, Ordering::Relaxed);
            capture
                ._context
                .received_signal
                .store(false, Ordering::Relaxed);
            log::info!(
                "Core Audio Process Tap resumed: session={}",
                capture.session_id
            );
            return Ok(SystemAudioSession {
                session_id: capture.session_id.clone(),
                sample_rate: 48_000,
            });
        }

        let session_id = Uuid::new_v4().to_string();
        let mut context = Box::new(TapCallbackContext {
            app,
            session_id: session_id.clone(),
            callback_count: AtomicU64::new(0),
            received_signal: AtomicBool::new(false),
        });
        let context_pointer = (&mut *context as *mut TapCallbackContext).cast::<c_void>();
        let mut sample_rate = 0_u32;
        let mut error = [0 as c_char; 512];
        let handle = unsafe {
            qwen_audio_process_tap_start(
                process_tap_callback,
                context_pointer,
                mute_original,
                &mut sample_rate,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if handle.is_null() {
            let message = unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .trim()
                .to_string();
            let message = if message.is_empty() {
                "无法启动 Core Audio Process Tap".to_string()
            } else {
                message
            };
            log::error!("Core Audio Process Tap start failed: {message}");
            return Err(message);
        }
        if sample_rate != 48_000 {
            unsafe { qwen_audio_process_tap_stop(handle) };
            return Err(format!(
                "当前输出设备为 {sample_rate} Hz，实时模型需要 48000 Hz"
            ));
        }

        *active = Some(ActiveCapture {
            session_id: session_id.clone(),
            handle,
            _context: context,
            playback_count: AtomicU64::new(0),
            playback_received_signal: AtomicBool::new(false),
            running: true,
        });
        log::info!(
            "Core Audio Process Tap started: session={}, rate={}",
            session_id,
            sample_rate
        );
        Ok(SystemAudioSession {
            session_id,
            sample_rate,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, runtime);
        Err("电脑音频接管当前仅支持 macOS 14.2 或更高版本".to_string())
    }
}

#[tauri::command]
pub fn system_audio_stop(
    runtime: State<'_, Arc<SystemAudioRuntime>>,
    session_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut active = runtime
            .active
            .lock()
            .map_err(|_| "电脑音频接管状态不可用".to_string())?;
        let Some(capture) = active.as_mut() else {
            return Ok(());
        };
        if capture.session_id != session_id {
            return Err("电脑音频监听会话不匹配".to_string());
        }
        if !capture.running {
            return Ok(());
        }
        log::info!("Core Audio Process Tap stopping: session={session_id}");
        let mut error = [0 as c_char; 512];
        let status = unsafe {
            qwen_audio_process_tap_pause(capture.handle, error.as_mut_ptr(), error.len())
        };
        if status != 0 {
            let message = unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .trim()
                .to_string();
            log::error!("Core Audio Process Tap pause failed: {message}");
            return Err(if message.is_empty() {
                format!("无法停止电脑音频监听 ({status})")
            } else {
                message
            });
        }
        capture.running = false;
        log::info!("Core Audio Process Tap stopped: session={session_id}");
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (runtime, session_id);
        Ok(())
    }
}

#[tauri::command]
pub fn system_audio_play_chunk(
    runtime: State<'_, Arc<SystemAudioRuntime>>,
    session_id: String,
    pcm_base64: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pcm = STANDARD
            .decode(pcm_base64)
            .map_err(|error| format!("监听音频数据无效：{error}"))?;
        if pcm.len() < 2 || pcm.len() % 2 != 0 {
            return Err("监听音频数据长度无效".to_string());
        }
        let samples = pcm
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>();
        let active = runtime
            .active
            .lock()
            .map_err(|_| "电脑音频接管状态不可用".to_string())?;
        let capture = active
            .as_ref()
            .ok_or_else(|| "电脑音频监听尚未启动".to_string())?;
        if capture.session_id != session_id {
            return Err("电脑音频监听会话不匹配".to_string());
        }
        if !capture.running {
            return Err("电脑音频监听尚未启动".to_string());
        }
        let playback_count = capture.playback_count.fetch_add(1, Ordering::Relaxed);
        if playback_count == 0 {
            let peak = samples
                .iter()
                .map(|sample| sample.unsigned_abs())
                .max()
                .unwrap_or(0);
            log::info!(
                "Core Audio native monitor received first output: frames={}, peak={}",
                samples.len(),
                peak
            );
        }
        let peak = samples
            .iter()
            .map(|sample| sample.unsigned_abs())
            .max()
            .unwrap_or(0);
        if peak > 256
            && !capture
                .playback_received_signal
                .swap(true, Ordering::Relaxed)
        {
            log::info!(
                "Core Audio native monitor received audible output: chunk={}, peak={}",
                playback_count + 1,
                peak
            );
        }
        let mut error = [0 as c_char; 512];
        let status = unsafe {
            qwen_audio_process_tap_play_pcm(
                capture.handle,
                samples.as_ptr(),
                samples.len() as u32,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            let message = unsafe { CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .trim()
                .to_string();
            return Err(if message.is_empty() {
                format!("原生监听播放失败 ({status})")
            } else {
                message
            });
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (runtime, session_id, pcm_base64);
        Err("电脑音频接管当前仅支持 macOS 14.2 或更高版本".to_string())
    }
}

#[tauri::command]
pub fn system_audio_flush_playback(
    runtime: State<'_, Arc<SystemAudioRuntime>>,
    session_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let active = runtime
            .active
            .lock()
            .map_err(|_| "电脑音频接管状态不可用".to_string())?;
        let capture = active
            .as_ref()
            .ok_or_else(|| "电脑音频监听尚未启动".to_string())?;
        if capture.session_id != session_id {
            return Err("电脑音频监听会话不匹配".to_string());
        }
        let status = unsafe { qwen_audio_process_tap_flush_playback(capture.handle) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("无法清空监听音频缓冲区 ({status})"))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (runtime, session_id);
        Ok(())
    }
}
