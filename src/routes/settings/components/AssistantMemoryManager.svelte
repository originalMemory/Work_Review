<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

  type MemoryType = 'preference' | 'workflow' | 'profile' | 'goal' | 'project' | 'constraint';
  type RecallPolicy = 'always' | 'relevant' | 'manual';
  type Sensitivity = 'normal' | 'caution';

  interface UserMemory {
    id: number;
    memoryType: MemoryType;
    memoryKey: string;
    valueText: string;
    recallPolicy: RecallPolicy;
    sensitivity: Sensitivity;
    sourceKind: string;
    sourceConversationId: number | null;
    sourceRequestId: string | null;
    revision: number;
    expiresAt: number | null;
    createdAt: number;
    updatedAt: number;
  }

  interface MemoryForm {
    memoryType: MemoryType;
    memoryKey: string;
    valueText: string;
    recallPolicy: RecallPolicy;
    sensitivity: Sensitivity;
    expiresAt: number | null;
  }

  export let enabled = false;
  export let t: (key: string) => string = (key) => key;

  const MEMORY_LIMIT = 200;
  const memoryTypes: MemoryType[] = ['preference', 'workflow', 'profile', 'goal', 'project', 'constraint'];
  const recallPolicies: RecallPolicy[] = ['always', 'relevant', 'manual'];
  const memoryTypeLabelKeys: Record<MemoryType, string> = {
    preference: 'settingsAI.assistantMemory.types.preference',
    workflow: 'settingsAI.assistantMemory.types.workflow',
    profile: 'settingsAI.assistantMemory.types.profile',
    goal: 'settingsAI.assistantMemory.types.goal',
    project: 'settingsAI.assistantMemory.types.project',
    constraint: 'settingsAI.assistantMemory.types.constraint',
  };
  const recallPolicyLabelKeys: Record<RecallPolicy, string> = {
    always: 'settingsAI.assistantMemory.policies.always',
    relevant: 'settingsAI.assistantMemory.policies.relevant',
    manual: 'settingsAI.assistantMemory.policies.manual',
  };

  let memories: UserMemory[] = [];
  let searchQuery = '';
  let selectedMemoryType: MemoryType | '' = '';
  let loading = false;
  let loadError = '';
  let actionError = '';
  let saveError = '';
  let saving = false;
  let deletingId: number | null = null;
  let clearing = false;
  let editorOpen = false;
  let editingId: number | null = null;
  let expectedRevision: number | null = null;
  let mounted = false;
  let loadedForCurrentEnable = false;
  let loadRequestId = 0;

  function emptyForm(): MemoryForm {
    return {
      memoryType: selectedMemoryType || 'preference',
      memoryKey: '',
      valueText: '',
      recallPolicy: 'relevant',
      sensitivity: 'normal',
      expiresAt: null,
    };
  }

  let form = emptyForm();

  const closeEditor = () => {
    editorOpen = false;
    editingId = null;
    expectedRevision = null;
    saveError = '';
    form = emptyForm();
  };

  const sourceReference = (memory: UserMemory) => {
    const references: string[] = [];
    if (memory.sourceConversationId != null) {
      references.push(String(memory.sourceConversationId));
    }
    if (memory.sourceRequestId) {
      references.push(memory.sourceRequestId);
    }
    return references.join(' · ');
  };

  function buildInput(): MemoryForm {
    return {
      memoryType: form.memoryType,
      memoryKey: form.memoryKey.trim(),
      valueText: form.valueText.trim(),
      recallPolicy: form.recallPolicy,
      sensitivity: form.sensitivity,
      expiresAt: form.expiresAt,
    };
  }

  async function loadMemories() {
    if (!enabled) return;

    const requestId = ++loadRequestId;
    loading = true;
    loadError = '';
    try {
      const result = await invoke<UserMemory[]>('list_user_memories', {
        memoryType: selectedMemoryType || null,
        limit: MEMORY_LIMIT,
      });
      if (requestId !== loadRequestId || !enabled) return;
      memories = Array.isArray(result) ? result : [];
    } catch (error) {
      if (requestId !== loadRequestId || !enabled) return;
      loadError = `${t('settingsAI.assistantMemory.loadFailed')}: ${String(error)}`;
    } finally {
      if (requestId === loadRequestId) {
        loading = false;
      }
    }
  }

  function openCreateForm() {
    if (!enabled) return;
    editingId = null;
    expectedRevision = null;
    form = emptyForm();
    saveError = '';
    editorOpen = true;
  }

  function openEditForm(memory: UserMemory) {
    if (!enabled) return;
    editingId = memory.id;
    expectedRevision = memory.revision;
    form = {
      memoryType: memory.memoryType,
      memoryKey: memory.memoryKey,
      valueText: memory.valueText,
      recallPolicy: memory.recallPolicy,
      sensitivity: memory.sensitivity || 'normal',
      expiresAt: memory.expiresAt ?? null,
    };
    saveError = '';
    editorOpen = true;
  }

  async function submitMemory() {
    if (!enabled || saving) return;

    const input = buildInput();
    if (!input.memoryKey || !input.valueText) return;

    saving = true;
    saveError = '';
    try {
      if (editingId === null) {
        const created = await invoke<UserMemory>('create_user_memory', { input });
        if (!selectedMemoryType || created.memoryType === selectedMemoryType) {
          memories = [created, ...memories];
        }
      } else {
        const updated = await invoke<UserMemory>('update_user_memory', {
          id: editingId,
          input,
          expectedRevision,
        });
        memories = memories
          .map((memory) => (memory.id === updated.id ? updated : memory))
          .filter((memory) => !selectedMemoryType || memory.memoryType === selectedMemoryType);
      }
      closeEditor();
    } catch (error) {
      saveError = `${t('settingsAI.assistantMemory.saveFailed')}: ${String(error)}`;
    } finally {
      saving = false;
    }
  }

  async function deleteMemory(memory: UserMemory) {
    if (!enabled) return;
    if (!window.confirm(t('settingsAI.assistantMemory.confirmDelete'))) return;

    deletingId = memory.id;
    actionError = '';
    try {
      await invoke<void>('delete_user_memory', {
        id: memory.id,
        expectedRevision: memory.revision,
      });
      memories = memories.filter((item) => item.id !== memory.id);
      if (editingId === memory.id) closeEditor();
    } catch (error) {
      actionError = `${t('settingsAI.assistantMemory.deleteFailed')}: ${String(error)}`;
    } finally {
      deletingId = null;
    }
  }

  async function clearMemories() {
    if (!enabled) return;
    if (!window.confirm(t('settingsAI.assistantMemory.confirmClear'))) return;

    clearing = true;
    actionError = '';
    try {
      await invoke<number>('clear_user_memories');
      memories = [];
      closeEditor();
    } catch (error) {
      actionError = `${t('settingsAI.assistantMemory.clearFailed')}: ${String(error)}`;
    } finally {
      clearing = false;
    }
  }

  function formatUpdatedAt(value: number | null): string {
    if (value == null) return '—';
    const timestamp = typeof value === 'number' && value < 1_000_000_000_000
      ? value * 1000
      : value;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  const typeLabel = (memoryType: MemoryType) => t(memoryTypeLabelKeys[memoryType]);
  const policyLabel = (recallPolicy: RecallPolicy) => t(recallPolicyLabelKeys[recallPolicy]);

  $: normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  $: filteredMemories = normalizedSearch
    ? memories.filter((memory) =>
        [memory.memoryType, memory.memoryKey, memory.valueText]
          .some((value) => String(value || '').toLocaleLowerCase().includes(normalizedSearch)))
    : memories;

  $: if (mounted && enabled && !loadedForCurrentEnable) {
    loadedForCurrentEnable = true;
    loadMemories();
  }

  $: if (!enabled && loadedForCurrentEnable) {
    loadedForCurrentEnable = false;
    loadRequestId += 1;
    loading = false;
    loadError = '';
    actionError = '';
    closeEditor();
  }

  onMount(() => {
    mounted = true;
    return () => {
      mounted = false;
      loadRequestId += 1;
    };
  });
</script>

<section class="settings-panel space-y-4" aria-labelledby="assistant-memory-title">
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h3 id="assistant-memory-title" class="settings-text">
        {t('settingsAI.assistantMemory.title')}
      </h3>
      <p class="settings-muted mt-1">{t('settingsAI.assistantMemory.hint')}</p>
    </div>
  </div>

  {#if !enabled}
    <p class="settings-muted rounded-lg bg-slate-100 px-3 py-2 dark:bg-[#30363d]/50">
      {t('settingsAI.assistantMemory.disabled')}
    </p>
  {:else}
    <p class="settings-muted rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-300">
      {t('settingsAI.assistantMemory.cloudNotice')}
    </p>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input
        type="search"
        bind:value={searchQuery}
        class="control-input min-w-0 flex-1"
        placeholder={t('settingsAI.assistantMemory.searchPlaceholder')}
        aria-label={t('settingsAI.assistantMemory.searchPlaceholder')}
      />
      <select
        bind:value={selectedMemoryType}
        on:change={loadMemories}
        class="control-input sm:w-40"
        aria-label={t('settingsAI.assistantMemory.type')}
      >
        <option value="">{t('settingsAI.assistantMemory.type')}</option>
        {#each memoryTypes as memoryType}
          <option value={memoryType}>{typeLabel(memoryType)}</option>
        {/each}
      </select>
      <button type="button" class="settings-action-primary shrink-0" on:click={openCreateForm}>
        {t('settingsAI.assistantMemory.add')}
      </button>
      <button
        type="button"
        class="settings-action-danger shrink-0"
        on:click={clearMemories}
        disabled={clearing || deletingId !== null}
      >
        {t('settingsAI.assistantMemory.clearAll')}
      </button>
    </div>

    {#if editorOpen}
      <form class="settings-card space-y-3" on:submit|preventDefault={submitMemory}>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="settings-field">
            <span class="settings-label">{t('settingsAI.assistantMemory.type')}</span>
            <select bind:value={form.memoryType} class="control-input" disabled={saving}>
              {#each memoryTypes as memoryType}
                <option value={memoryType}>{typeLabel(memoryType)}</option>
              {/each}
            </select>
          </label>

          <label class="settings-field">
            <span class="settings-label">{t('settingsAI.assistantMemory.recallPolicy')}</span>
            <select bind:value={form.recallPolicy} class="control-input" disabled={saving}>
              {#each recallPolicies as recallPolicy}
                <option
                  value={recallPolicy}
                  disabled={form.sensitivity === 'caution' && recallPolicy === 'always'}
                >
                  {policyLabel(recallPolicy)}
                </option>
              {/each}
            </select>
          </label>
        </div>

        <label class="settings-field">
          <span class="settings-label">{t('settingsAI.assistantMemory.key')}</span>
          <input
            type="text"
            bind:value={form.memoryKey}
            class="control-input"
            maxlength="160"
            required
            disabled={saving}
          />
        </label>

        <label class="settings-field">
          <span class="settings-label">{t('settingsAI.assistantMemory.value')}</span>
          <textarea
            bind:value={form.valueText}
            class="control-input min-h-24 resize-y"
            maxlength="4000"
            required
            disabled={saving}
          ></textarea>
        </label>

        {#if saveError}
          <p class="settings-text-danger text-xs" role="alert">{saveError}</p>
        {/if}

        <div class="settings-actions">
          <button
            type="button"
            class="settings-action-secondary"
            on:click={closeEditor}
            disabled={saving}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            class="settings-action-primary"
            disabled={saving || !form.memoryKey.trim() || !form.valueText.trim()}
          >
            {t('settingsAI.assistantMemory.save')}
          </button>
        </div>
      </form>
    {/if}

    {#if actionError}
      <p class="settings-text-danger text-xs" role="alert">{actionError}</p>
    {/if}

    <div aria-live="polite" aria-busy={loading}>
      {#if loading}
        <div class="settings-empty flex items-center justify-center gap-2">
          <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
          <span>{t('common.loading')}</span>
        </div>
      {:else if loadError}
        <div class="settings-empty space-y-2" role="alert">
          <p class="settings-text-danger">{loadError}</p>
          <button type="button" class="settings-action-secondary" on:click={loadMemories}>
            {t('common.retry')}
          </button>
        </div>
      {:else if filteredMemories.length === 0}
        <p class="settings-empty">{t('settingsAI.assistantMemory.empty')}</p>
      {:else}
        <div class="space-y-2">
          {#each filteredMemories as memory (memory.id)}
            <article class="settings-row items-start">
              <div class="min-w-0 flex-1 space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="settings-chip-neutral">{typeLabel(memory.memoryType)}</span>
                  <strong class="min-w-0 break-words text-sm text-slate-800 dark:text-[#e6edf3]">
                    {memory.memoryKey}
                  </strong>
                  {#if memory.sensitivity === 'caution'}
                    <span
                      class="h-2 w-2 rounded-full bg-amber-500"
                      title={memory.sensitivity}
                      aria-label={memory.sensitivity}
                    ></span>
                  {/if}
                </div>

                <p class="whitespace-pre-wrap break-words text-sm text-slate-600 dark:text-[#adbac7]">
                  {memory.valueText}
                </p>

                <dl class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400 dark:text-[#636c76]">
                  <div class="flex items-center gap-1">
                    <dt>{t('settingsAI.assistantMemory.recallPolicy')}:</dt>
                    <dd>{policyLabel(memory.recallPolicy)}</dd>
                  </div>
                  <div class="flex items-center gap-1">
                    <dt>{t('settingsAI.assistantMemory.source')}:</dt>
                    <dd title={sourceReference(memory)}>{memory.sourceKind}</dd>
                  </div>
                  <div class="flex items-center gap-1">
                    <dt>{t('settingsAI.assistantMemory.updatedAt')}:</dt>
                    <dd>{formatUpdatedAt(memory.updatedAt)}</dd>
                  </div>
                </dl>
              </div>

              <div class="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  class="settings-link-action"
                  on:click={() => openEditForm(memory)}
                  disabled={deletingId === memory.id || clearing}
                >
                  {t('settingsAI.assistantMemory.edit')}
                </button>
                <button
                  type="button"
                  class="settings-link-danger"
                  on:click={() => deleteMemory(memory)}
                  disabled={deletingId === memory.id || clearing}
                >
                  {t('settingsAI.assistantMemory.delete')}
                </button>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>
