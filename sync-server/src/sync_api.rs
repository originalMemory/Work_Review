use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::TimeZone;
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
) -> Result<Json<PushResponse>, (StatusCode, String)> {
    let database_error = |error: rusqlite::Error| {
        tracing::error!("同步数据库写入失败: {error}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "同步数据库写入失败".to_string(),
        )
    };
    let (accepted, duplicates) = state
        .db
        .upsert_activities(&req.activities, &state.data_dir)
        .map_err(database_error)?;
    let reports_accepted = state
        .db
        .upsert_daily_reports(&req.daily_reports)
        .map_err(database_error)?;
    let summaries_accepted = state
        .db
        .upsert_hourly_summaries(&req.hourly_summaries)
        .map_err(database_error)?;
    let categories_accepted = state
        .db
        .upsert_entity_categories(&req.entity_categories)
        .map_err(database_error)?;

    let device_name = if req.device_name.trim().is_empty() {
        req.device_id.clone()
    } else {
        req.device_name.clone()
    };
    state.db.upsert_device(&req.device_id, &device_name);

    let total_accepted = accepted + reports_accepted + summaries_accepted + categories_accepted;
    tracing::info!(
        "push from {}: {} activities ({} dup), {} reports, {} summaries, {} categories",
        req.device_id,
        accepted,
        duplicates,
        req.daily_reports.len(),
        req.hourly_summaries.len(),
        req.entity_categories.len()
    );

    Ok(Json(PushResponse {
        accepted: total_accepted,
        duplicates,
        server_timestamp: chrono::Local::now().timestamp(),
    }))
}

/// GET /api/sync/pull
pub async fn pull(
    State(state): State<AppState>,
    Query(q): Query<PullQuery>,
) -> Result<Json<PullResponse>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(500).min(2000);
    let exclude = q.exclude_device.as_deref();
    let database_error = |error: rusqlite::Error| {
        tracing::error!("同步数据库读取失败: {error}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "同步数据库读取失败".to_string(),
        )
    };

    let (activities, has_more, activity_cursor) = state
        .db
        .pull_activities(q.activity_since.unwrap_or(0), exclude, limit)
        .map_err(database_error)?;
    let (daily_reports, report_cursor) = state
        .db
        .pull_daily_reports(q.report_since.unwrap_or(0), exclude)
        .map_err(database_error)?;
    let (hourly_summaries, summary_cursor) = state
        .db
        .pull_hourly_summaries(q.summary_since.unwrap_or(0), exclude)
        .map_err(database_error)?;
    let (entity_categories, category_cursor) = state
        .db
        .pull_entity_categories(q.category_since.unwrap_or(0))
        .map_err(database_error)?;

    Ok(Json(PullResponse {
        activities,
        daily_reports,
        hourly_summaries,
        entity_categories,
        has_more,
        activity_cursor,
        report_cursor,
        summary_cursor,
        category_cursor,
        server_timestamp: chrono::Local::now().timestamp(),
    }))
}

/// 校验时间范围参数，返回错误消息（供测试复用）
fn validate_range(from: i64, to: i64) -> Result<(), &'static str> {
    if from < 0 {
        return Err("from 不能为负数");
    }
    if to < from {
        return Err("to 必须大于或等于 from");
    }
    Ok(())
}

