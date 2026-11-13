import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('切换 AI 服务商时应把各家配置（含 API Key）写入持久化缓存', async () => {
  const source = await readFile(
    new URL('./components/SettingsAI.svelte', import.meta.url),
    'utf8'
  );

  // 切换时快照必须同时写内存缓存和 config 上的持久化字段
  assert.match(source, /providerConfigs\[config\.text_model\.provider\] = snapshot;/);
  assert.match(
    source,
    /config\.text_model_provider_cache\[config\.text_model\.provider\] = snapshot;/
  );
  // 快照需保留 API Key
  assert.match(source, /api_key: config\.text_model\.api_key \|\| ''/);
});

test('AI 设置初始化时应载入持久化的服务商缓存', async () => {
  const source = await readFile(
    new URL('./components/SettingsAI.svelte', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /providerConfigs = \{ \.\.\.\(config\.text_model_provider_cache \|\| \{\}\) \};/
  );
  // 激活中的 provider 仍以 text_model 实时值为准（持久缓存可能滞后）
  assert.match(
    source,
    /providerConfigs\[config\.text_model\.provider\] = \{/
  );
});

test('后端 AppConfig 应提供向后兼容的服务商缓存字段', async () => {
  const source = await readFile(
    new URL('../../../crates/core/src/config.rs', import.meta.url),
    'utf8'
  );

  assert.match(source, /pub text_model_provider_cache: HashMap<String, ModelConfig>/);
  // serde(default)：旧配置文件缺少该字段时可以正常加载
  const fieldDecl = source.match(
    /#\[serde\(default\)\]\s+pub text_model_provider_cache/
  );
  assert.ok(fieldDecl, 'text_model_provider_cache 应带 #[serde(default)]');
  assert.match(source, /text_model_provider_cache: HashMap::new\(\)/);
});

test('设置页加载配置时应为服务商缓存提供兜底初始化', async () => {
  const source = await readFile(new URL('./Settings.svelte', import.meta.url), 'utf8');

  assert.match(
    source,
    /if \(!loadedConfig\.text_model_provider_cache\) \{\s*\n\s*loadedConfig\.text_model_provider_cache = \{\};/
  );
});

test('保存配置时应校验服务商缓存条目的端点安全', async () => {
  const source = await readFile(
    new URL('../../../src-tauri/src/commands/config.rs', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /for cached in config\.text_model_provider_cache\.values\(\) \{\s*\n\s*super::ai::validate_model_endpoint\(&cached\.endpoint\)/
  );
});
