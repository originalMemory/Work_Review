# 多设备数据同步方案设计

## 背景

Work Review 当前是单设备本地应用，所有数据（SQLite 数据库、截图、OCR 文本）仅存在于运行设备上。当用户拥有多台设备（如办公 Windows + 个人 MacBook）时，无法统一查看完整的工作轨迹。

本方案设计一套基于中央同步服务的增量同步机制，支持多设备数据合并与统一回看。

## 部署环境

- 中央服务：Docker 容器，部署在 24h 在线的 Unraid NAS 上
- 客户端：各台运行 Work Review 的桌面端（macOS / Windows / Linux）

---

## 整体架构

```
┌──────────┐      ┌──────────┐      ┌──────────┐
│  设备 A   │      │  设备 B   │      │  设备 C   │
│  桌面客户端│      │  桌面客户端│      │  桌面客户端│
│  (记录+同步)│     │  (记录+同步)│     │  (记录+同步)│
└────┬─────┘      └────┬─────┘      └────┬─────┘
     │                 │                 │
     │     HTTP/HTTPS (局域网或 VPN)      │
     └────────┬────────┘─────────────────┘
              ▼
     ┌─────────────────────────────┐
     │        Unraid NAS           │
     │   Docker: sync-server       │
     │ ┌─────────────────────────┐ │
     │ │  同步 API               │ │  ← 接收/分发设备数据
     │ │  合并数据库 + 截图存储  │ │
     │ └─────────────────────────┘ │
     └─────────────────────────────┘
```

**数据流向**：桌面客户端 → 推送增量到 NAS → NAS 存储合并 → 其他客户端拉取增量。设备之间不直接通信。

---

## 数据模型改造

### 1. 新增字段

现有 `activities` 表需要增加两个字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `device_id` | TEXT NOT NULL | 设备唯一标识，如 `macbook-home`、`win-office` |
| `uuid` | TEXT UNIQUE | 全局唯一记录 ID（UUID v7，时间有序），用于跨设备去重 |

迁移 SQL：

```sql
ALTER TABLE activities ADD COLUMN device_id TEXT NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN uuid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_uuid ON activities(uuid);
```

`daily_reports` 和 `hourly_summaries` 同理需要加 `device_id`。

### 2. device_id 生成

每台设备首次启动时，若 `config.json` 中没有 `device_id`，则自动生成：

```json
{
  "device_id": "macbook-home",
  "device_name": "MacBook (家)",
  ...
}
```

`device_id` 建议用户可自定义（设置界面提供输入框），便于辨认。自动生成时可用 `hostname-随机4位` 兜底。

### 3. 截图路径

截图存储路径加入 `device_id` 前缀，避免多设备同名冲突：

```
当前：screenshots/2026-03-30/143022.jpg
改后：screenshots/{device_id}/2026-03-30/143022.jpg
```

---

## 同步服务设计（sync-server）

### 技术栈

- 语言：Rust（与客户端一致，可共用数据结构）
- HTTP 框架：axum
- 数据库：SQLite（单用户场景足够；未来可换 PostgreSQL）
- 部署：Docker 容器

### API 接口

#### 1. 推送活动记录

```
POST /api/sync/push
Authorization: Bearer <sync_token>
Content-Type: application/json
```

请求体：

```json
{
  "device_id": "macbook-home",
  "activities": [
    {
      "uuid": "01960a3b-7e2a-7000-8000-abcdef123456",
      "timestamp": 1743302400,
      "app_name": "VS Code",
      "window_title": "main.rs — Work_Review",
      "screenshot_path": "macbook-home/2026-03-30/143022.jpg",
      "ocr_text": "fn main() { ... }",
      "category": "开发",
      "duration": 120,
      "browser_url": null,
      "executable_path": null,
      "semantic_category": "编程开发",
      "semantic_confidence": 85,
      "device_id": "macbook-home"
    }
  ],
  "daily_reports": [],
  "hourly_summaries": []
}
```

服务端处理逻辑：
- 按 `uuid` 做 UPSERT：不存在则插入，已存在则比较 `timestamp`，取较新的一方更新
- 返回已接收的 uuid 列表，客户端据此标记已同步

响应：

```json
{
  "accepted": 15,
  "duplicates": 2,
  "server_timestamp": 1743302500
}
```

#### 2. 推送截图

```
POST /api/sync/screenshots
Authorization: Bearer <sync_token>
Content-Type: multipart/form-data
```

表单字段：
- `device_id`: 设备标识
- `files[]`: 截图文件，每个文件的 name 为相对路径（如 `2026-03-30/143022.jpg`）

服务端存储路径：`/data/screenshots/{device_id}/{date}/{filename}`

去重：文件已存在（相同路径 + 相同大小）则跳过。

