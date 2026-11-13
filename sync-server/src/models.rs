use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncActivity {
    pub uuid: String,
    pub device_id: String,
    #[serde(default)]
    pub sync_version: i64,
    pub timestamp: i64,
    pub app_name: String,
    pub window_title: String,
    pub screenshot_path: String,
    #[serde(default)]
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
    #[serde(default)]
    pub screenshot_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncDailyReport {
    pub date: String,
    #[serde(default = "default_locale")]
    pub locale: String,
    pub device_id: String,
    pub content: String,
    pub ai_mode: String,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    pub created_at: i64,
}

fn default_locale() -> String {
    "zh-CN".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncHourlySummary {
    pub date: String,
    pub hour: i32,
    pub device_id: String,
    pub summary: String,
    pub main_apps: String,
    pub activity_count: i64,
    pub total_duration: i64,
    #[serde(default)]
    pub representative_screenshots: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SyncEntityCategory {
    pub entity_key: String,
    pub base_category: String,
    pub semantic_category: String,
    pub source: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub activities: Vec<SyncActivity>,
    #[serde(default)]
    pub daily_reports: Vec<SyncDailyReport>,
    #[serde(default)]
    pub hourly_summaries: Vec<SyncHourlySummary>,
    #[serde(default)]
    pub entity_categories: Vec<SyncEntityCategory>,
}

#[derive(Debug, Serialize)]
pub struct PushResponse {
    pub accepted: usize,
    pub duplicates: usize,
    pub server_timestamp: i64,
}

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    pub activity_since: Option<i64>,
    pub report_since: Option<i64>,
    pub summary_since: Option<i64>,
    pub category_since: Option<i64>,
    pub exclude_device: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct PullResponse {
    pub activities: Vec<SyncActivity>,
    pub daily_reports: Vec<SyncDailyReport>,
    pub hourly_summaries: Vec<SyncHourlySummary>,
    pub entity_categories: Vec<SyncEntityCategory>,
    pub has_more: bool,
    pub activity_cursor: i64,
    pub report_cursor: i64,
    pub summary_cursor: i64,
    pub category_cursor: i64,
    pub server_timestamp: i64,
}

/// GET /api/sync/range — 按时间范围拉取记录（供 AI 分析/总结使用）。
/// 数据结构与 pull 一致：activities 按 timestamp 过滤，日报/小时摘要按
/// from/to 对应的本地日期（YYYY-MM-DD）过滤，entity_categories 全量返回。
#[derive(Debug, Deserialize)]
pub struct RangeQuery {
    /// 起始时间戳（秒，闭区间）
    pub from: i64,
    /// 结束时间戳（秒，闭区间），必须 >= from
    pub to: i64,
    /// 可选：只返回指定设备；缺省为所有设备
    pub device_id: Option<String>,
    /// 每页条数，默认 500，上限 2000
    pub limit: Option<i64>,
    /// 分页偏移，默认 0
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct RangeResponse {
    pub activities: Vec<SyncActivity>,
    pub daily_reports: Vec<SyncDailyReport>,
    pub hourly_summaries: Vec<SyncHourlySummary>,
    pub entity_categories: Vec<SyncEntityCategory>,
    pub has_more: bool,
    pub offset: i64,
    pub limit: i64,
    /// 当前时间范围/设备过滤下的活动总数，供调用方判断是否继续翻页
    pub total_activities: i64,
    pub server_timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub last_seen: i64,
}

#[derive(Debug, Deserialize)]
pub struct RegisterDeviceRequest {
    pub device_id: String,
    pub device_name: String,
}
