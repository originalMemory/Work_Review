## Context

录制循环（`main.rs`）在每次落库前用 `should_confirm_idle`（键鼠空闲 + 可选截图哈希 + 20 分钟硬切断）决定 `effective_duration` 是否归零；应用切换时用 `previous_app_backfill_duration` 把间隔补到上一应用，但在 `was_input_idle` 或 `is_confirmed_idle` 时回补为 0。挂机游戏、Galgame 等场景下即使用户真实处于前台，也会被记短。用户希望在**设置 → 常规**中维护豁免列表，数据来源为本机 `activities` 表已出现过的 `app_name`。

## Goals / Non-Goals

**Goals:**

- 配置中持久化一组豁免应用名（与活动记录中的 `app_name` 一致），UI 从本机历史应用名中选择添加。
- 当前前台应用（及切换时的「上一应用」回补逻辑）若在豁免列表中，则**不因空闲检测而丢弃时长**（不将 `effective_duration` 置 0；切换时仍按 `duration_to_record` 回补上一应用，忽略 `was_input_idle` / `is_confirmed_idle` 对回补的抑制）。
- 仍保留现有截图间隔、`PrivacyAction::Skip`、合并规则等非空闲逻辑。

**Non-Goals:**

- 不按 Bundle ID / 可执行路径匹配（首版仅 `app_name` 字符串精确匹配，与库内展示一致）。
- 不自动同步豁免列表到其他设备（见 `proposal.md`）。
- 不为 PiP /  overlay 子窗口单独豁免（除非其实现为独立 `app_name` 且用户加入列表）。

## Decisions

1. **配置字段位置**  
   在 `AppConfig`（`config.rs`）新增 `idle_exempt_app_names: Vec<String>`，`#[serde(default)]` 默认为空。与「常规」设置同文件序列化，无需新表。

2. **匹配规则**  
   使用**精确字符串匹配**当前 `active_window.app_name`（及切换回补时的 `previous_app_name`）。与数据库 `DISTINCT app_name` 候选一致，避免「同名不同显示」歧义。不自动 `trim` 除非现有监控层已对名称规范化——若 `normalize_display_app_name` 仅用于统计而非存储，则以**落库原始名**为准并在 UI 展示候选时与配置一致。

3. **空闲判定注入点**（实现时在 `main.rs` 集中处理，避免改动 `idle_detector` 全局语义）  
   - 在计算 `is_confirmed_idle` 之后：若当前前台 `app_name` 在豁免列表，则对**本条** `effective_duration` 的计算视为「非确认空闲」（按非空闲路径使用 `adjusted_duration`）。  
   - 对 `previous_app_backfill_duration`：扩展为知晓「上一应用名」是否在豁免列表；若豁免，则**不因** `was_input_idle` / `is_confirmed_idle` 将回补置 0（仍需 `app_changed && duration_to_record > 0`）。  
   - 匿名化分支里 `anonymized_is_confirmed_idle` 若与通用空闲逻辑共用，豁免应用应同样跳过「空闲归零」。

4. **候选应用 API**  
   在 `database.rs` 新增只读方法，例如 `list_distinct_app_names() -> Result<Vec<String>>`：`SELECT DISTINCT app_name FROM activities WHERE TRIM(app_name) != '' ORDER BY app_name COLLATE NOCASE`（或等价排序）。`commands.rs` 暴露 Tauri command `get_recorded_app_names`（命名可与现有风格对齐）。可选：排除占位名如 `Unknown` 不出现在候选（可在 spec 中定为 SHOULD 以减轻误选）。

5. **前端 UI**  
   在 `SettingsGeneral.svelte` 增加卡片：说明文案 + 多选/Chip 列表；打开设置或展开区块时 `invoke` 拉取候选；已选列表绑定 `config.idle_exempt_app_names`，变更时 `dispatch('change')`。已保存但暂无历史记录的名称可仍显示在已选列表中（配置为准），候选查询合并「已选项」防止丢失显示。

## Risks / Trade-offs

- **[Risk] 应用更名或本地化显示名变化** → 豁免失效；缓解：用户可重新从新的历史记录中添加。  
- **[Risk] 用户把常用办公应用加入豁免** → 离开座位仍累加；缓解：文案警示 + 列表精简。  
- **[Risk] `app_name` 重复类别（多进程同名）** → 无法细分；首版接受，与 proposal Non-goals 一致。

## Migration Plan

- 配置新增字段带 `default`，旧配置文件反序列化自动得到空列表，无破坏。  
- 无需数据库迁移。

## Open Questions

- 是否在候选列表中默认隐藏 `Unknown`：建议在实现时隐藏，除非用户已在配置中包含该项。