/// GET /api/sync/range — 按指定时间段拉取记录（供 AI 分析/总结使用）。
/// 鉴权与数据结构均与 pull 一致；activities 按 timestamp 闭区间过滤，
/// 日报/小时摘要按 from/to 对应的本地日期过滤，分类缓存全量返回。
pub async fn pull_range(
    State(state): State<AppState>,
    Query(q): Query<RangeQuery>,
) -> Result<Json<RangeResponse>, (StatusCode, String)> {
    if let Err(message) = validate_range(q.from, q.to) {
        return Err((StatusCode::BAD_REQUEST, message.to_string()));
    }
    let limit = q.limit.unwrap_or(500).clamp(1, 2000);
    let offset = q.offset.unwrap_or(0).max(0);
    let device_id = q.device_id.as_deref();

    let database_error = |error: rusqlite::Error| {
        tracing::error!("时间段查询失败: {error}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "时间段查询失败".to_string(),
        )
    };

    let from_date = chrono::Local
        .timestamp_opt(q.from, 0)
        .single()
        .map(|dt| dt.date_naive().format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    let to_date = chrono::Local
        .timestamp_opt(q.to, 0)
        .single()
        .map(|dt| dt.date_naive().format("%Y-%m-%d").to_string())
        .unwrap_or_default();

    let (activities, total_activities) = state
        .db
        .query_activities_range(q.from, q.to, device_id, limit, offset)
        .map_err(database_error)?;
    let daily_reports = state
        .db
        .query_daily_reports_range(&from_date, &to_date, device_id)
        .map_err(database_error)?;
    let hourly_summaries = state
        .db
        .query_hourly_summaries_range(&from_date, &to_date, device_id)
        .map_err(database_error)?;
    let entity_categories = state
        .db
        .query_entity_categories_all()
        .map_err(database_error)?;

    let has_more = offset + (activities.len() as i64) < total_activities;
    tracing::info!(
        "range query [{}..{}] device={:?}: {} activities (total {total_activities}), {} reports, {} summaries, offset={offset} limit={limit}",
        q.from,
        q.to,
        device_id,
        activities.len(),
        daily_reports.len(),
        hourly_summaries.len(),
    );

    Ok(Json(RangeResponse {
        activities,
        daily_reports,
        hourly_summaries,
        entity_categories,
        has_more,
        offset,
        limit,
        total_activities,
        server_timestamp: chrono::Local::now().timestamp(),
    }))
}

/// PUT /api/sync/screenshot/{device_id}/{date}/{filename} — 单文件上传
pub async fn upload_screenshot(
    State(state): State<AppState>,
    Path((device_id, date, filename)): Path<(String, String, String)>,
    body: Bytes,
) -> StatusCode {
    if !sync_path_segment_ok(&device_id)
        || !sync_date_yyyy_mm_dd(&date)
        || !sync_path_segment_ok(&filename)
    {
        return StatusCode::BAD_REQUEST;
    }
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
    !s.is_empty() && !s.contains('/') && !s.contains('\\') && !s.contains("..")
}

fn sync_date_yyyy_mm_dd(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string() == s)
        .unwrap_or(false)
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
    let entries = std::fs::read_dir(&dir).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    for ent in entries.filter_map(|e| e.ok()) {
        let file_type = ent
            .file_type()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        if !file_type.is_file() {
            continue;
        }
        let fname = ent.file_name();
        let Some(fname) = fname.to_str() else {
            continue;
        };
        let lower = fname.to_ascii_lowercase();
        let is_image = lower.ends_with(".webp");
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
    if !sync_path_segment_ok(&device_id)
        || !sync_date_yyyy_mm_dd(&date)
        || !sync_path_segment_ok(&filename)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
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
    Ok(([(header::CONTENT_TYPE, "image/webp")], data))
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

#[cfg(test)]
mod tests {
    use super::{sync_date_yyyy_mm_dd, sync_path_segment_ok, validate_range};

    #[test]
    fn screenshot_route_rejects_traversal_segments() {
        assert!(sync_path_segment_ok("macbook-a1b2"));
        assert!(!sync_path_segment_ok("../secret"));
        assert!(!sync_path_segment_ok("device/name"));
        assert!(sync_date_yyyy_mm_dd("2026-08-03"));
        assert!(!sync_date_yyyy_mm_dd("2026-8-3"));
    }

    #[test]
    fn range_query_requires_valid_window() {
        assert!(validate_range(0, 0).is_ok());
        assert!(validate_range(1_752_710_400, 1_752_710_400 + 86_400).is_ok());
        assert!(validate_range(-1, 100).is_err());
        assert!(validate_range(200, 100).is_err());
        assert!(validate_range(100, 100).is_ok());
    }
    #[tokio::test]
    async fn screenshot_roundtrip_returns_webp_content_type() {
        use axum::{
            body::{to_bytes, Bytes},
            extract::{Path, State},
            http::{header, StatusCode},
            response::IntoResponse,
        };
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!(
            "work-review-sync-webp-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let state = Arc::new(super::ServerState {
            db: crate::db::Database::new(&dir),
            data_dir: dir.clone(),
        });
        let path = (
            "device-a".to_string(),
            "2026-11-13".to_string(),
            "shot.webp".to_string(),
        );
        let body = Bytes::from_static(b"webp roundtrip payload");
        assert_eq!(
            super::upload_screenshot(State(state.clone()), Path(path.clone()), body.clone()).await,
            StatusCode::CREATED
        );
        let response = super::download_screenshot(State(state.clone()), Path(path))
            .await
            .unwrap()
            .into_response();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/webp");
        assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), body);
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
