use rusqlite::{params, Connection};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use crate::models::*;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(data_dir: &Path) -> Self {
        std::fs::create_dir_all(data_dir).expect("无法创建数据目录");
        let db_path = data_dir.join("merged.db");
        let conn = Connection::open(&db_path).expect("无法打开数据库");

        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;",
        )
        .expect("设置 PRAGMA 失败");

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.init_tables();
        db
    }

    fn init_tables(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uuid TEXT NOT NULL UNIQUE,
                device_id TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                app_name TEXT NOT NULL,
                window_title TEXT NOT NULL,
                screenshot_path TEXT NOT NULL DEFAULT '',
                ocr_text TEXT,
                category TEXT NOT NULL,
                duration INTEGER NOT NULL,
                browser_url TEXT,
                executable_path TEXT,
                semantic_category TEXT,
                semantic_confidence INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities (timestamp);
            CREATE INDEX IF NOT EXISTS idx_activities_device ON activities (device_id);

            CREATE TABLE IF NOT EXISTS daily_reports (
                date TEXT NOT NULL,
                device_id TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                ai_mode TEXT NOT NULL,
                model_name TEXT,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (date, device_id)
            );

            CREATE TABLE IF NOT EXISTS hourly_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                hour INTEGER NOT NULL,
                device_id TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL,
                main_apps TEXT NOT NULL,
                activity_count INTEGER NOT NULL,
                total_duration INTEGER NOT NULL,
                representative_screenshots TEXT,
                created_at INTEGER NOT NULL,
                UNIQUE(date, hour, device_id)
            );
            CREATE INDEX IF NOT EXISTS idx_hourly_date ON hourly_summaries (date);

            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                device_name TEXT NOT NULL,
                last_seen INTEGER NOT NULL
            );",
        )
        .expect("初始化表结构失败");
    }

    /// UPSERT 活动记录，返回 (accepted, duplicates)。
    /// `data_dir`：合并库存储根目录；当某条活动 `screenshot_path` 被更新为其它值时，若旧路径不再被任何活动或小时摘要引用，则删除磁盘上对应文件。
    pub fn upsert_activities(&self, activities: &[SyncActivity], data_dir: &Path) -> (usize, usize) {
        let conn = self.conn.lock().unwrap();
        let mut accepted = 0usize;
        let mut duplicates = 0usize;

        for act in activities {
            let existing_ts: Option<i64> = conn
                .query_row(
                    "SELECT timestamp FROM activities WHERE uuid = ?1",
                    params![act.uuid],
                    |row| row.get(0),
                )
                .ok();

            match existing_ts {
                Some(ts) if act.timestamp <= ts => {
                    duplicates += 1;
                }
                Some(_) => {
                    let old_path: String = conn
                        .query_row(
                            "SELECT screenshot_path FROM activities WHERE uuid = ?1",
                            params![act.uuid],
                            |row| row.get(0),
                        )
                        .unwrap_or_default();
                    let _ = conn.execute(
                        "UPDATE activities SET timestamp=?1, app_name=?2, window_title=?3, screenshot_path=?4, ocr_text=?5, category=?6, duration=?7, browser_url=?8, executable_path=?9, semantic_category=?10, semantic_confidence=?11, device_id=?12 WHERE uuid=?13",
                        params![act.timestamp, act.app_name, act.window_title, act.screenshot_path, act.ocr_text, act.category, act.duration, act.browser_url, act.executable_path, act.semantic_category, act.semantic_confidence, act.device_id, act.uuid],
                    );
                    maybe_remove_replaced_screenshot_file(&conn, data_dir, &old_path, &act.screenshot_path);
                    accepted += 1;
                }
                None => {
                    let _ = conn.execute(
                        "INSERT INTO activities (uuid, device_id, timestamp, app_name, window_title, screenshot_path, ocr_text, category, duration, browser_url, executable_path, semantic_category, semantic_confidence) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                        params![act.uuid, act.device_id, act.timestamp, act.app_name, act.window_title, act.screenshot_path, act.ocr_text, act.category, act.duration, act.browser_url, act.executable_path, act.semantic_category, act.semantic_confidence],
                    );
                    accepted += 1;
                }
            }
        }
        (accepted, duplicates)
    }

    /// UPSERT 日报
    pub fn upsert_daily_reports(&self, reports: &[SyncDailyReport]) {
        let conn = self.conn.lock().unwrap();
        for r in reports {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO daily_reports (date, device_id, content, ai_mode, model_name, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
                params![r.date, r.device_id, r.content, r.ai_mode, r.model_name, r.created_at],
            );
        }
    }

    /// UPSERT 小时摘要
    pub fn upsert_hourly_summaries(&self, summaries: &[SyncHourlySummary]) {
        let conn = self.conn.lock().unwrap();
        for s in summaries {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO hourly_summaries (date, hour, device_id, summary, main_apps, activity_count, total_duration, representative_screenshots, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![s.date, s.hour, s.device_id, s.summary, s.main_apps, s.activity_count, s.total_duration, s.representative_screenshots, s.created_at],
            );
        }
    }

    /// 增量拉取活动记录
    pub fn pull_activities(
        &self,
        since: i64,
        exclude_device: Option<&str>,
        limit: i64,
    ) -> (Vec<SyncActivity>, bool) {
        let conn = self.conn.lock().unwrap();
        let fetch_limit = limit + 1;

        let mut activities = Vec::new();
        if let Some(exclude) = exclude_device {
            let mut stmt = conn
                .prepare(
                    "SELECT uuid, device_id, timestamp, app_name, window_title, screenshot_path, ocr_text, category, duration, browser_url, executable_path, semantic_category, semantic_confidence
                     FROM activities WHERE timestamp > ?1 AND device_id != ?2 ORDER BY timestamp ASC LIMIT ?3",
                )
                .unwrap();
            let rows = stmt
                .query_map(params![since, exclude, fetch_limit], |row| {
                    Ok(SyncActivity {
                        uuid: row.get(0)?,
                        device_id: row.get(1)?,
                        timestamp: row.get(2)?,
                        app_name: row.get(3)?,
                        window_title: row.get(4)?,
                        screenshot_path: row.get(5)?,
                        ocr_text: row.get(6)?,
                        category: row.get(7)?,
                        duration: row.get(8)?,
                        browser_url: row.get(9)?,
                        executable_path: row.get(10)?,
                        semantic_category: row.get(11)?,
                        semantic_confidence: row.get(12)?,
                    })
                })
                .unwrap();
            for row in rows.flatten() {
                activities.push(row);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT uuid, device_id, timestamp, app_name, window_title, screenshot_path, ocr_text, category, duration, browser_url, executable_path, semantic_category, semantic_confidence
                     FROM activities WHERE timestamp > ?1 ORDER BY timestamp ASC LIMIT ?2",
                )
                .unwrap();
            let rows = stmt
                .query_map(params![since, fetch_limit], |row| {
                    Ok(SyncActivity {
                        uuid: row.get(0)?,
                        device_id: row.get(1)?,
                        timestamp: row.get(2)?,
                        app_name: row.get(3)?,
                        window_title: row.get(4)?,
                        screenshot_path: row.get(5)?,
                        ocr_text: row.get(6)?,
                        category: row.get(7)?,
                        duration: row.get(8)?,
                        browser_url: row.get(9)?,
                        executable_path: row.get(10)?,
                        semantic_category: row.get(11)?,
                        semantic_confidence: row.get(12)?,
                    })
                })
                .unwrap();
            for row in rows.flatten() {
                activities.push(row);
            }
        }

        let has_more = activities.len() as i64 > limit;
        if has_more {
            activities.truncate(limit as usize);
        }
        (activities, has_more)
    }

    /// 增量拉取日报
    pub fn pull_daily_reports(&self, since: i64, exclude_device: Option<&str>) -> Vec<SyncDailyReport> {
        let conn = self.conn.lock().unwrap();
        let mut reports = Vec::new();
        if let Some(exclude) = exclude_device {
            let mut stmt = conn
                .prepare("SELECT date, device_id, content, ai_mode, model_name, created_at FROM daily_reports WHERE created_at > ?1 AND device_id != ?2")
                .unwrap();
            let rows = stmt
                .query_map(params![since, exclude], |row| {
                    Ok(SyncDailyReport {
                        date: row.get(0)?,
                        device_id: row.get(1)?,
                        content: row.get(2)?,
                        ai_mode: row.get(3)?,
                        model_name: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })
                .unwrap();
            for row in rows.flatten() {
                reports.push(row);
            }
        }
        reports
    }

    /// 增量拉取小时摘要
    pub fn pull_hourly_summaries(&self, since: i64, exclude_device: Option<&str>) -> Vec<SyncHourlySummary> {
        let conn = self.conn.lock().unwrap();
        let mut summaries = Vec::new();
        if let Some(exclude) = exclude_device {
            let mut stmt = conn
                .prepare("SELECT date, hour, device_id, summary, main_apps, activity_count, total_duration, representative_screenshots, created_at FROM hourly_summaries WHERE created_at > ?1 AND device_id != ?2")
                .unwrap();
            let rows = stmt
                .query_map(params![since, exclude], |row| {
                    Ok(SyncHourlySummary {
                        date: row.get(0)?,
                        device_id: row.get(1)?,
                        hour: row.get(2)?,
                        summary: row.get(3)?,
                        main_apps: row.get(4)?,
                        activity_count: row.get(5)?,
                        total_duration: row.get(6)?,
                        representative_screenshots: row.get(7)?,
                        created_at: row.get(8)?,
                    })
                })
                .unwrap();
            for row in rows.flatten() {
                summaries.push(row);
            }
        }
        summaries
    }

    /// 更新/注册设备
    pub fn upsert_device(&self, device_id: &str, device_name: &str) {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Local::now().timestamp();
        let _ = conn.execute(
            "INSERT INTO devices (device_id, device_name, last_seen) VALUES (?1, ?2, ?3)
             ON CONFLICT(device_id) DO UPDATE SET device_name=excluded.device_name, last_seen=excluded.last_seen",
            params![device_id, device_name, now],
        );
    }

    /// 获取所有设备列表
    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT device_id, device_name, last_seen FROM devices ORDER BY last_seen DESC")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok(DeviceInfo {
                    device_id: row.get(0)?,
                    device_name: row.get(1)?,
                    last_seen: row.get(2)?,
                })
            })
            .unwrap();
        rows.flatten().collect()
    }

    /// 获取存储统计
    pub fn storage_stats(&self) -> (i64, i64, i64, i64) {
        let conn = self.conn.lock().unwrap();
        let activities: i64 = conn
            .query_row("SELECT COUNT(*) FROM activities", [], |r| r.get(0))
            .unwrap_or(0);
        let reports: i64 = conn
            .query_row("SELECT COUNT(*) FROM daily_reports", [], |r| r.get(0))
            .unwrap_or(0);
        let summaries: i64 = conn
            .query_row("SELECT COUNT(*) FROM hourly_summaries", [], |r| r.get(0))
            .unwrap_or(0);
        let devices: i64 = conn
            .query_row("SELECT COUNT(*) FROM devices", [], |r| r.get(0))
            .unwrap_or(0);
        (activities, reports, summaries, devices)
    }

    /// 合并库中仍引用到的、位于 `device_id/date/` 下的截图文件名（不含路径）。
    pub fn referenced_screenshot_filenames(&self, device_id: &str, date: &str) -> HashSet<String> {
        let mut keep = HashSet::new();
        let needle = format!("/{}/{}/", device_id, date);

        let conn = self.conn.lock().unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT screenshot_path FROM activities WHERE device_id = ?1 AND screenshot_path != ''",
            )
            .unwrap();
        let paths: Vec<String> = stmt
            .query_map(params![device_id], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for path in paths {
            push_screenshot_basename_if_day_matches(&mut keep, &path, &needle);
        }

        let mut stmt = conn
            .prepare(
                "SELECT representative_screenshots FROM hourly_summaries WHERE device_id = ?1 AND date = ?2 AND representative_screenshots IS NOT NULL AND representative_screenshots != ''",
            )
            .unwrap();
        let reps: Vec<String> = stmt
            .query_map(params![device_id, date], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        for json in reps {
            if let Ok(paths) = serde_json::from_str::<Vec<String>>(&json) {
                for path in paths {
                    push_screenshot_basename_if_day_matches(&mut keep, &path, &needle);
                }
            }
        }

        keep
    }
}

