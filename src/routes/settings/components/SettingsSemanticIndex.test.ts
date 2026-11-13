import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('建立语义索引前应先落盘当前配置，避免开关未保存的矛盾', async () => {
  const source = await readFile(new URL('./SettingsAI.svelte', import.meta.url), 'utf8');
  const handlerStart = source.indexOf('async function startSemanticIndexing');
  const buildCall = source.indexOf("'index_semantic_memory'", handlerStart);
  const saveCall = source.indexOf("invoke('save_config'", handlerStart);

  assert.ok(handlerStart >= 0, '应存在 startSemanticIndexing 处理器');
  assert.ok(
    saveCall >= 0 && saveCall < buildCall,
    '点击建立索引时应先保存配置再调用索引命令（后端读取的是已持久化配置）',
  );
});
