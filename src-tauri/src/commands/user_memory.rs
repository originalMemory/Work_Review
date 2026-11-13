//! 用户显式长期记忆的设置页命令。
//!
//! Agent 写入由 `ask.rs` 的 ActionBridge 承担；这里仅提供用户在设置页主动管理
//! 本机长期记忆所需的 CRUD 接口。

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;
use work_review_core::database::{AssistantUserMemory, Database};

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserMemoryInput {
    pub memory_type: String,
    pub memory_key: String,
    pub value_text: String,
    pub recall_policy: String,
    pub sensitivity: String,
    pub expires_at: Option<i64>,
}

impl std::fmt::Debug for UserMemoryInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UserMemoryInput")
            .field("memory_type", &self.memory_type)
            .field("memory_key", &"<redacted>")
            .field("value_text", &"<redacted>")
            .field("recall_policy", &self.recall_policy)
            .field("sensitivity", &self.sensitivity)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

fn database_from_state(state: &State<'_, Arc<Mutex<AppState>>>) -> Result<Database, String> {
    state
        .lock()
        .map(|state| state.database.clone())
        .map_err(|error| format!("读取长期记忆状态失败: {error}"))
}

#[tauri::command]
pub async fn list_user_memories(
    memory_type: Option<String>,
    limit: Option<usize>,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Vec<AssistantUserMemory>, String> {
    database_from_state(&state)?
        .list_user_memories(memory_type.as_deref(), limit.unwrap_or(200))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_user_memory(
    input: UserMemoryInput,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<AssistantUserMemory, String> {
    crate::agent::tools::ensure_user_memory_value_is_safe(&input.memory_key, &input.value_text)?;
    database_from_state(&state)?
        .create_user_memory(
            &input.memory_type,
            &input.memory_key,
            &input.value_text,
            &input.recall_policy,
            &input.sensitivity,
            "manual",
            None,
            None,
            input.expires_at,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn update_user_memory(
    id: i64,
    input: UserMemoryInput,
    expected_revision: i64,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<AssistantUserMemory, String> {
    crate::agent::tools::ensure_user_memory_value_is_safe(&input.memory_key, &input.value_text)?;
    database_from_state(&state)?
        .update_user_memory(
            id,
            expected_revision,
            &input.memory_type,
            &input.memory_key,
            &input.value_text,
            &input.recall_policy,
            &input.sensitivity,
            input.expires_at,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_user_memory(
    id: i64,
    expected_revision: i64,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    database_from_state(&state)?
        .forget_user_memory(id, expected_revision)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn clear_user_memories(state: State<'_, Arc<Mutex<AppState>>>) -> Result<usize, String> {
    database_from_state(&state)?
        .clear_user_memories()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 设置页输入应使用_camel_case_字段() {
        let input: UserMemoryInput = serde_json::from_value(serde_json::json!({
            "memoryType": "preference",
            "memoryKey": "answer_style",
            "valueText": "先给结论",
            "recallPolicy": "relevant",
            "sensitivity": "normal",
            "expiresAt": null
        }))
        .expect("camelCase 输入应可解析");

        assert_eq!(input.memory_type, "preference");
        assert_eq!(input.memory_key, "answer_style");
        assert_eq!(input.value_text, "先给结论");
    }

    #[test]
    fn 设置页输入_debug_不应泄漏长期记忆内容() {
        let input = UserMemoryInput {
            memory_type: "preference".to_string(),
            memory_key: "answer_style".to_string(),
            value_text: "这是不应出现在 Debug 中的完整敏感内容".to_string(),
            recall_policy: "relevant".to_string(),
            sensitivity: "normal".to_string(),
            expires_at: None,
        };

        let debug = format!("{input:?}");
        assert!(!debug.contains(&input.value_text));
        assert!(debug.contains("<redacted>"));
    }
}
