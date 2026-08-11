//! CogniumLearn native shell.
//!
//! The window loads the deployed site rather than bundled files, so this crate
//! is not "the app" — it is the set of things a web page cannot do for itself:
//! persist to the filesystem, raise system notifications, update its own
//! binary, and run a language model on the device's own hardware.
//!
//! The inference layer is behind a Cargo feature. Without it the shell still
//! builds and runs; the frontend's capability probe simply finds no native
//! runtime and uses its browser execution path instead. That is what lets the
//! app be built by anyone who has not installed CMake and libclang.

pub mod inference_engine;
pub mod llm_commands;
pub mod model_download_manager;
pub mod system_capability_probe;

use llm_commands::NativeLlmState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run()
{
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());

    // Registered against the real target operating systems rather than the
    // `desktop` cfg alias, which is not defined during a mobile build — the
    // plugin would be compiled in and then fail to initialise on a phone.
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(NativeLlmState::new())
        .invoke_handler(tauri::generate_handler![
            llm_commands::probe_native_llm_capability,
            llm_commands::ensure_native_model_present,
            llm_commands::load_native_model,
            llm_commands::generate_native_completion,
            llm_commands::interrupt_native_generation,
            llm_commands::unload_native_model,
        ])
        .run(tauri::generate_context!())
        .expect("CogniumLearn failed to start");
}
