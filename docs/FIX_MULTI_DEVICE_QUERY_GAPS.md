# 多设备数据隔离缺口修复方案

> 背景：`feat/sync` 分支在概览/时间线/日报等主路径已正确传递 `device_id` 过滤，但仍有三类查询在多设备合库后存在数据混杂问题。

## 问题总览

| # | 位置 | 函数 | 问题 | 影响面 |
|---|------|------|------|--------|
| 1 | `database.rs` | `get_hourly_activities` | 生成小时摘要时读取活动不按 `device_id` 过滤，导致摘要混入其他设备活动 | 小时摘要数据污染 |
| 2 | `database.rs` | `get_hourly_summaries` | 读取摘要时不按 `device_id` 过滤，导致同一小时返回多条不同设备的摘要 | 前端展示异常 |
| 3 | `commands.rs` | `get_hourly_summaries` (Tauri command) | 前端调用没有传递 `deviceId`；生成+读取都未感知设备 | 上述 1、2 的入口 |
| 4 | `database.rs` | `get_activities_in_range` | 范围查询不按 `device_id` 过滤 | 记忆搜索跨设备 |
| 5 | `database.rs` | `search_memory` | 记忆搜索不按 `device_id` 过滤 | 同上 |
| 6 | `commands.rs` | `search_memory` / `ask_memory` (Tauri command) | 前端无 `deviceId` 参数传递 | 上述 4、5 的入口 |

## 数据库现状

`hourly_summaries` 表已在迁移中升级为 v2 schema，唯一约束为 `UNIQUE(date, hour, device_id)`：

```sql
CREATE TABLE hourly_summaries_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    summary TEXT NOT NULL,
    main_apps TEXT NOT NULL,
    activity_count INTEGER NOT NULL,
    total_duration INTEGER NOT NULL,
    representative_screenshots TEXT,
    created_at INTEGER NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    UNIQUE(date, hour, device_id)
);
```

写入侧 `save_hourly_summary` 使用 `INSERT OR REPLACE`，已按 `(date, hour, device_id)` 正确隔离。问题集中在**读取侧**和**生成侧**。

## 修复方案

### 设计原则

- 遵循已有模式：`device_id: Option<&str>` + 动态拼接 SQL 条件（与 `get_daily_stats_filtered` / `get_timeline_filtered` 一致）。
- `device_id = None` 或空字符串表示「全设备聚合」，保持向后兼容。
- 前端通过已有的 `$selectedDeviceId` store 传递，无需新增 UI 组件。

---

### 修复 1：`get_hourly_activities` 增加 `device_id` 过滤

**文件**：`src-tauri/src/database.rs`

**当前**：
```rust
pub fn get_hourly_activities(&self, date: &str, hour: i32) -> Result<Vec<Activity>>
```
SQL: `WHERE timestamp > ?1 AND timestamp - duration < ?2`

**改为**：
```rust
pub fn get_hourly_activities(
    &self,
    date: &str,
    hour: i32,
    device_id: Option<&str>,
) -> Result<Vec<Activity>>
```

SQL 拼接：
```rust
let device_filter = if device_id.is_some() {
    " AND device_id = ?3"
} else {
    ""
};

let mut stmt = conn.prepare(
    &format!(
        "SELECT {ACTIVITY_COLUMNS}
         FROM activities
         WHERE timestamp > ?1 AND timestamp - duration < ?2{device_filter}
         ORDER BY timestamp ASC"
    ),
)?;
```

参数构造沿用 `params_from_iter` 展平模式（与 `get_daily_stats_filtered` 一致）。

---

### 修复 2：`get_hourly_summaries` 增加 `device_id` 过滤

**文件**：`src-tauri/src/database.rs`

**当前**：
```rust
pub fn get_hourly_summaries(&self, date: &str) -> Result<Vec<HourlySummary>>
```
SQL: `WHERE date = ?1`

**改为**：
```rust
pub fn get_hourly_summaries(
    &self,
    date: &str,
    device_id: Option<&str>,
) -> Result<Vec<HourlySummary>>
```

