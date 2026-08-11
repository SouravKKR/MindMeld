//! The boundary between "run a model" and "which library runs it".
//!
//! Everything above this file — the command surface, the download manager, the
//! capability probe, and the whole frontend — is written against
//! [`InferenceEngine`]. The library that actually performs the arithmetic is
//! one implementation of it, selected at compile time, and is named nowhere
//! else in this crate.
//!
//! That is not speculative generality. On-device inference libraries move
//! quickly and each carries a different build burden; committing the command
//! layer to one of them would make replacing it a rewrite rather than a swap.
//! It is also what lets the shell build at all on a machine without the C++
//! toolchain: with the feature off, the unavailable implementation compiles in
//! its place and the frontend simply reports no native runtime and uses its
//! browser path.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum InferenceError
{
    #[error("this build has no native inference engine compiled in")]
    NotCompiledIn,

    #[error("no model is loaded")]
    NoModelLoaded,

    #[error("the model could not be loaded: {0}")]
    ModelLoadFailed(String),

    #[error("generation failed: {0}")]
    GenerationFailed(String),
}

/// What to load, and how much room to give it.
pub struct ModelLoadRequest
{
    pub model_file_path: std::path::PathBuf,
    pub context_window_tokens: u32,
    pub thread_count: usize,
}

/// One question, with the sampling settings for its answer.
pub struct GenerationRequest
{
    pub system_prompt: String,
    pub user_prompt: String,
    pub maximum_new_tokens: u32,
    pub temperature: f32,
}

/// An engine that can hold one model and answer with it.
///
/// `Send` because the implementation is owned by a dedicated worker thread —
/// see the note in `llm_commands`. It is deliberately NOT `Sync`: nothing
/// should be able to drive the same engine from two threads at once, and the
/// type system is a better place to enforce that than a comment.
pub trait InferenceEngine: Send
{
    fn load(&mut self, request: &ModelLoadRequest) -> Result<(), InferenceError>;

    /// Streams an answer, calling `on_token` with each fragment and returning
    /// the whole text.
    ///
    /// `cancellation` is checked between tokens rather than passed to the
    /// library, because these libraries generate synchronously and there is no
    /// other point at which a stop can be honoured. Checking per token bounds
    /// the delay to one token's worth of work, which on the slowest supported
    /// device is a fraction of a second — fast enough that closing a dialog
    /// really does stop the phone working.
    fn generate(
        &mut self,
        request: &GenerationRequest,
        cancellation: &Arc<AtomicBool>,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, InferenceError>;

    fn unload(&mut self);

    fn is_loaded(&self) -> bool;
}

/// Used when the inference feature is not compiled in.
///
/// It fails rather than pretending: a silent no-op would leave the frontend
/// waiting on an answer that is never coming, which is indistinguishable from
/// a hang. The capability probe reports `bInferenceCompiledIn: false` so the
/// frontend never reaches this in practice — this is the backstop for when it
/// does anyway.
pub struct UnavailableInferenceEngine;

impl InferenceEngine for UnavailableInferenceEngine
{
    fn load(&mut self, _request: &ModelLoadRequest) -> Result<(), InferenceError>
    {
        Err(InferenceError::NotCompiledIn)
    }

    fn generate(
        &mut self,
        _request: &GenerationRequest,
        _cancellation: &Arc<AtomicBool>,
        _on_token: &mut dyn FnMut(&str),
    ) -> Result<String, InferenceError>
    {
        Err(InferenceError::NotCompiledIn)
    }

    fn unload(&mut self)
    {
    }

    fn is_loaded(&self) -> bool
    {
        false
    }
}

/// The engine this build runs with.
///
/// The only place a concrete implementation is chosen. Adding or replacing a
/// library is this function plus its module — the command layer, the state and
/// the frontend are untouched.
pub fn create_inference_engine() -> Box<dyn InferenceEngine>
{
    #[cfg(feature = "native-inference")]
    {
        Box::new(crate::llama_inference_engine::LlamaInferenceEngine::new())
    }
    #[cfg(not(feature = "native-inference"))]
    {
        Box::new(UnavailableInferenceEngine)
    }
}

/// Convenience for implementations: whether generation should stop now.
pub fn is_cancelled(cancellation: &Arc<AtomicBool>) -> bool
{
    cancellation.load(Ordering::Relaxed)
}

/// The path exists check every implementation needs before trying to load, so
/// that a missing file reports itself as a missing file rather than as a
/// corrupt model from somewhere inside the library.
pub fn ensure_model_file_exists(model_file_path: &Path) -> Result<(), InferenceError>
{
    if !model_file_path.exists()
    {
        return Err(InferenceError::ModelLoadFailed(format!(
            "no model file at {}",
            model_file_path.display()
        )));
    }
    Ok(())
}


#[cfg(test)]
mod tests
{
    use super::*;

    #[test]
    fn the_unavailable_engine_reports_rather_than_pretends()
    {
        let mut engine = UnavailableInferenceEngine;
        assert!(!engine.is_loaded());

        let load_result = engine.load(&ModelLoadRequest
        {
            model_file_path: std::path::PathBuf::from("unused.gguf"),
            context_window_tokens: 2048,
            thread_count: 4,
        });
        assert!(matches!(load_result, Err(InferenceError::NotCompiledIn)));
    }

    #[test]
    fn a_missing_model_file_is_named_as_such()
    {
        let result = ensure_model_file_exists(Path::new("definitely-not-here.gguf"));
        assert!(matches!(result, Err(InferenceError::ModelLoadFailed(_))));
    }
}
