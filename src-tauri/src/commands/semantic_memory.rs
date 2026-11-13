//! 语义记忆（屏幕级数字记忆）。
//!
//! 把已采集的 OCR 文本、窗口标题和 URL 聚合为记忆块，经嵌入模型向量化后支持
//! 语义检索。索引与召回均执行当前完整隐私规则；任何状态或指纹不一致都会关闭
//! 向量召回并降级为关键词检索，避免使用过期或不符合当前隐私配置的向量。

use crate::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use work_review_core::config::{AppConfig, PrivacyConfig};
use work_review_core::database::{
    encode_embedding, normalize_embedding, Activity, Database, MemorySearchItem, SemanticMemoryHit,
    SemanticMemoryIndexState, SemanticMemoryStats, SEMANTIC_MEMORY_CURSOR_CHUNK_KEY,
};
use work_review_core::error::AppError;
use work_review_core::privacy::PrivacyAction;

/// 单轮索引最多消费的活动行数（前端循环调用直至完成）。
const INDEX_ACTIVITY_BATCH: usize = 1500;
/// 单轮索引最多嵌入的块数（控制单次调用时长）。
const EMBED_BATCH: usize = 32;
/// 记忆块正文上限（字符）。
const CHUNK_CONTENT_MAX_CHARS: usize = 1200;
/// 分块规则变化时必须重建索引。
pub(crate) const CHUNK_RULE_VERSION: &str = "semantic-chunk-v2";
/// 向量归一化规则变化时必须重建索引。
pub(crate) const NORMALIZATION_VERSION: &str = "l2-v1";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIndexProgress {
    /// 本轮消费的活动行数。
    pub processed_activities: usize,
    /// 本轮新写入或更新的记忆块数。
    pub upserted_chunks: usize,
    /// 本轮完成嵌入的块数。
    pub embedded_chunks: usize,
    /// 仍待嵌入的块数。
    pub pending_embeddings: usize,
    /// 活动游标是否已追平。
    pub activities_done: bool,
    /// 兼容既有调用方的块统计。
    pub stats: SemanticMemoryStats,
    /// 真实持久化索引状态。
    pub state: SemanticMemoryIndexState,
}

#[derive(Clone, Debug)]
struct EmbeddingConfig {
    provider: String,
    endpoint: String,
    model: String,
    api_key: Option<String>,
}

#[derive(Clone, Debug)]
struct SemanticBuildToken {
    build_id: String,
    embedding_fingerprint: String,
    privacy_fingerprint: String,
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// 规范化嵌入地址。只删除无语义的首尾空白、fragment 和末尾斜杠，
/// 不强行修改路径大小写，避免把实际不同的服务地址视为同一配置。
pub(crate) fn normalize_embedding_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    if let Ok(mut url) = reqwest::Url::parse(trimmed) {
        url.set_fragment(None);
        return url.to_string().trim_end_matches('/').to_string();
    }
    trimmed.trim_end_matches('/').to_string()
}

fn embedding_config_fingerprint_from_values(provider: &str, endpoint: &str, model: &str) -> String {
    let canonical = format!(
        "provider={}\nendpoint={}\nmodel={}\nchunk={}\nnormalization={}",
        provider.trim().to_ascii_lowercase(),
        normalize_embedding_endpoint(endpoint),
        model.trim(),
        CHUNK_RULE_VERSION,
        NORMALIZATION_VERSION,
    );
    sha256_hex(&canonical)
}

/// 配置级指纹不包含 API Key，也不包含运行时探测到的向量维度。
/// 用于配置保存时判断是否需要立即使旧索引失效。
pub(crate) fn embedding_config_fingerprint(config: &AppConfig) -> String {
    embedding_config_fingerprint_from_values(
        &config.embedding_provider,
        &config.embedding_endpoint,
        &config.embedding_model,
    )
}

fn embedding_config_fingerprint_for_runtime(config: &EmbeddingConfig) -> String {
    embedding_config_fingerprint_from_values(&config.provider, &config.endpoint, &config.model)
}

/// 最终索引指纹包含真实向量维度。格式保留配置指纹前缀，便于在不调用服务时
/// 先检查 Provider、Endpoint、模型和规则版本是否一致。
fn embedding_fingerprint(config: &EmbeddingConfig, dimension: usize) -> String {
    format!(
        "{}:{dimension}",
        embedding_config_fingerprint_for_runtime(config)
    )
}