SQL 拼接：
```rust
let device_filter = match device_id {
    Some(id) if !id.is_empty() => " AND device_id = ?2",
    _ => "",
};

let mut stmt = conn.prepare(
    &format!(
        "SELECT id, date, hour, summary, main_apps, activity_count,
                total_duration, representative_screenshots, created_at, device_id
         FROM hourly_summaries
         WHERE date = ?1{device_filter}
         ORDER BY hour ASC"
    ),
)?;
```

- `device_id = None` → 返回所有设备的摘要（全局聚合视角）。
- `device_id = Some("abc")` → 只返回该设备的摘要。

---

### 修复 3：`generate_and_save_summary` 传递 `device_id`

**文件**：`src-tauri/src/main.rs`

**当前**：
```rust
pub(crate) fn generate_and_save_summary(
    state: &Arc<Mutex<AppState>>,
    date: &str,
    hour: i32,
)
```
调用 `get_hourly_activities(date, hour)` 时不带 `device_id`。

**改为**：
```rust
pub(crate) fn generate_and_save_summary(
    state: &Arc<Mutex<AppState>>,
    date: &str,
    hour: i32,
)
```

签名不变，内部改为先取 `device_id` 再传入：

```rust
let (activities, device_id) = {
    let state_guard = state.lock().unwrap_or_else(|e| e.into_inner());
    let device_id = state_guard.config.sync.device_id.clone();
    let did = if device_id.is_empty() { None } else { Some(device_id.clone()) };
    let acts = state_guard
        .database
        .get_hourly_activities(date, hour, did.as_deref());
    (acts, device_id)
};
```

这样生成摘要时只统计**本机**活动，不会混入其他设备数据。

---

### 修复 4：`get_hourly_summaries` Tauri command 传递 `deviceId`

**文件**：`src-tauri/src/commands.rs`

**当前**：
```rust
pub async fn get_hourly_summaries(
    date: String,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Vec<serde_json::Value>, AppError>
```

**改为**：
```rust
pub async fn get_hourly_summaries(
    date: String,
    device_id: Option<String>,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Vec<serde_json::Value>, AppError>
```

内部调用相应更新：
```rust
// 生成摘要时只处理本机数据（保持不变，始终为本机生成）
for hour in 0..24 {
    crate::generate_and_save_summary(&app_state, &date, hour);
}

// 读取摘要时按前端传入的 device_id 过滤
let summaries = state
    .database
    .get_hourly_summaries(&date, device_id.as_deref())?;
```

---

### 修复 5：`get_activities_in_range` 增加 `device_id` 过滤

**文件**：`src-tauri/src/database.rs`

**当前**：
```rust
pub fn get_activities_in_range(
    &self,
    date_from: Option<&str>,
    date_to: Option<&str>,
    limit: usize,
) -> Result<Vec<Activity>>
```

**改为**：
```rust
pub fn get_activities_in_range(
    &self,
    date_from: Option<&str>,
    date_to: Option<&str>,
    limit: usize,
    device_id: Option<&str>,
) -> Result<Vec<Activity>>
```

SQL 拼接：
```rust
let device_filter = match device_id {
    Some(id) if !id.is_empty() => " AND device_id = ?4",
    _ => "",
};

let mut stmt = conn.prepare(
    &format!(
        "SELECT {ACTIVITY_COLUMNS}
         FROM activities
         WHERE (?1 IS NULL OR timestamp >= ?1)
           AND (?2 IS NULL OR timestamp < ?2){device_filter}
         ORDER BY timestamp ASC, id ASC
         LIMIT ?3"
    ),
)?;
```

---

### 修复 6：`search_memory` 增加 `device_id` 过滤

**文件**：`src-tauri/src/database.rs`

**当前**：
```rust
pub fn search_memory(
    &self,
    query: &str,
    date_from: Option<&str>,
    date_to: Option<&str>,
    limit: usize,
) -> Result<Vec<MemorySearchItem>>
```

**改为**：
```rust
pub fn search_memory(
    &self,
    query: &str,
    date_from: Option<&str>,
    date_to: Option<&str>,
    limit: usize,
    device_id: Option<&str>,
) -> Result<Vec<MemorySearchItem>>
```

