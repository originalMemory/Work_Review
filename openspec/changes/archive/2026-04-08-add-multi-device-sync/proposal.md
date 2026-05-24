## Why

Work Review 当前是纯本地单设备应用，所有活动记录、截图和 OCR 文本只存在于运行的那台机器上。当用户在多台设备上工作（如办公室 Windows + 家里 MacBook）时，无法统一查看完整的工作轨迹，也无法跨设备做日报总结和回顾。

需要一套基于中央服务器的增量同步机制，让多台设备的数据自动汇聚，每台设备都能看到所有设备的合并视图。

详细设计背景见 `docs/SYNC_DESIGN.md`。

## What Changes

- 活动记录（`activities`）新增 `uuid` 和 `device_id` 字段，支持跨设备去重与来源标识
- `daily_reports` 和 `hourly_summaries` 表同步加 `device_id`
- 截图存储路径加入 `device_id` 前缀（`screenshots/{device_id}/YYYY-MM-DD/`），避免多设备同名冲突
- 新增 `sync-server`（Rust / axum / Docker），部署在 NAS 上作为中央同步枢纽
- 客户端新增 `sync.rs` 模块：定时增量推送本地新记录和截图到服务端，拉取其他设备的增量并 UPSERT 到本地库
- 设置界面新增「同步」配置卡片：服务器地址、Token、设备名、同步开关、截图同步模式

## Non-goals

- **不做 Web 查看端**：同步后每台客户端本地已有完整数据，浏览器端属于未来规划
- **不做实时同步**：分钟级定时增量推拉，不做 WebSocket 实时推送
- **不做多用户 / 权限体系**：面向个人使用，单 token 认证即可
- **不做端到端加密**：内网或 VPN 场景下传输安全由网络层保障

## Capabilities

### New Capabilities

- `device-identity`: 设备唯一标识生成、持久化与管理
- `sync-data-model`: 活动记录、日报、摘要的跨设备数据模型（uuid / device_id / 截图路径改造）
- `sync-server`: NAS 上的中央同步服务（接收推送、存储合并、分发增量、截图存储）
- `sync-client`: 客户端增量推送/拉取逻辑（定时同步、首次同步、离线重试）
- `sync-settings-ui`: 设置界面的同步配置卡片

### Modified Capabilities

_(无现有 spec 需要修改)_

## Impact

- **数据库 schema**：`activities`、`daily_reports`、`hourly_summaries` 表结构变更（需迁移）
- **截图路径**：所有截图读写路径增加 `device_id` 层级，影响 `screenshot.rs`、`commands.rs`、`storage.rs`
- **新增依赖**：客户端需 `uuid`、`reqwest`；sync-server 需 `axum`、`rusqlite`、`tokio`、`tower-http`
- **新增 crate**：项目根目录下新建 `sync-server/` 独立 crate
- **Docker 部署**：新增 Dockerfile 和 docker-compose.yml
