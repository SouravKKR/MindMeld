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
#[cfg(feature = "native-inference")]
pub mod llama_inference_engine;
pub mod llm_commands;
pub mod model_download_manager;
pub mod system_capability_probe;

use llm_commands::NativeLlmState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run()
{
    // The context is built first so the configuration can be inspected before
    // any plugin is registered. See the updater note below — that check is the
    // only reason this is not the usual one-liner.
    let context = tauri::generate_context!();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());

    // THE UPDATER IS REGISTERED ONLY WHEN IT IS CONFIGURED, and that condition
    // is load-bearing rather than tidy.
    //
    // ConfigureTauriApp.js deletes `plugins.updater` whenever no signing public
    // key is supplied, which is the normal state for a development build and
    // for anyone building without the release key. The plugin then initialises
    // against a missing section, deserialises it as null, and panics before the
    // window is ever created:
    //
    //     PluginInitialization("updater", "Error deserializing 'plugins.updater'
    //     ... invalid type: null, expected struct Config")
    //
    // The app does not start at all — no window, no error dialog, just an exit.
    //
    // Registered against the real target operating systems rather than the
    // `desktop` cfg alias, which is not defined while the mobile targets are
    // resolved, so the plugin would otherwise be compiled into an Android build
    // and fail there instead.
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        if context.config().plugins.0.contains_key("updater")
        {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
    }

    builder
        .manage(NativeLlmState::new())
        .invoke_handler(tauri::generate_handler![
            llm_commands::probe_native_llm_capability,
            llm_commands::ensure_native_model_present,
            llm_commands::probe_native_model_presence,
            llm_commands::delete_native_model,
            llm_commands::load_native_model,
            llm_commands::generate_native_completion,
            llm_commands::interrupt_native_generation,
            llm_commands::unload_native_model,
        ])
        .run(context)
        .expect("CogniumLearn failed to start");
}