fn normalize_unordered_fingerprint_values(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut normalized: Vec<String> = values.into_iter().collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

/// 隐私指纹必须与真实判定语义一致：应用规则采用“首个匹配项”语义，因此保留顺序；
/// 其余集合规则排序去重。结构化 JSON 编码避免分隔符造成规范化碰撞。
pub(crate) fn privacy_fingerprint(config: &PrivacyConfig) -> String {
    let app_rules: Vec<serde_json::Value> = config
        .app_rules
        .iter()
        .map(|rule| {
            serde_json::json!({
                "appName": work_review_core::categorize::normalize_display_app_name(&rule.app_name)
                    .to_lowercase(),
                "level": rule.level,
            })
        })
        .collect();
    let excluded_apps =
        normalize_unordered_fingerprint_values(config.excluded_apps.iter().map(|app| {
            work_review_core::categorize::normalize_display_app_name(app).to_lowercase()
        }));
    let excluded_keywords = normalize_unordered_fingerprint_values(
        config
            .excluded_keywords
            .iter()
            .map(|keyword| keyword.to_lowercase()),
    );
    let excluded_domains = normalize_unordered_fingerprint_values(
        config
            .excluded_domains
            .iter()
            .map(|domain| PrivacyConfig::extract_domain(domain))
            .filter(|domain| !domain.is_empty()),
    );
    let canonical = serde_json::json!({
        "appRules": app_rules,
        "excludedApps": excluded_apps,
        "excludedKeywords": excluded_keywords,
        "excludedDomains": excluded_domains,
    });
    sha256_hex(&serde_json::to_string(&canonical).expect("隐私指纹 JSON 序列化不应失败"))
}

pub(crate) fn invalidate_semantic_memory_index(database: &Database) -> Result<(), AppError> {
    database.clear_memory_chunks_and_mark_rebuild_required()
}

fn load_embedding_config(state: &Arc<Mutex<AppState>>) -> Result<EmbeddingConfig, AppError> {
    let state = state.lock().map_err(|e| AppError::Unknown(e.to_string()))?;
    if !state.config.memory_semantic_enabled {
        return Err(AppError::Config(
            "语义记忆未启用，请到「设置 → AI 模型」开启".to_string(),
        ));
    }
    Ok(EmbeddingConfig {
        provider: state.config.embedding_provider.trim().to_ascii_lowercase(),
        endpoint: normalize_embedding_endpoint(&state.config.embedding_endpoint),
        model: state.config.embedding_model.trim().to_string(),
        api_key: state.config.embedding_api_key.clone(),
    })
}

fn embedding_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Unknown(format!("创建嵌入 HTTP 客户端失败: {e}")))
}

