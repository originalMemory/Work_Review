use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Serialize;
use std::sync::Arc;

use crate::db::Database;
use crate::models::*;

pub type AppState = Arc<ServerState>;

pub struct ServerState {
    pub db: Database,
    pub data_dir: std::path::PathBuf,
}

/// POST /api/sync/push
pub async fn push(
    State(state): State<AppState>,
    Json(req): Json<PushRequest>,
) -> Json<PushResponse> {
    let (accepted, duplicates) = state
        .db
        .upsert_activities(&req.activities, &state.data_dir);
    state.db.upsert_daily_reports(&req.daily_reports);
    state.db.upsert_hourly_summaries(&req.hourly_summaries);

    let device_name = req
        .device_name
        .unwrap_or_else(|| req.device_id.clone());
    state.db.upsert_device(&req.device_id, &device_name);

    let total_accepted = accepted + req.daily_reports.len() + req.hourly_summaries.len();
    tracing::info!(
        "push from {}: {} activities ({} dup), {} reports, {} summaries",
        req.device_id,
        accepted,
        duplicates,
        req.daily_reports.len(),
        req.hourly_summaries.len()
    );

    Json(PushResponse {
        accepted: total_accepted,
        duplicates,
        server_timestamp: chrono::Local::now().timestamp(),
    })
}

/// GET /api/sync/pull
pub async fn pull(
    State(state): State<AppState>,
    Query(q): Query<PullQuery>,
) -> Json<PullResponse> {
    let since = q.since.unwrap_or(0);
    let limit = q.limit.unwrap_or(500).min(2000);
    let exclude = q.exclude_device.as_deref();

    let (activities, has_more) = state.db.pull_activities(since, exclude, limit);
    let daily_reports = state.db.pull_daily_reports(since, exclude);
    let hourly_summaries = state.db.pull_hourly_summaries(since, exclude);

    Json(PullResponse {
        activities,
        daily_reports,
        hourly_summaries,
        has_more,
        server_timestamp: chrono::Local::now().timestamp(),
    })
}

/// PUT /api/sync/screenshot/{device_id}/{date}/{filename} — 单文件上传
pub async fn upload_screenshot(
    State(state): State<AppState>,
    Path((device_id, date, filename)): Path<(String, String, String)>,
    body: Bytes,
) -> StatusCode {
    let dest = state
        .data_dir
        .join("screenshots")
        .join(&device_id)
        .join(&date)
        .join(&filename);

    if dest.exists() {
        if let Ok(meta) = std::fs::metadata(&dest) {
            if meta.len() == body.len() as u64 {
                return StatusCode::NO_CONTENT;
            }
        }
    }

    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    match std::fs::write(&dest, &body) {
        Ok(_) => StatusCode::CREATED,
        Err(e) => {
            tracing::warn!("write screenshot failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(Serialize)]
pub struct PruneScreenshotsResponse {
    pub deleted: usize,
    pub kept: usize,
}

fn sync_path_segment_ok(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains("..")
}

fn sync_date_yyyy_mm_dd(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// POST /api/sync/screenshot/prune/{device_id}/{date} — 删除该日目录下未被合并库引用的图片
pub async fn prune_screenshots_for_day(
    State(state): State<AppState>,
    Path((device_id, date)): Path<(String, String)>,
) -> Result<Json<PruneScreenshotsResponse>, StatusCode> {
    if !sync_path_segment_ok(&device_id) || !sync_date_yyyy_mm_dd(&date) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let keep = state.db.referenced_screenshot_filenames(&device_id, &date);
    let dir = state
        .data_dir
        .join("screenshots")
        .join(&device_id)
        .join(&date);

    if !dir.is_dir() {
        return Ok(Json(PruneScreenshotsResponse {
            deleted: 0,
            kept: 0,
        }));
    }

    let mut deleted = 0usize;
    let mut kept = 0usize;
    let entries =
        std::fs::read_dir(&dir).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for ent in entries.filter_map(|e| e.ok()) {
        let file_type = ent.file_type().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !file_type.is_file() {
            continue;
        }
        let fname = ent.file_name();
        let Some(fname) = fname.to_str() else {
            continue;
        };
        let lower = fname.to_ascii_lowercase();
        let is_image = lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".png")
            || lower.ends_with(".webp");
        if !is_image {
            continue;
        }
        if keep.contains(fname) {
            kept += 1;
        } else if std::fs::remove_file(ent.path()).is_ok() {
            deleted += 1;
        }
    }

    if deleted > 0 {
        tracing::info!(
            "screenshot prune {}/{}: deleted={deleted} kept={kept}",
            device_id,
            date
        );
    }

    Ok(Json(PruneScreenshotsResponse { deleted, kept }))
}

/// GET /api/sync/screenshot/{device_id}/{date}/{filename} — 下载截图
pub async fn download_screenshot(
    State(state): State<AppState>,
    Path((device_id, date, filename)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, StatusCode> {
    let path = state
        .data_dir
        .join("screenshots")
        .join(&device_id)
        .join(&date)
        .join(&filename);

    if !path.exists() {
        return Err(StatusCode::NOT_FOUND);
    }

    let data = std::fs::read(&path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg")], data))
}

/// POST /api/devices/register
pub async fn register_device(
    State(state): State<AppState>,
    Json(req): Json<RegisterDeviceRequest>,
) -> StatusCode {
    state.db.upsert_device(&req.device_id, &req.device_name);
    StatusCode::OK
}

/// GET /api/devices
pub async fn list_devices(State(state): State<AppState>) -> Json<Vec<DeviceInfo>> {
    Json(state.db.list_devices())
}