fn push_screenshot_basename_if_day_matches(keep: &mut HashSet<String>, path: &str, needle: &str) {
    let n = path.replace('\\', "/");
    if !n.contains(needle) {
        return;
    }
    if let Some(name) = Path::new(&n).file_name().and_then(|s| s.to_str()) {
        if !name.is_empty() {
            keep.insert(name.to_string());
        }
    }
}

/// 活动行更新后，若旧截图路径已无任何引用则删除磁盘文件。
fn maybe_remove_replaced_screenshot_file(
    conn: &Connection,
    data_dir: &Path,
    old_path: &str,
    new_path: &str,
) {
    let old_n = old_path.replace('\\', "/");
    let new_n = new_path.replace('\\', "/");
    if old_n.is_empty() || old_n == new_n {
        return;
    }
    let cnt: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM activities WHERE screenshot_path = ?1",
            params![old_path],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if cnt > 0 {
        return;
    }
    let in_summary: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM hourly_summaries WHERE representative_screenshots IS NOT NULL AND instr(representative_screenshots, ?1) > 0",
            params![old_path],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if in_summary > 0 {
        return;
    }
    try_remove_screenshot_under_data_dir(data_dir, &old_n);
}

fn try_remove_screenshot_under_data_dir(data_dir: &Path, rel_path: &str) {
    let Some(rest) = rel_path.strip_prefix("screenshots/") else {
        return;
    };
    if rest.is_empty() || rest.contains("..") {
        return;
    }
    let base = data_dir.join("screenshots");
    let full = base.join(rest);
    if !full.starts_with(&base) {
        return;
    }
    let _ = std::fs::remove_file(&full);
}