#### 3. 拉取增量

```
GET /api/sync/pull?since=1743300000&exclude_device=macbook-home&limit=500
Authorization: Bearer <sync_token>
```

参数：
- `since`：上次同步的服务端时间戳
- `exclude_device`：排除本设备的记录（避免拉回自己刚推上去的数据）
- `limit`：单次最大返回条数（默认 500）

响应：

```json
{
  "activities": [...],
  "daily_reports": [...],
  "hourly_summaries": [...],
  "server_timestamp": 1743302500,
  "has_more": false
}
```

#### 4. 拉取截图（按需）

```
GET /api/sync/screenshot/{device_id}/{date}/{filename}
Authorization: Bearer <sync_token>
```

直接返回 JPEG 文件。客户端在时间线中查看其他设备的截图时按需下载。

#### 5. 设备注册与状态

```
GET /api/devices
POST /api/devices/register
```

用于查看已注册设备列表、最后同步时间等。

---

## 客户端同步逻辑

### 同步配置

`config.json` 新增：

```json
{
  "sync": {
    "enabled": false,
    "server_url": "http://192.168.1.100:8745",
    "sync_token": "your-secret-token",
    "device_id": "macbook-home",
    "device_name": "MacBook (家)",
    "sync_interval_minutes": 5,
    "sync_screenshots": true,
    "sync_screenshots_mode": "thumbnail",
    "last_push_timestamp": 0,
    "last_pull_timestamp": 0
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `enabled` | 同步总开关 |
| `server_url` | NAS 上 sync-server 的地址 |
| `sync_token` | 认证令牌 |
| `sync_interval_minutes` | 自动同步间隔（分钟） |
| `sync_screenshots` | 是否同步截图文件 |
| `sync_screenshots_mode` | `full` = 原图，`thumbnail` = 仅压缩缩略图，`none` = 不传截图 |

### 同步流程

```
定时触发（每 N 分钟）或手动触发：

1. 读取 last_push_timestamp
2. 查询本地：
   SELECT * FROM activities
   WHERE device_id = '本机'
     AND timestamp > last_push_timestamp
   ORDER BY timestamp ASC
   LIMIT 500
3. POST /api/sync/push → 推送新记录
4. （若开启截图同步）POST /api/sync/screenshots → 推送新截图
5. GET /api/sync/pull?since=last_pull_timestamp&exclude_device=本机
6. 收到其他设备的记录 → 按 uuid UPSERT 到本地库
7. （可选）按需下载其他设备的截图
8. 更新 last_push_timestamp 和 last_pull_timestamp
```

### 冲突策略

| 场景 | 策略 |
|------|------|
| 不同设备的不同记录 | 无冲突，各自有唯一 uuid |
| 同一设备的记录被 merge_activity 更新 | Last-write-wins：以 `timestamp` 更大的版本为准 |
| 同一天的日报 | 按 `(date, device_id)` 各保留一份，合并查看时拼接展示 |
| 同一小时摘要 | 按 `(date, hour, device_id)` 各保留一份 |

---

## 截图同步策略

截图是存储和带宽的主要消耗，提供三种模式：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `full` | 原图上传（按配置的 JPEG 质量） | 内网高速、存储充足 |
| `thumbnail` | 上传压缩缩略图（如 480px 宽），查看原图时按需拉取 | 带宽有限 |
| `none` | 仅同步元数据，不传截图 | 极度节省空间 |

---

## Docker 部署

### 目录结构

```
sync-server/
├── Cargo.toml
├── src/
│   ├── main.rs          # 入口，启动 HTTP 服务
│   ├── sync_api.rs      # 同步 API（push/pull/screenshots）
│   ├── db.rs            # 数据库操作（合并库）
│   ├── models.rs        # 共用数据结构
│   └── auth.rs          # Token 校验
├── Dockerfile
└── docker-compose.yml
```

### docker-compose.yml

```yaml
version: '3.8'
services:
  workreview-sync:
    build: .
    container_name: workreview-sync
    ports:
      - "8745:8745"
    volumes:
      - /mnt/user/appdata/workreview-sync:/data
    environment:
      - SYNC_TOKEN=your-secret-token-here
      - RUST_LOG=info
    restart: unless-stopped