活动查询部分拼接 `device_filter`：
```rust
let device_filter = match device_id {
    Some(id) if !id.is_empty() => " AND device_id = ?4",
    _ => "",
};

let mut activity_stmt = conn.prepare(
    &format!(
        "SELECT id, timestamp, app_name, window_title, ocr_text, browser_url, duration
         FROM activities
         WHERE (?1 IS NULL OR timestamp >= ?1)
           AND (?2 IS NULL OR timestamp < ?2){device_filter}
         ORDER BY timestamp DESC
         LIMIT ?3"
    ),
)?;
```

> 注：`search_memory` 中还有对 `daily_reports` 的查询，该表已有 `device_id` 列，也需同步过滤。

---

### 修复 7：上层 Tauri commands 和前端调用更新

#### `commands.rs` 调用链

| Tauri command | 需增加 `device_id` 参数 |
|--------------|------------------------|
| `get_hourly_summaries` | 是（修复 4） |
| `search_memory` | 是 |
| `ask_memory` | 是 |

#### `commands.rs` 内部函数

| 函数 | 改动 |
|------|------|
| `load_filtered_activities_in_range` | 增加 `device_id` 参数并传入 `get_activities_in_range` |

#### 前端调用点

| 文件 | 调用 | 改动 |
|------|------|------|
| `src/App.svelte:90` | `invoke('get_hourly_summaries', { date: today })` | 增加 `deviceId: null`（预加载用全局聚合） |
| `src/routes/timeline/Timeline.svelte:229` | `invoke('get_hourly_summaries', { date: selectedDate })` | 增加 `deviceId: $selectedDeviceId` |
| `src/routes/timeline/Summary.svelte:30` | `invoke('get_hourly_summaries', { date: selectedDate })` | 增加 `deviceId: $selectedDeviceId` |

## 变更范围汇总

| 文件 | 改动量（估计） |
|------|---------------|
| `src-tauri/src/database.rs` | ~40 行（4 个函数签名 + SQL 拼接） |
| `src-tauri/src/main.rs` | ~8 行（`generate_and_save_summary` 内部） |
| `src-tauri/src/commands.rs` | ~20 行（3 个 Tauri command + 1 个内部函数） |
| `src/App.svelte` | ~1 行 |
| `src/routes/timeline/Timeline.svelte` | ~1 行 |
| `src/routes/timeline/Summary.svelte` | ~1 行 |
| **合计** | **~70 行** |

## 注意事项

1. **向后兼容**：所有 `device_id` 参数均为 `Option`，`None` / 空字符串行为等同于当前逻辑（全设备聚合），不影响未开启同步的用户。
2. **唯一约束**：`hourly_summaries` 表的 `UNIQUE(date, hour, device_id)` 已支持按设备隔离写入，无需 schema 变更。
3. **`INSERT OR REPLACE` 语义**：当 `generate_and_save_summary` 对同一 `(date, hour, device_id)` 重复调用时，旧摘要会被覆盖，符合预期。
4. **`search_memory` / `ask_memory` 的产品决策**：记忆搜索跨设备检索在某些场景下反而是期望行为（如"我今天在任意设备上做了什么"），可考虑在 UI 上提供独立的「跨设备搜索」开关，默认跟随全局 `DeviceFilter`。
5. **性能**：`device_id` 列已在 `activities` 表的查询中被频繁使用，如有必要可增加 `CREATE INDEX IF NOT EXISTS idx_activities_device_ts ON activities(device_id, timestamp)` 加速多设备过滤。

## 实施优先级

1. **P0** — 修复 1 + 3（小时摘要生成污染）：数据写入就错了，且无法事后修正，优先堵住。
2. **P0** — 修复 2 + 4（小时摘要读取 + command 传参）：前端展示异常的直接原因。
3. **P1** — 修复 5 + 6 + 7（范围查询 + 记忆搜索）：当前前端暂无使用这些 API 的页面路由，但 Tauri command 已注册，属于潜在入口。
