use crate::config::{SyncConfig, SyncScreenshotsMode};
use crate::database::{SyncActivity, SyncDailyReport, SyncEntityCategory, SyncHourlySummary};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

const PUSH_ACTIVITY_BATCH_SIZE: usize = 150;
const PULL_BATCH_SIZE: usize = 500;

static SYNC_RUN_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

#[derive(Debug, Serialize)]
struct PushRequest {
    device_id: String,
    device_name: String,
    activities: Vec<SyncActivity>,
    daily_reports: Vec<SyncDailyReport>,
    hourly_summaries: Vec<SyncHourlySummary>,
    entity_categories: Vec<SyncEntityCategory>,
}

#[derive(Debug, Deserialize)]
struct PushResponse {
    accepted: usize,
    duplicates: usize,
    #[allow(dead_code)]
    server_timestamp: i64,
}

#[derive(Debug, Deserialize)]
pub struct PullResponse {
    pub activities: Vec<SyncActivity>,
    pub daily_reports: Vec<SyncDailyReport>,
    pub hourly_summaries: Vec<SyncHourlySummary>,
    #[serde(default)]
    pub entity_categories: Vec<SyncEntityCategory>,
    pub has_more: bool,
    pub activity_cursor: i64,
    pub report_cursor: i64,
    pub summary_cursor: i64,
    pub category_cursor: i64,
    #[allow(dead_code)]
    pub server_timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub last_seen: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncRunResult {
    pub pushed: usize,
    pub pulled: usize,
    pub screenshots_pushed: usize,
    pub screenshots_pulled: usize,
    pub devices: Vec<DeviceInfo>,
    pub push_cursor: i64,
    pub pull_cursor: i64,
}

pub struct SyncService {
    server_url: String,
    token: String,
    device_id: String,
    device_name: String,
    client: reqwest::Client,
    data_dir: PathBuf,
}

enum ScreenshotDownloadResult {
    Downloaded,
    AlreadyPresent,
    MissingRemote,
}

impl SyncService {
    pub fn new(config: &SyncConfig, data_dir: &Path) -> Result<Self, String> {
        let server_url = config.server_url.trim().trim_end_matches('/').to_string();
        if !(server_url.starts_with("http://") || server_url.starts_with("https://")) {
            return Err("同步服务器地址必须以 http:// 或 https:// 开头".to_string());
        }
        if config.sync_token.trim().is_empty() {
            return Err("同步 Token 不能为空".to_string());
        }
        if config.device_id.trim().is_empty() {
            return Err("设备标识尚未初始化".to_string());
        }
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|error| format!("创建同步客户端失败: {error}"))?;
        Ok(Self {
            server_url,
            token: config.sync_token.clone(),
            device_id: config.device_id.clone(),
            device_name: config.device_name.clone(),
            client,
            data_dir: data_dir.to_path_buf(),
        })
    }

    fn authenticated(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.bearer_auth(&self.token)
    }

