/// The six inference commands, declared so the ACL can grant them to the
/// deployed site.
///
/// WITHOUT THIS THE WHOLE NATIVE PATH IS DEAD, and silently so. Tauri allows an
/// app's own commands by default only for LOCAL content; this window loads the
/// deployed site over the network, and for a remote origin every command is
/// refused unless a capability names it. The rejection surfaces as
/// "Command … not allowed by ACL" from a promise the driver treats as "no
/// native runtime here", so the app would simply fall back to the browser
/// engine and nothing would look broken.
///
/// Declaring them here autogenerates an `allow-<command>` permission for each
/// (underscores become hyphens), which capabilities/remote.json then grants.
/// Adding a command means adding it here AND to that file —
/// Dock/VerifyLocalLlmProvisioning.mjs asserts the two agree.
const NATIVE_INFERENCE_COMMAND_NAMES: &[&str] = &[
    "probe_native_llm_capability",
    "ensure_native_model_present",
    "probe_native_model_presence",
    "delete_native_model",
    "load_native_model",
    "generate_native_completion",
    "interrupt_native_generation",
    "unload_native_model",
];

fn main()
{
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(NATIVE_INFERENCE_COMMAND_NAMES),
        ),
    )
    .expect("the Tauri build step failed");
}
