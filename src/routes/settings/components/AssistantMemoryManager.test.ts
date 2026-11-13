import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const componentUrl = new URL('./AssistantMemoryManager.svelte', import.meta.url);

async function readComponent(): Promise<string> {
  return readFile(componentUrl, 'utf8');
}

function functionSource(source: string, name: string, nextName?: string): string {
  const end = nextName
    ? `(?=\\n\\s*(?:async\\s+)?function\\s+${nextName}\\b)`
    : '(?=\\n\\s*\\$?:|\\n</script>)';
  const match = source.match(
    new RegExp(
      `(?:async\\s+)?function\\s+${name}\\([^)]*\\)(?:\\s*:\\s*[^{}]+)?\\s*\\{[\\s\\S]*?${end}`,
    ),
  );
  assert.ok(match, `未找到 ${name} 函数`);
  return match[0];
}

test('组件通过 enabled 和 t props 控制启用状态，禁用时只显示说明', async () => {
  const source = await readComponent();

  assert.match(source, /export let enabled\s*=\s*false/);
  assert.match(source, /export let t(?:\s*:\s*[^=]+)?\s*=/);
  assert.match(
    source,
    /\{#if !enabled\}[\s\S]*settingsAI\.assistantMemory\.disabled[\s\S]*\{:else\}/,
  );

  const loadMemories = functionSource(source, 'loadMemories', 'openCreateForm');
  assert.match(loadMemories, /if \(!enabled\) return;/);
  assert.match(
    loadMemories,
    /invoke(?:<[^>]+>)?\('list_user_memories', \{\s*memoryType: selectedMemoryType \|\| null,\s*limit: MEMORY_LIMIT,?\s*\}\)/s,
  );
});

test('加载后渲染可搜索、可按类型筛选的列表，并覆盖加载、错误和空状态', async () => {
  const source = await readComponent();

  assert.match(source, /bind:value=\{searchQuery\}/);
  assert.match(source, /bind:value=\{selectedMemoryType\}/);
  assert.match(source, /settingsAI\.assistantMemory\.searchPlaceholder/);
  assert.match(source, /\{#if loading\}/);
  assert.match(source, /\{:else if loadError\}/);
  assert.match(source, /\{:else if filteredMemories\.length === 0\}/);
  assert.match(source, /settingsAI\.assistantMemory\.empty/);
  assert.match(source, /\{#each filteredMemories as memory \(memory\.id\)\}/);

  for (const field of [
    'memoryType',
    'memoryKey',
    'valueText',
    'recallPolicy',
    'sensitivity',
    'sourceKind',
    'updatedAt',
  ]) {
    assert.match(source, new RegExp(`memory\\.${field}`));
  }
});

test('手动新增使用 create_user_memory，并只提交允许的输入字段', async () => {
  const source = await readComponent();
  const submitMemory = functionSource(source, 'submitMemory', 'deleteMemory');

  assert.match(source, /function openCreateForm\(/);
  assert.match(submitMemory, /invoke(?:<[^>]+>)?\('create_user_memory', \{ input \}\)/);
  assert.match(submitMemory, /memories\s*=\s*\[created, \.\.\.memories\]/);

  const buildInput = functionSource(source, 'buildInput', 'loadMemories');
  for (const field of [
    'memoryType',
    'memoryKey',
    'valueText',
    'recallPolicy',
    'sensitivity',
    'expiresAt',
  ]) {
    assert.match(buildInput, new RegExp(`${field}:`));
  }
  for (const serverOwnedField of [
    'sourceKind',
    'sourceConversationId',
    'sourceRequestId',
    'revision',
  ]) {
    assert.doesNotMatch(buildInput, new RegExp(`${serverOwnedField}:`));
  }
});

test('类型筛选开启时，新增其他类型不会污染当前列表', async () => {
  const source = await readComponent();
  const submitMemory = functionSource(source, 'submitMemory', 'deleteMemory');

  assert.match(
    submitMemory,
    /if \(!selectedMemoryType \|\| created\.memoryType === selectedMemoryType\) \{\s*memories\s*=\s*\[created, \.\.\.memories\];\s*\}/s,
  );
});

test('编辑记忆携带 id、输入和 expectedRevision，并用返回值替换列表项', async () => {
  const source = await readComponent();
  const submitMemory = functionSource(source, 'submitMemory', 'deleteMemory');

  assert.match(source, /function openEditForm\(memory(?:\s*:\s*UserMemory)?\)/);
  assert.match(source, /expectedRevision\s*=\s*memory\.revision/);
  assert.match(
    submitMemory,
    /invoke(?:<[^>]+>)?\('update_user_memory', \{\s*id: editingId,\s*input,\s*expectedRevision,?\s*\}\)/s,
  );
  assert.match(submitMemory, /memory\.id === updated\.id \? updated : memory/);
});

test('单项删除需要确认并携带 expectedRevision，成功后只移除对应项', async () => {
  const source = await readComponent();
  const deleteMemory = functionSource(source, 'deleteMemory', 'clearMemories');

  assert.match(deleteMemory, /if \(!enabled\) return;/);
  assert.match(
    deleteMemory,
    /window\.confirm\(t\('settingsAI\.assistantMemory\.confirmDelete'\)\)/,
  );
  assert.match(
    deleteMemory,
    /invoke(?:<[^>]+>)?\('delete_user_memory', \{\s*id: memory\.id,\s*expectedRevision: memory\.revision,?\s*\}\)/s,
  );
  assert.match(
    deleteMemory,
    /memories\s*=\s*memories\.filter\(\(item\) => item\.id !== memory\.id\)/,
  );
  assert.match(deleteMemory, /settingsAI\.assistantMemory\.deleteFailed/);
});

test('清空全部需要确认，成功后清空本地列表', async () => {
  const source = await readComponent();
  const clearMemories = functionSource(source, 'clearMemories', 'formatUpdatedAt');

  assert.match(clearMemories, /if \(!enabled\) return;/);
  assert.match(
    clearMemories,
    /window\.confirm\(t\('settingsAI\.assistantMemory\.confirmClear'\)\)/,
  );
  assert.match(clearMemories, /invoke(?:<[^>]+>)?\('clear_user_memories'\)/);
  assert.match(clearMemories, /memories\s*=\s*\[\]/);
  assert.match(clearMemories, /settingsAI\.assistantMemory\.clearFailed/);
});

test('清空全部不应因当前类型筛选为空而被禁用', async () => {
  const source = await readComponent();

  assert.doesNotMatch(source, /disabled=\{clearing \|\| memories\.length === 0\}/);
  assert.match(source, /disabled=\{clearing \|\| deletingId !== null\}/);
});

test('enabled=false 时删除和清空处理器在 invoke 之前直接返回', async () => {
  const source = await readComponent();

  for (const [name, nextName, command] of [
    ['deleteMemory', 'clearMemories', 'delete_user_memory'],
    ['clearMemories', 'formatUpdatedAt', 'clear_user_memories'],
  ]) {
    const handler = functionSource(source, name, nextName);
    const invokeIndex = handler.search(new RegExp(`invoke(?:<[^>]+>)?\\('${command}'`));
    assert.ok(invokeIndex >= 0, `${name} 必须调用 ${command}`);
    assert.ok(
      handler.indexOf('if (!enabled) return;') < invokeIndex,
      `${name} 必须先检查 enabled，再调用 ${command}`,
    );
  }
});

test('组件使用约定的长期记忆 i18n 命名空间', async () => {
  const source = await readComponent();

  for (const key of [
    'title',
    'hint',
    'disabled',
    'cloudNotice',
    'searchPlaceholder',
    'type',
    'key',
    'value',
    'recallPolicy',
    'source',
    'updatedAt',
    'add',
    'edit',
    'save',
    'delete',
    'clearAll',
    'empty',
    'loadFailed',
    'saveFailed',
    'deleteFailed',
    'clearFailed',
    'confirmDelete',
    'confirmClear',
  ]) {
    assert.match(source, new RegExp(`settingsAI\\.assistantMemory\\.${key}`));
  }
  for (const type of ['preference', 'workflow', 'profile', 'goal', 'project', 'constraint']) {
    assert.match(source, new RegExp(`settingsAI\\.assistantMemory\\.types\\.${type}`));
  }
  for (const policy of ['always', 'relevant', 'manual']) {
    assert.match(source, new RegExp(`settingsAI\\.assistantMemory\\.policies\\.${policy}`));
  }
});
