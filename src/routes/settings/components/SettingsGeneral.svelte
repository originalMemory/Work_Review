<script>
  import { createEventDispatcher, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { formatDurationLocalized, locale, t } from '$lib/i18n/index.js';
  import SettingsAppearance from './SettingsAppearance.svelte';

  export let config;

  const dispatch = createEventDispatcher();
  $: currentLocale = $locale;
  let workHours = '—';
  let autoStartEnabled = false;
  /** @type {string[]} */
  let recordedAppNames = [];
  let addIdleExemptSelection = '';
  const MAX_WORK_SEGMENTS = 8;

  onMount(async () => {
    try {
      autoStartEnabled = await invoke('is_autostart_enabled');
      if (config.auto_start !== autoStartEnabled) {
        config.auto_start = autoStartEnabled;
        try {
          await invoke('save_config', { config });
        } catch (e) {
          console.error('对齐注册表自启状态时写盘失败:', e);
        }
        dispatch('change', config);
      }
    } catch (e) {
      console.error('查询自启动状态失败:', e);
    }
    try {
      recordedAppNames = await invoke('get_recorded_app_names');
    } catch (e) {
      console.error('加载已记录应用列表失败:', e);
      recordedAppNames = [];
    }
  });

  $: idleExemptList = config.idle_exempt_app_names ?? [];
  $: idleExemptAddOptions = (() => {
    const sel = new Set(idleExemptList);
    const merged = [...new Set([...recordedAppNames, ...idleExemptList])];
    return merged.filter((n) => !sel.has(n)).sort((a, b) => a.localeCompare(b));
  })();

  function removeIdleExempt(name) {
    if (!config.idle_exempt_app_names) config.idle_exempt_app_names = [];
    config.idle_exempt_app_names = config.idle_exempt_app_names.filter((n) => n !== name);
    dispatch('change', config);
  }

  function addIdleExemptFromSelect() {
    const name = addIdleExemptSelection;
    if (!name) return;
    if (!config.idle_exempt_app_names) config.idle_exempt_app_names = [];
    if (config.idle_exempt_app_names.includes(name)) return;
    config.idle_exempt_app_names = [...config.idle_exempt_app_names, name];
    addIdleExemptSelection = '';
    dispatch('change', config);
  }

  // 小时选项 (0-23)
  function normalizeHour(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(Math.max(parsed, 0), 23);
  }

  function normalizeMinute(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(Math.max(parsed, 0), 59);
  }

  function parseTimeInput(value) {
    const [hour = '0', minute = '0'] = String(value ?? '').split(':');
    return [normalizeHour(hour), normalizeMinute(minute)];
  }

  function segmentToTimeValue(hour, minute) {
    return `${String(normalizeHour(hour)).padStart(2, '0')}:${String(normalizeMinute(minute)).padStart(2, '0')}`;
  }

  function normalizeSegment(segment) {
    return {
      start_hour: normalizeHour(segment?.start_hour),
      start_minute: normalizeMinute(segment?.start_minute),
      end_hour: normalizeHour(segment?.end_hour),
      end_minute: normalizeMinute(segment?.end_minute),
    };
  }

  function normalizeWorkSegments(segments) {
    if (Array.isArray(segments) && segments.length > 0) {
      return segments.slice(0, MAX_WORK_SEGMENTS).map(normalizeSegment);
    }
    return [
      normalizeSegment({
        start_hour: config?.work_start_hour ?? 9,
        start_minute: config?.work_start_minute ?? 0,
        end_hour: config?.work_end_hour ?? 18,
        end_minute: config?.work_end_minute ?? 0,
      }),
    ];
  }

  function syncLegacyWorkRange(segments) {
    if (!segments.length) return;
    const first = segments[0];
    const last = segments[segments.length - 1];
    config.work_start_hour = first.start_hour;
    config.work_start_minute = first.start_minute;
    config.work_end_hour = last.end_hour;
    config.work_end_minute = last.end_minute;
  }

  function segmentDurationMinutes(segment) {
    const startTotal = segment.start_hour * 60 + segment.start_minute;
    const endTotal = segment.end_hour * 60 + segment.end_minute;
    const isZeroDuration = endTotal === startTotal;
    if (isZeroDuration) return 0;
    return endTotal < startTotal ? endTotal + 24 * 60 - startTotal : endTotal - startTotal;
  }

  $: workSegments = normalizeWorkSegments(config?.work_time_segments);

  $: {
    currentLocale;
    const diffMinutes = workSegments.reduce((sum, segment) => sum + segmentDurationMinutes(segment), 0);
    const diffSeconds = diffMinutes * 60;
    workHours = diffSeconds === 0 ? formatDurationLocalized(0) : formatDurationLocalized(diffSeconds);
  }

  function updateSegment(index, type, value) {
    const segments = normalizeWorkSegments(config.work_time_segments);
    const target = { ...segments[index] };
    const [hour, minute] = parseTimeInput(value);
    if (type === 'start') {
      target.start_hour = hour;
      target.start_minute = minute;
    } else {
      target.end_hour = hour;
      target.end_minute = minute;
    }
    segments[index] = normalizeSegment(target);
    config.work_time_segments = segments;
    syncLegacyWorkRange(segments);
    dispatch('change', config);
  }

  function addWorkSegment() {
    const segments = normalizeWorkSegments(config.work_time_segments);
    if (segments.length >= MAX_WORK_SEGMENTS) return;

    const last = segments[segments.length - 1];
    const nextStartHour = normalizeHour(last?.end_hour ?? 9);
    const nextStartMinute = normalizeMinute(last?.end_minute ?? 0);
    const nextEndHour = (nextStartHour + 1) % 24;
    const nextSegment = normalizeSegment({
      start_hour: nextStartHour,
      start_minute: nextStartMinute,
      end_hour: nextEndHour,
      end_minute: nextStartMinute,
    });

    segments.push(nextSegment);
    config.work_time_segments = segments;
    syncLegacyWorkRange(segments);
    dispatch('change', config);
  }

  function removeWorkSegment(index) {
    const segments = normalizeWorkSegments(config.work_time_segments);
    if (segments.length <= 1) return;
    segments.splice(index, 1);
    config.work_time_segments = segments;
    syncLegacyWorkRange(segments);
    dispatch('change', config);
  }

  function handleChange() {
    dispatch('change', config);
  }

  async function toggleAutoStart() {
    const targetState = !autoStartEnabled;
    try {
      if (targetState) {
        await invoke('enable_autostart', { silent: !!config.auto_start_silent });
      } else {
        await invoke('disable_autostart');
      }
    } catch (e) {
      console.warn(`切换系统自启失败/警告 (目标状态: ${targetState}):`, e);
    }
    try {
      autoStartEnabled = await invoke('is_autostart_enabled');
      config.auto_start = autoStartEnabled;
      try {
        await invoke('save_config', { config });
      } catch (e) {
        console.error('保存开机自启状态失败:', e);
      }
      dispatch('change', config);
    } catch (e) {
      console.error('重新校验开机自启状态失败:', e);
    }
  }

  async function toggleDockIcon() {
    config.hide_dock_icon = !config.hide_dock_icon;
    try {
      await invoke('set_dock_visibility', { visible: !config.hide_dock_icon });
    } catch (e) {
      console.error('设置 Dock 图标失败:', e);
    }
    dispatch('change', config);
  }

  function toggleLightweightMode() {
    config.lightweight_mode = !config.lightweight_mode;
    dispatch('change', config);
  }

  async function updateAutoStartLaunchMode(silentMode) {
    config.auto_start_silent = silentMode;
    try {
      await invoke('save_config', { config });
    } catch (e) {
      console.error('保存启动模式失败:', e);
    }
    if (autoStartEnabled) {
      try {
        await invoke('enable_autostart', { silent: silentMode });
      } catch (e) {
        console.error('更新自启动参数失败:', e);
      }
    }
    dispatch('change', config);
  }
</script>

<div class="settings-card" data-locale={currentLocale}>
  <h3 class="settings-card-title">{t('settingsGeneral.title')}</h3>

  <div class="settings-section">
    <!-- 工作时段 -->
    <div class="settings-block">
      <div class="flex items-center justify-between">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="settings-text">{t('settingsGeneral.workTime')}</span>
          {#if config.work_time_enabled}
            <span class="settings-muted">{t('settingsGeneral.totalWorkHours', { duration: workHours })}</span>
          {:else}
            <span class="settings-muted">{t('settingsGeneral.workTimeDisabledHint')}</span>
          {/if}
        </div>
        <button
          type="button"
          on:click={() => {
            config.work_time_enabled = !config.work_time_enabled;
            handleChange();
          }}
          class="switch-track {config.work_time_enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}"
          aria-pressed={config.work_time_enabled}
        >
          <span class="switch-thumb {config.work_time_enabled ? 'translate-x-5' : 'translate-x-0'}"></span>
        </button>
      </div>

      {#if config.work_time_enabled}
      <div class="space-y-2.5">
        {#each workSegments as segment, index}
          <div class="flex flex-wrap items-center gap-2.5">
            <span class="settings-subtle min-w-16">{t('settingsGeneral.segmentLabel', { index: index + 1 })}</span>
            <div class="control-inline">
              <span class="settings-subtle">{t('settingsGeneral.from')}</span>
              <input
                type="time"
                value={segmentToTimeValue(segment.start_hour, segment.start_minute)}
                on:change={(e) => updateSegment(index, 'start', e.target.value)}
                class="w-24 bg-transparent text-sm font-mono text-slate-800 dark:text-white focus:outline-none"
              />
            </div>

            <span class="text-slate-300 dark:text-slate-600">—</span>

            <div class="control-inline">
              <span class="settings-subtle">{t('settingsGeneral.to')}</span>
              <input
                type="time"
                value={segmentToTimeValue(segment.end_hour, segment.end_minute)}
                on:change={(e) => updateSegment(index, 'end', e.target.value)}
                class="w-24 bg-transparent text-sm font-mono text-slate-800 dark:text-white focus:outline-none"
              />
            </div>

            <button
              type="button"
              class="settings-action-secondary px-2.5 py-1.5 text-xs"
              disabled={workSegments.length <= 1}
              on:click={() => removeWorkSegment(index)}
            >
              {t('settingsGeneral.removeSegment')}
            </button>
          </div>
        {/each}
      </div>
      <button
        type="button"
        class="settings-action-secondary mt-3 px-3 py-1.5 text-xs"
        on:click={addWorkSegment}
        disabled={workSegments.length >= MAX_WORK_SEGMENTS}
      >
        {t('settingsGeneral.addSegment')}
      </button>
      <p class="settings-note">{t('settingsGeneral.workTimeHint')}</p>
      {/if}

      <!-- 空闲检测阈值 -->
      <div class="flex items-center justify-between mt-3">
        <div>
          <span class="settings-text text-sm">{t('settingsGeneral.idleThreshold')}</span>
          <p class="settings-muted mt-0.5">{t('settingsGeneral.idleThresholdHint')}</p>
        </div>
        <div class="flex items-center gap-2">
          <input
            type="number"
            min="1"
            max="60"
            step="1"
            bind:value={config.idle_threshold_minutes}
            on:change={() => {
              config.idle_threshold_minutes = Math.max(1, Math.min(60, Number(config.idle_threshold_minutes) || 5));
              handleChange();
            }}
            class="w-16 rounded-md border border-slate-200 bg-white px-2 py-1 text-center text-sm dark:border-slate-600 dark:bg-slate-800"
          />
          <span class="text-xs settings-subtle">{t('settingsGeneral.minutesUnit')}</span>
        </div>
      </div>

      <!-- 空闲检测豁免应用 -->
      <div class="settings-block mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
        <div class="settings-text">{t('settingsGeneral.idleExemptTitle')}</div>
        <p class="settings-muted mt-1 text-sm leading-relaxed">
          {t('settingsGeneral.idleExemptDescription')}
        </p>

        <div class="mt-3 flex min-h-[2rem] flex-wrap gap-2">
          {#if idleExemptList.length === 0}
            <span class="settings-subtle">{t('settingsGeneral.idleExemptEmpty')}</span>
          {:else}
            {#each idleExemptList as name (name)}
              <span
                class="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2.5 py-0.5 text-sm text-slate-800 dark:bg-slate-700 dark:text-slate-100"
              >
                {name}
                <button
                  type="button"
                  class="rounded p-0.5 text-slate-500 hover:bg-slate-300 hover:text-slate-800 dark:hover:bg-slate-600 dark:hover:text-white"
                  aria-label={t('settingsGeneral.idleExemptRemoveAria', { name })}
                  on:click={() => removeIdleExempt(name)}
                >
                  ×
                </button>
              </span>
            {/each}
          {/if}
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <select
            bind:value={addIdleExemptSelection}
            class="min-w-[12rem] rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">{t('settingsGeneral.idleExemptAddPlaceholder')}</option>
            {#each idleExemptAddOptions as opt (opt)}
              <option value={opt}>{opt}</option>
            {/each}
          </select>
          <button
            type="button"
            disabled={!addIdleExemptSelection}
            class="rounded-md bg-primary-500 px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
            on:click={addIdleExemptFromSelect}
          >
            {t('settingsGeneral.idleExemptAdd')}
          </button>
        </div>
        {#if recordedAppNames.length === 0}
          <p class="settings-note mt-2">{t('settingsGeneral.idleExemptNoCandidates')}</p>
        {/if}
      </div>
    </div>

    <!-- 日报设置 -->
    <div class="settings-block pt-4 border-t border-slate-200 dark:border-slate-700">
      <div class="flex flex-wrap items-center gap-3">
        <span class="settings-text">{t('settingsGeneral.reportAutoGenerateTime')}</span>
        <div class="control-inline">
          <input
            type="time"
            value={config.daily_report_auto_generate_time ?? ''}
            on:change={(e) => {
              config.daily_report_auto_generate_time = e.target.value || null;
              dispatch('change', config);
            }}
            class="w-20 bg-transparent text-sm font-mono text-slate-800 dark:text-white focus:outline-none"
          />
        </div>
        {#if config.daily_report_auto_generate_time}
          <button
            type="button"
            class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg text-rose-500 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30 transition-colors"
            on:click={() => {
              config.daily_report_auto_generate_time = null;
              dispatch('change', config);
            }}
          >
            {t('settingsGeneral.reportAutoGenerateReset')}
          </button>
        {/if}
      </div>
      <p class="settings-note">{t('settingsGeneral.reportAutoGenerateTimeHint')}</p>
    </div>

    <!-- 系统行为 -->
    <div class="settings-block pt-4 border-t border-slate-200 dark:border-slate-700">
      <div class="space-y-2.5">
        <div class="settings-row">
          <span class="settings-text">{t('settingsGeneral.autoStart')}</span>
          <button
            on:click={toggleAutoStart}
            class="switch-track {autoStartEnabled ? 'bg-primary-500' : 'bg-slate-300 dark:bg-slate-600'}"
          >
            <span class="switch-thumb {autoStartEnabled ? 'translate-x-5' : 'translate-x-0'}"></span>
          </button>
        </div>

        {#if autoStartEnabled}
          <div class="ml-3 pl-3 border-l-2 border-primary-200/60 dark:border-primary-800/40">
            <span class="settings-label">{t('settingsGeneral.autoStartLaunchMode')}</span>
            <div class="mt-2 flex gap-2">
              <button
                type="button"
                on:click={() => updateAutoStartLaunchMode(false)}
                class="segment-btn {config.auto_start_silent ? 'settings-segment-base' : 'settings-segment-active'}"
              >
                {t('settingsGeneral.autoStartLaunchShow')}
              </button>
              <button
                type="button"
                on:click={() => updateAutoStartLaunchMode(true)}
                class="segment-btn {config.auto_start_silent ? 'settings-segment-active' : 'settings-segment-base'}"
              >
                {t('settingsGeneral.autoStartLaunchSilent')}
              </button>
            </div>
          </div>
        {/if}

        <div class="settings-row">
          <span class="settings-text">{t('settingsGeneral.hideDockIcon')}</span>
          <button
            on:click={toggleDockIcon}
            class="switch-track {config.hide_dock_icon ? 'bg-primary-500' : 'bg-slate-300 dark:bg-slate-600'}"
          >
            <span class="switch-thumb {config.hide_dock_icon ? 'translate-x-5' : 'translate-x-0'}"></span>
          </button>
        </div>

        <div class="settings-row">
          <div>
            <span class="settings-text">{t('settingsGeneral.lightweightMode')}</span>
            <p class="settings-muted mt-0.5">{t('settingsGeneral.lightweightModeDescription')}</p>
          </div>
          <button
            on:click={toggleLightweightMode}
            class="switch-track {config.lightweight_mode ? 'bg-primary-500' : 'bg-slate-300 dark:bg-slate-600'}"
          >
            <span class="switch-thumb {config.lightweight_mode ? 'translate-x-5' : 'translate-x-0'}"></span>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>

<SettingsAppearance bind:config mode="background-only" on:change={handleChange} />
