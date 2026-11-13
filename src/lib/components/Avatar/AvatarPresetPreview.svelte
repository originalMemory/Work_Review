<script lang="ts">
  import AvatarCanvas from './AvatarCanvas.svelte';
  import { getAvatarPresetOption, normalizeAvatarPresetId } from './avatarPresetRegistry.ts';
  import type { AvatarMode } from './avatarStateMeta.ts';

  export let presetId = 'original-standard';
  export let selected = false;

  const previewMode: AvatarMode = 'working';

  $: normalizedPresetId = normalizeAvatarPresetId(presetId);
  $: presetOption = getAvatarPresetOption(normalizedPresetId);
  $: previewState = {
    mode: previewMode,
    appName: 'Work Review',
    contextLabel: '办公中',
    hint: '',
    isIdle: false,
    isGeneratingReport: false,
    avatarOpacity: selected ? 0.96 : 0.9,
    avatarPreset: normalizedPresetId,
  };
  $: previewInputActivity = presetOption.previewInputActivity;
  $: previewMotionBeat = presetOption.previewMotionBeat ?? 18;
</script>

<div class="pointer-events-none h-full w-full overflow-hidden rounded-lg">
  <div class="h-full w-full scale-[1.08] origin-center">
    <AvatarCanvas
      state={previewState}
      inputActivity={previewInputActivity}
      transitionClass=""
      motionBeat={previewMotionBeat}
    />
  </div>
</div>
