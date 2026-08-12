//! The command surface the frontend's NativeRuntimeDriver calls.
//!
//! Two things here are load-bearing and easy to get wrong.
//!
//! THE ENGINE LIVES ON ITS OWN THREAD. An inference context is created from,
//! and borrows, its model — so the pair cannot simply be parked in shared
//! application state and reached from whichever async task happens to run
//! next. Beyond the borrow, generation is a long synchronous CPU burn:
//! performing it on the async runtime would stall every other task, including
//! the events that tell the learner anything is happening. So one dedicated
//! thread owns the engine for the life of the app, and the commands are
//! messages to it.
//!
//! EVERY EXCHANGE CARRIES A REQUEST ID. Events are emitted to the whole window,
//! so a token carries no inherent notion of which generation produced it. Two
//! concurrent answers — a card's Ask AI and a deck chat — would otherwise
//! interleave into each other's text, which cannot be untangled afterwards.
//! The frontend filters on this id; the ids also key the cancellation flags, so
//! interrupting one answer cannot stop another.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

use crate::inference_engine::{
    create_inference_engine, GenerationRequest, InferenceError, ModelLoadRequest,
};
use crate::model_download_manager::{ModelDownloadManager, ModelPresenceReport};
use crate::system_capability_probe::{SystemCapability, SystemCapabilityProbe};

