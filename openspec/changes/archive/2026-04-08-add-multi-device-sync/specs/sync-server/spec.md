## 新增需求

### 需求：推送活动接口
sync-server 应接受 `POST /api/sync/push`，JSON 请求体包含 `device_id`、`device_name`、`activities`、`daily_reports` 和 `hourly_summaries`。按 `uuid` 执行 UPSERT，优先保留 `timestamp` 更大的版本。

#### 场景：推送新活动
- **当** 客户端发送 10 条 uuid 唯一的活动
- **则** 服务端全部插入，返回 `{"accepted": 10, "duplicates": 0}`

#### 场景：推送重复活动
- **当** 客户端发送的活动 uuid 已存在且 timestamp 更旧
- **则** 服务端保留现有（更新的）版本，返回为 duplicates

#### 场景：推送更新的活动
- **当** 客户端发送的活动 uuid 已存在但 timestamp 更新
- **则** 服务端用更新的数据覆盖原记录

### 需求：增量拉取接口
sync-server 应提供 `GET /api/sync/pull?since={timestamp}&exclude_device={device_id}&limit={n}`，返回 `since` 之后创建或更新的 activities、daily_reports 和 hourly_summaries，排除请求设备自身的记录。

#### 场景：拉取其他设备数据
- **当** 设备 A 以 `exclude_device=device-a` 请求拉取
- **则** 响应仅包含其他设备（device-b、device-c 等）的记录

#### 场景：分页拉取
- **当** 记录数超过 `limit`
- **则** 响应包含 `has_more: true`，客户端可请求下一页

### 需求：截图上传接口
sync-server 应接受 `POST /api/sync/screenshots`（multipart），将文件存储在 `/data/screenshots/{device_id}/{date}/{filename}`。已存在的同路径同大小文件跳过。

#### 场景：上传新截图
- **当** 客户端上传服务端不存在的截图
- **则** 文件保存到 `/data/screenshots/{device_id}/{date}/{filename}`

#### 场景：跳过重复截图
- **当** 客户端上传的截图已存在且大小相同
- **则** 服务端跳过该文件，返回成功

### 需求：截图下载接口
sync-server 应提供 `GET /api/sync/screenshot/{device_id}/{date}/{filename}`，返回 JPEG 文件。

#### 场景：下载已有截图
- **当** 客户端请求存在的截图路径
- **则** 服务端返回 JPEG 文件，content-type 正确

### 需求：设备注册表接口
sync-server 应维护 `devices` 表（`device_id TEXT PRIMARY KEY, device_name TEXT NOT NULL, last_seen INTEGER NOT NULL`），并通过 `GET /api/devices` 和 `POST /api/devices/register` 暴露。

#### 场景：注册新设备
- **当** 设备发送包含 device_id 和 device_name 的注册请求
- **则** 服务端插入或更新设备记录，包含最新 device_name 和 last_seen 时间戳

#### 场景：列出设备
- **当** 任意客户端调用 GET /api/devices
- **则** 服务端返回所有已注册设备的 device_id、device_name 和 last_seen

### 需求：推送时自动更新设备信息
sync-server 在收到 `/api/sync/push` 请求时，应自动更新 `devices` 表中对应设备的 `device_name` 和 `last_seen`。

#### 场景：推送时更新设备信息
- **当** 设备 A 推送活动数据
- **则** 服务端更新 `devices` 表中设备 A 的 `last_seen` 时间戳
- **则** 若设备 A 的 `device_name` 有变化，`devices` 表反映新名称

### 需求：Bearer Token 认证
所有 sync-server 接口应要求 `Authorization: Bearer <token>`。无有效 token 的请求返回 401 Unauthorized。

#### 场景：无 token 请求
- **当** 请求未携带 Authorization 头
- **则** 服务端返回 401

#### 场景：无效 token 请求
- **当** 请求携带错误的 token
- **则** 服务端返回 401

### 需求：永久存储
sync-server 应永久保留所有同步数据（活动、截图、报告）。服务端不自动删除任何同步数据。存储清理由各客户端在本地自行处理。

#### 场景：旧数据被保留
- **当** 客户端本地清理删除了超过保留期的记录
- **则** 服务端仍保留这些记录，可提供给其他设备
