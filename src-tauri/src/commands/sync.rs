use crate::config::SyncScreenshotsMode;
use crate::database::SyncDailyReport;
use crate::error::AppError;
use crate::sync::{DeviceInfo, SyncRunResult, SyncService};
use crate::AppState;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct SyncStatusInfo {
    pub enabled: bool,
    pub server_url: String,
    pub device_id: String,
    pub device_name: String,
    pub last_push_timestamp: i64,
    pub last_pull_timestamp: i64,
    pub sync_interval_minutes: u32,
    pub sync_screenshots_mode: &'static str,
}

#[tauri::command]
pub fn get_sync_status(state: State<'_, Arc<Mutex<AppState>>>) -> Result<SyncStatusInfo, AppError> {
    let guard = state
        .lock()
        .map_err(|error| AppError::Unknown(error.to_string()))?;
    let sync = &guard.config.sync;
    let mode = match sync.sync_screenshots_mode {
        SyncScreenshotsMode::Full => "full",
        SyncScreenshotsMode::Thumbnail => "thumbnail",
        SyncScreenshotsMode::None => "none",
    };
    Ok(SyncStatusInfo {
        enabled: sync.enabled,
        server_url: sync.server_url.clone(),
        device_id: sync.device_id.clone(),
        device_name: sync.device_name.clone(),
        last_push_timestamp: sync.last_push_timestamp,
        last_pull_timestamp: sync.last_pull_timestamp,
        sync_interval_minutes: sync.sync_interval_minutes,
        sync_screenshots_mode: mode,
    })
}

#[tauri::command]
pub async fn sync_now(state: State<'_, Arc<Mutex<AppState>>>) -> Result<SyncRunResult, AppError> {
    crate::sync::sync_once(state.inner())
        .await
        .map_err(AppError::Unknown)
}

#[tauri::command]
pub async fn get_known_devices(
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Vec<DeviceInfo>, AppError> {
    let (local_ids, sync_config, data_dir) = {
        let guard = state
            .lock()
            .map_err(|error| AppError::Unknown(error.to_string()))?;
        (
            guard.database.get_known_device_ids()?,
            guard.config.sync.clone(),
            guard.data_dir.clone(),
        )
    };
    let mut devices: Vec<DeviceInfo> = local_ids
        .into_iter()
        .map(|device_id| DeviceInfo {
            device_name: if device_id == sync_config.device_id {
                sync_config.device_name.clone()
            } else {
                device_id.clone()
            },
            device_id,
            last_seen: 0,
        })
        .collect();

    if sync_config.enabled {
        if let Ok(service) = SyncService::new(&sync_config, &data_dir) {
            if let Ok(remote) = service.pull_devices().await {
                for item in remote {
                    if let Some(existing) = devices
                        .iter_mut()
                        .find(|value| value.device_id == item.device_id)
                    {
                        existing.device_name = item.device_name;
                        existing.last_seen = item.last_seen;
                    } else {
                        devices.push(item);
                    }
                }
            }
        }
    }
    devices.sort_by(|left, right| {
        left.device_name
            .cmp(&right.device_name)
            .then_with(|| left.device_id.cmp(&right.device_id))
    });
    Ok(devices)
}

#[tauri::command]
pub fn get_reports_by_date(
    date: String,
    locale: Option<String>,
    device_id: Option<String>,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Vec<SyncDailyReport>, AppError> {
    let guard = state
        .lock()
        .map_err(|error| AppError::Unknown(error.to_string()))?;
    guard
        .database
        .get_reports_by_date(&date, locale.as_deref(), device_id.as_deref())
}

#[tauri::command]
pub fn set_ui_selected_device_id(
    device_id: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), AppError> {
    let config = {
        let mut guard = state
            .lock()
            .map_err(|error| AppError::Unknown(error.to_string()))?;
        guard.config.ui_selected_device_id = device_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        guard.config.save(&guard.config_path)?;
        guard.config.clone()
    };
    crate::emit_config_changed(&app, &config);
    Ok(())
}
