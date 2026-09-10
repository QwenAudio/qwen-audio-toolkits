// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(code) = qwenaudio_toolkits_lib::run_native_worker_from_arguments(&arguments) {
        std::process::exit(code);
    }
    qwenaudio_toolkits_lib::run();
}
