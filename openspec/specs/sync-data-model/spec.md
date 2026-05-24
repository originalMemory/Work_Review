# sync-data-model Specification

## Purpose

定义跨设备同步所需的活动、日报、摘要及截图存储的数据形态：全局唯一 `uuid`、每条记录携带 `device_id`、截图路径规范及向下兼容的 schema 迁移。

## Requirements

### Requirement: 活动记录包含 UUID v7

系统 SHALL 为每条新插入的活动生成 UUID v7 并写入 `uuid` 列。该标识在所有设备间 MUST 全局唯一，用于去重与 UPSERT。

#### Scenario: 新活动获得 uuid

- **WHEN** 通过 `insert_activity` 写入新活动
- **THEN** 记录 SHALL 包含非空 `uuid`（UUID v7）

#### Scenario: 相同 uuid 的冲突处理

- **WHEN** 同步或本地逻辑尝试写入已存在 `uuid` 的活动
- **THEN** 系统 SHALL 按既定 UPSERT 规则处理（例如以较新 `timestamp` 为准）

### Requirement: 活动、日报与摘要均携带 device_id

`activities`、`daily_reports` 与 `hourly_summaries` 的每条记录 SHALL 包含 `device_id`，取值与产生该记录时本机配置的 `device_id` 一致（综合日报等明确约定为空的场景除外）。

#### Scenario: 新活动携带 device_id

- **WHEN** 录制产生新活动
- **THEN** `device_id` SHALL 等于当前设备配置

#### Scenario: 生成日报携带 device_id

- **WHEN** 用户为当前设备生成日报
- **THEN** 日报记录的 `device_id` SHALL 对应该设备

### Requirement: 截图路径包含 device_id

截图文件 SHALL 保存在 `screenshots/{device_id}/YYYY-MM-DD/` 下，数据库中的 `screenshot_path` SHALL 使用带 `device_id` 前缀的相对路径。

#### Scenario: 新截图按设备目录存储

- **WHEN** 系统保存新截图
- **THEN** 文件 SHALL 位于 `screenshots/{device_id}/YYYY-MM-DD/`，且路径字段反映该结构

#### Scenario: 迁移前旧路径仍可解析

- **WHEN** 数据库中存在不含 `device_id` 前缀的旧 `screenshot_path`
- **THEN** 系统 SHALL 回退到旧路径规则仍能加载图像

### Requirement: Schema 迁移保持兼容

系统 SHALL 通过 `ALTER TABLE` 等方式为既有库增加 `uuid`、`device_id` 等列，不得破坏已有行。迁移后旧行 SHALL 获得合理默认值（例如生成的 `uuid`、空或后续回填的 `device_id`）。

#### Scenario: 旧库升级

- **WHEN** 打开缺少 `uuid` 或 `device_id` 列的既有数据库
- **THEN** 系统 SHALL 添加列并完成回填策略，且不丢失历史活动数据
