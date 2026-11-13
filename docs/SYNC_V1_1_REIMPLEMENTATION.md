# 多设备同步 v1.1 重实现

## 基线

- 上游：`c17a966`（`v1.1.4-rc.2`，2026-11-11）
- 首次重实现基线：`cf79fec`（`v1.1.0` 后两次修复）
- 旧实现：`feat/sync`，仅作为行为与协议参考
- 原则：以上游模块和查询口径为主体，不移植旧页面或旧 `commands.rs`

## 本轮范围

- 设备身份：不可编辑 `device_id`、可编辑 `device_name`
- 活动、日报、小时摘要：设备维度、增量推拉、UPSERT
- 截图：按设备目录存储，支持 full / thumbnail / none
- AI 实体分类缓存：跨设备同步，复用学习结果
- UI：存储页同步配置；概览、时间线、日报设备筛选
- 服务端：Bearer 认证、设备注册、数据/截图推拉

## 不同步的数据

- `memory_chunks`、FTS：活动数据的派生索引，本机重建
- `insights`：派生结果，当前无稳定 ID 与删除语义
- `assistant_conversations` / `assistant_messages`：待补 UUID、墓碑与冲突规则后再做
- `AppConfig`：含模型 Key、Bot 凭据等敏感信息，禁止整份上传

因此 `AppConfig.idle_exempt_app_names` 也仅保存在本机。空闲豁免应用的当前实现、行为边界和验收清单见 [`archive/2026-08-03-idle-exempt-apps.md`](archive/2026-08-03-idle-exempt-apps.md)。

## 实现约束

- `Activity` 等现有业务 DTO 不新增同步字段；同步层使用专用记录 DTO
- 配置损坏或从备份恢复时，不因生成 `device_id` 自动写盘
- `None` 设备筛选表示全设备聚合；具体 ID 表示单设备
- 同步游标只在对应阶段完整成功后推进
- `entity_category_cache` 以 `entity_key` 为键、较新的 `created_at` 胜出

## 验证

- core schema 迁移与 UPSERT 单测
- sync-server API/数据库单测
- `cargo check --workspace`
- 前端测试与构建
- 手动验证双设备推拉、筛选、截图保留和离线重试


## 2026-11-13 合并上游

- 合并前先独立提交同步服务的时间范围查询接口（`bf1c2df`）。
- 前端设备筛选接入上游 TypeScript 与时间线网关；日报请求快照和缓存键保留设备维度。
- 保留同步 schema、协议、设备目录和空闲豁免；WebDAV 配置同步不得覆盖本机同步身份、游标、设备筛选及空闲豁免列表。
- 上游截图清理适配设备目录，并仅清空实际删除目录的本地路径；保留上游元数据自动清理默认关闭的行为。
- 本轮只做上游合并及必要适配，不新增 OCR 或数据库保留策略，不对实际数据库执行清理。
- 验证入口：`npm run verify:frontend`、`cargo test --workspace --all-targets`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test --manifest-path sync-server/Cargo.toml`。
