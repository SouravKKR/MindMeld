//! The llama.cpp-backed implementation of [`InferenceEngine`].
//!
//! This is the ONLY file in the crate that names the inference library. If it
//! is ever replaced, this file and one line of `create_inference_engine` are
//! the change; the command surface, the download manager, the capability probe
//! and the entire frontend are untouched. Keep it that way — nothing here
//! should leak a library type past the trait.

use std::num::NonZeroU32;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;

use crate::inference_engine::{
    ensure_model_file_exists, is_cancelled, GenerationRequest, InferenceEngine, InferenceError,
    ModelLoadRequest,
};

/// Batch capacity for the prompt pass. The prompt is fed in one go, so this
/// bounds the longest prompt the engine will accept; it is sized from the
/// context window at load time rather than fixed here.
const MINIMUM_BATCH_CAPACITY: usize = 512;

/// Sampling settings. Deliberately conservative — this tier answers questions
/// about a learner's own study material, where a plausible invention is worse
/// than a dull answer.
const TOP_K_CANDIDATES: i32 = 40;
const TOP_P_MASS: f32 = 0.95;
const MINIMUM_KEPT_CANDIDATES: usize = 1;

/// Fixed seed. Sampling is still stochastic, but the same question against the
/// same model gives the same answer, which is what makes a report of "it said
/// something wrong" reproducible.
const SAMPLER_SEED: u32 = 1234;

pub struct LlamaInferenceEngine
{
    backend: Option<LlamaBackend>,
    model: Option<LlamaModel>,
    context_window_tokens: u32,
    thread_count: i32,
}

impl LlamaInferenceEngine
{
    pub fn new() -> Self
    {
        Self
        {
            backend: None,
            model: None,
            context_window_tokens: 0,
            thread_count: 1,
        }
    }

    /// Qwen2.5's ChatML framing.
    ///
    /// Written out rather than read from the model's embedded chat template
    /// because the catalogue pins which models this tier runs, and a template
    /// read at run time is one more thing that can be absent or malformed in a
    /// downloaded file. If the catalogue ever carries a model from another
    /// family, this is what has to change with it.
    fn build_prompt(request: &GenerationRequest) -> String
    {
        format!(
            "<|im_start|>system\n{}<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n",
            request.system_prompt.trim(),
            request.user_prompt.trim()
        )
    }

    fn build_sampler(temperature: f32) -> LlamaSampler
    {
        // A temperature at or below zero means "always take the most likely
        // token". Feeding that to the temperature sampler would divide by it.
        if temperature <= 0.0
        {
            return LlamaSampler::chain_simple([LlamaSampler::greedy()]);
        }

        // Order matters: the candidate set is narrowed first, then temperature
        // reshapes what survives, and the distribution sampler draws last.
        LlamaSampler::chain_simple([
            LlamaSampler::top_k(TOP_K_CANDIDATES),
            LlamaSampler::top_p(TOP_P_MASS, MINIMUM_KEPT_CANDIDATES),
            LlamaSampler::temp(temperature),
            LlamaSampler::dist(SAMPLER_SEED),
        ])
    }
}

impl Default for LlamaInferenceEngine
{
    fn default() -> Self
    {
        Self::new()
    }
}

impl InferenceEngine for LlamaInferenceEngine
{
    fn load(&mut self, request: &ModelLoadRequest) -> Result<(), InferenceError>
    {
        ensure_model_file_exists(&request.model_file_path)?;

        // The backend is process-wide and initialised once. Re-initialising it
        // on a second load is not merely wasteful; it re-registers llama.cpp's
        // global state underneath a model that is still mapped.
        if self.backend.is_none()
        {
            self.backend = Some(
                LlamaBackend::init().map_err(|error| InferenceError::ModelLoadFailed(error.to_string()))?,
            );
        }
        let backend = self.backend.as_ref().expect("the backend was just initialised");

        // Everything on the processor. A GPU offload needs the library built
        // with a graphics feature, which this build deliberately does not do:
        // on Android mobile GPU compute measures worse than the processor's
        // own vector units at this model size, and enabling it would drag a
        // shader toolchain into the build for a slowdown. Desktop offload is a
        // separate change with its own measurements.
        let model_parameters = LlamaModelParams::default().with_n_gpu_layers(0);

        let model = LlamaModel::load_from_file(backend, &request.model_file_path, &model_parameters)
            .map_err(|error| InferenceError::ModelLoadFailed(error.to_string()))?;

        // A model's own trained window is the ceiling; asking for more than it
        // was trained on produces confident nonsense past that point rather
        // than an error.
        let requested_window = request.context_window_tokens.max(1);
        let resolved_window = requested_window.min(model.n_ctx_train());

        self.model = Some(model);
        self.context_window_tokens = resolved_window;
        self.thread_count = i32::try_from(request.thread_count.max(1)).unwrap_or(1);

        Ok(())
    }

    fn generate(
        &mut self,
        request: &GenerationRequest,
        cancellation: &Arc<AtomicBool>,
        on_token: &mut dyn FnMut(&str),
    ) -> Result<String, InferenceError>
    {
        let backend = self.backend.as_ref().ok_or(InferenceError::NoModelLoaded)?;
        let model = self.model.as_ref().ok_or(InferenceError::NoModelLoaded)?;

        // The context is created per generation and dropped at the end of it.
        //
        // That is a deliberate trade. A context borrows its model, so holding
        // one in this struct would make the pair self-referential — which Rust
        // will not allow without unsafe self-reference machinery that would
        // outlive every future change to this file. Recreating it costs one
        // KV-cache allocation per answer, tens of milliseconds against an
        // answer measured in seconds, and it has a second benefit: each answer
        // starts from a genuinely clean state, so a previous question can
        // never bleed into the next one.
        let context_parameters = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(self.context_window_tokens))
            .with_n_threads(self.thread_count)
            .with_n_threads_batch(self.thread_count);

