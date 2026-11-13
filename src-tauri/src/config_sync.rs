//! 常用应用配置的 WebDAV 同步（最后写入获胜）。
//!
//! 只在远程存储提供商为 WebDAV 且用户打开 `sync_app_config` 时生效。
//! 本机端口、窗口位置、开机自启、导出目录等不覆盖。

use crate::commands::persist_app_config;
use crate::remote_upload::{pull_app_config_bytes, push_app_config_bytes, should_sync_app_config};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use work_review_core::config::AppConfig;
use work_review_core::error::AppError;

const ENVELOPE_FORMAT: u32 = 1;

#[derive(Serialize, Deserialize)]
struct SyncedConfigEnvelope {
    format: u32,
    synced_at: u64,
    config: AppConfig,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

pub fn stamp_local_sync(config: &mut AppConfig) {
    if should_sync_app_config(&config.remote_storage) {
        config.config_synced_at = now_ms().max(1);
    }
}

pub fn spawn_push(config: AppConfig) {
    if !should_sync_app_config(&config.remote_storage) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = push_now(&config).await {
            log::warn!("WebDAV 配置同步上传失败: {error}");
        }
    });
}

async fn push_now(config: &AppConfig) -> Result<(), AppError> {
    let envelope = SyncedConfigEnvelope {
        format: ENVELOPE_FORMAT,
        synced_at: config.config_synced_at.max(1),
        config: config.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&envelope)
        .map_err(|error| AppError::Unknown(format!("序列化同步配置失败: {error}")))?;
    push_app_config_bytes(&config.remote_storage, bytes).await?;
    log::info!("常用配置已上传到 WebDAV");
    Ok(())
}

pub fn spawn_pull_on_startup(app: AppHandle, state: Arc<Mutex<AppState>>) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = pull_and_apply(app, state).await {
            log::warn!("WebDAV 配置同步下载失败: {error}");
        }
    });
}

async fn pull_and_apply(app: AppHandle, state: Arc<Mutex<AppState>>) -> Result<(), AppError> {
    let remote_storage = {
        let guard = state
            .lock()
            .map_err(|error| AppError::Unknown(error.to_string()))?;
        if !should_sync_app_config(&guard.config.remote_storage) {
            return Ok(());
        }
        guard.config.remote_storage.clone()
    };
    let Some(bytes) = pull_app_config_bytes(&remote_storage).await? else {
        return Ok(());
    };
    let envelope: SyncedConfigEnvelope = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::Unknown(format!("解析远端配置失败: {error}")))?;
    if envelope.format != ENVELOPE_FORMAT {
        return Err(AppError::Unknown(format!(
            "不支持的配置同步格式: {}",
            envelope.format
        )));
    }

    let local_synced_at = {
        let guard = state
            .lock()
            .map_err(|error| AppError::Unknown(error.to_string()))?;
        guard.config.config_synced_at
    };
    if envelope.synced_at <= local_synced_at {
        return Ok(());
    }

    let mut merged = {
        let guard = state
            .lock()
            .map_err(|error| AppError::Unknown(error.to_string()))?;
        guard.config.clone()
    };
    merged.apply_synced_remote(envelope.config);
    merged.config_synced_at = envelope.synced_at;
    persist_app_config(merged, app, &state)?;
    log::info!("已从 WebDAV 应用更新的常用配置");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_upload::should_sync_app_config;
    use work_review_core::config::{RemoteStorageProvider, WebDavConfig};

    #[test]
    fn 同步信封应能往返() {
        let envelope = SyncedConfigEnvelope {
            format: ENVELOPE_FORMAT,
            synced_at: 42,
            config: AppConfig::default(),
        };
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let parsed: SyncedConfigEnvelope = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.format, 1);
        assert_eq!(parsed.synced_at, 42);
    }

    #[test]
    fn 仅webdav且打开开关才同步() {
        let mut config = AppConfig::default().remote_storage;
        assert!(!should_sync_app_config(&config));
        config.provider = RemoteStorageProvider::WebDav;
        config.webdav = WebDavConfig {
            url: "https://dav.example.com/dav".to_string(),
            ..WebDavConfig::default()
        };
        config.sync_app_config = true;
        assert!(should_sync_app_config(&config));
    }
}
