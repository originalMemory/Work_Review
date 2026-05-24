## 新增需求

### 需求：设备 ID 自动生成
系统应在首次启动时自动生成唯一的 `device_id`（如 `config.json` 中不存在）。默认格式为 `{hostname}-{random4}`（例如 `macbook-a3f2`）。

#### 场景：首次启动无 device_id
- **当** 应用启动且 `config.json` 中没有 `device_id` 字段
- **则** 系统按 `{hostname}-{random4}` 格式生成 `device_id` 并持久化到 `config.json`

#### 场景：后续启动已有 device_id
- **当** 应用启动且 `config.json` 已包含 `device_id`
- **则** 系统直接使用现有 `device_id`，不做修改

### 需求：设备 ID 生成后不可变
系统不允许用户在生成后修改 `device_id`。`device_id` 是用于数据库记录和文件路径的内部标识符，仅 `device_name`（显示名称）可编辑。

#### 场景：设置中 device_id 只读展示
- **当** 用户查看同步设置卡片
- **则** `device_id` 以只读文本形式展示（不可编辑）

### 需求：设备名称可自定义
系统允许用户通过设置界面修改 `device_name`。修改 `device_name` 不影响数据库记录、文件路径和同步行为。

#### 场景：用户在设置中修改 device_name
- **当** 用户编辑 device_name 字段并保存
- **则** 新的 `device_name` 被持久化到 `config.json`，并在下次同步时上报给服务端

### 需求：通过映射表展示设备名称
系统通过查询设备注册表（服务端 `devices` 表或本地缓存）将 `device_id` 解析为 `device_name` 用于 UI 展示。`device_name` 不存储在活动记录上。

#### 场景：时间线中展示设备名称
- **当** 在时间线中查看来自其他设备的同步活动
- **则** 系统将活动的 `device_id` 映射为设备注册表中对应的 `device_name`
- **则** 展示 `device_name`（若未设置则回退显示 `device_id`）

#### 场景：远端设备更新了名称
- **当** 设备 A 修改了 `device_name` 并同步
- **则** 服务端更新 `devices` 表中的 `device_name`
- **则** 设备 B 在下次同步时拉取最新设备列表
- **则** 设备 B 的 UI 自动显示设备 A 的新名称，无需修改活动记录
