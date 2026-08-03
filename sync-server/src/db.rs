use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use crate::models::*;

fn next_sync_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.execute("INSERT INTO sync_sequence DEFAULT VALUES", [])?;
    Ok(conn.last_insert_rowid())
}

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
                semantic_confidence INTEGER,
                screenshot_url TEXT,
                sync_version INTEGER NOT NULL DEFAULT 0,
                source_version INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_activities_timestamp ON activities (timestamp);
            CREATE INDEX IF NOT EXISTS idx_activities_device ON activities (device_id);

            CREATE TABLE IF NOT EXISTS daily_reports (
                date TEXT NOT NULL,
                locale TEXT NOT NULL DEFAULT 'zh-CN',
                device_id TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                ai_mode TEXT NOT NULL,
                model_name TEXT,
                fallback_reason TEXT,
                created_at INTEGER NOT NULL,
                sync_version INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (date, locale, device_id)
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
                sync_version INTEGER NOT NULL DEFAULT 0,
                UNIQUE(date, hour, device_id)
            );
            CREATE INDEX IF NOT EXISTS idx_hourly_date ON hourly_summaries (date);

            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                device_name TEXT NOT NULL,
                last_seen INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS entity_category_cache (
                entity_key TEXT PRIMARY KEY,
                base_category TEXT NOT NULL,
                semantic_category TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                sync_version INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS sync_sequence (
                id INTEGER PRIMARY KEY AUTOINCREMENT
            );",
        )
        .expect("初始化表结构失败");

        let _ = conn.execute("ALTER TABLE activities ADD COLUMN screenshot_url TEXT", []);
        let _ = conn.execute(
            "ALTER TABLE activities ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE activities ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE daily_reports ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE hourly_summaries ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE entity_category_cache ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0",
            [],
        );
        if conn
            .prepare("SELECT locale FROM daily_reports LIMIT 0")
            .is_err()
        {
            conn.execute_batch(
                "CREATE TABLE daily_reports_v2 (
                    date TEXT NOT NULL,
                    locale TEXT NOT NULL DEFAULT 'zh-CN',
                    device_id TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL,
                    ai_mode TEXT NOT NULL,
                    model_name TEXT,
                    fallback_reason TEXT,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (date, locale, device_id)
                );
                INSERT INTO daily_reports_v2
                    (date, locale, device_id, content, ai_mode, model_name, created_at)
                    SELECT date, 'zh-CN', device_id, content, ai_mode, model_name, created_at
                    FROM daily_reports;
                DROP TABLE daily_reports;
                ALTER TABLE daily_reports_v2 RENAME TO daily_reports;",
            )
            .expect("迁移日报表失败");
        }
        let _ = conn.execute(
            "ALTER TABLE daily_reports ADD COLUMN fallback_reason TEXT",
            [],
        );
        for table in [
            "activities",
            "daily_reports",
            "hourly_summaries",
            "entity_category_cache",
        ] {
            let ids: Vec<i64> = {
                let mut stmt = conn
                    .prepare(&format!("SELECT rowid FROM {table} WHERE sync_version = 0"))
                    .expect("读取同步版本迁移数据失败");
                stmt.query_map([], |row| row.get(0))
                    .expect("读取同步版本迁移数据失败")
                    .flatten()
                    .collect()
            };
            for rowid in ids {
                conn.execute("INSERT INTO sync_sequence DEFAULT VALUES", [])
                    .expect("生成同步版本失败");
                let version = conn.last_insert_rowid();
                conn.execute(
                    &format!("UPDATE {table} SET sync_version = ?1 WHERE rowid = ?2"),
                    params![version, rowid],
                )
                .expect("回填同步版本失败");
            }
        }
    }

    /// UPSERT 活动记录，返回 (accepted, duplicates)。
    /// `data_dir`：合并库存储根目录；当某条活动 `screenshot_path` 被更新为其它值时，若旧路径不再被任何活动或小时摘要引用，则删除磁盘上对应文件。
    pub fn upsert_activities(
        &self,
        activities: &[SyncActivity],
        data_dir: &Path,
    ) -> rusqlite::Result<(usize, usize)> {
        let conn = self.conn.lock().unwrap();
        let mut accepted = 0usize;
        let mut duplicates = 0usize;

        for act in activities {
            let existing: Option<(i64, String)> = conn
                .query_row(
                    "SELECT source_version, screenshot_path FROM activities WHERE uuid = ?1",
                    params![act.uuid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if existing
                .as_ref()
                .is_some_and(|(source_version, _)| act.sync_version <= *source_version)
            {
                duplicates += 1;
                continue;
            }
            let sync_version = next_sync_version(&conn)?;

            if let Some((_, old_path)) = existing {
                conn.execute(
                        "UPDATE activities SET timestamp=?1, app_name=?2, window_title=?3, screenshot_path=?4, ocr_text=?5, category=?6, duration=?7, browser_url=?8, executable_path=?9, semantic_category=?10, semantic_confidence=?11, screenshot_url=?12, device_id=?13, sync_version=?14, source_version=?15 WHERE uuid=?16",
                        params![act.timestamp, act.app_name, act.window_title, act.screenshot_path, act.ocr_text, act.category, act.duration, act.browser_url, act.executable_path, act.semantic_category, act.semantic_confidence, act.screenshot_url, act.device_id, sync_version, act.sync_version, act.uuid],
                    )?;
                maybe_remove_replaced_screenshot_file(
                    &conn,
                    data_dir,
                    &old_path,
                    &act.screenshot_path,
                );
                accepted += 1;
            } else {
                conn.execute(
                        "INSERT INTO activities (uuid, device_id, timestamp, app_name, window_title, screenshot_path, ocr_text, category, duration, browser_url, executable_path, semantic_category, semantic_confidence, screenshot_url, sync_version, source_version) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                        params![act.uuid, act.device_id, act.timestamp, act.app_name, act.window_title, act.screenshot_path, act.ocr_text, act.category, act.duration, act.browser_url, act.executable_path, act.semantic_category, act.semantic_confidence, act.screenshot_url, sync_version, act.sync_version],
                    )?;
                accepted += 1;
            }
        }
        Ok((accepted, duplicates))
    }

    /// UPSERT 日报
    pub fn upsert_daily_reports(&self, reports: &[SyncDailyReport]) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let mut accepted = 0;
        for r in reports {
            let sync_version = next_sync_version(&conn)?;
            accepted += conn.execute(
                "INSERT INTO daily_reports (date, locale, device_id, content, ai_mode, model_name, fallback_reason, created_at, sync_version)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
                 ON CONFLICT(date, locale, device_id) DO UPDATE SET
                    content=excluded.content, ai_mode=excluded.ai_mode,
                    model_name=excluded.model_name, fallback_reason=excluded.fallback_reason,
                    created_at=excluded.created_at, sync_version=excluded.sync_version
                 WHERE excluded.created_at > daily_reports.created_at",
                params![r.date, r.locale, r.device_id, r.content, r.ai_mode, r.model_name, r.fallback_reason, r.created_at, sync_version],
            )?;
        }
        Ok(accepted)
    }

    /// UPSERT 小时摘要
    pub fn upsert_hourly_summaries(
        &self,
        summaries: &[SyncHourlySummary],
    ) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let mut accepted = 0;
        for s in summaries {
            let sync_version = next_sync_version(&conn)?;
            accepted += conn.execute(
                "INSERT INTO hourly_summaries (date, hour, device_id, summary, main_apps, activity_count, total_duration, representative_screenshots, created_at, sync_version) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
                 ON CONFLICT(date, hour, device_id) DO UPDATE SET
                    summary=excluded.summary, main_apps=excluded.main_apps,
                    activity_count=excluded.activity_count, total_duration=excluded.total_duration,
                    representative_screenshots=excluded.representative_screenshots,
                    created_at=excluded.created_at, sync_version=excluded.sync_version
                 WHERE excluded.created_at > hourly_summaries.created_at",
                params![s.date, s.hour, s.device_id, s.summary, s.main_apps, s.activity_count, s.total_duration, s.representative_screenshots, s.created_at, sync_version],
            )?;
        }
        Ok(accepted)
    }

    pub fn upsert_entity_categories(
        &self,
        categories: &[SyncEntityCategory],
    ) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().unwrap();
        let mut accepted = 0;
        for item in categories {
            let sync_version = next_sync_version(&conn)?;
            accepted += conn.execute(
                "INSERT INTO entity_category_cache
                 (entity_key, base_category, semantic_category, source, created_at, sync_version)
                 VALUES (?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(entity_key) DO UPDATE SET
                    base_category=excluded.base_category,
                    semantic_category=excluded.semantic_category,
                    source=excluded.source,
                    created_at=excluded.created_at,
                    sync_version=excluded.sync_version
                 WHERE excluded.created_at > entity_category_cache.created_at",
                params![
                    item.entity_key,
                    item.base_category,
                    item.semantic_category,
                    item.source,
                    item.created_at,
                    sync_version
                ],
            )?;
        }
        Ok(accepted)
    }

    /// 增量拉取活动记录
    pub fn pull_activities(
        &self,
        since: i64,
        exclude_device: Option<&str>,
        limit: i64,
    ) -> rusqlite::Result<(Vec<SyncActivity>, bool, i64)> {
        let conn = self.conn.lock().unwrap();
        let fetch_limit = limit + 1;

        let mut activities = Vec::new();
        if let Some(exclude) = exclude_device {
            let mut stmt = conn
                .prepare(
                    "SELECT uuid, device_id, sync_version, timestamp, app_name, window_title, screenshot_path, ocr_text, category, duration, browser_url, executable_path, semantic_category, semantic_confidence, screenshot_url
                     FROM activities WHERE sync_version > ?1 AND device_id != ?2 ORDER BY sync_version ASC LIMIT ?3",
                )?;
            let rows = stmt.query_map(params![since, exclude, fetch_limit], |row| {
                Ok(SyncActivity {
                    uuid: row.get(0)?,
                    device_id: row.get(1)?,
                    sync_version: row.get(2)?,
                    timestamp: row.get(3)?,
                    app_name: row.get(4)?,
                    window_title: row.get(5)?,
                    screenshot_path: row.get(6)?,
                    ocr_text: row.get(7)?,
                    category: row.get(8)?,
                    duration: row.get(9)?,
                    browser_url: row.get(10)?,
                    executable_path: row.get(11)?,
                    semantic_category: row.get(12)?,
                    semantic_confidence: row.get(13)?,
                    screenshot_url: row.get(14)?,
                })
            })?;
            for row in rows {
                activities.push(row?);
            }
        } else {
            let mut stmt = conn
                .prepare(
                    "SELECT uuid, device_id, sync_version, timestamp, app_name, window_title, screenshot_path, ocr_text, category, duration, browser_url, executable_path, semantic_category, semantic_confidence, screenshot_url
                     FROM activities WHERE sync_version > ?1 ORDER BY sync_version ASC LIMIT ?2",
                )?;
            let rows = stmt.query_map(params![since, fetch_limit], |row| {
                Ok(SyncActivity {
                    uuid: row.get(0)?,
                    device_id: row.get(1)?,
                    sync_version: row.get(2)?,
                    timestamp: row.get(3)?,
                    app_name: row.get(4)?,
                    window_title: row.get(5)?,
                    screenshot_path: row.get(6)?,
                    ocr_text: row.get(7)?,
                    category: row.get(8)?,
                    duration: row.get(9)?,
                    browser_url: row.get(10)?,
                    executable_path: row.get(11)?,
                    semantic_category: row.get(12)?,
                    semantic_confidence: row.get(13)?,
                    screenshot_url: row.get(14)?,
                })
            })?;
            for row in rows {
                activities.push(row?);
            }
        }

        let has_more = activities.len() as i64 > limit;
        if has_more {
            activities.truncate(limit as usize);
        }
        let cursor = activities
            .last()
            .map(|item| item.sync_version)
            .unwrap_or(since);
        Ok((activities, has_more, cursor))
    }

    /// 增量拉取日报
    pub fn pull_daily_reports(
        &self,
        since: i64,
        exclude_device: Option<&str>,
    ) -> rusqlite::Result<(Vec<SyncDailyReport>, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT date, locale, device_id, content, ai_mode, model_name, fallback_reason, created_at FROM daily_reports WHERE sync_version > ?1 AND (?2 IS NULL OR device_id != ?2) ORDER BY sync_version ASC")?;
        let reports = stmt
            .query_map(params![since, exclude_device], |row| {
                Ok(SyncDailyReport {
                    date: row.get(0)?,
                    locale: row.get(1)?,
                    device_id: row.get(2)?,
                    content: row.get(3)?,
                    ai_mode: row.get(4)?,
                    model_name: row.get(5)?,
                    fallback_reason: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let cursor = conn.query_row(
            "SELECT COALESCE(MAX(sync_version), ?1) FROM daily_reports WHERE sync_version > ?1 AND (?2 IS NULL OR device_id != ?2)",
            params![since, exclude_device],
            |row| row.get(0),
        )?;
        Ok((reports, cursor))
    }

    pub fn pull_entity_categories(
        &self,
        since: i64,
    ) -> rusqlite::Result<(Vec<SyncEntityCategory>, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT entity_key, base_category, semantic_category, source, created_at
                 FROM entity_category_cache WHERE sync_version > ?1 ORDER BY sync_version ASC",
        )?;
        let categories = stmt
            .query_map(params![since], |row| {
                Ok(SyncEntityCategory {
                    entity_key: row.get(0)?,
                    base_category: row.get(1)?,
                    semantic_category: row.get(2)?,
                    source: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let cursor = conn.query_row(
            "SELECT COALESCE(MAX(sync_version), ?1) FROM entity_category_cache WHERE sync_version > ?1",
            params![since],
            |row| row.get(0),
        )?;
        Ok((categories, cursor))
    }

    /// 增量拉取小时摘要
    pub fn pull_hourly_summaries(
        &self,
        since: i64,
        exclude_device: Option<&str>,
    ) -> rusqlite::Result<(Vec<SyncHourlySummary>, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT date, hour, device_id, summary, main_apps, activity_count, total_duration, representative_screenshots, created_at FROM hourly_summaries WHERE sync_version > ?1 AND (?2 IS NULL OR device_id != ?2) ORDER BY sync_version ASC")?;
        let summaries = stmt
            .query_map(params![since, exclude_device], |row| {
                Ok(SyncHourlySummary {
                    date: row.get(0)?,
                    hour: row.get(1)?,
                    device_id: row.get(2)?,
                    summary: row.get(3)?,
                    main_apps: row.get(4)?,
                    activity_count: row.get(5)?,
                    total_duration: row.get(6)?,
                    representative_screenshots: row.get(7)?,
                    created_at: row.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let cursor = conn.query_row(
            "SELECT COALESCE(MAX(sync_version), ?1) FROM hourly_summaries WHERE sync_version > ?1 AND (?2 IS NULL OR device_id != ?2)",
            params![since, exclude_device],
            |row| row.get(0),
        )?;
        Ok((summaries, cursor))
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
            .prepare(
                "SELECT device_id, device_name, last_seen FROM devices ORDER BY last_seen DESC",
            )
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

#[cfg(test)]
mod tests {
    use super::*;

    fn activity(uuid: &str, timestamp: i64) -> SyncActivity {
        SyncActivity {
            uuid: uuid.to_string(),
            device_id: "device-a".to_string(),
            sync_version: 0,
            timestamp,
            app_name: "Code".to_string(),
            window_title: uuid.to_string(),
            screenshot_path: String::new(),
            ocr_text: None,
            category: "development".to_string(),
            duration: 60,
            browser_url: None,
            executable_path: None,
            semantic_category: None,
            semantic_confidence: None,
            screenshot_url: None,
        }
    }

    #[test]
    fn activity_pagination_does_not_share_report_cursor() {
        let data_dir = std::env::temp_dir().join(format!(
            "work-review-sync-server-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let db = Database::new(&data_dir);
        db.upsert_activities(
            &[activity("a", 100), activity("b", 100), activity("c", 100)],
            &data_dir,
        )
        .expect("写入活动失败");
        db.upsert_daily_reports(&[SyncDailyReport {
            date: "2026-08-03".to_string(),
            locale: "zh-CN".to_string(),
            device_id: "device-a".to_string(),
            content: "report".to_string(),
            ai_mode: "local".to_string(),
            model_name: None,
            fallback_reason: None,
            created_at: 9_999,
        }])
        .expect("写入日报失败");
        db.upsert_hourly_summaries(&[SyncHourlySummary {
            date: "2026-08-03".to_string(),
            hour: 10,
            device_id: "device-a".to_string(),
            summary: "summary".to_string(),
            main_apps: "Code".to_string(),
            activity_count: 1,
            total_duration: 60,
            representative_screenshots: None,
            created_at: 10_000,
        }])
        .expect("写入小时摘要失败");

        let (first_page, has_more, activity_cursor) = db
            .pull_activities(0, Some("device-b"), 2)
            .expect("拉取活动第一页失败");
        let (reports, report_cursor) = db
            .pull_daily_reports(0, Some("device-b"))
            .expect("拉取日报失败");
        assert_eq!(first_page.len(), 2);
        assert!(has_more);
        assert_eq!(reports.len(), 1);
        assert!(report_cursor > activity_cursor);
        let (summaries, _) = db
            .pull_hourly_summaries(0, Some("device-b"))
            .expect("拉取小时摘要失败");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].hour, 10);
        assert_eq!(summaries[0].device_id, "device-a");

        let (all_reports, _) = db.pull_daily_reports(0, None).expect("拉取全部日报失败");
        let (all_summaries, _) = db
            .pull_hourly_summaries(0, None)
            .expect("拉取全部小时摘要失败");
        assert_eq!(all_reports.len(), 1);
        assert_eq!(all_summaries.len(), 1);

        let (second_page, has_more, _) = db
            .pull_activities(activity_cursor, Some("device-b"), 2)
            .expect("拉取活动第二页失败");
        assert_eq!(second_page.len(), 1);
        assert!(!has_more);

        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn stale_activity_source_version_cannot_overwrite_newer_data() {
        let data_dir = std::env::temp_dir().join(format!(
            "work-review-sync-server-version-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let db = Database::new(&data_dir);
        let mut newer = activity("same", 100);
        newer.sync_version = 2;
        newer.ocr_text = Some("newer".to_string());
        db.upsert_activities(&[newer], &data_dir)
            .expect("写入新版本活动失败");

        let mut stale = activity("same", 100);
        stale.sync_version = 1;
        stale.ocr_text = Some("stale".to_string());
        let (accepted, duplicates) = db
            .upsert_activities(&[stale], &data_dir)
            .expect("处理旧版本活动失败");
        assert_eq!(accepted, 0);
        assert_eq!(duplicates, 1);

        let (activities, _, _) = db
            .pull_activities(0, Some("device-b"), 10)
            .expect("拉取活动失败");
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].ocr_text.as_deref(), Some("newer"));
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
