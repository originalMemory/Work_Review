# feat/sync 相对上游最新 `main` 的说明

本文档只做两件事：**记录 `feat/sync` 与 `upstream/main` 的差异**，以及**沉淀把本分支变基到上游最新时的固定操作流程**。上游各版本自身的变更说明以原仓库 `CHANGELOG.md` 为准，此处不再复述。

## 当前基线（最近一次更新）

| 项目 | 值 |
|------|-----|
| 上游远程 | `upstream` → `git@github.com:wm94i/Work_Review.git` |
| 上游 `main` 尖端 | `f630403`（tag **v1.0.47**；2026-05-24 同步） |
| 架构 | 数据层已迁入 **`crates/core/`**（config / database 等）；`src-tauri` 为 Tauri 壳与 sync 命令 |
| 备份分支 | `feat/sync-pre-rebase-backup-20260524`（变基前本地 `feat/sync` 快照，含旧 monolith 结构） |
| 合并基 | 以 `git merge-base feat/sync upstream/main` 为准；目标是在 v1.0.47 之上线性延伸 sync 能力 |

## 标准操作流程（fork 更新 + feat/sync 变基）

在仓库根目录执行；已配置好 `origin`（你的 fork）与 `upstream`（原项目）。

1. **拉取上游**  
   `git fetch upstream`

2. **（建议）本地备份当前分支**  
   在变基前打标签或分支，便于回滚：  
   `git branch feat/sync-pre-rebase-backup-$(date +%Y%m%d) feat/sync`

3. **检出并变基**  
   `git checkout feat/sync`  
   `git rebase upstream/main`

4. **处理冲突**  
   - 按文件逐个解决后 `git add <path>`，再 `git rebase --continue`。  
   - 无图形编辑器时：`GIT_EDITOR=true git rebase --continue`  
   - 放弃本次变基：`git rebase --abort`

5. **编译自检**  
   `cd src-tauri && cargo check`（必要时再跑前端构建）

6. **推送到 fork**  
   变基会改写历史，需：  
   `git push --force-with-lease origin feat/sync`

7. **（可选）把 fork 的 `main` 跟上上游**  
   若你希望 fork 的默认分支与上游一致：  
   `git checkout main && git fetch upstream && git reset --hard upstream/main`（若本地 `main` 无独有提交；否则用 `merge upstream/main`），再 `git push origin main`。

## feat/sync 相对 `upstream/main`（v1.0.47）的差异概要

以下为本分支相对 **v1.0.47 一代主干** 多出的能力与设计，按主题归纳（不展开上游已合并的通用功能）。

- **多设备数据模型**（`crates/core/`）：活动、日报、小时摘要等带 `device_id` / `uuid`；截图目录 `screenshots/{device_id}/日期/`；查询按设备隔离。
- **同步子系统**：`src-tauri/src/sync.rs`、Tauri 命令、设置页同步卡片；独立 **`sync-server/`**。
- **前端**：`DeviceFilter`、`selectedDeviceId` 持久化；概览/时间线/日报设备筛选与多设备日报分段；设置页 sync 段与空闲豁免应用 UI。
- **工程与规格**：OpenSpec 目录、`.claude` 下 opsx 命令与技能、设计/排障文档。

**前端合并策略（v1.0.47 rebase）**：禁止从 backup 整文件 checkout（会回退上游 UI）。应在 upstream 版本上做 **最小 sync 补丁**；参考 `feat/sync-pre-rebase-backup-20260524` 中的 sync-only diff。

## 最近一次变基备忘（v1.0.47 / core crate port）

自 backup 分支变基到 **`f630403`（v1.0.47）** 时需关注的合并点：

| 区域 | 说明 |
|------|------|
| `crates/core/` | 在 upstream database/config 之上移植 `device_id`、`SyncConfig`、`get_timeline_filtered`、`get_reports_by_date` 等 |
| `src-tauri/src/main.rs` | 保留 sync 后台任务、`backfill_device_id`、invoke 注册；与上游 avatar / macOS 采集等并列 |
| `src-tauri/src/commands.rs` | 统计/时间线命令加 `device_id`；sync 命令与 `get_known_devices` |
| 前端 | **保留** upstream v1.0.47 UI（presets、DOMPurify、S3/WebDAV、语义分类等），**叠加** DeviceFilter / sync 设置 / 多设备日报 |

备份分支（本次）：`feat/sync-pre-rebase-backup-20260524` 指向变基前的本地 `feat/sync` 尖端。

## 重点手测清单（多设备 + 同步）

1. 截图路径：`screenshots/{device_id}/日期/` 与库中路径一致。  
2. 概览 / 时间线 / 时段摘要：切换设备筛选后数据不与其它设备混淆。  
3. 日报：多设备分段、缓存维度（locale + device）、导出命名。  
4. 同步：推拉活动、日报、小时摘要；截图单文件上传/下载；增量游标。  
5. 与上游近期功能：日报 presets / `fallback_reason` / 语义分类与 **`device_id`** 交叉处。

若上游后续继续改 **`daily_reports_localized`、日报生成命令、`Report.svelte`、`App.svelte`、`Overview.svelte`** 或统计 SQL，下次变基仍优先检查这些与 **`device_id`** 的交叉处。
