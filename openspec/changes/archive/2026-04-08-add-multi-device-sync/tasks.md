## 1. 客户端数据模型改造

- [x] 1.1 `config.rs`：新增 `SyncConfig` 结构体（enabled, server_url, sync_token, device_id, device_name, sync_interval_minutes, sync_screenshots_mode, last_push_timestamp, last_pull_timestamp）并嵌入 `AppConfig`
- [x] 1.2 `config.rs`：新增 `device_id` 自动生成逻辑（首次启动时按 `{hostname}-{random4}` 格式生成并写入 config.json）
- [x] 1.3 `database.rs`：`Activity` 结构体新增 `uuid: Option<String>` 和 `device_id: String` 字段
- [x] 1.4 `database.rs`：`init_tables` 中添加 `uuid` / `device_id` 列的 `ALTER TABLE` 迁移（失败则静默跳过），并创建 `idx_activities_uuid` 唯一索引
- [x] 1.5 `database.rs`：`daily_reports` 和 `hourly_summaries` 表添加 `device_id` 列迁移
- [x] 1.6 `database.rs`：`insert_activity` 方法在插入时自动生成 UUID v7 并填入 `device_id`
- [x] 1.7 `database.rs`：新增 `upsert_activity_by_uuid` 方法（按 uuid 查找，存在且 timestamp 更新则更新，否则插入）
- [x] 1.8 `Cargo.toml`：添加 `uuid` crate（启用 v7 feature）
- [x] 1.9 `screenshot.rs`：截图保存路径从 `screenshots/YYYY-MM-DD/` 改为 `screenshots/{device_id}/YYYY-MM-DD/`，兼容无前缀的旧路径回退

## 2. sync-server 基础框架

- [x] 2.1 在项目根目录创建 `sync-server/` crate：`Cargo.toml`（axum, rusqlite, serde, serde_json, tokio, tower-http, clap）
- [x] 2.2 `sync-server/src/main.rs`：命令行参数解析（`--data-dir`, `--port`）、初始化日志、启动 axum HTTP 服务
- [x] 2.3 `sync-server/src/db.rs`：初始化合并数据库（创建与客户端相同 schema 的 activities / daily_reports / hourly_summaries 表 + devices 表）
- [x] 2.4 `sync-server/src/models.rs`：定义共用的请求/响应结构体（PushRequest, PushResponse, PullResponse, DeviceInfo 等）
- [x] 2.5 `sync-server/src/auth.rs`：实现 Bearer token 校验中间件（从环境变量 `SYNC_TOKEN` 读取）

## 3. sync-server 同步 API

- [x] 3.1 `sync_api.rs`：实现 `POST /api/sync/push` — 接收活动记录 / 日报 / 摘要，按 uuid UPSERT 到合并库
- [x] 3.2 `sync_api.rs`：实现 `GET /api/sync/pull` — 按 since / exclude_device / limit 参数查询并返回增量数据
- [x] 3.3 `sync_api.rs`：实现 `POST /api/sync/screenshots` — 接收 multipart 截图文件，存储到 `/data/screenshots/{device_id}/{date}/`，去重
- [x] 3.4 `sync_api.rs`：实现 `GET /api/sync/screenshot/{device_id}/{date}/{filename}` — 返回 JPEG 文件
- [x] 3.5 `sync_api.rs`：实现 `POST /api/devices/register` 和 `GET /api/devices` — 设备注册与列表查询；push 时自动更新 devices 表的 device_name 和 last_seen

## 4. sync-server 部署

- [x] 4.1 编写 `sync-server/Dockerfile`（Rust 构建 + debian-slim 运行）
- [x] 4.2 编写 `sync-server/docker-compose.yml`（端口映射、volume 挂载、环境变量配置）
- [x] 4.3 sync-server 确认永久保留策略：不添加自动清理逻辑，仅在日志中输出当前存储占用统计

## 5. 客户端同步逻辑