    async fn push_batch(
        &self,
        activities: Vec<SyncActivity>,
        reports: Vec<SyncDailyReport>,
        summaries: Vec<SyncHourlySummary>,
        categories: Vec<SyncEntityCategory>,
    ) -> Result<PushResponse, String> {
        let response = self
            .authenticated(
                self.client
                    .post(format!("{}/api/sync/push", self.server_url)),
            )
            .json(&PushRequest {
                device_id: self.device_id.clone(),
                device_name: self.device_name.clone(),
                activities,
                daily_reports: reports,
                hourly_summaries: summaries,
                entity_categories: categories,
            })
            .send()
            .await
            .map_err(|error| format!("推送同步数据失败: {error}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("推送同步数据返回 HTTP {status}: {body}"));
        }
        response
            .json()
            .await
            .map_err(|error| format!("解析推送响应失败: {error}"))
    }

    async fn push_data(
        &self,
        activities: Vec<SyncActivity>,
        reports: Vec<SyncDailyReport>,
        summaries: Vec<SyncHourlySummary>,
        categories: Vec<SyncEntityCategory>,
    ) -> Result<(usize, usize), String> {
        if activities.is_empty() {
            let response = self
                .push_batch(activities, reports, summaries, categories)
                .await?;
            return Ok((response.accepted, response.duplicates));
        }

        let chunk_count = activities.len().div_ceil(PUSH_ACTIVITY_BATCH_SIZE);
        let mut accepted = 0;
        let mut duplicates = 0;
        for (index, chunk) in activities.chunks(PUSH_ACTIVITY_BATCH_SIZE).enumerate() {
            let last = index + 1 == chunk_count;
            let response = self
                .push_batch(
                    chunk.to_vec(),
                    if last { reports.clone() } else { Vec::new() },
                    if last { summaries.clone() } else { Vec::new() },
                    if last { categories.clone() } else { Vec::new() },
                )
                .await?;
            accepted += response.accepted;
            duplicates += response.duplicates;
        }
        Ok((accepted, duplicates))
    }

    pub async fn pull_data(
        &self,
        activity_since: i64,
        report_since: i64,
        summary_since: i64,
        category_since: i64,
    ) -> Result<PullResponse, String> {
        let response = self
            .authenticated(
                self.client
                    .get(format!("{}/api/sync/pull", self.server_url)),
            )
            .query(&[
                ("activity_since", activity_since.to_string()),
                ("report_since", report_since.to_string()),
                ("summary_since", summary_since.to_string()),
                ("category_since", category_since.to_string()),
                ("exclude_device", self.device_id.clone()),
                ("limit", PULL_BATCH_SIZE.to_string()),
            ])
            .send()
            .await
            .map_err(|error| format!("拉取同步数据失败: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("拉取同步数据返回 HTTP {}", response.status()));
        }
        response
            .json()
            .await
            .map_err(|error| format!("解析拉取响应失败: {error}"))
    }

    pub async fn pull_devices(&self) -> Result<Vec<DeviceInfo>, String> {
        let response = self
            .authenticated(self.client.get(format!("{}/api/devices", self.server_url)))
            .send()
            .await
            .map_err(|error| format!("拉取设备列表失败: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("拉取设备列表返回 HTTP {}", response.status()));
        }
        response
            .json()
            .await
            .map_err(|error| format!("解析设备列表失败: {error}"))
    }

    async fn upload_screenshot(
        &self,
        relative_path: &str,
        thumbnail: bool,
    ) -> Result<bool, String> {
        let subpath = screenshot_subpath(relative_path)?;
        let local_path = self.data_dir.join("screenshots").join(&subpath);
        if !local_path.is_file() {
            return Ok(false);
        }
        let mut bytes = tokio::fs::read(&local_path)
            .await
            .map_err(|error| format!("读取截图失败 {}: {error}", local_path.display()))?;
        if thumbnail {
            bytes = resize_thumbnail(&bytes).unwrap_or(bytes);
        }
        let response = self
            .authenticated(self.client.put(format!(
                "{}/api/sync/screenshot/{}",
                self.server_url,
                subpath.to_string_lossy().replace('\\', "/")
            )))
            .header(reqwest::header::CONTENT_TYPE, "image/jpeg")
            .body(bytes)
            .send()
            .await
            .map_err(|error| format!("上传截图失败: {error}"))?;
        if response.status().is_success() {
            Ok(true)
        } else {
            Err(format!("上传截图返回 HTTP {}", response.status()))
        }
    }

    async fn download_screenshot(
        &self,
        relative_path: &str,
    ) -> Result<ScreenshotDownloadResult, String> {
        let subpath = screenshot_subpath(relative_path)?;
        let local_path = self.data_dir.join("screenshots").join(&subpath);
        if local_path.is_file() {
            return Ok(ScreenshotDownloadResult::AlreadyPresent);
        }
        let response = self
            .authenticated(self.client.get(format!(
                "{}/api/sync/screenshot/{}",
                self.server_url,
                subpath.to_string_lossy().replace('\\', "/")
            )))
            .send()
            .await
            .map_err(|error| format!("下载截图失败: {error}"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(ScreenshotDownloadResult::MissingRemote);
        }
        if !response.status().is_success() {
            return Err(format!("下载截图返回 HTTP {}", response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("读取截图响应失败: {error}"))?;
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("创建截图目录失败: {error}"))?;
        }
        tokio::fs::write(&local_path, bytes)
            .await
            .map_err(|error| format!("保存截图失败: {error}"))?;
        Ok(ScreenshotDownloadResult::Downloaded)
    }
}

fn screenshot_subpath(relative_path: &str) -> Result<PathBuf, String> {
    let normalized = relative_path.replace('\\', "/");
    let value = normalized
        .strip_prefix("screenshots/")
        .unwrap_or(&normalized);
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.components().count() != 3
    {
        return Err(format!("非法截图路径: {relative_path}"));
    }
    Ok(path.to_path_buf())
}

fn should_download_screenshot(
    relative_path: &str,
    retention_days: u32,
    today: chrono::NaiveDate,
) -> bool {
    let Ok(path) = screenshot_subpath(relative_path) else {
        return false;
    };
    if retention_days == 0 {
        return true;
    }
    let cutoff = today - chrono::Duration::days(i64::from(retention_days));
    path.components()
        .nth(1)
        .and_then(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .and_then(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        .is_some_and(|date| date >= cutoff)
}

pub async fn sync_once(state: &Arc<Mutex<crate::AppState>>) -> Result<SyncRunResult, String> {
    let _run_guard = SYNC_RUN_LOCK.lock().await;
    let (config, database, data_dir, config_path, retention_days) = {
        let guard = state.lock().map_err(|error| error.to_string())?;
        (
            guard.config.sync.clone(),
            guard.database.clone(),
            guard.data_dir.clone(),
            guard.config_path.clone(),
            guard.config.storage.screenshot_retention_days,
        )
    };
    if !config.enabled {
        return Err("同步未启用".to_string());
    }
    let service = SyncService::new(&config, &data_dir)?;

    let reports = database
        .get_sync_reports_since(0, &config.device_id)
        .map_err(|error| error.to_string())?;
    let summaries = database
        .get_sync_hourly_summaries_since(0, &config.device_id)
        .map_err(|error| error.to_string())?;
    let categories = database
        .get_sync_entity_categories_since(0)
        .map_err(|error| error.to_string())?;
    let mut screenshot_push_cursor = config.screenshot_push_cursor;
    let mut pending_screenshot_uploads = config.pending_screenshot_uploads.clone();
    let mut screenshots_pushed = 0;
    if !matches!(config.sync_screenshots_mode, SyncScreenshotsMode::None) {
        loop {
            let activities = database
                .get_sync_activities_since(screenshot_push_cursor, &config.device_id, 10_000)
                .map_err(|error| error.to_string())?;
            let activity_count = activities.len();
            pending_screenshot_uploads.extend(
                activities
                    .iter()
                    .map(|item| item.activity.screenshot_path.clone())
                    .filter(|value| !value.is_empty()),
            );
            screenshot_push_cursor = activities
                .last()
                .map(|item| item.sync_version)
                .unwrap_or(screenshot_push_cursor);
            if activity_count < 10_000 {
                break;
            }
        }
        pending_screenshot_uploads.sort();
        pending_screenshot_uploads.dedup();
        let mut remaining = Vec::new();
        for screenshot_path in pending_screenshot_uploads {
            if screenshot_subpath(&screenshot_path).is_err() {
                log::warn!("跳过非法同步截图路径: {screenshot_path}");
                continue;
            }
            if service
                .upload_screenshot(
                    &screenshot_path,
                    matches!(config.sync_screenshots_mode, SyncScreenshotsMode::Thumbnail),
                )
                .await?
            {
                screenshots_pushed += 1;
            } else {
                remaining.push(screenshot_path);
            }
        }
        pending_screenshot_uploads = remaining;
    }
    let mut activity_push_cursor = config.activity_push_cursor;
    let mut pushed = 0;
    let mut duplicates = 0;
    let mut first_push = true;
    loop {
        let activities = database
            .get_sync_activities_since(activity_push_cursor, &config.device_id, 10_000)
            .map_err(|error| error.to_string())?;
        let next_cursor = activities
            .last()
            .map(|item| item.sync_version)
            .unwrap_or(activity_push_cursor);
        let activity_count = activities.len();
        let (batch_pushed, batch_duplicates) = service
            .push_data(
                activities,
                if first_push {
                    reports.clone()
                } else {
                    Vec::new()
                },
                if first_push {
                    summaries.clone()
                } else {
                    Vec::new()
                },
                if first_push {
                    categories.clone()
                } else {
                    Vec::new()
                },
            )
            .await?;
        pushed += batch_pushed;
        duplicates += batch_duplicates;
        first_push = false;

        activity_push_cursor = next_cursor;
        if activity_count < 10_000 {
            break;
        }
    }
    log::info!("同步推送完成: accepted={pushed}, duplicates={duplicates}");

    let mut activity_pull_cursor = config.activity_pull_cursor;
    let mut report_pull_cursor = config.report_pull_cursor;
    let mut summary_pull_cursor = config.summary_pull_cursor;
    let mut category_pull_cursor = config.category_pull_cursor;
    let mut pulled = 0;
    let mut screenshots_to_download = config.pending_screenshot_downloads.clone();
    loop {
        let pull = service
            .pull_data(
                activity_pull_cursor,
                report_pull_cursor,
                summary_pull_cursor,
                category_pull_cursor,
            )
            .await?;
        let count = pull.activities.len()
            + pull.daily_reports.len()
            + pull.hourly_summaries.len()
            + pull.entity_categories.len();
        for activity in &pull.activities {
            database
                .upsert_sync_activity(activity)
                .map_err(|error| error.to_string())?;
            if !activity.activity.screenshot_path.is_empty() {
                screenshots_to_download.push(activity.activity.screenshot_path.clone());
            }
        }
        for report in &pull.daily_reports {
            database
                .upsert_sync_report(report)
                .map_err(|error| error.to_string())?;
        }
        for summary in &pull.hourly_summaries {
            database
                .upsert_sync_hourly_summary(summary)
                .map_err(|error| error.to_string())?;
        }
        for category in &pull.entity_categories {
            if database
                .upsert_sync_entity_category(category)
                .map_err(|error| error.to_string())?
            {
                if let Ok(mut cache) = crate::entity_category_cache().write() {
                    cache.insert(
                        category.entity_key.clone(),
                        (
                            category.base_category.clone(),
                            category.semantic_category.clone(),
                        ),
                    );
                }
            }
        }
        pulled += count;
        if pull.has_more && pull.activity_cursor <= activity_pull_cursor {
            return Err("同步活动拉取游标未前进".to_string());
        }
        activity_pull_cursor = activity_pull_cursor.max(pull.activity_cursor);
        report_pull_cursor = report_pull_cursor.max(pull.report_cursor);
        summary_pull_cursor = summary_pull_cursor.max(pull.summary_cursor);
        category_pull_cursor = category_pull_cursor.max(pull.category_cursor);
        if !pull.has_more {
            break;
        }
    }

    let today = chrono::Local::now().date_naive();
    let mut screenshots_pulled = 0;
    screenshots_to_download.sort();
    screenshots_to_download.dedup();
    if !matches!(config.sync_screenshots_mode, SyncScreenshotsMode::None) {
        let mut remaining = Vec::new();
        for screenshot_path in screenshots_to_download {
            let should_download =
                should_download_screenshot(&screenshot_path, retention_days, today);
            if !should_download {
                continue;
            }
            match service.download_screenshot(&screenshot_path).await? {
                ScreenshotDownloadResult::Downloaded => screenshots_pulled += 1,
                ScreenshotDownloadResult::AlreadyPresent => {}
                ScreenshotDownloadResult::MissingRemote => remaining.push(screenshot_path),
            }
        }
        screenshots_to_download = remaining;
    }

    let devices = service.pull_devices().await?;
    let now = chrono::Utc::now().timestamp();
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        guard.config.sync.last_push_timestamp = now;
        guard.config.sync.last_pull_timestamp = now;
        guard.config.sync.activity_push_cursor = activity_push_cursor;
        guard.config.sync.activity_pull_cursor = activity_pull_cursor;
        guard.config.sync.report_pull_cursor = report_pull_cursor;
        guard.config.sync.summary_pull_cursor = summary_pull_cursor;
        guard.config.sync.category_pull_cursor = category_pull_cursor;
        guard.config.sync.screenshot_push_cursor = screenshot_push_cursor;
        guard.config.sync.pending_screenshot_uploads = pending_screenshot_uploads;
        guard.config.sync.pending_screenshot_downloads = screenshots_to_download;
        guard
            .config
            .save(&config_path)
            .map_err(|error| error.to_string())?;
    }

    Ok(SyncRunResult {
        pushed,
        pulled,
        screenshots_pushed,
        screenshots_pulled,
        devices,
        push_cursor: activity_push_cursor,
        pull_cursor: activity_pull_cursor,
    })
}

pub async fn sync_background_task(state: Arc<Mutex<crate::AppState>>) {
    let mut last_attempt = None;
    loop {
        let (enabled, interval) = state
            .lock()
            .map(|guard| {
                (
                    guard.config.sync.enabled,
                    guard.config.sync.sync_interval_minutes.max(1),
                )
            })
            .unwrap_or((false, 1));

        if !enabled {
            last_attempt = None;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        }

        let interval = std::time::Duration::from_secs(u64::from(interval) * 60);
        let due = last_attempt
            .map(|attempt: tokio::time::Instant| attempt.elapsed() >= interval)
            .unwrap_or(true);
        if due {
            last_attempt = Some(tokio::time::Instant::now());
            if let Err(error) = sync_once(&state).await {
                log::warn!("后台同步失败: {error}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

fn resize_thumbnail(data: &[u8]) -> Option<Vec<u8>> {
    let image = image::load_from_memory(data).ok()?;
    let thumbnail = image.thumbnail(640, 480);
    let mut output = std::io::Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, image::ImageFormat::Jpeg)
        .ok()?;
    Some(output.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{screenshot_subpath, should_download_screenshot};

    #[test]
    fn screenshot_path_must_be_device_date_file() {
        assert!(screenshot_subpath("screenshots/mac-a/2026-08-03/120000.jpg").is_ok());
        assert!(screenshot_subpath("screenshots/../secret.txt").is_err());
        assert!(screenshot_subpath("/tmp/secret.jpg").is_err());
    }

    #[test]
    fn zero_retention_downloads_all_valid_screenshots() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 8, 3).unwrap();
        assert!(should_download_screenshot(
            "screenshots/device-a/2020-01-01/old.jpg",
            0,
            today,
        ));
        assert!(!should_download_screenshot("../old.jpg", 0, today));
    }

    #[test]
    fn finite_retention_skips_expired_screenshots() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 8, 3).unwrap();
        assert!(should_download_screenshot(
            "screenshots/device-a/2026-07-27/kept.jpg",
            7,
            today,
        ));
        assert!(!should_download_screenshot(
            "screenshots/device-a/2026-07-26/expired.jpg",
            7,
            today,
        ));
    }
}