/// 调用嵌入服务，返回与输入等长的归一化向量列表。
async fn embed_texts(
    config: &EmbeddingConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = embedding_client()?;

    if config.provider == "openai" {
        let url = if config.endpoint.contains("/v1") {
            format!("{}/embeddings", config.endpoint)
        } else {
            format!("{}/v1/embeddings", config.endpoint)
        };
        let mut request = client
            .post(&url)
            .json(&serde_json::json!({ "model": config.model, "input": texts }));
        if let Some(key) = config
            .api_key
            .as_deref()
            .filter(|key| !key.trim().is_empty())
        {
            request = request.header("Authorization", format!("Bearer {key}"));
        }
        let response = request
            .send()
            .await
            .map_err(|e| AppError::Analysis(format!("嵌入请求失败: {e}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let body: String = response
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            return Err(AppError::Analysis(format!(
                "嵌入服务返回 HTTP {status}: {body}"
            )));
        }
        let payload: serde_json::Value = response
            .json()
            .await
            .map_err(|e| AppError::Analysis(format!("嵌入响应解析失败: {e}")))?;
        let data = payload["data"]
            .as_array()
            .ok_or_else(|| AppError::Analysis("嵌入响应缺少 data 字段".to_string()))?;
        let mut vectors = Vec::with_capacity(texts.len());
        for item in data {
            let vector: Vec<f32> = item["embedding"]
                .as_array()
                .ok_or_else(|| AppError::Analysis("嵌入响应缺少 embedding 字段".to_string()))?
                .iter()
                .filter_map(|value| value.as_f64().map(|number| number as f32))
                .collect();
            vectors.push(normalize_embedding(vector));
        }
        if vectors.len() != texts.len() {
            return Err(AppError::Analysis(format!(
                "嵌入结果数量不匹配: 期望 {} 实际 {}",
                texts.len(),
                vectors.len()
            )));
        }
        Ok(vectors)
    } else {
        let url = format!("{}/api/embeddings", config.endpoint);
        let mut vectors = Vec::with_capacity(texts.len());
        for text in texts {
            let response = client
                .post(&url)
                .json(&serde_json::json!({ "model": config.model, "prompt": text }))
                .send()
                .await
                .map_err(|e| {
                    AppError::Analysis(format!(
                        "Ollama 嵌入请求失败（请确认 Ollama 已启动并已拉取模型 {}）: {e}",
                        config.model
                    ))
                })?;
            if !response.status().is_success() {
                let status = response.status();
                let body: String = response
                    .text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect();
                // 模型未拉取是最常见的部署遗漏：404 + not found 时直接给出安装命令
                if status.as_u16() == 404 && body.contains("not found") {
                    return Err(AppError::Analysis(format!(
                        "嵌入模型 {model} 未安装：请在终端执行 ollama pull {model} 后重试（原始错误：HTTP {status}: {body}）",
                        model = config.model
                    )));
                }
                return Err(AppError::Analysis(format!(
                    "Ollama 嵌入返回 HTTP {status}: {body}"
                )));
            }
            let payload: serde_json::Value = response
                .json()
                .await
                .map_err(|e| AppError::Analysis(format!("Ollama 嵌入响应解析失败: {e}")))?;
            let vector: Vec<f32> = payload["embedding"]
                .as_array()
                .ok_or_else(|| {
                    AppError::Analysis("Ollama 嵌入响应缺少 embedding 字段".to_string())
                })?
                .iter()
                .filter_map(|value| value.as_f64().map(|number| number as f32))
                .collect();
            vectors.push(normalize_embedding(vector));
        }
        Ok(vectors)
    }
}

/// 记忆块草稿（分块结果，纯数据）。
#[derive(Debug, Clone)]
pub(crate) struct ChunkDraft {
    pub chunk_key: String,
    pub date: String,
    pub app_name: String,
    pub title: String,
    pub browser_url: Option<String>,
    pub content: String,
    pub last_activity_id: i64,
}

fn local_date_of_timestamp(timestamp: i64) -> String {
    chrono::DateTime::from_timestamp(timestamp, 0)
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn domain_of(url: &str) -> String {
    let trimmed = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    trimmed
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_string()
}

/// 把活动记录聚合成记忆块草稿。
pub(crate) fn build_chunk_drafts(activities: &[Activity]) -> Vec<ChunkDraft> {
    struct Group {
        date: String,
        app_name: String,
        title: String,
        browser_url: Option<String>,
        best_ocr: String,
        titles: Vec<String>,
        last_activity_id: i64,
    }

    let mut groups: HashMap<String, Group> = HashMap::new();
    for activity in activities {
        let Some(id) = activity.id else { continue };
        let title = activity.window_title.trim();
        if title.is_empty() || title == "[内容已脱敏]" {
            continue;
        }
        let ocr = activity.ocr_text.as_deref().unwrap_or("").trim();
        if ocr.is_empty() && activity.browser_url.is_none() && title.chars().count() < 4 {
            continue;
        }

        let date = local_date_of_timestamp(activity.timestamp);
        let group_hint = activity
            .browser_url
            .as_deref()
            .map(domain_of)
            .filter(|domain| !domain.is_empty())
            .unwrap_or_else(|| title.chars().take(80).collect());
        let chunk_key = format!("{date}|{}|{group_hint}", activity.app_name);

        let entry = groups.entry(chunk_key).or_insert_with(|| Group {
            date,
            app_name: activity.app_name.clone(),
            title: title.to_string(),
            browser_url: activity.browser_url.clone(),
            best_ocr: String::new(),
            titles: Vec::new(),
            last_activity_id: id,
        });
        entry.last_activity_id = entry.last_activity_id.max(id);
        if ocr.chars().count() > entry.best_ocr.chars().count() {
            entry.best_ocr = ocr.to_string();
        }
        if entry.browser_url.is_none() {
            entry.browser_url = activity.browser_url.clone();
        }
        let title_owned = title.to_string();
        if !entry.titles.contains(&title_owned) && entry.titles.len() < 5 {
            entry.titles.push(title_owned);
        }
    }

    let mut drafts: Vec<ChunkDraft> = groups
        .into_iter()
        .map(|(chunk_key, group)| {
            let mut content = format!("{} | {}", group.app_name, group.titles.join(" / "));
            if let Some(url) = &group.browser_url {
                content.push_str(&format!("\n{url}"));
            }
            if !group.best_ocr.is_empty() {
                content.push('\n');
                content.push_str(&group.best_ocr);
            }
            let content: String = content.chars().take(CHUNK_CONTENT_MAX_CHARS).collect();
            ChunkDraft {
                chunk_key,
                date: group.date,
                app_name: group.app_name,
                title: group.title,
                browser_url: group.browser_url,
                content,
                last_activity_id: group.last_activity_id,
            }
        })
        .collect();
    drafts.sort_by_key(|draft| draft.last_activity_id);
    drafts
}

fn fail_build_if_active(database: &Database, token: &SemanticBuildToken, error: &AppError) {
    match database.fail_semantic_memory_build(
        &token.build_id,
        &token.embedding_fingerprint,
        &token.privacy_fingerprint,
        &error.to_string(),
    ) {
        Ok(true) | Ok(false) => {}
        Err(update_error) => log::error!("记录语义索引失败状态时出错: {update_error}"),
    }
}

async fn start_rebuild(
    database: &Database,
    embedding: &EmbeddingConfig,
    current_privacy_fingerprint: &str,
) -> Result<SemanticMemoryIndexState, AppError> {
    let build_id = uuid::Uuid::new_v4().simple().to_string();
    let provisional_embedding_fingerprint = embedding_config_fingerprint_for_runtime(embedding);
    database.begin_semantic_memory_build(
        &build_id,
        &provisional_embedding_fingerprint,
        current_privacy_fingerprint,
    )?;
    let provisional_token = SemanticBuildToken {
        build_id: build_id.clone(),
        embedding_fingerprint: provisional_embedding_fingerprint.clone(),
        privacy_fingerprint: current_privacy_fingerprint.to_string(),
    };

    // 先声明唯一代际再探测模型：失败可精确落到本任务，同指纹的新任务不受影响。
    let probe = match embed_texts(embedding, &["semantic memory index probe".to_string()]).await {
        Ok(probe) => probe,
        Err(error) => {
            fail_build_if_active(database, &provisional_token, &error);
            return Err(error);
        }
    };
    let dimension = probe.first().map(Vec::len).unwrap_or(0);
    if dimension == 0 {
        let error = AppError::Analysis("嵌入服务返回了空向量".to_string());
        fail_build_if_active(database, &provisional_token, &error);
        return Err(error);
    }
    let final_embedding_fingerprint = embedding_fingerprint(embedding, dimension);

    if !database.activate_semantic_memory_build(
        &build_id,
        &provisional_embedding_fingerprint,
        &final_embedding_fingerprint,
        current_privacy_fingerprint,
    )? {
        return Err(AppError::Config(
            "语义索引重建已被更新的任务替代".to_string(),
        ));
    }
    database.get_semantic_memory_state()
}

fn build_matches_current_config(
    index_state: &SemanticMemoryIndexState,
    embedding: &EmbeddingConfig,
    current_privacy_fingerprint: &str,
) -> bool {
    let expected_prefix = format!("{}:", embedding_config_fingerprint_for_runtime(embedding));
    !index_state.build_id.is_empty()
        && index_state.status == "building"
        && index_state
            .embedding_fingerprint
            .starts_with(&expected_prefix)
        && index_state.privacy_fingerprint == current_privacy_fingerprint
}

fn build_token(index_state: &SemanticMemoryIndexState) -> SemanticBuildToken {
    SemanticBuildToken {
        build_id: index_state.build_id.clone(),
        embedding_fingerprint: index_state.embedding_fingerprint.clone(),
        privacy_fingerprint: index_state.privacy_fingerprint.clone(),
    }
}

fn ensure_current_build_context(
    state: &AppState,
    embedding: &EmbeddingConfig,
    token: &SemanticBuildToken,
) -> Result<(), AppError> {
    let current_embedding_config = embedding_config_fingerprint(&state.config);
    let expected_embedding_config = embedding_config_fingerprint_for_runtime(embedding);
    let current_privacy = privacy_fingerprint(&state.config.privacy);
    if !state.config.memory_semantic_enabled
        || current_embedding_config != expected_embedding_config
        || current_privacy != token.privacy_fingerprint
    {
        return Err(AppError::Config(
            "语义索引配置或隐私规则已变化，请重新建立".to_string(),
        ));
    }
    Ok(())
}

async fn index_semantic_memory_inner(
    state_arc: &Arc<Mutex<AppState>>,
) -> Result<SemanticIndexProgress, AppError> {
    let embedding = load_embedding_config(state_arc)?;
    let (database, current_privacy_fingerprint) = {
        let state = state_arc
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        (
            state.database.clone(),
            privacy_fingerprint(&state.config.privacy),
        )
    };

    let mut index_state = database.get_semantic_memory_state()?;
    if !build_matches_current_config(&index_state, &embedding, &current_privacy_fingerprint) {
        index_state = start_rebuild(&database, &embedding, &current_privacy_fingerprint).await?;
    }
    let token = build_token(&index_state);

    let result = async {
        if !database.is_semantic_memory_build_current(
            &token.build_id,
            &token.embedding_fingerprint,
            &token.privacy_fingerprint,
        )? {
            return Err(AppError::Config(
                "语义索引重建已被更新的任务替代".to_string(),
            ));
        }

        let cursor = database.semantic_memory_stats()?.last_indexed_activity_id;
        let initial_activities = database.get_activities_after_id(cursor, INDEX_ACTIVITY_BATCH)?;
        let max_id = initial_activities
            .iter()
            .filter_map(|activity| activity.id)
            .max()
            .unwrap_or(cursor);

        // 入库前重新读取活动并应用当前隐私过滤；持有 AppState 锁期间，配置保存和
        // 删除活动无法穿过该校验，数据库条件写入再校验 build_id、指纹和来源活动。
        let (processed, upserted) = {
            let state = state_arc
                .lock()
                .map_err(|e| AppError::Unknown(e.to_string()))?;
            ensure_current_build_context(&state, &embedding, &token)?;
            if !database.is_semantic_memory_build_current(
                &token.build_id,
                &token.embedding_fingerprint,
                &token.privacy_fingerprint,
            )? {
                return Err(AppError::Config("语义索引在块入库前已失效".to_string()));
            }

            let activities: Vec<Activity> = state
                .database
                .get_activities_after_id(cursor, INDEX_ACTIVITY_BATCH)?
                .into_iter()
                .filter(|activity| activity.id.unwrap_or_default() <= max_id)
                .collect();
            let processed = activities.len();
            let allowed: Vec<Activity> = activities
                .into_iter()
                .filter(|activity| {
                    state.privacy_filter.check_privacy_full(
                        &activity.app_name,
                        &activity.window_title,
                        activity.browser_url.as_deref(),
                    ) == PrivacyAction::Record
                })
                .collect();
            let mut drafts = build_chunk_drafts(&allowed);

            // 即使本批全部被隐私规则过滤，也要推进持久化游标。
            if let Some(last) = drafts.last_mut() {
                last.last_activity_id = last.last_activity_id.max(max_id);
            } else if max_id > cursor {
                drafts.push(ChunkDraft {
                    chunk_key: SEMANTIC_MEMORY_CURSOR_CHUNK_KEY.to_string(),
                    date: "1970-01-01".to_string(),
                    app_name: "__cursor__".to_string(),
                    title: "__cursor__".to_string(),
                    browser_url: None,
                    content: "__cursor__".to_string(),
                    last_activity_id: max_id,
                });
            }

            let mut upserted = 0usize;
            for draft in &drafts {
                let written = database.upsert_memory_chunk_if_current_build(
                    &token.build_id,
                    &token.embedding_fingerprint,
                    &token.privacy_fingerprint,
                    &draft.chunk_key,
                    &draft.date,
                    &draft.app_name,
                    &draft.title,
                    draft.browser_url.as_deref(),
                    &draft.content,
                    draft.last_activity_id,
                )?;
                if !written {
                    return Err(AppError::Config(
                        "语义索引在块入库前已失效或来源活动已删除".to_string(),
                    ));
                }
                if draft.chunk_key != SEMANTIC_MEMORY_CURSOR_CHUNK_KEY {
                    upserted += 1;
                }
            }
            (processed, upserted)
        };

        let pending = database.get_unembedded_memory_chunks_if_current_build(
            &token.build_id,
            &token.embedding_fingerprint,
            &token.privacy_fingerprint,
            EMBED_BATCH,
        )?;
        let mut embedded = 0usize;
        if !pending.is_empty() {
            let texts = {
                let state = state_arc
                    .lock()
                    .map_err(|e| AppError::Unknown(e.to_string()))?;
                ensure_current_build_context(&state, &embedding, &token)?;
                if !database.is_semantic_memory_build_current(
                    &token.build_id,
                    &token.embedding_fingerprint,
                    &token.privacy_fingerprint,
                )? {
                    return Err(AppError::Config(
                        "语义索引在发送嵌入请求前已失效".to_string(),
                    ));
                }
                for chunk in &pending {
                    let activity = database
                        .get_activity_by_id(chunk.last_activity_id)?
                        .ok_or_else(|| {
                            AppError::Config("语义块来源活动已删除，已取消嵌入请求".to_string())
                        })?;
                    let activity_allowed = state.privacy_filter.check_privacy_full(
                        &activity.app_name,
                        &activity.window_title,
                        activity.browser_url.as_deref(),
                    ) == PrivacyAction::Record;
                    let chunk_allowed = state.privacy_filter.check_privacy_full(
                        &chunk.app_name,
                        &chunk.title,
                        chunk.browser_url.as_deref(),
                    ) == PrivacyAction::Record;
                    if !activity_allowed || !chunk_allowed {
                        return Err(AppError::Config(
                            "语义块不再满足当前隐私规则，已取消嵌入请求".to_string(),
                        ));
                    }
                }
                pending
                    .iter()
                    .map(|chunk| chunk.content.clone())
                    .collect::<Vec<_>>()
            };

            // 紧邻外发再校验一次代际；失效任务不得把已删除或新禁用内容发送出去。
            if !database.is_semantic_memory_build_current(
                &token.build_id,
                &token.embedding_fingerprint,
                &token.privacy_fingerprint,
            )? {
                return Err(AppError::Config(
                    "语义索引在发送嵌入请求前已失效".to_string(),
                ));
            }
            let vectors = embed_texts(&embedding, &texts).await?;
            let expected_dimension = token
                .embedding_fingerprint
                .rsplit_once(':')
                .and_then(|(_, dimension)| dimension.parse::<usize>().ok())
                .unwrap_or(0);
            if vectors
                .iter()
                .any(|vector| vector.len() != expected_dimension)
            {
                return Err(AppError::Analysis(
                    "嵌入向量维度在重建过程中发生变化，请重试".to_string(),
                ));
            }
            for (chunk, vector) in pending.iter().zip(vectors.iter()) {
                if database.set_memory_chunk_embedding_if_current_build(
                    &token.build_id,
                    chunk.id,
                    &chunk.content,
                    &encode_embedding(vector),
                    &token.embedding_fingerprint,
                    &token.privacy_fingerprint,
                )? {
                    embedded += 1;
                }
            }
        }

        if !database.is_semantic_memory_build_current(
            &token.build_id,
            &token.embedding_fingerprint,
            &token.privacy_fingerprint,
        )? {
            return Err(AppError::Config(
                "语义索引在建立过程中已失效，请重新建立".to_string(),
            ));
        }
        index_state = database.get_semantic_memory_state()?;
        let stats = database.semantic_memory_stats()?;
        let pending_embeddings = stats.total_chunks.saturating_sub(stats.embedded_chunks);
        let mut activities_done =
            !database.has_activities_after_id(stats.last_indexed_activity_id)?;
        index_state.indexed_activities = index_state
            .indexed_activities
            .saturating_add(processed)
            .min(index_state.total_activities);
        if activities_done && pending_embeddings == 0 {
            index_state.status = "ready".to_string();
            index_state.rebuild_required = false;
            index_state.indexed_activities = index_state.total_activities;
            index_state.last_error = None;
        }
        let updated = database.update_semantic_memory_state_if_current_build(
            &token.build_id,
            &token.embedding_fingerprint,
            &token.privacy_fingerprint,
            &index_state,
        )?;
        if !updated {
            let current = database.get_semantic_memory_state()?;
            if database.is_semantic_memory_build_current(
                &token.build_id,
                &token.embedding_fingerprint,
                &token.privacy_fingerprint,
            )? {
                // 新活动可能在完成检查后插入；保持 building，下一轮继续消费。
                activities_done = false;
                return Ok(SemanticIndexProgress {
                    processed_activities: processed,
                    upserted_chunks: upserted,
                    embedded_chunks: embedded,
                    pending_embeddings,
                    activities_done,
                    stats,
                    state: current,
                });
            }
            return Err(AppError::Config(
                "语义索引在建立过程中已失效，请重新建立".to_string(),
            ));
        }
        let index_state = database.get_semantic_memory_state()?;

        Ok(SemanticIndexProgress {
            processed_activities: processed,
            upserted_chunks: upserted,
            embedded_chunks: embedded,
            pending_embeddings,
            activities_done,
            stats,
            state: index_state,
        })
    }
    .await;

    if let Err(error) = &result {
        fail_build_if_active(&database, &token, error);
    }
    result
}

/// 分批推进一次全量重建。首次调用、失败重试或 ready 状态下主动重建都会先探测模型，
/// 清空旧块并从活动游标 0 开始。
#[tauri::command]
pub async fn index_semantic_memory(
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<SemanticIndexProgress, AppError> {
    let state_arc = state.inner().clone();
    index_semantic_memory_inner(&state_arc).await
}

/// 测试嵌入模型连通性：发一条探针文本，返回向量维度与耗时。
#[tauri::command]
pub async fn test_embedding_model(
    provider: String,
    endpoint: String,
    model: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let endpoint = normalize_embedding_endpoint(&endpoint);
    if endpoint.is_empty() || model.trim().is_empty() {
        return Err(AppError::Config("请先填写嵌入服务地址与模型名".to_string()));
    }
    let embedding = EmbeddingConfig {
        provider: provider.trim().to_ascii_lowercase(),
        endpoint,
        model: model.trim().to_string(),
        api_key,
    };

    let started = std::time::Instant::now();
    let vectors = embed_texts(&embedding, &["connection test".to_string()]).await?;
    let dimension = vectors.first().map(Vec::len).unwrap_or(0);
    if dimension == 0 {
        return Err(AppError::Analysis("嵌入服务返回了空向量".to_string()));
    }
    Ok(serde_json::json!({
        "dimension": dimension,
        "latencyMs": started.elapsed().as_millis() as u64,
    }))
}

/// 返回真实持久化索引状态，供设置页显示重建需求、进度和最后错误。
#[tauri::command]
pub async fn semantic_memory_status(
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<SemanticMemoryIndexState, AppError> {
    let state = state.lock().map_err(|e| AppError::Unknown(e.to_string()))?;
    state.database.get_semantic_memory_state()
}

fn fts_activity_hits(items: Vec<MemorySearchItem>) -> Vec<SemanticMemoryHit> {
    items
        .into_iter()
        // 摘要和日报没有可追溯的应用/域名来源，无法按当前规则证明安全。
        .filter(|item| item.source_type == "activity")
        .map(|item| SemanticMemoryHit {
            chunk_id: item.source_id.unwrap_or_default(),
            date: item.date,
            app_name: item.app_name.unwrap_or_default(),
            title: item.title,
            browser_url: item.browser_url,
            excerpt: item.excerpt,
            score: 0.0,
        })
        .collect()
}

fn filter_hits_by_current_privacy(
    state: &AppState,
    hits: Vec<SemanticMemoryHit>,
) -> Vec<SemanticMemoryHit> {
    hits.into_iter()
        .filter(|hit| hit.app_name != "__cursor__")
        .filter(|hit| {
            state.privacy_filter.check_privacy_full(
                &hit.app_name,
                &hit.title,
                hit.browser_url.as_deref(),
            ) == PrivacyAction::Record
        })
        .collect()
}

/// 内部实现：也供助手 semantic_search 工具桥接调用。
pub(crate) async fn search_semantic_memory_inner(
    state_arc: &Arc<Mutex<AppState>>,
    query: &str,
    limit: usize,
) -> Result<Vec<SemanticMemoryHit>, AppError> {
    let embedding = load_embedding_config(state_arc)?;
    let (database, current_privacy_fingerprint) = {
        let state = state_arc
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        (
            state.database.clone(),
            privacy_fingerprint(&state.config.privacy),
        )
    };
    let index_state = database.get_semantic_memory_state()?;
    let config_prefix = format!("{}:", embedding_config_fingerprint_for_runtime(&embedding));

    // 非 ready、待重建或配置/隐私指纹不一致时禁止向量查询，只保留 FTS。
    let vector_query_allowed = index_state.status == "ready"
        && !index_state.rebuild_required
        && index_state
            .embedding_fingerprint
            .starts_with(&config_prefix)
        && index_state.privacy_fingerprint == current_privacy_fingerprint;

    let semantic_hits = if vector_query_allowed {
        match embed_texts(&embedding, &[query.to_string()]).await {
            Ok(vectors) => match vectors.into_iter().next() {
                Some(query_vector) => {
                    let current_embedding_fingerprint =
                        embedding_fingerprint(&embedding, query_vector.len());
                    if index_state.embedding_fingerprint != current_embedding_fingerprint {
                        log::warn!("嵌入维度或配置指纹变化，语义检索降级并标记待重建");
                        invalidate_semantic_memory_index(&database)?;
                        Vec::new()
                    } else {
                        let hits =
                            database.search_memory_chunks_semantic(&query_vector, limit.max(20))?;
                        let state = state_arc
                            .lock()
                            .map_err(|e| AppError::Unknown(e.to_string()))?;
                        filter_hits_by_current_privacy(&state, hits)
                    }
                }
                None => Vec::new(),
            },
            Err(error) => {
                log::warn!("嵌入服务不可用，语义检索降级为关键词检索: {error}");
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    let fts_hits = fts_activity_hits(
        database
            .search_memory(query, None, None, limit.max(20))
            .unwrap_or_default(),
    );
    let fts_hits = {
        let state = state_arc
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        filter_hits_by_current_privacy(&state, fts_hits)
    };

    // RRF 融合向量召回与 FTS 召回。
    const RRF_K: f64 = 60.0;
    let mut fused: HashMap<String, SemanticMemoryHit> = HashMap::new();
    for (rank, hit) in semantic_hits.into_iter().enumerate() {
        let key = format!("{}|{}|{}", hit.date, hit.app_name, hit.title);
        let entry = fused
            .entry(key)
            .or_insert_with(|| SemanticMemoryHit { score: 0.0, ..hit });
        entry.score += 1.0 / (RRF_K + rank as f64 + 1.0);
    }
    for (rank, hit) in fts_hits.into_iter().enumerate() {
        let key = format!("{}|{}|{}", hit.date, hit.app_name, hit.title);
        let entry = fused.entry(key).or_insert(hit);
        entry.score += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    let mut results: Vec<SemanticMemoryHit> = fused.into_values().collect();
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(limit);
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use work_review_core::config::{AppPrivacyRule, PrivacyLevel};

    fn activity(
        id: i64,
        timestamp: i64,
        app: &str,
        title: &str,
        url: Option<&str>,
        ocr: Option<&str>,
    ) -> Activity {
        Activity {
            id: Some(id),
            timestamp,
            app_name: app.to_string(),
            window_title: title.to_string(),
            screenshot_path: String::new(),
            ocr_text: ocr.map(ToString::to_string),
            category: "other".to_string(),
            duration: 30,
            browser_url: url.map(ToString::to_string),
            executable_path: None,
            semantic_category: None,
            semantic_confidence: None,
            screenshot_url: None,
        }
    }

    #[test]
    fn 分块应按日期应用域名聚合并保留最长ocr() {
        let timestamp = 1_753_500_000;
        let activities = vec![
            activity(
                1,
                timestamp,
                "Chrome",
                "Rust async 详解 - 博客",
                Some("https://blog.example.com/rust-async"),
                Some("短 OCR"),
            ),
            activity(
                2,
                timestamp + 60,
                "Chrome",
                "Rust async 详解 - 博客",
                Some("https://blog.example.com/rust-async?p=2"),
                Some("这是一段更长的 OCR 文本内容示例"),
            ),
            activity(
                3,
                timestamp + 120,
                "Xcode",
                "main.rs — work-review",
                None,
                Some("fn main() {}"),
            ),
        ];
        let drafts = build_chunk_drafts(&activities);
        assert_eq!(drafts.len(), 2, "同域名网页应合并，Xcode 单独一块");
        let chrome = drafts
            .iter()
            .find(|draft| draft.app_name == "Chrome")
            .unwrap();
        assert!(chrome.content.contains("更长的 OCR"), "应保留组内最长 OCR");
        assert!(chrome.content.contains("blog.example.com"));
        assert_eq!(chrome.last_activity_id, 2);
    }

    #[test]
    fn 分块应跳过脱敏与无价值记录() {
        let timestamp = 1_753_500_000;
        let activities = vec![
            activity(1, timestamp, "App", "[内容已脱敏]", None, Some("不应出现")),
            activity(2, timestamp, "App", "ab", None, None),
        ];
        assert!(build_chunk_drafts(&activities).is_empty());
    }

    #[test]
    fn 域名提取应容忍协议与路径() {
        assert_eq!(domain_of("https://a.b.com/x?y=1"), "a.b.com");
        assert_eq!(domain_of("http://a.b.com"), "a.b.com");
        assert_eq!(domain_of("a.b.com/path"), "a.b.com");
    }

    #[test]
    fn embedding配置指纹应忽略api_key与末尾斜杠() {
        let first = AppConfig {
            embedding_provider: "OPENAI".to_string(),
            embedding_endpoint: "https://example.com/v1/".to_string(),
            embedding_model: "bge-m3".to_string(),
            embedding_api_key: Some("secret-a".to_string()),
            ..AppConfig::default()
        };
        let mut second = first.clone();
        second.embedding_endpoint = "https://example.com/v1".to_string();
        second.embedding_api_key = Some("secret-b".to_string());

        assert_eq!(
            embedding_config_fingerprint(&first),
            embedding_config_fingerprint(&second)
        );
        second.embedding_model = "other-model".to_string();
        assert_ne!(
            embedding_config_fingerprint(&first),
            embedding_config_fingerprint(&second)
        );
    }

    #[test]
    fn 隐私指纹应保留重叠应用规则顺序() {
        let first = PrivacyConfig {
            app_rules: vec![
                AppPrivacyRule {
                    app_name: "Acme".to_string(),
                    level: PrivacyLevel::Full,
                },
                AppPrivacyRule {
                    app_name: "Acme Vault".to_string(),
                    level: PrivacyLevel::Ignored,
                },
            ],
            ..PrivacyConfig::default()
        };
        let mut second = first.clone();
        second.app_rules.reverse();

        assert_ne!(
            first.get_app_privacy_level("Acme Vault"),
            second.get_app_privacy_level("Acme Vault"),
            "测试前提：重叠规则顺序必须改变真实隐私语义"
        );
        assert_ne!(privacy_fingerprint(&first), privacy_fingerprint(&second));
    }

    #[test]
    fn 隐私指纹应忽略无序集合顺序但识别语义变化() {
        let mut first = PrivacyConfig {
            excluded_keywords: vec!["登录".to_string(), "Password".to_string()],
            excluded_domains: vec![
                "https://Secret.Example.com/path".to_string(),
                "private.example.org".to_string(),
            ],
            excluded_apps: vec!["Legacy".to_string(), "Vault".to_string()],
            ..PrivacyConfig::default()
        };
        let mut second = first.clone();
        second.excluded_keywords.reverse();
        second.excluded_domains.reverse();
        second.excluded_apps.reverse();

        assert_eq!(privacy_fingerprint(&first), privacy_fingerprint(&second));
        first.excluded_keywords.push("token".to_string());
        assert_ne!(privacy_fingerprint(&first), privacy_fingerprint(&second));
    }

    #[test]
    fn 隐私指纹结构化编码不得发生分隔符碰撞() {
        let first = PrivacyConfig {
            excluded_keywords: vec!["a|b".to_string(), "c".to_string()],
            ..PrivacyConfig::default()
        };
        let second = PrivacyConfig {
            excluded_keywords: vec!["a".to_string(), "b|c".to_string()],
            ..PrivacyConfig::default()
        };

        assert_ne!(privacy_fingerprint(&first), privacy_fingerprint(&second));
    }

    #[test]
    fn fts降级只允许可按当前隐私规则复核的活动来源() {
        let items = vec![
            work_review_core::database::MemorySearchItem {
                source_type: "activity".to_string(),
                source_id: Some(1),
                date: "2026-08-05".to_string(),
                timestamp: 1,
                title: "活动".to_string(),
                excerpt: "允许返回".to_string(),
                app_name: Some("Code".to_string()),
                browser_url: None,
                duration: Some(60),
                score: 200,
            },
            work_review_core::database::MemorySearchItem {
                source_type: "hourly_summary".to_string(),
                source_id: Some(2),
                date: "2026-08-05".to_string(),
                timestamp: 2,
                title: "小时摘要".to_string(),
                excerpt: "旧隐私内容".to_string(),
                app_name: None,
                browser_url: None,
                duration: Some(60),
                score: 180,
            },
            work_review_core::database::MemorySearchItem {
                source_type: "daily_report".to_string(),
                source_id: None,
                date: "2026-08-05".to_string(),
                timestamp: 3,
                title: "日报".to_string(),
                excerpt: "旧隐私内容".to_string(),
                app_name: None,
                browser_url: None,
                duration: None,
                score: 160,
            },
        ];

        let hits = fts_activity_hits(items);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].excerpt, "允许返回");
    }
}