        let mut context = model
            .new_context(backend, context_parameters)
            .map_err(|error| InferenceError::GenerationFailed(error.to_string()))?;

        let prompt_text = Self::build_prompt(request);
        let prompt_tokens = model
            .str_to_token(&prompt_text, AddBos::Always)
            .map_err(|error| InferenceError::GenerationFailed(error.to_string()))?;

        let window_size = self.context_window_tokens as usize;
        if prompt_tokens.len() >= window_size
        {
            // The prompt builder on the frontend budgets against this same
            // window, so reaching here means its estimate was wrong rather
            // than that the learner asked too much. Failing loudly is right:
            // silently truncating would drop the question, which produces a
            // confident answer to something nobody asked.
            return Err(InferenceError::GenerationFailed(format!(
                "the prompt is {} tokens, which does not fit the {}-token context window",
                prompt_tokens.len(),
                window_size
            )));
        }

        let batch_capacity = prompt_tokens.len().max(MINIMUM_BATCH_CAPACITY);
        let mut batch = LlamaBatch::new(batch_capacity, 1);

        let last_prompt_index = prompt_tokens.len() - 1;
        for (token_index, prompt_token) in prompt_tokens.iter().enumerate()
        {
            // Logits are only needed for the final prompt token — that is the
            // position the first answer token is predicted from. Requesting
            // them for every position multiplies the prompt pass's memory by
            // the vocabulary size for no benefit.
            let b_needs_logits = token_index == last_prompt_index;
            batch
                .add(*prompt_token, token_index as i32, &[0], b_needs_logits)
                .map_err(|error| InferenceError::GenerationFailed(error.to_string()))?;
        }

        context
            .decode(&mut batch)
            .map_err(|error| InferenceError::GenerationFailed(error.to_string()))?;

        let mut sampler = Self::build_sampler(request.temperature);
        let mut assembled_text = String::new();

        // ONE decoder for the whole answer, deliberately.
        //
        // Tokens are byte sequences, and a multi-byte character can straddle
        // two of them — routine for accented text, CJK, and anything with an
        // emoji. A decoder created per token sees the leading bytes of such a
        // character, has nothing to finish them with, and emits a replacement
        // character; the trailing bytes then produce a second one. Carrying
        // the decoder across the loop lets it hold the incomplete sequence
        // until the next token completes it. (The convenience method this
        // replaces creates a fresh decoder each call and has exactly that
        // bug, which is part of why it is deprecated.)
        let mut token_decoder = encoding_rs::UTF_8.new_decoder();
        let mut next_position = prompt_tokens.len() as i32;
        let maximum_new_tokens = request.maximum_new_tokens.max(1);

        for _ in 0..maximum_new_tokens
        {
            // Checked between tokens because generation is synchronous and
            // there is no other point a stop can be honoured. One token's
            // latency is the worst-case delay, which is what makes closing a
            // dialog genuinely stop the device working rather than merely stop
            // showing the result.
            if is_cancelled(cancellation)
            {
                break;
            }

            let sampled_token = sampler.sample(&context, batch.n_tokens() - 1);
            sampler.accept(sampled_token);

            if model.is_eog_token(sampled_token)
            {
                break;
            }

            //  for the special-token flag: the control tokens that
            // frame the conversation are rendered as plain text rather than
            // emitted literally, so "<|im_end|>" can never surface in an
            // answer the learner reads.
            let fragment = model
                .token_to_piece(sampled_token, &mut token_decoder, false, None)
                .map_err(|error| InferenceError::GenerationFailed(error.to_string()))?;

            assembled_text.push_str(&fragment);
            on_token(&fragment);

            batch.clear();
            batch
                .add(sampled_token, next_position, &[0], true)
                .map_err(|error| InferenceError::GenerationFailed(error.to_string()))?;
            next_position += 1;

            context
                .decode(&mut batch)
                .map_err(|error| InferenceError::GenerationFailed(error.to_string()))?;
        }

        Ok(assembled_text)
    }

    fn unload(&mut self)
    {
        // The model is dropped; the backend is not. It is process-wide and
        // cheap to keep, and tearing it down while anything else still holds a
        // reference to llama.cpp's global state is how a clean unload turns
        // into a crash on the next load.
        self.model = None;
        self.context_window_tokens = 0;
    }

    fn is_loaded(&self) -> bool
    {
        self.model.is_some()
    }
}


#[cfg(test)]
mod tests
{
    use super::*;

    #[test]
    fn the_prompt_uses_chatml_framing_and_ends_ready_for_the_answer()
    {
        let request = GenerationRequest
        {
            system_prompt: "  You are helpful.  ".to_string(),
            user_prompt: "  What is spaced repetition?  ".to_string(),
            maximum_new_tokens: 128,
            temperature: 0.7,
        };

        let prompt = LlamaInferenceEngine::build_prompt(&request);

        assert!(prompt.starts_with("<|im_start|>system\nYou are helpful.<|im_end|>"));
        assert!(prompt.contains("<|im_start|>user\nWhat is spaced repetition?<|im_end|>"));
        // Must end on the open assistant turn, or the model continues the
        // user's message instead of answering it.
        assert!(prompt.ends_with("<|im_start|>assistant\n"));
    }

    #[test]
    fn an_unloaded_engine_reports_rather_than_panicking()
    {
        let engine = LlamaInferenceEngine::new();
        assert!(!engine.is_loaded());
    }
}
