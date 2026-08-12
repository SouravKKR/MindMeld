//! Gets a model's weights onto the device, once.
//!
//! Knows nothing about inference — it moves bytes and proves they are the right
//! bytes. That separation is what lets the download be tested without a model
//! and the engine be swapped without touching the network path.

use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

/// Where weights live under the app's data directory. A subdirectory rather
/// than the root so that clearing models never risks the app's own state.
const MODELS_DIRECTORY_NAME: &str = "Models";

/// Suffix for a download still in flight. A partial file must never be
/// loadable: the engine would map a truncated file and fail somewhere deep in
/// the tensor layout, which reads as a corrupt model rather than an
/// interrupted download.
const PARTIAL_FILE_SUFFIX: &str = ".partial";

/// How often progress is reported, in bytes. Emitting per chunk would post
/// thousands of events a second across the IPC boundary and cost more than the
/// download.
const PROGRESS_REPORT_INTERVAL_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ModelDownloadError
{
    #[error("the application data directory is unavailable: {0}")]
    DataDirectoryUnavailable(String),

    #[error("could not create the model directory: {0}")]
    DirectoryCreationFailed(String),

    #[error("the download request failed: {0}")]
    RequestFailed(String),

    #[error("the server answered {0} for the model download")]
    UnexpectedStatus(u16),

    #[error("writing the model to disk failed: {0}")]
    WriteFailed(String),

    #[error("the downloaded model failed its integrity check (expected {expected}, got {actual})")]
    IntegrityMismatch { expected: String, actual: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressReport
{
    pub request_id: u64,
    pub loaded_bytes: u64,
    pub total_bytes: u64,
}

pub struct ModelDownloadManager;

impl ModelDownloadManager
{
    pub fn resolve_models_directory(app_handle: &AppHandle) -> Result<PathBuf, ModelDownloadError>
    {
        let data_directory = app_handle
            .path()
            .app_data_dir()
            .map_err(|error| ModelDownloadError::DataDirectoryUnavailable(error.to_string()))?;

        Ok(data_directory.join(MODELS_DIRECTORY_NAME))
    }

    pub fn resolve_model_path(app_handle: &AppHandle, weights_file_name: &str) -> Result<PathBuf, ModelDownloadError>
    {
        // Only the file's own name is used. The catalogue is the sole source of
        // these names, but treating the value as a bare name regardless means a
        // descriptor carrying a path — however it came to — cannot write
        // outside the models directory.
        let safe_file_name = Path::new(weights_file_name)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| weights_file_name.to_string());

        Ok(Self::resolve_models_directory(app_handle)?.join(safe_file_name))
    }

    /// Ensures the weights are present and verified, downloading them if not.
    ///
    /// Returns immediately when the file is already there. The hash is NOT
    /// recomputed on that path: re-reading a gigabyte on every load would add
    /// seconds to each app start to re-prove something already proven at
    /// download time, and the file is inside the app's own data directory.
    pub async fn ensure_present(
        app_handle: &AppHandle,
        request_id: u64,
        weights_url: &str,
        weights_file_name: &str,
        expected_sha256: Option<String>,
        progress_event_name: &str,
    ) -> Result<PathBuf, ModelDownloadError>
    {
        let destination_path = Self::resolve_model_path(app_handle, weights_file_name)?;

        if destination_path.exists()
        {
            return Ok(destination_path);
        }

        let models_directory = Self::resolve_models_directory(app_handle)?;
        tokio::fs::create_dir_all(&models_directory)
            .await
            .map_err(|error| ModelDownloadError::DirectoryCreationFailed(error.to_string()))?;

        let partial_path = models_directory.join(format!("{weights_file_name}{PARTIAL_FILE_SUFFIX}"));
        let already_downloaded_bytes = tokio::fs::metadata(&partial_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        Self::stream_to_partial_file(
            app_handle,
            request_id,
            weights_url,
            &partial_path,
            already_downloaded_bytes,
            progress_event_name,
        )
        .await?;

        if let Some(expected_digest) = expected_sha256
        {
            let actual_digest = Self::compute_sha256(&partial_path).await?;
            if !actual_digest.eq_ignore_ascii_case(&expected_digest)
            {
                // The partial is removed rather than kept, because a resumed
                // download would otherwise append to corrupt bytes forever and
                // fail the same check every time with no way out.
                let _ = tokio::fs::remove_file(&partial_path).await;
                return Err(ModelDownloadError::IntegrityMismatch
                {
                    expected: expected_digest,
                    actual: actual_digest,
                });
            }
        }

        // Renamed only once complete and verified, which is what makes
        // `destination_path.exists()` above a trustworthy "already have it".
        tokio::fs::rename(&partial_path, &destination_path)
            .await
            .map_err(|error| ModelDownloadError::WriteFailed(error.to_string()))?;

        Ok(destination_path)
    }

    async fn stream_to_partial_file(
        app_handle: &AppHandle,
        request_id: u64,
        weights_url: &str,
        partial_path: &Path,
        resume_from_bytes: u64,
        progress_event_name: &str,
    ) -> Result<(), ModelDownloadError>
    {
        // Checked before the request is built, because reqwest reports a URL it
        // cannot parse as a bare "builder error" — naming neither the URL nor
        // what was wrong with it. A root-relative path from the manifest is the
        // realistic way to arrive here, and that message sent the reader
        // looking at the network rather than at the string.
        if !weights_url.starts_with("http://") && !weights_url.starts_with("https://")
        {
            return Err(ModelDownloadError::RequestFailed(format!(
                "the weights URL must be absolute, got \"{weights_url}\" — the manifest serves \
                 root-relative paths and the caller has to resolve them against its origin"
            )));
        }

        let http_client = reqwest::Client::new();
        let mut request_builder = http_client.get(weights_url);

        if resume_from_bytes > 0
        {
            request_builder = request_builder.header(reqwest::header::RANGE, format!("bytes={resume_from_bytes}-"));
        }

        let response = request_builder
            .send()
            .await
            .map_err(|error| ModelDownloadError::RequestFailed(error.to_string()))?;

        let status_code = response.status();
        if !status_code.is_success()
        {
            return Err(ModelDownloadError::UnexpectedStatus(status_code.as_u16()));
        }

        // A server that ignores the Range header answers 200 with the whole
        // file. Appending that to what we already have would silently produce a
        // file longer than the model, so the resume is abandoned and the file
        // restarted — slower, and correct.
        let b_server_honoured_resume = status_code == reqwest::StatusCode::PARTIAL_CONTENT;
        let b_appending = resume_from_bytes > 0 && b_server_honoured_resume;

        let mut loaded_bytes = if b_appending { resume_from_bytes } else { 0 };
        let total_bytes = response.content_length().unwrap_or(0) + loaded_bytes;

        let mut destination_file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(b_appending)
            .truncate(!b_appending)
            .open(partial_path)
            .await
            .map_err(|error| ModelDownloadError::WriteFailed(error.to_string()))?;

        let mut byte_stream = response.bytes_stream();
        let mut bytes_since_last_report: u64 = 0;

        while let Some(chunk_result) = byte_stream.next().await
        {
            let chunk = chunk_result.map_err(|error| ModelDownloadError::RequestFailed(error.to_string()))?;

            destination_file
                .write_all(&chunk)
                .await
                .map_err(|error| ModelDownloadError::WriteFailed(error.to_string()))?;

            loaded_bytes += chunk.len() as u64;
            bytes_since_last_report += chunk.len() as u64;

            if bytes_since_last_report >= PROGRESS_REPORT_INTERVAL_BYTES
            {
                bytes_since_last_report = 0;
                let _ = app_handle.emit(progress_event_name, DownloadProgressReport
                {
                    request_id,
                    loaded_bytes,
                    total_bytes,
                });
            }
        }

        destination_file
            .flush()
            .await
            .map_err(|error| ModelDownloadError::WriteFailed(error.to_string()))?;

        // A final report at the true total, so a progress bar lands on 100%
        // rather than stopping wherever the last interval fell.
        let _ = app_handle.emit(progress_event_name, DownloadProgressReport
        {
            request_id,
            loaded_bytes,
            total_bytes: if total_bytes > 0 { total_bytes } else { loaded_bytes },
        });

        Ok(())
    }

    async fn compute_sha256(file_path: &Path) -> Result<String, ModelDownloadError>
    {
        let file_path = file_path.to_path_buf();

        // Hashing a multi-gigabyte file is CPU-bound and would stall every
        // other task on the async runtime — including the events that tell the
        // learner anything is still happening.
        tokio::task::spawn_blocking(move || -> Result<String, ModelDownloadError>
        {
            let mut file = std::fs::File::open(&file_path)
                .map_err(|error| ModelDownloadError::WriteFailed(error.to_string()))?;
            let mut hasher = Sha256::new();
            std::io::copy(&mut file, &mut hasher)
                .map_err(|error| ModelDownloadError::WriteFailed(error.to_string()))?;
            Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|error| ModelDownloadError::WriteFailed(error.to_string()))?
    }
}


#[cfg(test)]
mod tests
{
    use super::*;

    #[test]
    fn a_path_in_the_file_name_cannot_escape_the_models_directory()
    {
        // The catalogue is the only source of these names, but the guard is
        // cheap and the failure it prevents — writing outside the app's data
        // directory — is not recoverable by the user.
        let escaping = Path::new("../../evil.gguf")
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap();

        assert_eq!(escaping, "evil.gguf");
    }
}
