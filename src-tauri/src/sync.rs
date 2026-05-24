use crate::config::{SyncConfig, SyncScreenshotsMode};
use crate::database::{Activity, DailyReport, Database, HourlySummary};

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 统一为正斜杠并去掉 `screenshots/` 前缀，得到 PUT/GET API 子路径 `device_id/date/filename`。
fn screenshot_api_subpath(rel_path: &str) -> String {
    let normalized = rel_path.replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("screenshots/") {
        rest.to_string()
    } else {
        normalized
    }
}

// ─── 与 sync-server 共用的数据结构 ───

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncActivity {
    pub uuid: String,
    pub device_id: String,
    pub timestamp: i64,
    pub app_name: String,
    pub window_title: String,
    pub screenshot_path: String,
    #[serde(default)]
    pub ocr_text: Option<String>,
    pub category: String,
    pub duration: i64,
    #[serde(default)]
    pub browser_url: Option<String>,
    #[serde(default)]
    pub executable_path: Option<String>,
    #[serde(default)]
    pub semantic_category: Option<String>,
    #[serde(default)]
    pub semantic_confidence: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncDailyReport {
    pub date: String,
    pub device_id: String,
    pub content: String,
    pub ai_mode: String,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncHourlySummary {
    pub date: String,
    pub hour: i32,
    pub device_id: String,
    pub summary: String,
    pub main_apps: String,
    pub activity_count: i32,
    pub total_duration: i64,
    #[serde(default)]
    pub representative_screenshots: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
struct PushRequest {
    device_id: String,
    device_name: Option<String>,
    activities: Vec<SyncActivity>,
    daily_reports: Vec<SyncDailyReport>,
    hourly_summaries: Vec<SyncHourlySummary>,
}

#[derive(Debug, Deserialize)]
pub struct PushResponse {
    pub accepted: usize,
    pub duplicates: usize,
    /// 服务端响应时刻（客户端游标已改为事件时间，此字段仅保留兼容 JSON）
    #[allow(dead_code)]
    pub server_timestamp: i64,
}

#[derive(Debug, Deserialize)]
pub struct PullResponse {
    pub activities: Vec<SyncActivity>,
    pub daily_reports: Vec<SyncDailyReport>,
    pub hourly_summaries: Vec<SyncHourlySummary>,
    pub has_more: bool,
    /// 同上，pull 游标以本批活动/摘要的事件时间为准
    #[allow(dead_code)]
    pub server_timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub last_seen: i64,
}

/// 单次 push 请求中的活动条数上限，避免 JSON 体超过服务端/反向代理 body 限制。
pub const PUSH_ACTIVITY_BATCH_SIZE: usize = 150;

/// 截图上传进度日志间隔（每 N 张输出一次）。
const PUSH_SCREENSHOT_LOG_EVERY: usize = 50;

// ─── SyncService（仅做 HTTP 通信，不持有 DB） ───

pub struct SyncService {
    server_url: String,
    token: String,
    device_id: String,
    device_name: String,
    client: reqwest::Client,
    data_dir: PathBuf,
}

impl SyncService {
    pub fn new(config: &SyncConfig, data_dir: &Path) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_default();

        Self {
            server_url: config.server_url.trim_end_matches('/').to_string(),
            token: config.sync_token.clone(),
            device_id: config.device_id.clone(),
            device_name: config.device_name.clone(),
            client,
            data_dir: data_dir.to_path_buf(),
        }
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// 推送数据到服务端（纯 HTTP，不涉及 DB）。活动较多时自动分批，避免请求体超限。
    pub async fn push_data(
        &self,
        activities: Vec<SyncActivity>,
        reports: Vec<SyncDailyReport>,
        summaries: Vec<SyncHourlySummary>,
    ) -> std::result::Result<PushResponse, String> {
        let total = activities.len() + reports.len() + summaries.len();
        if total == 0 {
            return Ok(PushResponse {
                accepted: 0,
                duplicates: 0,
                server_timestamp: chrono::Local::now().timestamp(),
            });
        }

        let mut accepted_total = 0usize;
        let mut duplicates_total = 0usize;
        let mut server_timestamp = chrono::Local::now().timestamp();

        if activities.is_empty() {
            log::info!(
                "push_data 开始: 活动 0 条, 日报 {} 份, 摘要 {} 条（单批）",
                reports.len(),
                summaries.len()
            );
            let resp = self
                .push_data_batch(&[], &reports, &summaries)
                .await?;
            log::info!(
                "push_data 完成: accepted={}, duplicates={}",
                resp.accepted,
                resp.duplicates
            );
            return Ok(resp);
        }

        let chunks: Vec<&[SyncActivity]> = activities
            .chunks(PUSH_ACTIVITY_BATCH_SIZE)
            .collect();
        let batch_total = chunks.len();
        let last = batch_total - 1;
        log::info!(
            "push_data 开始: 活动 {} 条, 日报 {} 份, 摘要 {} 条, 分 {} 批（每批最多 {} 条活动）",
            activities.len(),
            reports.len(),
            summaries.len(),
            batch_total,
            PUSH_ACTIVITY_BATCH_SIZE
        );
        for (idx, chunk) in chunks.iter().enumerate() {
            let batch_reports = if idx == last { reports.as_slice() } else { &[] };
            let batch_summaries = if idx == last { summaries.as_slice() } else { &[] };
            log::info!(
                "push_data 批次 {}/{} 上传中: 活动 {} 条, 日报 {} 份, 摘要 {} 条",
                idx + 1,
                batch_total,
                chunk.len(),
                batch_reports.len(),
                batch_summaries.len()
            );
            let resp = self
                .push_data_batch(chunk, batch_reports, batch_summaries)
                .await?;
            accepted_total += resp.accepted;
            duplicates_total += resp.duplicates;
            server_timestamp = resp.server_timestamp;
            log::info!(
                "push_data 批次 {}/{} 完成: accepted={}, duplicates={}",
                idx + 1,
                batch_total,
                resp.accepted,
                resp.duplicates
            );
        }

        log::info!(
            "push_data 全部完成: accepted={}, duplicates={}, 共 {} 批",
            accepted_total,
            duplicates_total,
            batch_total
        );

        Ok(PushResponse {
            accepted: accepted_total,
            duplicates: duplicates_total,
            server_timestamp,
        })
    }

    async fn push_data_batch(
        &self,
        activities: &[SyncActivity],
        reports: &[SyncDailyReport],
        summaries: &[SyncHourlySummary],
    ) -> std::result::Result<PushResponse, String> {
        let req_body = PushRequest {
            device_id: self.device_id.clone(),
            device_name: Some(self.device_name.clone()),
            activities: activities.to_vec(),
            daily_reports: reports.to_vec(),
            hourly_summaries: summaries.to_vec(),
        };

        let resp = self
            .client
            .post(format!("{}/api/sync/push", self.server_url))
            .header("Authorization", self.auth_header())
            .json(&req_body)
            .send()
            .await
            .map_err(|e| format!("push network error: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("push failed: {body}"));
        }

        resp.json::<PushResponse>()
            .await
            .map_err(|e| format!("push parse error: {e}"))
    }

    /// 推送截图到服务端（逐文件 PUT 二进制 body）
    pub async fn push_screenshots(
        &self,
        screenshot_paths: &[String],
        mode: SyncScreenshotsMode,
    ) -> std::result::Result<usize, String> {
        if matches!(mode, SyncScreenshotsMode::None) || screenshot_paths.is_empty() {
            return Ok(0);
        }
        let total = screenshot_paths.len();
        log::info!(
            "push_screenshots 开始: 共 {} 张, mode={:?}（每 {} 张输出进度）",
            total,
            mode,
            PUSH_SCREENSHOT_LOG_EVERY
        );

        let mut saved = 0usize;
        let mut skipped = 0usize;
        let mut missing = 0usize;
        let mut failed = 0usize;

        for (index, rel_path) in screenshot_paths.iter().enumerate() {
            let done = index + 1;
            let normalized = rel_path.replace('\\', "/");
            let clean = screenshot_api_subpath(rel_path);
            let abs_path = self.data_dir.join(Path::new(&normalized));
            if !abs_path.exists() {
                missing += 1;
                continue;
            }

            let file_data = match tokio::fs::read(&abs_path).await {
                Ok(d) => d,
                Err(_) => { failed += 1; continue; }
            };

            let file_data = if matches!(mode, SyncScreenshotsMode::Thumbnail) {
                resize_thumbnail(&file_data).unwrap_or(file_data)
            } else {
                file_data
            };

            let url = format!("{}/api/sync/screenshot/{}", self.server_url, clean);
            match self
                .client
                .put(&url)
                .header("Authorization", self.auth_header())
                .header("Content-Type", "image/jpeg")
                .body(file_data)
                .send()
                .await
            {
                Ok(resp) => match resp.status().as_u16() {
                    201 => saved += 1,
                    204 => skipped += 1,
                    s => {
                        failed += 1;
                        if failed <= 3 {
                            log::warn!("push_screenshot: {} -> {}", clean, s);
                        }
                    }
                },
                Err(e) => {
                    failed += 1;
                    if failed <= 3 {
                        log::warn!("push_screenshot: {} -> {e}", clean);
                    }
                }
            }

            if done == 1 || done == total || done % PUSH_SCREENSHOT_LOG_EVERY == 0 {
                log::info!(
                    "push_screenshots 进度 {done}/{total}: saved={saved}, skipped={skipped}, missing={missing}, failed={failed}"
                );
            }
        }

        log::info!(
            "push_screenshots 完成 {total}/{total}: saved={saved}, skipped={skipped}, missing={missing}, failed={failed}"
        );
        Ok(saved)
    }

    /// 从服务端拉取增量数据
    pub async fn pull_data(
        &self,
        since: i64,
    ) -> std::result::Result<PullResponse, String> {
        let resp = self
            .client
            .get(format!("{}/api/sync/pull", self.server_url))
            .header("Authorization", self.auth_header())
            .query(&[
                ("since", since.to_string()),
                ("exclude_device", self.device_id.clone()),
                ("limit", "500".to_string()),
            ])
            .send()
            .await
            .map_err(|e| format!("pull network error: {e}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("pull failed: {body}"));
        }

        resp.json::<PullResponse>()
            .await
            .map_err(|e| format!("pull parse error: {e}"))
    }

    /// 下载单个截图，已存在则跳过，返回本地路径
    pub async fn download_screenshot(
        &self,
        screenshot_path: &str,
    ) -> std::result::Result<PathBuf, String> {
        let clean = screenshot_api_subpath(screenshot_path);
        let local_path = self
            .data_dir
            .join("screenshots")
            .join(Path::new(&clean));
        if local_path.exists() {
            return Ok(local_path);
        }

        let url = format!("{}/api/sync/screenshot/{}", self.server_url, clean);

        let resp = self
            .client
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await
            .map_err(|e| format!("download screenshot error: {e}"))?;

        if !resp.status().is_success() {
            return Err(format!("download screenshot failed: {}", resp.status()));
        }

        let data = resp
            .bytes()
            .await
            .map_err(|e| format!("read screenshot bytes error: {e}"))?;

        if let Some(parent) = local_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&local_path, &data)
            .map_err(|e| format!("write screenshot error: {e}"))?;

        Ok(local_path)
    }

    /// 拉取设备列表
    pub async fn pull_devices(&self) -> std::result::Result<Vec<DeviceInfo>, String> {
        let resp = self
            .client
            .get(format!("{}/api/devices", self.server_url))
            .header("Authorization", self.auth_header())
            .send()
            .await
            .map_err(|e| format!("pull devices error: {e}"))?;

        if !resp.status().is_success() {
            return Err("pull devices failed".to_string());
        }

        resp.json::<Vec<DeviceInfo>>()
            .await
            .map_err(|e| format!("parse devices error: {e}"))
    }
}

// ─── 转换辅助 ───

pub fn activities_to_sync(activities: &[Activity]) -> Vec<SyncActivity> {
    activities
        .iter()
        .filter_map(|a| {
            let uuid = a.uuid.as_ref()?;
            Some(SyncActivity {
                uuid: uuid.clone(),
                device_id: a.device_id.clone(),
                timestamp: a.timestamp,
                app_name: a.app_name.clone(),
                window_title: a.window_title.clone(),
                screenshot_path: a.screenshot_path.replace('\\', "/"),
                ocr_text: a.ocr_text.clone(),
                category: a.category.clone(),
                duration: a.duration,
                browser_url: a.browser_url.clone(),
                executable_path: a.executable_path.clone(),
                semantic_category: a.semantic_category.clone(),
                semantic_confidence: a.semantic_confidence,
            })
        })
        .collect()
}

pub fn reports_to_sync(reports: &[DailyReport]) -> Vec<SyncDailyReport> {
    reports
        .iter()
        .map(|r| SyncDailyReport {
            date: r.date.clone(),
            device_id: r.device_id.clone(),
            content: r.content.clone(),
            ai_mode: r.ai_mode.clone(),
            model_name: r.model_name.clone(),
            fallback_reason: r.fallback_reason.clone(),
            created_at: r.created_at,
        })
        .collect()
}

pub fn summaries_to_sync(summaries: &[HourlySummary]) -> Vec<SyncHourlySummary> {
    summaries
        .iter()
        .map(|s| SyncHourlySummary {
            date: s.date.clone(),
            hour: s.hour,
            device_id: s.device_id.clone(),
            summary: s.summary.clone(),
            main_apps: s.main_apps.clone(),
            activity_count: s.activity_count,
            total_duration: s.total_duration,
            representative_screenshots: s.representative_screenshots.clone(),
            created_at: s.created_at,
        })
        .collect()
}

pub fn upsert_pulled_data(
    db: &Database,
    pull: &PullResponse,
) {
    for sa in &pull.activities {
        let activity = Activity {
            id: None,
            timestamp: sa.timestamp,
            app_name: sa.app_name.clone(),
            window_title: sa.window_title.clone(),
            screenshot_path: sa.screenshot_path.clone(),
            ocr_text: sa.ocr_text.clone(),
            category: sa.category.clone(),
            duration: sa.duration,
            browser_url: sa.browser_url.clone(),
            executable_path: sa.executable_path.clone(),
            semantic_category: sa.semantic_category.clone(),
            semantic_confidence: sa.semantic_confidence,
            screenshot_url: None,
            uuid: Some(sa.uuid.clone()),
            device_id: sa.device_id.clone(),
        };
        let _ = db.upsert_activity_by_uuid(&activity);
    }

    for sr in &pull.daily_reports {
        let report = DailyReport {
            date: sr.date.clone(),
            locale: "zh-CN".to_string(),
            content: sr.content.clone(),
            ai_mode: sr.ai_mode.clone(),
            model_name: sr.model_name.clone(),
            fallback_reason: sr.fallback_reason.clone(),
            created_at: sr.created_at,
            device_id: sr.device_id.clone(),
        };
        let _ = db.save_report(&report);
    }

    for ss in &pull.hourly_summaries {
        let summary = HourlySummary {
            id: None,
            date: ss.date.clone(),
            hour: ss.hour,
            summary: ss.summary.clone(),
            main_apps: ss.main_apps.clone(),
            activity_count: ss.activity_count,
            total_duration: ss.total_duration,
            representative_screenshots: ss.representative_screenshots.clone(),
            created_at: ss.created_at,
            device_id: ss.device_id.clone(),
        };
        let _ = db.save_hourly_summary(&summary);
    }
}

/// 与 sync-server `GET /api/sync/pull` 的 `since` 一致：活动比较 `timestamp`，日报/小时摘要比较 `created_at`。
pub(crate) fn max_event_cursor_from_pull(pull: &PullResponse) -> Option<i64> {
    let mut m: Option<i64> = None;
    for a in &pull.activities {
        m = Some(m.map_or(a.timestamp, |x| x.max(a.timestamp)));
    }
    for r in &pull.daily_reports {
        m = Some(m.map_or(r.created_at, |x| x.max(r.created_at)));
    }
    for s in &pull.hourly_summaries {
        m = Some(m.map_or(s.created_at, |x| x.max(s.created_at)));
    }
    m
}

/// 本地推送批次对应的最大事件时间（与 `get_*_since` 查询字段一致）。
pub(crate) fn max_event_cursor_from_local_push(
    activities: &[Activity],
    reports: &[DailyReport],
    summaries: &[HourlySummary],
) -> Option<i64> {
    let mut m: Option<i64> = None;
    for a in activities {
        m = Some(m.map_or(a.timestamp, |x| x.max(a.timestamp)));
    }
    for r in reports {
        m = Some(m.map_or(r.created_at, |x| x.max(r.created_at)));
    }
    for s in summaries {
        m = Some(m.map_or(s.created_at, |x| x.max(s.created_at)));
    }
    m
}

// ─── 后台同步任务 ───

pub async fn sync_background_task(state: Arc<Mutex<crate::AppState>>) {
    loop {
        // 1) 读取配置（短锁）
        let config_snapshot = {
            let guard = state.lock().unwrap_or_else(|e| e.into_inner());
            (
                guard.config.sync.enabled,
                guard.config.sync.sync_interval_minutes,
                guard.config.sync.clone(),
                guard.data_dir.clone(),
                guard.config_path.clone(),
                guard.config.storage.screenshot_retention_days,
            )
        };
        let (enabled, interval_minutes, sync_config, data_dir, config_path, retention_days) =
            config_snapshot;

        if !enabled {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            continue;
        }

        let service = SyncService::new(&sync_config, &data_dir);
        let mut new_push_ts = sync_config.last_push_timestamp;
        let mut new_pull_ts = sync_config.last_pull_timestamp;

        // 2) Push: 从 DB 读取数据（短锁），然后 HTTP 发送（无锁）
        let push_result = {
            let (activities, reports, summaries, screenshot_paths) = {
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                let activities = guard
                    .database
                    .get_activities_since(sync_config.last_push_timestamp)
                    .unwrap_or_default();
                let reports = guard
                    .database
                    .get_reports_since(sync_config.last_push_timestamp)
                    .unwrap_or_default();
                let summaries = guard
                    .database
                    .get_hourly_summaries_since(sync_config.last_push_timestamp)
                    .unwrap_or_default();
                let screenshot_paths: Vec<String> = activities
                    .iter()
                    .filter(|a| !a.screenshot_path.is_empty())
                    .map(|a| a.screenshot_path.clone())
                    .collect();
                (activities, reports, summaries, screenshot_paths)
            };
            // 无锁区域：HTTP 请求
            let sync_activities = activities_to_sync(&activities);
            let sync_reports = reports_to_sync(&reports);
            let sync_summaries = summaries_to_sync(&summaries);

            let push_empty =
                activities.is_empty() && reports.is_empty() && summaries.is_empty();
            match service
                .push_data(sync_activities, sync_reports, sync_summaries)
                .await
            {
                Ok(resp) => {
                    if !push_empty {
                        if let Some(m) =
                            max_event_cursor_from_local_push(&activities, &reports, &summaries)
                        {
                            new_push_ts = new_push_ts.max(m);
                        }
                    }
                    log::info!(
                        "push 完成: accepted={}, duplicates={}",
                        resp.accepted,
                        resp.duplicates
                    );
                    // 先保存推送游标，截图上传耗时长且不阻塞元数据同步进度
                    {
                        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                        guard.config.sync.last_push_timestamp = new_push_ts;
                        let _ = guard.config.save(&config_path);
                    }
                    // 上传截图（无锁）
                    match service
                        .push_screenshots(&screenshot_paths, sync_config.sync_screenshots_mode)
                        .await
                    {
                        Ok(n) => log::info!("push screenshots: {n} uploaded"),
                        Err(e) => log::warn!("push screenshots 失败: {e}"),
                    }
                    true
                }
                Err(e) => {
                    log::warn!("push 失败（将在下次重试）: {e}");
                    false
                }
            }
        };

        // 3) Pull: HTTP 拉取（无锁），然后写入 DB（短锁），收集截图路径
        let mut pulled_screenshot_paths: Vec<String> = Vec::new();
        let mut pull_session_max: Option<i64> = None;
        if push_result {
            let cutoff_date = chrono::Local::now().date_naive()
                - chrono::Duration::days(retention_days as i64);

            let mut pull_page = 0u32;
            loop {
                pull_page += 1;
                log::info!("pull 第 {pull_page} 页: since={new_pull_ts}");
                match service.pull_data(new_pull_ts).await {
                    Ok(pull) => {
                        let has_more = pull.has_more;
                        let count = pull.activities.len()
                            + pull.daily_reports.len()
                            + pull.hourly_summaries.len();
                        if let Some(m) = max_event_cursor_from_pull(&pull) {
                            pull_session_max = Some(pull_session_max.map_or(m, |x| x.max(m)));
                        }

                        // 从 pull 结果中收集保留期内的截图路径
                        for act in &pull.activities {
                            if act.screenshot_path.is_empty() {
                                continue;
                            }
                            let clean = screenshot_api_subpath(&act.screenshot_path);
                            if let Some(date_str) = clean.split('/').nth(1) {
                                if let Ok(date) =
                                    chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
                                {
                                    if date >= cutoff_date {
                                        pulled_screenshot_paths.push(act.screenshot_path.clone());
                                    }
                                }
                            }
                        }

                        if count > 0 {
                            let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                            upsert_pulled_data(&guard.database, &pull);
                        }

                        log::info!(
                            "pull 第 {pull_page} 页完成: {count} 条 (活动 {}, 日报 {}, 摘要 {}), has_more={has_more}",
                            pull.activities.len(),
                            pull.daily_reports.len(),
                            pull.hourly_summaries.len()
                        );

                        if !has_more {
                            break;
                        }
                        if let Some(last) = pull.activities.last() {
                            new_pull_ts = last.timestamp;
                        } else {
                            break;
                        }
                    }
                    Err(e) => {
                        log::warn!("pull 失败: {e}");
                        break;
                    }
                }
            }
            new_pull_ts = match pull_session_max {
                Some(m) => sync_config.last_pull_timestamp.max(m),
                None => sync_config.last_pull_timestamp,
            };
        }

        // 4) 下载 pull 到的截图（已在第 3 步按保留期过滤）
        if !pulled_screenshot_paths.is_empty()
            && !matches!(sync_config.sync_screenshots_mode, SyncScreenshotsMode::None)
        {
            let mut downloaded = 0usize;
            let mut dl_failed = 0usize;
            for path in &pulled_screenshot_paths {
                match service.download_screenshot(path).await {
                    Ok(_) => downloaded += 1,
                    Err(_) => dl_failed += 1,
                }
            }
            log::info!(
                "pull screenshots: {downloaded} downloaded, {dl_failed} failed (of {})",
                pulled_screenshot_paths.len()
            );
        }

        // 5) Pull devices
        match service.pull_devices().await {
            Ok(devices) => log::info!("pull devices: {} 台设备", devices.len()),
            Err(e) => log::warn!("pull devices 失败: {e}"),
        }

        // 5) 更新时间戳并保存配置（短锁）
        {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            guard.config.sync.last_push_timestamp = new_push_ts;
            guard.config.sync.last_pull_timestamp = new_pull_ts;
            let _ = guard.config.save(&guard.config_path);
        }

        let interval = std::time::Duration::from_secs(interval_minutes.max(1) as u64 * 60);
        tokio::time::sleep(interval).await;
    }
}

fn resize_thumbnail(data: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(data).ok()?;
    let thumb = img.thumbnail(640, 480);
    let mut buf = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut buf, image::ImageFormat::Jpeg).ok()?;
    Some(buf.into_inner())
}
