<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { selectedDeviceId } from '../stores/deviceFilter.js';
  import { t, locale } from '$lib/i18n/index.js';

  /**
   * @typedef {{ device_id: string, device_name: string, last_seen?: number }} DeviceInfo
   */

  /** @type {DeviceInfo[]} */
  let devices = [];
  $: currentLocale = $locale;

  onMount(async () => {
    try {
      devices = await invoke('get_known_devices');
    } catch (e) {
      console.warn('Failed to load devices:', e);
    }
  });

  async function handleChange(e) {
    const val = e.target.value;
    const next = val === '' ? null : val;
    $selectedDeviceId = next;
    try {
      await invoke('set_ui_selected_device_id', { deviceId: next });
    } catch (err) {
      console.warn('保存设备筛选失败:', err);
    }
  }
</script>

{#if devices.length > 1}
  <div class="device-filter">
    <label class="device-filter-label">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
        <path d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10z" />
      </svg>
      <select value={$selectedDeviceId ?? ''} on:change={handleChange}>
        <option value="">{t('deviceFilter.allDevices')}</option>
        {#each devices as device}
          <option value={device.device_id}>{device.device_name || device.device_id}</option>
        {/each}
      </select>
    </label>
  </div>
{/if}

<style>
  .device-filter {
    display: inline-flex;
    align-items: center;
  }

  .device-filter-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-secondary, #6b7280);
    font-size: 0.8rem;
  }

  select {
    background: var(--bg-secondary, #f3f4f6);
    border: 1px solid var(--border-color, #e5e7eb);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 0.8rem;
    color: var(--text-primary, #1f2937);
    cursor: pointer;
    outline: none;
  }

  select:focus {
    border-color: var(--accent-color, #3b82f6);
  }

  :global(.dark) select {
    background: var(--bg-secondary, #374151);
    border-color: var(--border-color, #4b5563);
    color: var(--text-primary, #f9fafb);
  }
</style>
