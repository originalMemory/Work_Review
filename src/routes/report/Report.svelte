<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { open } from '@tauri-apps/plugin-shell';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import { showToast } from '../../lib/stores/toast.js';
  import { cache } from '../../lib/stores/cache.js';
  import { formatLocalizedDate, formatLocalizedTime, formatDurationLocalized, locale, t } from '$lib/i18n/index.js';
  import { shouldShowPromptAppliedToast } from './reportPromptFeedback.js';
  import { resolveReportMeta } from './reportMeta.js';
  import LocalizedDatePicker from '../../lib/components/LocalizedDatePicker.svelte';
  import DeviceFilter from '../../lib/components/DeviceFilter.svelte';
  import { selectedDeviceId } from '../../lib/stores/deviceFilter.js';

  function getLocalDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function getYesterdayDateString() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  }

  let report = null;
  let allDeviceReports = [];
  let loading = false;
  let generating = false;
  let error = null;
  let selectedDate = getLocalDateString();
  let freshStats = null;
  let isYesterdayReport = false; // 标记是否显示的是昨日日报
  let showPresetDropdown = false;
  let dropdownStyle = '';
  let showPresetModal = false;
  let presetSaving = false;
  $: activePresetName = (config?.daily_report_prompt_presets || []).find(p => p.prompt === config?.daily_report_custom_prompt)?.name || '';
  let editingPresetIndex = -1;
  let editingPresetName = '';
  let editingPresetPrompt = '';
  let pendingDeletePreset = -1;
  let config = null;
  let lastLoadedDate = '';
  let reportRequestId = 0;
  let exportInProgress = false;
  let promptSaving = false;
  let cacheData = null;
  cache.subscribe(v => {
    cacheData = v;
    // 首次或缓存有值时，立即从缓存恢复配置（避免页面切换闪烁）
    if (!config && v?.config) {
      config = v.config;
    }
  });
  $: generating = cacheData?.reportGenerating ?? false;
  $: generating = cacheData?.reportGenerating ?? false;
  $: currentLocale = $locale;
  $: currentReportCacheKey = `${selectedDate}:${currentLocale}:${$selectedDeviceId ?? 'all'}`;

  // 获取 AI 模式显示名称
  function getAiModeName(mode) {
    const normalizedMode = (mode || '').toString().trim().toLowerCase();
    const modeNames = {
      'local': t('report.modeNames.local'),
      'summary': t('report.modeNames.summary'),
      'cloud': t('report.modeNames.cloud')
    };
    return modeNames[normalizedMode] || mode || t('report.modeNames.unknown');
  }

  function getFallbackReasonText(meta) {
    return meta?.fallbackReason || t('report.savedReportNotAi');
  }

  async function loadConfig() {
    try {
      const cfg = await invoke('get_config');
      cache.setConfig(cfg);
    } catch (e) {
      console.error('加载配置失败:', e);
    }
  }

  async function loadReport(previousReport = null) {
    const requestId = ++reportRequestId;
    freshStats = null;

    // 并行加载实时统计
    invoke('get_daily_stats', { date: selectedDate })
      .then(stats => { if (requestId === reportRequestId) freshStats = stats; })
      .catch(() => {});

    // 乐观更新：先显示缓存数据
    let cacheData;
    const unsubscribe = cache.subscribe(c => { cacheData = c; });
    unsubscribe();
    
    if (cacheData.reports[currentReportCacheKey]?.data) {
      report = cacheData.reports[currentReportCacheKey].data;
      isYesterdayReport = false;
      loading = false;
      
      // 缓存有效则直接返回
      if (cache.isValid(cacheData.reports[currentReportCacheKey], 'reports')) {
        try {
          allDeviceReports = await invoke('get_reports_by_date', {
            date: selectedDate,
            locale: currentLocale,
            deviceId: $selectedDeviceId ?? null,
          });
        } catch (e) {
          allDeviceReports = [];
        }
        return;
      }
      
      // 后台静默刷新
      try {
        const savedReport = await invoke('get_saved_report', {
          date: selectedDate,
          locale: currentLocale,
          deviceId: $selectedDeviceId ?? null,
        });
        if (requestId !== reportRequestId) return;
        if (savedReport) {
          report = savedReport;
          cache.setReport(currentReportCacheKey, savedReport);
        }
      } catch (e) {
        console.warn('后台刷新日报失败:', e);
      }
    } else {
      // 首次加载
      loading = true;
      error = null;
      try {
        const savedReport = await invoke('get_saved_report', {
          date: selectedDate,
          locale: currentLocale,
          deviceId: $selectedDeviceId ?? null,
        });
        if (requestId !== reportRequestId) return;
        if (savedReport) {
          report = savedReport;
          isYesterdayReport = false;
          cache.setReport(currentReportCacheKey, savedReport);
        } else {
          if (!savedReport && previousReport?.date === selectedDate && previousReport?.content) {
            generating = true;
            await invoke('generate_report', {
              date: selectedDate,
              force: false,
              locale: currentLocale,
              deviceId: $selectedDeviceId ?? null,
            });
            const localizedReport = await invoke('get_saved_report', {
              date: selectedDate,
              locale: currentLocale,
              deviceId: $selectedDeviceId ?? null,
            });

            if (localizedReport) {
              report = localizedReport;
              isYesterdayReport = false;
              cache.setReport(currentReportCacheKey, localizedReport);
              return;
            }
          }

          // 如果选择今天且今天无日报，尝试加载昨日日报
          if (!$selectedDeviceId && selectedDate === getLocalDateString()) {
            const yesterday = getYesterdayDateString();
            const yesterdayReport = await invoke('get_saved_report', {
              date: yesterday,
              locale: currentLocale,
              deviceId: null,
            });
            if (yesterdayReport) {
              report = yesterdayReport;
              isYesterdayReport = true;
            } else {
              report = null;
              isYesterdayReport = false;
            }
          } else {
             report = null;
             isYesterdayReport = false;
          }
        }
      } catch (e) {
        error = e.toString();
      } finally {
        generating = false;
        loading = false;
      }
    }

    try {
      allDeviceReports = await invoke('get_reports_by_date', {
        date: selectedDate,
        locale: currentLocale,
        deviceId: $selectedDeviceId ?? null,
      });
    } catch (e) {
      allDeviceReports = [];
    }
  }

  function selectDate(date) {
    if (!date || date === selectedDate) return;
    selectedDate = date;
  }

  async function generateReport(force = true) {
    cache.setReportGenerating(true);
    error = null;
    try {
      if (config?.ai_mode === 'summary') {
        await persistReportPrompt();
      }
      await invoke('generate_report', {
        date: selectedDate,
        force,
        locale: currentLocale,
        deviceId: $selectedDeviceId ?? null,
      });
      const savedReport = await invoke('get_saved_report', {
        date: selectedDate,
        locale: currentLocale,
        deviceId: $selectedDeviceId ?? null,
      });
      report = savedReport || { date: selectedDate, content: '', created_at: Date.now() / 1000 };
      isYesterdayReport = false;
      cache.setReport(currentReportCacheKey, report);

      if (
        shouldShowPromptAppliedToast({
          configAiMode: config?.ai_mode,
          customPrompt: config?.daily_report_custom_prompt,
          reportAiMode: savedReport?.ai_mode,
        })
      ) {
        showToast(t('report.promptApplied'), 'success');
      }
    } catch (e) {
      error = e.toString();
    } finally {
      cache.setReportGenerating(false);
    }
  }

  async function persistReportPrompt() {
    if (!config || config.ai_mode !== 'summary' || promptSaving) {
      return;
    }

    promptSaving = true;
    try {
      config.daily_report_custom_prompt = (config.daily_report_custom_prompt || '').trim();
      await invoke('save_config', { config });
    } finally {
      promptSaving = false;
    }
  }

  async function savePresets() {
    try {
      await invoke('save_config', { config });
    } catch (e) {
      console.error('保存预设失败:', e);
    }
  }

  // 把节点移到 document.body，规避祖先的 backdrop-filter / overflow 对 position:fixed 的干扰
  function portal(node) {
    document.body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode === document.body) {
          document.body.removeChild(node);
        }
      }
    };
  }

  async function exportReportMarkdown() {
    if (!report) return;

    exportInProgress = true;
    try {
      let exportDir = config?.daily_report_export_dir || null;
      if (!exportDir) {
        const selected = await openDialog({
          directory: true,
          multiple: false,
        });

        if (!selected || Array.isArray(selected)) {
          return;
        }

        exportDir = selected;
      }

      const exportPath = await invoke('export_report_markdown', {
        date: report.date || selectedDate,
        content: report.content,
        deviceId: report.device_id ?? null,
        exportDir,
      });
      showToast(t('report.exportSuccess', { path: exportPath }), 'success');
    } catch (e) {
      showToast(t('report.exportFailed', { error: e }), 'error');
    } finally {
      exportInProgress = false;
    }
  }

  function renderMarkdown(content) {
    const rawHtml = marked(content);
    return DOMPurify.sanitize(rawHtml);
  }

  async function handleReportLinkClick(event) {
    const link = event.target.closest('a[href]');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) return;

    event.preventDefault();
    try {
      await open(href);
    } catch (e) {
      console.error('打开日报链接失败:', e);
    }
  }

  function interceptReportLinks(node) {
    const listener = (event) => {
      handleReportLinkClick(event);
    };

    node.addEventListener('click', listener);

    return {
      destroy() {
        node.removeEventListener('click', listener);
      }
    };
  }

  // 结构化编辑：将 markdown 按 ## 标题拆分为段落
  let editingSection = -1; // 当前正在编辑的段落索引
  let editingContent = ''; // 编辑中的内容

  function parseSections(content) {
    if (!content) return [];
    const lines = content.split('\n');
    const sections = [];
    let currentTitle = '';
    let currentLines = [];

    for (const line of lines) {
      // <details> 块作为独立段落，与上方内容分离
      if (line.startsWith('<details>') || line.startsWith('## ')) {
        if (currentTitle || currentLines.length) {
          sections.push({ title: currentTitle, body: currentLines.join('\n') });
        }
        currentTitle = line.startsWith('## ') ? line : '';
        currentLines = line.startsWith('<details>') ? [line] : [];
      } else {
        currentLines.push(line);
      }
    }
    if (currentTitle || currentLines.length) {
      sections.push({ title: currentTitle, body: currentLines.join('\n') });
    }

    return sections;
  }

  function startEditSection(sections, index) {
    editingSection = index;
    const section = sections[index];
    editingContent = section.title ? section.title + '\n' + section.body : section.body;
  }

  function cancelEditSection() {
    editingSection = -1;
    editingContent = '';
  }

  async function saveEditSection(sections, index) {
    const newContent = editingContent.trim();
    const newSections = [...sections];
    const parsed = parseSections(newContent || '');
    if (parsed.length > 0) {
      newSections[index] = parsed[0];
      // If user added more ## headers, merge them in
      if (parsed.length > 1) {
        newSections.splice(index + 1, 0, ...parsed.slice(1));
      }
    }

    const fullContent = newSections.map(s => {
      if (s.title && s.body) return s.title + '\n' + s.body;
      return s.title || s.body;
    }).join('\n');

    try {
      await invoke('update_report_content', { date: selectedDate, locale: currentLocale, content: fullContent });
      report = { ...report, content: fullContent };
      cache.setReport(currentReportCacheKey, report);
      editingSection = -1;
      editingContent = '';
    } catch (e) {
      showToast(t('report.editSectionFailed') + ': ' + e, 'error');
    }
  }

  function formatReportDate(dateStr) {
    const date = new Date(dateStr);
    return formatLocalizedDate(date, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  }

  $: if (currentReportCacheKey && currentReportCacheKey !== lastLoadedDate) {
    const previousReport = report;
    lastLoadedDate = currentReportCacheKey;
    report = null;
    editingSection = -1;
    isYesterdayReport = false;
    loadReport(previousReport);
  }

  $: reportSections = parseSections(report?.content || '');

  $: reportMeta = resolveReportMeta(report, config);

  onMount(() => {
    loadConfig();
  });

  // 页面重新获得焦点时刷新配置，确保 AI 增强状态为最新
  let configRefreshTimer = 0;
  function refreshConfigOnFocus() {
    const now = Date.now();
    if (now - configRefreshTimer < 2000) return;
    configRefreshTimer = now;
    loadConfig();
  }
</script>

<svelte:window on:click={(e) => {
  if (!showPresetDropdown) return;
  if (!e.target.closest('[data-preset-dropdown]') && !e.target.closest('[data-preset-toggle]')) {
    showPresetDropdown = false;
    pendingDeletePreset = -1;
  }
}} on:focusin={refreshConfigOnFocus} on:visibilitychange={() => {
  if (document.visibilityState === 'visible') refreshConfigOnFocus();
}} />

<div class="page-shell report-editorial-shell" data-locale={currentLocale}>
  <!-- 页面标题 -->
  <div class="report-hero">
    <div class="report-hero-main">
      <div class="page-title-group report-hero-copy">
      <div class="page-title-badge">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 7h8M8 12h8M8 17h5" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M7 3h7l5 5v10a3 3 0 01-3 3H7a3 3 0 01-3-3V6a3 3 0 013-3Z" />
        </svg>
      </div>
      <div class="page-title-copy">
        <h2>
          {selectedDate === getLocalDateString() ? t('report.todayReport') : t('report.historyReport')}
        </h2>
        <div class="report-hero-meta">
          <div class="report-hero-date-row">
            <span class="report-hero-date">{formatReportDate(selectedDate)}</span>
            {#if config || report}
              <span class="report-hero-mode-chip">{getAiModeName(reportMeta.reportMode)}</span>
            {/if}
          </div>
          {#if config || report}
            {#if reportMeta.showUsageMismatchNotice}
              <p class="report-hero-mode-note">{t('report.aiNotAppliedPrefix')}{getFallbackReasonText(reportMeta)}</p>
            {/if}
          {/if}
        </div>
      </div>
    </div>
      <div class="report-hero-actions">
      <div class="page-toolbar-end">
        <DeviceFilter />
        <button
          class="page-control-btn {selectedDate === getLocalDateString() ? 'page-control-btn-active' : ''}"
          on:click={() => selectDate(getLocalDateString())}
        >
          {t('report.today')}
        </button>
        <button
          class="page-control-btn {selectedDate === getYesterdayDateString() ? 'page-control-btn-active' : ''}"
          on:click={() => selectDate(getYesterdayDateString())}
        >
          {t('report.yesterday')}
        </button>
        {#key `report-date-${currentLocale}`}
          <LocalizedDatePicker
            bind:value={selectedDate}
            max={getLocalDateString()}
            localeCode={currentLocale}
            triggerClass="page-control-input w-auto"
          />
        {/key}
      </div>
      <div class="flex flex-wrap justify-end gap-2">
        {#if report}
          <button
            class="page-action-secondary min-h-10 px-4 py-2"
            on:click={exportReportMarkdown}
            disabled={exportInProgress}
            title={config?.daily_report_export_dir ? '' : t('report.exportWithoutDefaultDir')}
          >
            {#if exportInProgress}
              <div class="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent"></div>
              {t('report.exporting')}
            {:else}
              {t('report.exportMarkdown')}
            {/if}
          </button>
          <button
            class="page-action-warn"
            on:click={() => generateReport(true)}
            disabled={generating}
          >
            {#if generating}
              <div class="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
              {t('report.generating')}
            {:else}
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {t('report.regenerate')}
            {/if}
          </button>
        {/if}
      </div>
    </div>
    </div>
  </div>

  <div class="report-editorial-stack">
  {#if config && config.ai_mode === 'summary'}
    <div class="page-card report-sheet report-sheet-controls">
      <div class="flex items-center justify-between mb-1.5">
        <label for="daily-report-custom-prompt" class="settings-label">{t('report.promptLabel')}</label>
        <div class="relative">
          <button
            type="button"
            data-preset-toggle
            class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:border-indigo-300 dark:hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
            on:click={(e) => {
              if (showPresetDropdown) {
                showPresetDropdown = false;
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              dropdownStyle = `position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;width:240px;max-height:320px;`;
              showPresetDropdown = true;
            }}
          >
            <span class="truncate max-w-[140px]">{activePresetName || t('report.presetsTitle')}</span>
            <svg class="w-3.5 h-3.5 transition-transform {showPresetDropdown ? 'rotate-180' : ''}" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
          </button>
          {#if showPresetDropdown}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div use:portal data-preset-dropdown style={dropdownStyle} class="z-50 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-xl overscroll-contain" on:wheel={(e) => { e.stopPropagation(); e.preventDefault(); e.currentTarget.scrollTop += e.deltaY; }} on:touchmove|stopPropagation>
              <div class="py-1.5">
                {#each (config?.daily_report_prompt_presets || []) as preset, i}
                  {#if pendingDeletePreset === i}
                    <div class="flex flex-col items-center gap-1.5 px-3 py-2 bg-rose-50 dark:bg-rose-900/20 mx-2 rounded-lg">
                      <span class="text-xs text-rose-600 dark:text-rose-400 text-center">{t('report.confirmDeletePreset', { name: preset.name })}</span>
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          class="px-2.5 py-0.5 text-xs font-medium text-white bg-rose-500 hover:bg-rose-600 rounded-md transition-colors"
                          on:click|stopPropagation={async () => {
                            const wasActive = config.daily_report_custom_prompt === preset.prompt;
                            config.daily_report_prompt_presets = config.daily_report_prompt_presets.filter((_, j) => j !== i);
                            pendingDeletePreset = -1;
                            if (wasActive) {
                              config.daily_report_custom_prompt = '';
                              persistReportPrompt();
                            }
                            await savePresets();
                          }}
                        >{t('common.confirm') || '确定'}</button>
                        <button
                          type="button"
                          class="px-2.5 py-0.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 rounded-md border border-slate-200 dark:border-slate-600 transition-colors"
                          on:click|stopPropagation={() => { pendingDeletePreset = -1; }}
                        >{t('common.cancel') || '取消'}</button>
                      </div>
                    </div>
                  {:else}
                    <div class="group flex items-center gap-1 mx-1.5 px-1.5 py-0.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                      {#if config.daily_report_custom_prompt === preset.prompt}
                        <svg class="w-3.5 h-3.5 text-indigo-500 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
                      {:else}
                        <div class="w-3.5 shrink-0"></div>
                      {/if}
                      <button
                        type="button"
                        class="flex-1 text-left px-1 py-1.5 text-sm text-slate-700 dark:text-slate-300 truncate transition-colors"
                        title={preset.prompt}
                        on:click={() => {
                          config.daily_report_custom_prompt = preset.prompt;
                          persistReportPrompt();
                          showPresetDropdown = false;
                        }}
                      >
                        {preset.name}
                      </button>
                      <button
                        type="button"
                        class="p-1 text-slate-300 hover:text-rose-500 dark:text-slate-600 dark:hover:text-rose-400 rounded-md hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                        title="删除"
                        on:click|stopPropagation={() => { pendingDeletePreset = i; }}
                      >
                        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
                      </button>
                    </div>
                  {/if}
                {/each}
              </div>
              <div class="border-t border-slate-100 dark:border-slate-700">
                <button
                  type="button"
                  class="w-full text-center px-3 py-2.5 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors flex items-center justify-center gap-1.5"
                  on:click={() => {
                    editingPresetIndex = -1;
                    editingPresetName = '';
                    editingPresetPrompt = '';
                    pendingDeletePreset = -1;
                    showPresetDropdown = false;
                    showPresetModal = true;
                  }}
                >
                  <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/></svg>
                  {t('report.addPreset')}
                </button>
              </div>
            </div>
          {/if}
        </div>
      </div>
      <textarea
        id="daily-report-custom-prompt"
        bind:value={config.daily_report_custom_prompt}
        on:change={persistReportPrompt}
        rows="3"
        class="control-input resize-y min-h-[80px]"
        placeholder={t('report.promptPlaceholder')}
      ></textarea>
    </div>
  {/if}

  <!-- 日报内容 -->
  {#if loading}
    <div class="empty-state-lg">
      <div class="empty-state-icon">
        <div class="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent"></div>
      </div>
      <h3 class="empty-state-title">{t('report.loadingTitle')}</h3>
      <p class="empty-state-copy mt-1">{t('report.loadingCopy')}</p>
    </div>
  {:else if error}
    <div class="page-banner-error">
      <div>
        <div class="flex items-center gap-3 text-red-500 mb-2">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <span class="font-medium">{t('report.generateFailed')}</span>
      </div>
      <p class="text-sm">{error}</p>
      </div>
      <button class="page-action-brand" on:click={() => generateReport(true)}>{t('common.retry')}</button>
    </div>
  {:else if report}
    <!-- 昨日日报提示 -->
    {#if isYesterdayReport}
      <div class="page-banner-warning report-fallback-banner mb-4">
        <div class="report-fallback-copy">
          <div class="flex items-center gap-2 text-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {t('report.showingYesterday', { date: formatReportDate(report.date) })}
          </div>
        </div>
        <div class="report-fallback-action">
          <button
            class="page-action-warn report-fallback-button min-h-9 px-3 text-xs rounded-lg shadow-none"
            on:click={() => generateReport(false)}
            disabled={generating}
          >
            {#if generating}
              <div class="inline-flex items-center gap-2">
                <div class="animate-spin rounded-full h-3 w-3 border-2 border-white border-t-transparent"></div>
                <span>{t('report.generating')}</span>
              </div>
            {:else}
              ✨ {t('report.generatingToday')}
            {/if}
          </button>
        </div>
      </div>
    {/if}
    {#if allDeviceReports.length > 1}
      {#each allDeviceReports as deviceReport}
        <div class="page-card report-sheet report-article-card mb-4">
          <div class="report-sheet-content">
            <div class="report-sheet-meta text-xs text-slate-400 mb-4 flex flex-wrap items-center gap-2">
              <div class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></div>
              <span class="text-sm font-medium text-slate-600 dark:text-slate-300">
                {t('report.deviceSection', { device: deviceReport.device_id || t('deviceFilter.allDevices') })}
              </span>
              <span class="text-slate-400 ml-auto">
                {t('report.generatedAt', { time: formatLocalizedDate(new Date(deviceReport.created_at * 1000), { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + formatLocalizedTime(new Date(deviceReport.created_at * 1000), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}
              </span>
            </div>
            <div
              use:interceptReportLinks
              class="markdown-body report-sheet-body prose prose-slate dark:prose-invert max-w-none"
            >
              {@html renderMarkdown(deviceReport.content)}
            </div>
          </div>
        </div>
      {/each}
    {:else}
    <div class="page-card report-sheet report-article-card">
      <div class="report-sheet-content">
        <div class="report-sheet-meta text-xs text-slate-400 mb-4 flex items-center gap-2">
          <div class="w-1.5 h-1.5 rounded-full {isYesterdayReport ? 'bg-amber-500' : 'bg-emerald-500'}"></div>
          {isYesterdayReport ? t('report.yesterdayPrefix') : ''}{t('report.generatedAt', { time: formatLocalizedDate(new Date(report.created_at * 1000), { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + formatLocalizedTime(new Date(report.created_at * 1000), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })}
        </div>
        {#if freshStats}
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <div class="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2.5 text-center">
              <div class="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">{t('report.statTotalDuration')}</div>
              <div class="text-sm font-semibold text-slate-800 dark:text-slate-200">{formatDurationLocalized(freshStats.total_duration)}</div>
            </div>
            <div class="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2.5 text-center">
              <div class="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">{t('report.statScreenshots')}</div>
              <div class="text-sm font-semibold text-slate-800 dark:text-slate-200">{freshStats.screenshot_count}</div>
            </div>
            <div class="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2.5 text-center">
              <div class="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">{t('report.statApps')}</div>
              <div class="text-sm font-semibold text-slate-800 dark:text-slate-200">{freshStats.app_usage?.length ?? 0}</div>
            </div>
            <div class="rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-2.5 text-center">
              <div class="text-[11px] text-slate-500 dark:text-slate-400 mb-0.5">{t('report.statWebsites')}</div>
              <div class="text-sm font-semibold text-slate-800 dark:text-slate-200">{freshStats.domain_usage?.length ?? 0}</div>
            </div>
          </div>
        {/if}
        <div class="markdown-body report-sheet-body prose prose-slate dark:prose-invert max-w-none">
          {#each reportSections as section, i}
            <div class="report-section">
              <div class="report-section-header">
                <div
                  use:interceptReportLinks
                  class="report-section-content"
                >
                  {@html renderMarkdown(section.title + '\n' + section.body)}
                </div>
                <button
                  class="report-section-edit-btn"
                  on:click={() => startEditSection(reportSections, i)}
                  title={t('report.editSection')}
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
    {/if}
    {:else}
    <div class="empty-state-lg">
      <div class="empty-state-icon !w-16 !h-16 !mb-5 bg-amber-50 dark:bg-amber-950/30">
        <span class="text-3xl">📝</span>
      </div>
      <h3 class="empty-state-title">
        {selectedDate === getLocalDateString() ? t('report.noReportToday') : t('report.noReportForDate', { date: selectedDate })}
      </h3>
      <p class="empty-state-copy mb-5">
        {t('report.aiWillGenerate')}
      </p>
      <button
        class="page-action-warn min-h-11 px-6 py-3"
        on:click={() => generateReport(false)}
        disabled={generating}
      >
        {#if generating}
          <div class="inline-flex items-center gap-2">
            <div class="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
            {t('report.generating')}
          </div>
        {:else}
          ✨ {selectedDate === getLocalDateString() ? t('report.generatingToday') : t('report.generatingSelected')}
        {/if}
      </button>
    </div>
  {/if}
</div>
</div>

<!-- 段落编辑弹窗 -->
{#if editingSection >= 0}
  <div class="modal-overlay" on:click|self={cancelEditSection}>
    <div class="modal-panel" on:click|stopPropagation>
      <div class="modal-header">
        <h3 class="modal-title">{t('report.editSection')}</h3>
        <button class="modal-close" on:click={cancelEditSection}>
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <textarea
          class="report-edit-textarea"
          bind:value={editingContent}
        ></textarea>
      </div>
      <div class="modal-footer">
        <button class="page-control-btn" on:click={cancelEditSection}>
          {t('report.cancelEdit')}
        </button>
        <button
          class="page-action-brand"
          on:click={() => saveEditSection(reportSections, editingSection)}
        >
          {t('report.saveSection')}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- 表格 / 标题 / 列表等 markdown 样式已统一放到 app.css .markdown-body -->

{#if showPresetModal}
  <div class="modal-overlay" on:click|self={() => { showPresetModal = false; }}>
    <div class="modal-panel" style="max-width: 36rem;" on:click|stopPropagation>
      <div class="modal-header">
        <h3 class="modal-title">{editingPresetIndex >= 0 ? editingPresetName || t('report.presetsTitle') : t('report.addPreset')}</h3>
        <button class="modal-close" on:click={() => { showPresetModal = false; }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="modal-body space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">{t('report.presetNamePlaceholder')}</label>
          <input
            type="text"
            class="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors"
            placeholder={t('report.presetNamePlaceholder')}
            bind:value={editingPresetName}
          />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">{t('report.promptLabel')}</label>
          <textarea
            class="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-colors resize-y min-h-[160px] leading-relaxed"
            placeholder={t('report.presetPromptPlaceholder')}
            bind:value={editingPresetPrompt}
            rows="6"
          ></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button
          class="px-4 py-2 text-sm font-medium rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          on:click={() => { showPresetModal = false; }}
        >
          {t('report.cancelEdit')}
        </button>
        <button
          class="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={!editingPresetName.trim() || !editingPresetPrompt.trim() || presetSaving}
          on:click={async () => {
            if (presetSaving) return;
            presetSaving = true;
            try {
              const presets = [...(config.daily_report_prompt_presets || [])];
              const entry = { name: editingPresetName.trim(), prompt: editingPresetPrompt.trim() };
              if (editingPresetIndex >= 0) {
                presets[editingPresetIndex] = entry;
              } else {
                presets.push(entry);
              }
              config.daily_report_prompt_presets = presets;
              await savePresets();
              showPresetModal = false;
            } finally {
              presetSaving = false;
            }
          }}
        >
          {#if presetSaving}
            <span class="inline-flex items-center gap-1.5">
              <span class="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
              {t('report.saving')}
            </span>
          {:else}
            {t('report.saveSection')}
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