// Hand-mirrored from Common/Constants/NativeLlmProtocolConstants.json, which is
// the source of truth. Rust is not a codegen target, so these are duplicated
// the same way the web worker's protocol is — and asserted identical by
// Dock/VerifyLocalLlmProvisioning.mjs, because a drift here is silent: the
// frontend would subscribe to an event nobody emits and simply wait forever.
const EVENT_DOWNLOAD_PROGRESS: &str = "native-llm-download-progress";
const EVENT_LOAD_PROGRESS: &str = "native-llm-load-progress";
const EVENT_TOKEN: &str = "native-llm-token";
const EVENT_FAILED: &str = "native-llm-failed";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEvent
{
    request_id: u64,
    value: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadProgressEvent
{
    request_id: u64,
    loaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FailureEvent
{
    request_id: u64,
    message: String,
}

enum EngineCommand
{
    Load
    {
        request: ModelLoadRequest,
        responder: tokio::sync::oneshot::Sender<Result<(), InferenceError>>,
    },
    Generate
    {
        request: GenerationRequest,
        request_id: u64,
        app_handle: AppHandle,
        cancellation: Arc<AtomicBool>,
        responder: tokio::sync::oneshot::Sender<Result<String, InferenceError>>,
    },
    Unload
    {
        responder: tokio::sync::oneshot::Sender<()>,
    },
}

/// The handle to the thread that owns the engine.
struct InferenceWorker
{
    command_sender: mpsc::Sender<EngineCommand>,
}

impl InferenceWorker
{
    fn start() -> Self
    {
        let (command_sender, command_receiver) = mpsc::channel::<EngineCommand>();

        std::thread::Builder::new()
            .name("cogniumlearn-inference".to_string())
            .spawn(move ||
            {
                let mut engine = create_inference_engine();

                // Ends when every sender is dropped, i.e. when the app is
                // shutting down. No explicit shutdown message is needed, and
                // relying on the channel closing means an abrupt exit cannot
                // leave the thread waiting on a message that never arrives.
                while let Ok(command) = command_receiver.recv()
                {
                    match command
                    {
                        EngineCommand::Load { request, responder } =>
                        {
                            let _ = responder.send(engine.load(&request));
                        }
                        EngineCommand::Generate { request, request_id, app_handle, cancellation, responder } =>
                        {
                            let mut emit_token = |fragment: &str|
                            {
                                let _ = app_handle.emit(EVENT_TOKEN, TokenEvent
                                {
                                    request_id,
                                    value: fragment.to_string(),
                                });
                            };

                            let generation_result = engine.generate(&request, &cancellation, &mut emit_token);

                            if let Err(generation_error) = &generation_result
                            {
                                let _ = app_handle.emit(EVENT_FAILED, FailureEvent
                                {
                                    request_id,
                                    message: generation_error.to_string(),
                                });
                            }

                            let _ = responder.send(generation_result);
                        }
                        EngineCommand::Unload { responder } =>
                        {
                            engine.unload();
                            let _ = responder.send(());
                        }
                    }
                }
            })
            .expect("the inference worker thread could not be started");

        Self { command_sender }
    }
}

/// Application state for the native model. One worker, one loaded model.
pub struct NativeLlmState
{
    worker: Mutex<Option<InferenceWorker>>,
    cancellation_flags: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    loaded_model_key: Mutex<Option<String>>,
}

impl NativeLlmState
{
    pub fn new() -> Self
    {
        Self
        {
            worker: Mutex::new(None),
            cancellation_flags: Mutex::new(HashMap::new()),
            loaded_model_key: Mutex::new(None),
        }
    }

    /// Starts the worker on first use rather than at app start.
    ///
    /// Most sessions never touch the on-device model — a learner on a paid tier
    /// never will — and a thread that exists from launch costs memory and a
    /// stack for nothing.
    fn send_command(&self, command: EngineCommand) -> Result<(), String>
    {
        let mut worker_slot = self.worker.lock().map_err(|error| error.to_string())?;

        if worker_slot.is_none()
        {
            *worker_slot = Some(InferenceWorker::start());
        }

        worker_slot
            .as_ref()
            .expect("the worker was just created")
            .command_sender
            .send(command)
            .map_err(|_| "the inference worker is no longer running".to_string())
    }
}

impl Default for NativeLlmState
{
    fn default() -> Self
    {
        Self::new()
    }
}


#[tauri::command]
pub async fn probe_native_llm_capability() -> Result<SystemCapability, String>
{
    Ok(SystemCapabilityProbe::probe())
}

#[tauri::command]
pub async fn ensure_native_model_present(
    app_handle: AppHandle,
    request_id: u64,
    weights_url: String,
    weights_file_name: String,
    expected_sha256: Option<String>,
) -> Result<String, String>
{
    let model_path = ModelDownloadManager::ensure_present(
        &app_handle,
        request_id,
        &weights_url,
        &weights_file_name,
        expected_sha256,
        EVENT_DOWNLOAD_PROGRESS,
    )
    .await
    .map_err(|error| error.to_string())?;

    Ok(model_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn probe_native_model_presence(
    app_handle: AppHandle,
    weights_file_name: String,
) -> Result<ModelPresenceReport, String>
{
    ModelDownloadManager::describe_presence(&app_handle, &weights_file_name)
        .map_err(|error| error.to_string())
}

/// Removes a model's weights from the device.
///
/// UNLOADS FIRST WHEN THIS IS THE MODEL IN USE, and that ordering is the whole
/// substance of the command. The engine memory-maps the weights file for the
/// lifetime of the loaded model; on Windows an open mapping makes the file
/// undeletable outright, and on Unix the unlink succeeds while the space stays
/// held until the last handle closes. Both end with a learner who asked for a
/// couple of gigabytes back and did not get them — one loudly, one silently,
/// and the silent one is worse.
#[tauri::command]
pub async fn delete_native_model(
    app_handle: AppHandle,
    state: State<'_, NativeLlmState>,
    model_key: String,
    weights_file_name: String,
) -> Result<(), String>
{
    let b_model_is_loaded = state
        .loaded_model_key
        .lock()
        .map(|loaded_model_key| loaded_model_key.as_deref() == Some(model_key.as_str()))
        .unwrap_or(false);

    if b_model_is_loaded
    {
        let (responder, response_receiver) = tokio::sync::oneshot::channel();
        state.send_command(EngineCommand::Unload { responder })?;

        // Awaited rather than fired and forgotten: the unload is what releases
        // the mapping, so deleting before it completes reintroduces exactly the
        // failure this ordering exists to prevent.
        let _ = response_receiver.await;

        if let Ok(mut loaded_model_key) = state.loaded_model_key.lock()
        {
            *loaded_model_key = None;
        }
    }

    ModelDownloadManager::remove(&app_handle, &weights_file_name)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn load_native_model(
    app_handle: AppHandle,
    state: State<'_, NativeLlmState>,
    request_id: u64,
    model_key: String,
    weights_file_name: String,
    context_window_tokens: u32,
    thread_count: usize,
) -> Result<(), String>
{
    let model_file_path = ModelDownloadManager::resolve_model_path(&app_handle, &weights_file_name)
        .map_err(|error| error.to_string())?;

    // Zero means "decide for me". The frontend can override from the
    // catalogue, but the device knows its own core count better than a
    // catalogue written months earlier does.
    let resolved_thread_count = if thread_count == 0
    {
        SystemCapabilityProbe::probe().logical_core_count
    }
    else
    {
        thread_count
    };

    let (responder, response_receiver) = tokio::sync::oneshot::channel();
    state.send_command(EngineCommand::Load
    {
        request: ModelLoadRequest
        {
            model_file_path,
            context_window_tokens,
            thread_count: resolved_thread_count,
        },
        responder,
    })?;

    // A load reports progress as a single completion step rather than a
    // fraction: the libraries memory-map the weights and expose no progress to
    // report, so a moving bar here would be a fiction. The download before it
    // is where the minutes actually go, and that one is genuinely measured.
    let _ = app_handle.emit(EVENT_LOAD_PROGRESS, LoadProgressEvent
    {
        request_id,
        loaded_bytes: 0,
        total_bytes: 1,
    });

    let load_result = response_receiver
        .await
        .map_err(|_| "the inference worker stopped while loading the model".to_string())?;

    load_result.map_err(|error| error.to_string())?;

    if let Ok(mut loaded_model_key) = state.loaded_model_key.lock()
    {
        *loaded_model_key = Some(model_key);
    }

    let _ = app_handle.emit(EVENT_LOAD_PROGRESS, LoadProgressEvent
    {
        request_id,
        loaded_bytes: 1,
        total_bytes: 1,
    });

    Ok(())
}

#[tauri::command]
pub async fn generate_native_completion(
    app_handle: AppHandle,
    state: State<'_, NativeLlmState>,
    request_id: u64,
    system_prompt: String,
    user_prompt: String,
    maximum_new_tokens: u32,
    temperature: f32,
) -> Result<String, String>
{
    let cancellation = Arc::new(AtomicBool::new(false));

    // Registered BEFORE the work is queued. An interrupt can arrive while the
    // generation is still waiting its turn on the worker, and a flag that only
    // appears once generation starts would drop that stop on the floor.
    if let Ok(mut cancellation_flags) = state.cancellation_flags.lock()
    {
        cancellation_flags.insert(request_id, Arc::clone(&cancellation));
    }

    let (responder, response_receiver) = tokio::sync::oneshot::channel();
    let send_result = state.send_command(EngineCommand::Generate
    {
        request: GenerationRequest
        {
            system_prompt,
            user_prompt,
            maximum_new_tokens,
            temperature,
        },
        request_id,
        app_handle,
        cancellation,
        responder,
    });

    let generation_outcome = match send_result
    {
        Err(send_error) => Err(send_error),
        Ok(()) => response_receiver
            .await
            .map_err(|_| "the inference worker stopped while generating".to_string())
            .and_then(|result| result.map_err(|error| error.to_string())),
    };

    if let Ok(mut cancellation_flags) = state.cancellation_flags.lock()
    {
        cancellation_flags.remove(&request_id);
    }

    generation_outcome
}

#[tauri::command]
pub async fn interrupt_native_generation(
    state: State<'_, NativeLlmState>,
    request_id: u64,
) -> Result<(), String>
{
    if let Ok(cancellation_flags) = state.cancellation_flags.lock()
    {
        if let Some(cancellation) = cancellation_flags.get(&request_id)
        {
            cancellation.store(true, Ordering::Relaxed);
        }
    }

    // Never an error. The caller is tearing down a dialog and an unknown id
    // simply means the answer already finished — reporting that as a failure
    // would surface an error over a view the learner has dismissed.
    Ok(())
}

#[tauri::command]
pub async fn unload_native_model(state: State<'_, NativeLlmState>) -> Result<(), String>
{
    let (responder, response_receiver) = tokio::sync::oneshot::channel();
    state.send_command(EngineCommand::Unload { responder })?;

    let _ = response_receiver.await;

    if let Ok(mut loaded_model_key) = state.loaded_model_key.lock()
    {
        *loaded_model_key = None;
    }

    Ok(())
}
