import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('流式装配器应解析思考型模型的 reasoning_content 增量', async () => {
  const source = await readFile(
    new URL('../src-tauri/src/agent/model.rs', import.meta.url),
    'utf8'
  );

  // 正文帧缺失/为空时回落到思维链增量
  assert.match(
    source,
    /\.or_else\(\|\| delta\["reasoning_content"\]\.as_str\(\)\)\?/
  );
});

test('非流式解析应在正文为空时兜底思维链', async () => {
  const source = await readFile(
    new URL('../src-tauri/src/agent/model.rs', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /\.or_else\(\|\| msg\["reasoning_content"\]\.as_str\(\)\.map\(\|s\| s\.to_string\(\)\)\)/
  );
});

test('OpenAI 兼容链路的输出上限应为思考模型留足空间', async () => {
  const source = await readFile(
    new URL('../src-tauri/src/agent/model.rs', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /generation_params::apply_openai_compatible\(&mut body, model_config, false\)/,
  );
  assert.match(
    source,
    /generation_params::apply_openai_compatible\(&mut body, model_config, true\)/,
  );
  const params = await readFile(
    new URL('../crates/core/src/generation_params.rs', import.meta.url),
    'utf8',
  );
  assert.match(params, /resolved_max_tokens\(config, 8192\)/);
  assert.match(params, /resolved_max_tokens\(config, 1600\)/);
});

test('连接测试必须校验模型返回非空内容，消灭假阳性', async () => {
  const source = await readFile(
    new URL('../src-tauri/src/commands/ai.rs', import.meta.url),
    'utf8'
  );

  // content 或 reasoning_content 任一非空才算可用（[\s\S] 允许 rustfmt 换行）
  assert.match(
    source,
    /let has_output = message\["content"\][\s\S]*?\.is_some_and/
  );
  assert.match(source, /API 可达但模型未返回内容/);
  // 测试请求额度提升到 256（思考模型能产出思维链片段）
  assert.match(source, /assert_eq!\(openai_connection_test_max_tokens\(\), 256\)/);
});
