use serde::{Deserialize, Serialize};

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

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    pub device_id: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub activities: Vec<SyncActivity>,
    #[serde(default)]
    pub daily_reports: Vec<SyncDailyReport>,
    #[serde(default)]
    pub hourly_summaries: Vec<SyncHourlySummary>,
}

#[derive(Debug, Serialize)]
pub struct PushResponse {
    pub accepted: usize,
    pub duplicates: usize,
    pub server_timestamp: i64,
}

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    pub since: Option<i64>,
    pub exclude_device: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct PullResponse {
    pub activities: Vec<SyncActivity>,
    pub daily_reports: Vec<SyncDailyReport>,
    pub hourly_summaries: Vec<SyncHourlySummary>,
    pub has_more: bool,
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
