# sync-server Specification

## Purpose

定义中央同步服务（sync-server）对外 HTTP API：活动/日报/摘要的推送与增量拉取、截图存储与下载、设备注册表、Bearer 认证及数据保留策略。

## Requirements

### Requirement: 推送活动与报告

服务端 SHALL 提供 `POST /api/sync/push`，请求体包含 `device_id`、`device_name`、以及 `activities`、`daily_reports`、`hourly_summaries` 等负载。服务端 SHALL 按活动 `uuid` 执行 UPSERT，在冲突时优先保留 `timestamp` 更新的版本。

#### Scenario: 推送全新活动

- **WHEN** 客户端推送若干条服务端未见过的 `uuid`
- **THEN** 服务端 SHALL 插入记录并返回已接受数量

#### Scenario: 推送较旧副本

- **WHEN** 推送的 `uuid` 已存在且已有版本 `timestamp` 更新
- **THEN** 服务端 SHALL 保留现有数据并将该条计为重复/跳过

#### Scenario: 推送较新副本

- **WHEN** 推送的 `uuid` 已存在且负载中 `timestamp` 更新
- **THEN** 服务端 SHALL 用新数据覆盖存储

### Requirement: 增量拉取

服务端 SHALL 提供 `GET /api/sync/pull`，支持 `since`、`exclude_device`、`limit` 等查询参数，返回指定时间之后创建或更新的活动与报告数据，且默认排除请求方本机 `device_id` 的记录（按实现约定）。

#### Scenario: 拉取其他设备数据

- **WHEN** 设备 A 使用 `exclude_device` 指向自身发起拉取
- **THEN** 响应 SHALL 主要包含其他设备的记录

#### Scenario: 分页

- **WHEN** 匹配记录数超过 `limit`
- **THEN** 响应 SHALL 指示仍存在更多数据，客户端可继续请求

### Requirement: 截图上传与下载

服务端 SHALL 接受客户端以单文件二进制方式上传截图（例如 `PUT /api/sync/screenshot/{device_id}/{date}/{filename}`），并将文件存储在数据目录下 `screenshots/{device_id}/{date}/`。服务端 SHALL 提供按路径获取 JPEG 的下载接口。对已存在且相同的文件，服务端 MAY 跳过写入并返回成功。

#### Scenario: 上传新截图

- **WHEN** 客户端上传服务端尚不存在的截图文件
- **THEN** 服务端 SHALL 持久化到 `screenshots/{device_id}/{date}/{filename}`

#### Scenario: 下载已有截图

- **WHEN** 客户端请求已存储的截图路径
- **THEN** 服务端 SHALL 返回 JPEG 及正确的 `Content-Type`

### Requirement: 设备注册与列表

服务端 SHALL 维护 `devices` 表（至少包含 `device_id`、`device_name`、`last_seen`），并提供注册与列表接口（例如 `POST /api/devices/register` 与 `GET /api/devices`）。

#### Scenario: 注册或更新设备

- **WHEN** 客户端上报 `device_id` 与 `device_name`
- **THEN** 服务端 SHALL 插入或更新设备行并刷新 `last_seen`

#### Scenario: 列出设备

- **WHEN** 客户端请求设备列表
- **THEN** 服务端 SHALL 返回已知设备的标识与名称及最近活跃信息

### Requirement: 推送时刷新设备元数据

在收到 `/api/sync/push` 时，服务端 SHALL 根据请求中的 `device_id` / `device_name` 更新 `devices` 表中对应行的 `last_seen`，并在名称变化时更新 `device_name`。

#### Scenario: 推送附带设备信息

- **WHEN** 某设备成功推送数据负载
- **THEN** 该设备在 `devices` 表中的 `last_seen` SHALL 更新；若名称变化则 SHALL 反映新名称

### Requirement: Bearer Token 认证

除健康检查等明确公开的端点外，同步 API SHALL 要求 `Authorization: Bearer <token>`。无效或缺失 token 的请求 SHALL 返回 401。

#### Scenario: 未授权请求

- **WHEN** 请求缺少或携带错误 token
- **THEN** 服务端 SHALL 返回 401

### Requirement: 服务端长期保留同步数据

服务端 SHALL 不因客户端本地保留策略而自动删除已接收的活动、截图与报告；清理由运维或显式策略单独处理。

#### Scenario: 客户端本地已清理

- **WHEN** 某客户端在本地删除过期数据
- **THEN** 服务端仍 MAY 保留对应副本以供其他设备拉取
