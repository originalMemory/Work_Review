# device-identity Specification

## Purpose

定义多设备同步场景下本机设备标识（`device_id`）的生成规则、不可变约束，以及设备显示名（`device_name`）与跨设备展示映射行为。

## Requirements

### Requirement: 首次启动自动生成 device_id

系统 SHALL 在配置中尚无 `device_id` 时于首次使用前生成并持久化唯一标识。格式 SHALL 为 `{hostname}-{random4}`（示例：`macbook-a3f2`）。

#### Scenario: 首次启动无 device_id

- **WHEN** 应用启动且 `config.json` 中不存在 `device_id`
- **THEN** 系统 SHALL 按 `{hostname}-{random4}` 生成 `device_id` 并写入配置

#### Scenario: 后续启动已有 device_id

- **WHEN** 应用启动且配置已包含 `device_id`
- **THEN** 系统 SHALL 沿用现有 `device_id`，不得自动改写

### Requirement: device_id 对用户不可编辑

`device_id` 为内部标识，用于数据库与文件路径；用户 MUST NOT 在 UI 中修改 `device_id`。仅 `device_name` 允许用户编辑。

#### Scenario: 设置中 device_id 只读

- **WHEN** 用户查看同步相关设置
- **THEN** `device_id` SHALL 以只读形式展示

### Requirement: device_name 可自定义并参与同步

系统 SHALL 允许用户在设置中修改 `device_name` 并持久化。修改 `device_name` MUST NOT 改变既有活动记录的 `device_id` 或本地文件路径布局。

#### Scenario: 用户修改 device_name

- **WHEN** 用户编辑 `device_name` 并保存
- **THEN** 新名称 SHALL 写入配置，并在后续同步中上报服务端

### Requirement: UI 通过映射展示设备名称

系统 SHALL 使用设备注册信息（服务端 `devices` 表及本地缓存）将 `device_id` 解析为 `device_name` 用于展示。活动记录本身 SHALL NOT 依赖存储 `device_name` 字段完成展示。

#### Scenario: 时间线展示设备名

- **WHEN** 用户查看包含其他设备数据的时间线
- **THEN** 系统 SHALL 将每条记录的 `device_id` 映射为已知 `device_name`，若无名称则回退显示 `device_id`

#### Scenario: 远端更新设备名后本机刷新

- **WHEN** 设备 A 修改 `device_name` 并成功同步，设备 B 在后续同步中拉取设备列表
- **THEN** 设备 B 的 UI SHALL 显示设备 A 的新名称，且无需改写已存储活动行
