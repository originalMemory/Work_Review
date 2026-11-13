import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

async function listStyleSources(
  directory = new URL('.', import.meta.url)
): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: URL[] = [];

  for (const entry of entries) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) {
      files.push(...await listStyleSources(entryUrl));
    } else if (entry.name.endsWith('.svelte') || entry.name.endsWith('.css')) {
      files.push(entryUrl);
    }
  }

  return files;
}

function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `缺少样式选择器：${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  assert.notEqual(open, -1, `选择器缺少声明块：${selector}`);
  assert.notEqual(close, -1, `选择器声明块未闭合：${selector}`);
  return css.slice(open + 1, close);
}

function openingTagBefore(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `缺少标记：${marker}`);
  const tagStart = source.lastIndexOf('<button', markerIndex);
  assert.notEqual(tagStart, -1, `缺少按钮：${marker}`);
  return source.slice(tagStart, markerIndex);
}

test('圆角令牌应收敛为 4/6/8/12/full 五档', async () => {
  const css = await source('./app.css');
  const root = cssBlock(css, ':root');

  assert.match(root, /--radius-xs:\s*4px;/);
  assert.match(root, /--radius-sm:\s*6px;/);
  assert.match(root, /--radius-md:\s*8px;/);
  assert.match(root, /--radius-lg:\s*12px;/);
  assert.match(root, /--radius-full:\s*999px;/);
});

test('共享普通按钮、输入、卡片、菜单和页面框架应复用非胶囊令牌', async () => {
  const css = await source('./app.css');
  const expectedRadii = new Map([
    ['.app-shell-sidebar-frame,', 'var(--radius-lg)'],
    ['.app-shell-sidebar {', 'var(--radius-lg)'],
    ['.app-shell-main {', 'var(--radius-lg)'],
    ['.page-card {', 'var(--radius-md)'],
    ['.page-card-soft {', 'var(--radius-md)'],
    ['.page-control-input {', 'var(--radius-md)'],
    ['.page-control-btn {', 'var(--radius-md)'],
    ['.page-action-btn {', 'var(--radius-md)'],
    ['.settings-card {', 'var(--radius-md)'],
    ['.settings-panel {', 'var(--radius-md)'],
    ['.settings-tab-rail {', 'var(--radius-md)'],
    ['.settings-tab-rail-item {', 'var(--radius-md)'],
    ['.report-export-menu-panel {', 'var(--radius-md)'],
    ['.modal-panel {', 'var(--radius-lg)'],
  ]);

  for (const [selector, radius] of expectedRadii) {
    const block = cssBlock(css, selector);
    assert.match(block, new RegExp(`border-radius:\\s*${radius.replace(/[()\-]/g, '\\$&')};`), selector);
    assert.doesNotMatch(block, /border-radius:\s*(?:999px|[2-9]\dpx|1[3-9]px)/, selector);
  }
});

test('日报日期工具栏与周日期应使用统一的普通控件圆角', async () => {
  const css = await source('./app.css');

  assert.match(cssBlock(css, '.report-hero-actions .page-toolbar-end {'), /border-radius:\s*var\(--radius-md\);/);
  assert.match(cssBlock(css, '.report-hero-actions .page-toolbar-end .page-control-btn {'), /border-radius:\s*var\(--radius-md\);/);
  assert.match(cssBlock(css, '.report-hero-actions .page-toolbar-end .page-control-input {'), /border-radius:\s*var\(--radius-md\);/);
  assert.match(cssBlock(css, '.report-weekstrip-day {'), /border-radius:\s*var\(--radius-sm\);/);
  assert.match(cssBlock(css, '.report-anchor-chip {'), /border-radius:\s*var\(--radius-md\);/);
});

test('A/B/C 界面风格不得改写基础圆角尺度', async () => {
  const css = await source('./app.css');

  for (const selector of [
    '.app-shell.ui-style-a .app-shell-sidebar-frame,',
    '.app-shell.ui-style-c .app-shell-sidebar-frame,',
  ]) {
    assert.doesNotMatch(cssBlock(css, selector), /--app-shell-(?:frame|inner)-radius:/, selector);
  }

  assert.doesNotMatch(css, /\.app-shell\.ui-style-[abc][^{]*\{[^}]*border-radius:/s);
});

test('所有前端样式只能使用统一圆角令牌或对应的 4/6/8/12px 工具类', async () => {
  const files = await listStyleSources();
  const radiusToken = String.raw`(?:0|inherit|var\(--radius-(?:xs|sm|md|lg|full)\))`;
  const allowedRadiusValue = new RegExp(`^${radiusToken}(?:\\s+${radiusToken}){0,3}$`);

  for (const file of files) {
    const component = await readFile(file, 'utf8');
    const label = file.pathname.replace(new URL('.', import.meta.url).pathname, './');

    assert.doesNotMatch(
      component,
      /\brounded(?:-[trblse]{1,2})?-(?:sm|2xl|3xl)\b/,
      label,
    );

    for (const match of component.matchAll(/rounded-\[([^\]]+)\]/g)) {
      assert.match(
        match[1],
        /^var\(--radius-(?:xs|sm|md|lg|full)\)$/,
        `${label} 存在未令牌化的任意圆角：${match[0]}`,
      );
    }

    for (const match of component.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius:\s*([^;]+);/g)) {
      const value = match[1].trim();
      assert.ok(
        allowedRadiusValue.test(value),
        `${label} 存在未令牌化的圆角声明：${match[0]}`,
      );
    }
  }
});

test('普通发送按钮不得使用 full 圆角', async () => {
  const css = await source('./app.css');
  assert.match(cssBlock(css, '.ask-send-button {'), /border-radius:\s*var\(--radius-md\);/);
});

test('日报预设编辑与删除按钮不得使用 full 圆角', async () => {
  const report = await source('./routes/report/Report.svelte');
  for (const marker of ["title={t('report.editPreset')}", "title={t('common.delete')}"]) {
    const buttonTag = openingTagBefore(report, marker);
    assert.match(buttonTag, /rounded-\[var\(--radius-sm\)\]/, marker);
    assert.doesNotMatch(buttonTag, /rounded-full/, marker);
  }
});

test('组件内合理的胶囊语义也应复用 full 令牌', async () => {
  const paths = [
    './routes/timeline/HourlySummaryDrawer.svelte',
    './routes/timeline/Summary.svelte',
    './routes/settings/components/SettingsSystem.svelte',
  ];

  for (const path of paths) {
    const component = await source(path);
    assert.doesNotMatch(component, /border-radius:\s*999px;/, path);
    assert.match(component, /border-radius:\s*var\(--radius-full\);/, path);
  }
});

test('干净设置组件中的内层分组应扁平化为共享 subsection', async () => {
  const paths = [
    './routes/settings/components/SettingsStorage.svelte',
    './routes/settings/components/nodeGateway/DeviceIdentityPanel.svelte',
    './routes/settings/components/nodeGateway/McpServerPanel.svelte',
    './routes/settings/components/nodeGateway/BotCredentialsPanel.svelte',
    './routes/settings/components/nodeGateway/TelegramBotPanel.svelte',
    './routes/settings/components/nodeGateway/LocalApiPanel.svelte',
  ];

  for (const path of paths) {
    const component = await source(path);
    assert.doesNotMatch(component, /<div class="rounded-(?:xl|2xl)[^\"]*(?:border|ring)/, path);
  }

  const css = await source('./app.css');
  const subsection = cssBlock(css, '.settings-subsection {');
  assert.match(subsection, /border-radius:\s*0;/);
  assert.match(subsection, /background:\s*transparent;/);
});
