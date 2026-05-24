## 1. 配置与类型

- [x] 1.1 在 `AppConfig`（`config.rs`）新增 `idle_exempt_app_names: Vec<String>`，`serde` 默认空列表；更新默认构造/合并逻辑（若有集中 `Default`）
- [x] 1.2 新增小工具函数：给定 `app_name` 与 `&AppConfig`，判断是否在豁免列表（精确匹配）；供录制循环与命令复用

## 2. 数据库与 Tauri 命令

- [x] 2.1 在 `database.rs` 实现 `list_distinct_recorded_app_names`（或等价命名）：`SELECT DISTINCT app_name FROM activities`，过滤空名；可选排除 `Unknown`；排序便于 UI
- [x] 2.2 在 `commands.rs` 注册 `get_recorded_app_names`（或项目命名惯例），返回 `Vec<String>`；在 `lib.rs` / `main.rs` 的 invoke 列表中注册

## 3. 录制主循环（空闲豁免）

- [x] 3.1 在 `main.rs` 录制路径中读取当前配置的豁免列表；对**当前前台** `app_name`：在计算 `effective_duration` 时若豁免则忽略「确认空闲」导致的归零（覆盖合并、新建、无截图、脱敏等分支）
- [x] 3.2 扩展 `previous_app_backfill_duration`（或等价封装）：传入「上一应用是否豁免」；豁免时忽略 `was_input_idle` / `is_confirmed_idle` 对回补的抑制，保留 `app_changed` 与 `duration_to_record > 0` 条件
- [x] 3.3 核对浮动窗口（PiP）路径：默认仅主窗口豁免；若文档化不扩展，确保主路径无回归

## 4. 前端常规设置

- [x] 4.1 在 `SettingsGeneral.svelte`（或常规页实际组件）增加「空闲检测豁免应用」区块：说明文案、已选标签/列表、从候选添加、移除
- [x] 4.2 `onMount` 或可见时 `invoke('get_recorded_app_names')`；将候选与 `config.idle_exempt_app_names` 合并展示；变更时 `dispatch('change', config)`
- [x] 4.3 若有 TypeScript 配置类型定义（前端 `config` 接口），同步新增字段

## 5. 文案与验证

- [x] 5.1 在 `i18n` 中为标题、说明、空状态补充中英（或项目已有语言）键值
- [x] 5.2 手动验证：将测试应用加入豁免后，长时间无输入仍累计；切换应用后上一应用时长回补；隐私「完全跳过」仍不写库
