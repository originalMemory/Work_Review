# sync-client Specification

## Purpose

定义桌面客户端与 sync-server 之间的同步编排：定时与手动周期、增量推送与拉取、截图上传/下载策略、设备列表缓存及离线容错。

## Requirements

### Requirement: 定时后台同步

客户端 SHALL 在同步启用时按 `sync_interval_minutes` 启动后台任务。每个周期 SHALL 先推送本机增量，再拉取远端增量（及关联设备列表等步骤，按实现编排）。

#### Scenario: 到达同步间隔

- **WHEN** 同步已开启且距上次计划同步已超过配置间隔
- **THEN** 客户端 SHALL 执行完整同步周期

#### Scenario: 同步关闭

- **WHEN** `sync.enabled` 为 false
- **THEN** 客户端 SHALL NOT 发起计划同步请求

### Requirement: 增量推送活动

客户端 SHALL 仅推送满足「新于 `last_push_timestamp`」且属于本机 `device_id` 的活动（或实现等价增量条件）。推送成功后 SHALL 更新 `last_push_timestamp`。

#### Scenario: 存在待推送活动

- **WHEN** 本地存在较上次推送更新的活动
- **THEN** 客户端 SHALL 调用推送接口发送这些记录并推进游标

#### Scenario: 无新活动

- **WHEN** 没有需要推送的新活动
- **THEN** 客户端 MAY 跳过推送请求以减少流量

### Requirement: 增量拉取与本地 UPSERT

客户端 SHALL 使用 `since` 与 `exclude_device`（本机）等参数拉取远端更新，并按 `uuid` 将活动与报告 UPSERT 到本地库，保留记录中的原始 `device_id`。

#### Scenario: 插入其他设备活动

- **WHEN** 拉取结果包含其他设备的若干活动
- **THEN** 客户端 SHALL 写入本地且保留其 `device_id`

#### Scenario: 更新已存在 uuid

- **WHEN** 拉取到的 `uuid` 本地已存在且远端版本更新
- **THEN** 客户端 SHALL 更新本地行

### Requirement: 截图上传模式

客户端 SHALL 根据 `sync_screenshots_mode`（`full`、`thumbnail`、`none`）决定是否及如何上传截图。上传 SHALL 使用与服务端约定的单文件接口（例如按路径 `PUT` 二进制）。

#### Scenario: full 模式

- **WHEN** 模式为 `full`
- **THEN** 客户端 SHALL 上传原始 JPEG（按实现逐文件调用上传接口）

#### Scenario: thumbnail 模式

- **WHEN** 模式为 `thumbnail`
- **THEN** 客户端 SHALL 生成缩小图后上传

#### Scenario: none 模式

- **WHEN** 模式为 `none`
- **THEN** 客户端 SHALL NOT 上传截图文件

### Requirement: 拉取后下载保留期内远端截图

在 pull 周期内，客户端 SHALL 根据 pull 返回的活动记录及本地 `screenshot_retention_days`，自动下载仍在保留窗口内的、属于其他设备的截图到本地目录。待下载列表 MUST 来自本次 pull 结果，不得依赖全表扫描本地活动。

#### Scenario: 下载近期远端截图

- **WHEN** pull 返回的活动含截图路径且日期在保留期内
- **THEN** 客户端 SHALL 从服务端拉取对应文件到本地

#### Scenario: 超出保留期

- **WHEN** 活动截图日期早于保留期截止
- **THEN** 客户端 SHALL NOT 自动下载该截图

### Requirement: 同步失败不丢游标数据

当服务端不可达或请求失败时，客户端 SHALL 记录日志并保留 `last_push_timestamp` / `last_pull_timestamp`（及本地数据）不变，以便下次重试。

#### Scenario: 推送失败

- **WHEN** 推送阶段网络或服务端错误
- **THEN** 客户端 SHALL NOT 前进推送游标导致数据丢失

#### Scenario: 拉取失败

- **WHEN** 拉取阶段失败
- **THEN** 客户端 SHALL NOT 前进拉取游标导致永久跳过区间

### Requirement: 设备列表缓存

每个同步周期中，客户端 SHALL 拉取设备列表并缓存，用于 UI 将 `device_id` 映射为 `device_name`。缓存未命中时 UI SHALL 回退显示 `device_id`。

#### Scenario: 更新缓存

- **WHEN** 同步周期成功拉取设备列表
- **THEN** 本地缓存 SHALL 反映最新设备名称

### Requirement: 手动触发同步

客户端 SHALL 暴露 Tauri command（或等价入口）以立即执行完整同步周期，而不等待定时器。

#### Scenario: 用户点击立即同步

- **WHEN** 用户在设置中触发立即同步
- **THEN** 客户端 SHALL 执行推送与拉取并更新 UI 可见状态
