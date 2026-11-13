<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { ComponentEvents, ComponentProps } from 'svelte';
  import SettingsAppearance from './SettingsAppearance.svelte';

  type AppearanceConfig = ComponentProps<SettingsAppearance>['config'];
  type AppearanceChangeEvent = ComponentEvents<SettingsAppearance>['change'];
  type AppearanceChangeDetail = AppearanceChangeEvent['detail'];

  export let config: AppearanceConfig;

  const dispatch = createEventDispatcher<{ change: AppearanceChangeDetail }>();

  function handleChange(event: AppearanceChangeEvent) {
    dispatch('change', event.detail);
  }
</script>

<SettingsAppearance
  bind:config
  mode="avatar-only"
  on:change={handleChange}
/>
