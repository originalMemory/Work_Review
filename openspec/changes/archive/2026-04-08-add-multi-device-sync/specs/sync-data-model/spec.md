## 新增需求

### 需求：活动记录使用 UUID
系统应为每条新活动记录生成 UUID v7 并存储在 `uuid` 列中。`uuid` 在所有设备间全局唯一。

#### 场景：新活动获得 UUID
- **当** 通过 `insert_activity` 插入新活动
- **则** 活动包含非空的 `uuid` 字段（UUID v7 格式）

#### 场景：UUID 唯一性约束
- **当** 尝试插入已存在 `uuid` 的活动
- **则** 执行 UPSERT 操作（若新记录 timestamp 更大则更新）

### 需求：所有记录携带 device_id
系统应在每条 `activities`、`daily_reports` 和 `hourly_summaries` 记录上存储 `device_id`。

#### 场景：活动记录携带 device_id
- **当** 录制过程中创建新活动
- **则** 活动的 `device_id` 字段与当前设备配置的 `device_id` 一致

#### 场景：日报携带 device_id
- **当** 生成日报
- **则** 日报的 `device_id` 字段与当前设备的 `device_id` 一致

### 需求：截图路径包含 device_id
系统应将截图存储在 `screenshots/{device_id}/YYYY-MM-DD/HHmmss.jpg` 路径下。

#### 场景：截图以设备前缀保存
- **当** 截取截图
- **则** 文件保存在 `screenshots/{device_id}/YYYY-MM-DD/` 目录下，数据库中的 `screenshot_path` 使用此带前缀的路径

#### 场景：无前缀的旧截图仍可加载
- **当** 数据库中包含不带 `device_id` 前缀的 `screenshot_path`（迁移前数据）
- **则** 系统回退到不带前缀的路径查找

### 需求：Schema 迁移向下兼容
系统应通过添加 `uuid`、`device_id` 列来迁移现有数据库，使用安全的默认值。现有记录的 `device_id` 设为 `''`（空字符串），`uuid` 用生成值回填。

#### 场景：升级时数据库迁移
- **当** 应用打开一个没有 `uuid` / `device_id` 列的现有数据库
- **则** 通过 `ALTER TABLE ADD COLUMN` 添加列，不丢失数据
- **则** 现有记录获得生成的 `uuid` 和空 `device_id`