- [x] 5.1 新建 `src-tauri/src/sync.rs`：定义 `SyncService` 结构体（持有 server_url, token, device_id, reqwest::Client）
- [x] 5.2 `sync.rs`：实现 `push_activities` — 查询本地 `timestamp > last_push_timestamp` 的记录，POST 到 `/api/sync/push`
- [x] 5.3 `sync.rs`：实现 `push_screenshots` — 根据 sync_screenshots_mode 上传新截图（full / thumbnail / none）
- [x] 5.4 `sync.rs`：实现 `pull_activities` — GET `/api/sync/pull`，将返回的记录 UPSERT 到本地库
- [x] 5.5 `sync.rs`：实现 `pull_screenshot_on_demand` — 按需下载远端截图到本地缓存目录
- [x] 5.6 `sync.rs`：实现 `pull_devices` — 拉取 GET /api/devices 并缓存到本地（用于 device_id → device_name 映射）
- [x] 5.7 `sync.rs`：实现 `run_sync_cycle` — 编排完整的 push → pull → pull_devices 流程，更新 last_push/pull_timestamp
- [x] 5.8 `sync.rs`：错误处理 — 服务端不可达时 log warning 并保留 timestamp 不变，下次重试
- [x] 5.9 `main.rs`：在 `background_screenshot_task` 同级启动 `sync_background_task`（tokio::spawn），按配置的间隔定时执行 `run_sync_cycle`
- [x] 5.10 `Cargo.toml`：添加 `reqwest` crate（初始使用 multipart，后续调整为单文件二进制上传）
- [x] 5.11 截图上传协议从 multipart 批量上传调整为 `PUT /api/sync/screenshot/{device_id}/{date}/{filename}` 单文件二进制上传，避免跨端兼容问题
- [x] 5.12 pull 周期中自动下载保留期内的远端截图；下载列表直接从 pull 结果收集，不再全表扫描本地活动表
- [x] 5.13 修复远端截图拉取日期解析，正确识别 `screenshots/{device_id}/{YYYY-MM-DD}/{filename}` 路径中的日期段

## 6. 客户端 Tauri Commands

- [x] 6.1 `commands.rs`：新增 `sync_now` command — 手动触发一次完整同步，返回结果摘要
- [x] 6.2 `commands.rs`：新增 `get_sync_status` command — 返回当前同步状态（上次同步时间、是否正在同步、已注册设备数）
- [x] 6.3 `commands.rs`：新增 `register_device` command — 向 sync-server 注册当前设备
- [x] 6.4 `main.rs`：在 Tauri builder 的 `invoke_handler` 中注册新 commands
- [x] 6.5 `save_config` 返回后端规范化后的配置，确保首次进入设置页即可显示 `device_id` / `device_name`

## 7. 设置界面同步卡片

- [x] 7.1 `SettingsStorage.svelte`：新增「同步」卡片 — 开关、服务器地址输入、Token 输入、设备名输入
- [x] 7.2 `SettingsStorage.svelte`：同步卡片 — 同步间隔选择、截图同步模式选择（完整 / 缩略图 / 不传）
- [x] 7.3 `SettingsStorage.svelte`：同步卡片 — 显示同步状态（上次同步时间、同步结果、设备数量）
- [x] 7.4 `SettingsStorage.svelte`：同步卡片 — 「立即同步」按钮，调用 `sync_now` command 并显示结果
- [x] 7.5 `Settings.svelte`：确保 `SyncConfig` 的默认值初始化和加载/保存逻辑正确
- [x] 7.6 设置页保存后立即回收后端规范化配置，首次进入同步卡片即可显示 device_id / device_name

## 8. 合并查看与设备筛选

- [x] 8.1 概览页/时间线页面顶部新增设备筛选下拉列表组件，列表项来自本地设备缓存（`device_name`，无名称时回退 `device_id`）
- [x] 8.2 下拉列表默认选中「全部设备」，选择单设备时通过 `device_id` 过滤查询条件
- [x] 8.3 `database.rs`：`get_timeline` / `get_daily_stats` 等查询方法新增可选 `device_id` 参数，传入时追加 `WHERE device_id = ?` 条件
- [x] 8.4 `commands.rs`：相关 Tauri command 透传 `device_id` 筛选参数
- [x] 8.5 日报页面支持与概览/时间线一致的设备筛选：默认全部设备，可切换到单设备查看
- [x] 8.6 `get_known_devices` 返回完整设备对象（`device_id` + `device_name`），概览/时间线设备筛选下拉优先展示 `device_name`
- [x] 8.7 综合日报存储：在日报表中以 `device_id=''` 存储“全部设备”视角的综合日报
- [x] 8.8 日报读取逻辑：全部设备模式优先读取 `device_id=''` 的综合日报；单设备模式继续读取对应 `device_id`
- [x] 8.9 综合日报生成逻辑：仅在用户手动生成时，基于全部设备活动数据生成并保存；无现成综合日报时不自动生成
- [x] 8.10 日报页面 UI：全部设备模式展示单张综合日报卡片，不再按设备分栏展示

## 9. 服务端接口与部署补充

- [x] 9.1 `sync-server`：截图上传接口改为 `PUT /api/sync/screenshot/{device_id}/{date}/{filename}`，返回 `201 Created` / `204 No Content`
- [x] 9.2 `sync-server`：移除 multipart 截图上传实现与对应依赖，下载接口保持 `GET /api/sync/screenshot/{device_id}/{date}/{filename}`
- [x] 9.3 `sync-server`：新增 `deploy.sh`，支持读取 `.env` 中的 `BUILD_PROXY` 执行构建与部署
- [x] 9.4 日报自动保存与手动导出统一使用带设备标识的文件名：综合日报 `<date>.all.md`，单设备日报 `<date>.<device_id>.md`
