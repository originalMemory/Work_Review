<script>
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { selectedDeviceId } from '../stores/deviceFilter.js';
  import { t } from '$lib/i18n/index.js';

  let devices = [];

  onMount(async () => {
    try {
      devices = await invoke('get_known_devices');
    } catch (error) {
      console.warn('加载同步设备失败:', error);
    }
  });

  async function changeDevice(event) {
    const next = event.currentTarget.value || null;
    $selectedDeviceId = next;
    try {
      await invoke('set_ui_selected_device_id', { deviceId: next });
    } catch (error) {
      console.warn('保存设备筛选失败:', error);
    }
  }
</script>

{#if devices.length > 1}
  <label class="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-[#8b949e]">
    <span>{t('deviceFilter.label')}</span>
    <select class="page-control-input w-auto" value={$selectedDeviceId ?? ''} on:change={changeDevice}>
      <option value="">{t('deviceFilter.allDevices')}</option>
      {#each devices as device}
        <option value={device.device_id}>{device.device_name || device.device_id}</option>
      {/each}
    </select>
  </label>
{/if}