```

### Dockerfile

```dockerfile
FROM rust:1.85-slim AS builder
WORKDIR /app
COPY sync-server/ .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/workreview-sync /usr/local/bin/
EXPOSE 8745
VOLUME ["/data"]
CMD ["workreview-sync", "--data-dir", "/data", "--port", "8745"]
```

### NAS 存储结构

```
/data/
├── merged.db                    ← 中央合并数据库
├── config.json                  ← 服务端配置（token 等）
├── screenshots/
│   ├── macbook-home/
│   │   ├── 2026-03-30/
│   │   │   ├── 143022.jpg
│   │   │   └── 144505.jpg
│   │   └── 2026-03-31/
│   └── win-office/
│       └── 2026-03-30/
└── sync.log
```

---

## 安全

| 项目 | 方案 |
|------|------|
| 认证 | 所有接口需 `Authorization: Bearer <token>`，token 在 docker 环境变量中配置 |
| 传输加密 | 内网直接 HTTP；外网场景通过 Tailscale / WireGuard VPN，或前置 Nginx 反代加 TLS |
| 数据隔离 | 截图按 `device_id` 目录隔离，避免路径穿越 |
| Token 管理 | 初期单 token；后续可扩展为多 token（每设备独立） |

---

## 改动清单

### 桌面客户端改动

| 文件 | 改动 |
|------|------|
| `src-tauri/src/config.rs` | 新增 `SyncConfig` 结构体和 `device_id` 字段 |
| `src-tauri/src/database.rs` | `Activity` 加 `uuid`/`device_id` 字段；建表迁移；UPSERT 逻辑 |
| `src-tauri/src/screenshot.rs` | 截图路径加 `device_id` 前缀 |
| `src-tauri/src/main.rs` | `insert_activity` 时填入 `uuid`（UUID v7）和 `device_id` |
| **新建** `src-tauri/src/sync.rs` | 增量推送/拉取、定时同步任务、截图上传 |
| `src-tauri/src/commands.rs` | 暴露手动同步、同步状态查询等 Tauri command |
| `src-tauri/Cargo.toml` | 新增依赖：`uuid`（v7）、`reqwest`（HTTP 客户端） |
| `src/routes/settings/components/SettingsStorage.svelte` | 新增「同步」配置卡片：服务器地址、Token、设备名、同步开关、截图模式 |
| `src/routes/settings/Settings.svelte` | 加载/保存同步配置 |

### 新建 sync-server

| 文件 | 说明 |
|------|------|
| `sync-server/Cargo.toml` | axum, rusqlite, serde, tokio, tower-http |
| `sync-server/src/main.rs` | 入口：启动 HTTP 服务 |
| `sync-server/src/sync_api.rs` | 同步接口：push / pull / screenshots |
| `sync-server/src/db.rs` | 合并库操作（与客户端 `database.rs` 共用数据结构） |
| `sync-server/src/models.rs` | 共用结构体（Activity, DailyReport 等） |
| `sync-server/src/auth.rs` | Bearer token 校验中间件 |
| `sync-server/Dockerfile` | 单阶段 Rust 构建 |
| `sync-server/docker-compose.yml` | 部署配置 |

---

## 已确定

- [x] **截图存储上限**：NAS 端永久保留所有截图，不做自动清理；客户端继续维持原有保留天数清理逻辑
- [x] **首次同步**：全量推送所有历史数据（`last_push_timestamp` 初始为 0，分批推送，每批 500 条）
- [x] **设备标识**：`device_id` 自动生成格式为 `{hostname}-{random4}`，生成后不可修改；用户可改 `device_name`（显示名）
- [x] **数据删除同步**：不做。客户端本地清理仅影响当前设备，NAS 作为归档中心永久保留数据

- [x] **合并查看方式**：概览页/时间线顶部增加设备下拉列表，默认「全部设备」，也可选择单台设备筛选
- [x] **离线容忍**：静默跳过，下次定时触发时补推；不弹窗打扰用户
- [x] **日报合并**：日报是用户手动生成的（AI 或本地模板），按 `(date, device_id)` 各保留一份，日报页面展示时按设备分栏显示
- [x] **外网访问**：项目内不处理，用户自行通过 Lucky 等工具反代 + TLS；sync-server 只监听 HTTP
- [x] **同步粒度**：不需要，全量同步所有数据

---

## 未来规划

### Web 查看端

同步完成后，每台桌面客户端本地已有完整的合并数据，日常查看不依赖额外界面。但后续可以考虑在 sync-server 上增加一个只读 Web 前端，用于：

- 在手机/平板等非桌面设备上浏览合并后的工作轨迹
- 不安装客户端即可快速回看（如在同事电脑上临时查看）

技术上可行：现有前端是 Svelte + Vite + Tailwind，可以直接跑在浏览器中。核心改动是新增一个 `api.js` 适配层，将 `invoke()` 调用按环境分流为 Tauri 桥接或 HTTP 请求，组件 UI 逻辑不需要改动。sync-server 需要额外实现一组只读查询 API（从 `commands.rs` 移植读逻辑），Docker 镜像改为多阶段构建（Node 前端 + Rust 后端）。

此功能**不在本期实现范围内**，待同步核心稳定后再考虑。
