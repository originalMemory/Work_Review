# sync-settings-ui Specification

## Purpose

定义设置页与数据浏览页中与多设备同步相关的界面：同步参数编辑、状态展示、手动同步、设备筛选及日报综合视图与导出命名。

## Requirements

### Requirement: 存储页同步卡片

「设置 → 存储」SHALL 包含「同步」配置区，至少包括：同步开关、服务器地址、Token、`device_id`（只读）、`device_name`、同步间隔、截图同步模式。

#### Scenario: 可见性

- **WHEN** 用户打开存储设置
- **THEN** 同步卡片及上述字段 SHALL 可见

#### Scenario: 保存

- **WHEN** 用户修改字段并保存
- **THEN** 配置 SHALL 持久化，后台同步行为 SHALL 按新配置生效

### Requirement: 同步状态展示

同步卡片 SHALL 展示上次同步时间、结果摘要（成功/失败）及已知设备数量（或等价状态）。

#### Scenario: 展示上次结果

- **WHEN** 用户查看同步卡片
- **THEN** 系统 SHALL 显示最近一次同步时间与设备统计

#### Scenario: 失败可见

- **WHEN** 上次同步失败
- **THEN** 系统 SHALL 在状态中提示错误信息

### Requirement: 立即同步按钮

同步卡片 SHALL 提供按钮以触发手动同步 command。

#### Scenario: 手动同步完成

- **WHEN** 用户点击立即同步且执行结束
- **THEN** 展示的状态 SHALL 更新为最新时间与结果

### Requirement: 概览、时间线与日报的设备筛选

概览、时间线与日报页面 SHALL 在顶部提供设备下拉筛选：默认「全部设备」，可选单台设备以仅展示该 `device_id` 的数据。列表项 SHALL 来自本地已知设备，优先显示 `device_name`，缺省时回退 `device_id`。

#### Scenario: 默认全部设备

- **WHEN** 用户进入上述页面之一
- **THEN** 默认 SHALL 为「全部设备」且展示合并数据

#### Scenario: 单设备筛选

- **WHEN** 用户选择某台设备
- **THEN** 页面 SHALL 仅展示该设备数据

### Requirement: 日报与综合日报

在「全部设备」筛选下，系统 SHALL 优先展示 `device_id` 为空（或约定值）的综合日报；若不存在，SHALL NOT 自动伪造，直至用户手动生成。单设备筛选下 SHALL 读取该设备 `device_id` 对应日报。

#### Scenario: 全部设备且已有综合日报

- **WHEN** 筛选为全部设备且当日存在综合日报记录
- **THEN** 页面 SHALL 展示该综合日报

#### Scenario: 全部设备且无综合日报

- **WHEN** 无综合日报
- **THEN** 页面 SHALL 保持无日报状态直至用户手动生成

#### Scenario: 单设备日报

- **WHEN** 用户选择具体设备
- **THEN** 系统 SHALL 加载该设备 `device_id` 的日报，不使用综合日报行

#### Scenario: 手动生成综合日报

- **WHEN** 用户在全部设备模式下触发生成
- **THEN** 系统 SHALL 基于全部设备活动生成内容并保存为综合日报（`device_id` 按约定为空或专用值）

### Requirement: 保存后回显设备标识

保存设置后，前端 SHALL 立即展示后端规范化后的 `device_id` 与 `device_name`，无需重启应用。

#### Scenario: 首次保存补齐字段

- **WHEN** 保存时后端首次写回 `device_id` / `device_name`
- **THEN** 保存成功后界面 SHALL 显示最新值

### Requirement: 日报导出文件名区分视角

导出 Markdown 时，文件名 SHALL 区分「全部设备」与单设备，避免同日覆盖。

#### Scenario: 导出综合日报

- **WHEN** 在全部设备视角导出
- **THEN** 文件名 SHALL 包含 `.all` 或等价约定（如 `<date>.all.md`）

#### Scenario: 导出单设备日报

- **WHEN** 在单设备视角导出
- **THEN** 文件名 SHALL 包含该设备 `device_id`（如 `<date>.<device_id>.md`）
