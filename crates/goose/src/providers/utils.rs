// Modified for Local AI Desktop: bounded diagnostics; log failures must not abort inference.
use crate::config::paths::Paths;
use anyhow::Result;
use fs2::FileExt;
use goose_providers::request_log::{install_logger, RequestLogHandle, RequestLogger};
use serde_json::Value;
use std::error::Error;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use uuid::Uuid;

pub fn filter_extensions_from_system_prompt(system: &str) -> String {
    let Some(extensions_start) = system.find("# Extensions") else {
        return system.to_string();
    };

    let Some(after_extensions) = system.get(extensions_start + 1..) else {
        return system.to_string();
    };

    if let Some(next_section_pos) = after_extensions.find("\n# ") {
        let Some(before) = system.get(..extensions_start) else {
            return system.to_string();
        };
        let Some(after) = system.get(extensions_start + next_section_pos + 1..) else {
            return system.to_string();
        };
        format!("{}{}", before.trim_end(), after)
    } else {
        system
            .get(..extensions_start)
            .map(|s| s.trim_end().to_string())
            .unwrap_or_else(|| system.to_string())
    }
}

/// Extract the model name from a JSON object. Common with most providers to have this top level attribute.
pub fn get_model(data: &Value) -> String {
    if let Some(model) = data.get("model") {
        if let Some(model_str) = model.as_str() {
            model_str.to_string()
        } else {
            "Unknown".to_string()
        }
    } else {
        "Unknown".to_string()
    }
}

pub const LOGS_TO_KEEP: usize = 10;
const REQUEST_LOG_MAX_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_LOG_RETENTION: std::time::Duration = std::time::Duration::from_secs(7 * 86400);

fn prune_request_logs(dir: &std::path::Path) -> Result<()> {
    let mut entries = Vec::new();
    let mut total = 0u64;
    for entry in fs_err::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("llm_request.") || !name.ends_with(".jsonl") {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        total += metadata.len();
        entries.push((metadata.modified()?, metadata.len(), entry.path()));
    }
    entries.sort_by_key(|entry| entry.0);
    for (modified, size, path) in entries {
        if modified.elapsed().unwrap_or_default() <= REQUEST_LOG_RETENTION
            && total <= 128 * 1024 * 1024
        {
            continue;
        }
        if let Ok(file) = File::options().read(true).write(true).open(&path) {
            if file.try_lock_exclusive().is_ok() && fs_err::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
    Ok(())
}

static INIT_LOGGER: OnceLock<Result<()>> = OnceLock::new();

pub fn init_goose_request_log() -> Result<()> {
    INIT_LOGGER
        .get_or_init(|| Ok(install_logger(RequestLog::new(LOGS_TO_KEEP)?)?))
        .as_ref()
        .map_err(|e| anyhow::anyhow!("failed to set up logger: {}", e))?;
    Ok(())
}

pub struct RequestLog {
    logs_to_keep: usize,
}

impl RequestLog {
    pub fn new(logs_to_keep: usize) -> Result<Self> {
        let logs_dir = Paths::in_state_dir("logs");
        if let Err(error) = fs_err::create_dir_all(&logs_dir) {
            tracing::warn!(%error, "Request diagnostic directory unavailable");
        }
        Ok(Self { logs_to_keep })
    }
}

struct FileLogHandle {
    writer: Option<BufWriter<File>>,
    temp_path: PathBuf,
    logs_to_keep: usize,
    bytes: usize,
    truncated: bool,
}

impl RequestLogger for RequestLog {
    fn start(&self) -> Result<Box<dyn RequestLogHandle>, Box<dyn Error + Send + Sync>> {
        let logs_dir = Paths::in_state_dir("logs");
        if let Err(error) = fs_err::create_dir_all(&logs_dir) {
            tracing::warn!(%error, "Request diagnostic directory unavailable");
        }

        if let Err(error) = prune_request_logs(&logs_dir) {
            tracing::warn!(%error, "Cannot prune request diagnostics");
        }
        let request_id = Uuid::new_v4();
        let temp_name = format!("llm_request.{request_id}.jsonl");
        let temp_path = logs_dir.join(PathBuf::from(temp_name));

        let writer = match File::options()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => match file.try_lock_exclusive() {
                Ok(()) => Some(BufWriter::new(file)),
                Err(error) => {
                    tracing::warn!(%error, "Request log lock unavailable");
                    None
                }
            },
            Err(error) => {
                tracing::warn!(%error, "Request diagnostics unavailable; inference continues");
                None
            }
        };
        Ok(Box::new(FileLogHandle {
            writer,
            temp_path,
            logs_to_keep: self.logs_to_keep,
            bytes: 0,
            truncated: false,
        }))
    }
}

impl RequestLogHandle for FileLogHandle {
    fn write(&mut self, s: &str) -> Result<(), Box<dyn Error + Send + Sync>> {
        if self.truncated || self.writer.is_none() {
            return Ok(());
        }
        let record = if self.bytes.saturating_add(s.len() + 1) > REQUEST_LOG_MAX_BYTES {
            self.truncated = true;
            r#"{"diagnostic_truncated":true,"limit_bytes":8388608}"#
        } else {
            s
        };
        if let Some(writer) = self.writer.as_mut() {
            if let Err(error) = writeln!(writer, "{}", record).and_then(|_| writer.flush()) {
                tracing::warn!(%error, "Request diagnostic write stopped; inference continues");
                self.writer = None;
            } else {
                self.bytes += record.len() + 1;
            }
        }
        Ok(())
    }
}

impl FileLogHandle {
    fn finish(&mut self) -> Result<()> {
        if let Some(mut writer) = self.writer.take() {
            writer.flush()?;
            let logs_dir = Paths::in_state_dir("logs");
            let log_path = |i| logs_dir.join(format!("llm_request.{}.jsonl", i));

            if self.logs_to_keep == 0 {
                fs_err::remove_file(&self.temp_path)?;
                return Ok(());
            }

            for i in (0..self.logs_to_keep.saturating_sub(1)).rev() {
                let _ = fs_err::rename(log_path(i), log_path(i + 1));
            }

            fs_err::rename(&self.temp_path, log_path(0))?;
        }
        Ok(())
    }
}

impl Drop for FileLogHandle {
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        let _ = self.finish();
    }
}

#[cfg(test)]
mod bounded_request_log_tests {
    use super::*;
    #[test]
    fn oversized_context_does_not_grow_the_log_or_abort_inference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("request.jsonl");
        let mut handle = FileLogHandle {
            writer: Some(BufWriter::new(File::create(&path).unwrap())),
            temp_path: path.clone(),
            logs_to_keep: 10,
            bytes: 0,
            truncated: false,
        };
        handle
            .write(&"x".repeat(REQUEST_LOG_MAX_BYTES + 1))
            .unwrap();
        handle.write("another context").unwrap();
        assert!(std::fs::metadata(path).unwrap().len() < 128);
        assert!(handle.truncated);
        // Avoid rotating into global state during this isolated unit test.
        handle.writer.take();
    }
    #[test]
    fn unavailable_diagnostic_writer_is_non_fatal() {
        let mut handle = FileLogHandle {
            writer: None,
            temp_path: PathBuf::new(),
            logs_to_keep: 10,
            bytes: 0,
            truncated: false,
        };
        handle.write("inference can continue").unwrap();
    }
}
