<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { t } from '$lib/i18n/index.ts';

  type DatePickerMode = 'single' | 'range';
  type RangeSelectionStage = 'start' | 'end';

  export let mode: DatePickerMode = 'single';
  export let localeCode = 'zh-CN';
  export let value = '';
  export let startDate = '';
  export let endDate = '';
  export let min = '';
  export let max = '';
  export let triggerClass = 'page-control-input';
  export let open = false;
  export let hideTrigger = false;
  export let inlinePanel = false;

  const dispatch = createEventDispatcher<{ change: void }>();
  const weekdayBase = new Date(Date.UTC(2026, 2, 1));

  let rootElement: HTMLDivElement | null = null;
  let triggerElement: HTMLButtonElement | null = null;
  let popoverElement: HTMLElement | null = null;
  let floatingPanelStyle = '';
  let rangeSelectionStage: RangeSelectionStage = 'start';
  let viewDate = new Date();

  function formatSelectionLabel(dateValue: string, compact = false): string {
    return dateValue ? formatTriggerLabel(dateValue, compact) : t('datePicker.notSelected');
  }

  function parseIsoDate(dateValue: string): Date {
    return new Date(`${dateValue}T12:00:00`);
  }

  function formatIsoDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1, 12);
  }

  function startOfWeek(date: Date): Date {
    return addDays(date, -date.getDay());
  }

  function sameMonth(left: Date, right: Date): boolean {
    return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth();
  }

  function clampDate(isoDate: string): string {
    if (!isoDate) return isoDate;
    if (min && isoDate < min) return min;
    if (max && isoDate > max) return max;
    return isoDate;
  }

  function formatTriggerLabel(dateValue: string, compact = false): string {
    if (!dateValue) return '';
    const options: Intl.DateTimeFormatOptions = {
      ...(compact ? {} : { year: 'numeric' }),
      month: '2-digit',
      day: '2-digit',
    };
    return new Intl.DateTimeFormat(localeCode, options).format(parseIsoDate(dateValue));
  }

  function getMonthTitle(date: Date): string {
    return new Intl.DateTimeFormat(localeCode, {
      year: 'numeric',
      month: 'long',
    }).format(date);
  }

  function getWeekdayLabels(): string[] {
    return Array.from({ length: 7 }, (_, offset) =>
      new Intl.DateTimeFormat(localeCode, { weekday: 'short' }).format(addDays(weekdayBase, offset))
    );
  }

  function buildVisibleDays(date: Date): Date[] {
    const monthStart = startOfMonth(date);
    const gridStart = startOfWeek(monthStart);
    return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  }

  function resetRangeSelectionStage(): void {
    rangeSelectionStage = 'start';
  }

  function portalToBody(
    node: HTMLElement,
    enabled: boolean,
  ): { destroy?: () => void } {
    if (!enabled) {
      return {};
    }

    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function updateFloatingPanelPosition(): void {
    if (!open || inlinePanel || !popoverElement) return;

    const anchorElement = triggerElement || rootElement;
    if (!anchorElement) return;

    const viewportPadding = 12;
    const gap = 6;
    const anchorRect = anchorElement.getBoundingClientRect();
    const panelWidth = popoverElement.offsetWidth || 212;
    const panelHeight = popoverElement.offsetHeight || 260;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - panelWidth - viewportPadding);

    let left = anchorRect.right - panelWidth;
    left = Math.min(Math.max(viewportPadding, left), maxLeft);

    let top = anchorRect.bottom + gap;
    if (top + panelHeight > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, anchorRect.top - panelHeight - gap);
    }

    floatingPanelStyle = `left: ${Math.round(left)}px; top: ${Math.round(top)}px;`;
  }

  function syncViewDate(): void {
    if (mode === 'range') {
      if (startDate) {
        viewDate = startOfMonth(parseIsoDate(startDate));
        return;
      }
      if (endDate) {
        viewDate = startOfMonth(parseIsoDate(endDate));
        return;
      }
    }

    if (value) {
      viewDate = startOfMonth(parseIsoDate(value));
      return;
    }

    viewDate = startOfMonth(new Date());
  }

  function openPanel(): void {
    syncViewDate();
    resetRangeSelectionStage();
    open = true;
    tick().then(updateFloatingPanelPosition);
  }

  function closePanel(): void {
    if (mode === 'range' && rangeSelectionStage === 'end' && startDate && !endDate) {
      endDate = startDate;
      dispatch('change');
    }
    open = false;
    resetRangeSelectionStage();
  }

  function togglePanel(): void {
    if (open) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function isDisabled(date: Date): boolean {
    const isoDate = formatIsoDate(date);
    return Boolean((min && isoDate < min) || (max && isoDate > max));
  }

  function isSelected(date: Date): boolean {
    const isoDate = formatIsoDate(date);
    if (mode === 'range') {
      return isoDate === startDate || isoDate === endDate;
    }
    return isoDate === value;
  }

  function isInRange(date: Date): boolean {
    if (mode !== 'range' || !startDate || !endDate || startDate === endDate) {
      return false;
    }
    const isoDate = formatIsoDate(date);
    return isoDate > startDate && isoDate < endDate;
  }

  function isRangeStart(date: Date): boolean {
    return mode === 'range' && !!startDate && formatIsoDate(date) === startDate;
  }

  function isRangeEnd(date: Date): boolean {
    return mode === 'range' && !!endDate && formatIsoDate(date) === endDate;
  }

  function selectToday(): void {
    const today = clampDate(formatIsoDate(new Date()));
    if (!today) return;

    if (mode === 'range') {
      startDate = today;
      endDate = today;
    } else {
      value = today;
    }

    dispatch('change');
    closePanel();
  }

  function selectDate(day: Date): void {
    const isoDate = clampDate(formatIsoDate(day));
    if (!isoDate || isDisabled(day)) return;

    if (mode === 'range') {
      if (rangeSelectionStage === 'start') {
        startDate = isoDate;
        endDate = '';
        rangeSelectionStage = 'end';
        return;
      }

      if (isoDate < startDate) {
        endDate = startDate;
        startDate = isoDate;
      } else {
        endDate = isoDate;
      }

      dispatch('change');
      closePanel();
      return;
    }

    value = isoDate;
    dispatch('change');
    closePanel();
  }

  function shiftMonth(offset: number): void {
    viewDate = startOfMonth(new Date(viewDate.getFullYear(), viewDate.getMonth() + offset, 1, 12));
  }

  function handleDocumentPointerDown(event: MouseEvent): void {
    if (!open || !rootElement) return;
    if (event.target instanceof Node && rootElement.contains(event.target)) return;
    if (event.target instanceof Node && popoverElement?.contains(event.target)) return;
    closePanel();
  }

  function handleDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      closePanel();
    }
  }

  $: triggerLabel = mode === 'range'
    ? (startDate && endDate && startDate === endDate
      ? formatSelectionLabel(startDate, true)
      : `${formatSelectionLabel(startDate, true)} - ${formatSelectionLabel(endDate, true)}`)
    : formatTriggerLabel(value);
  $: weekdayLabels = getWeekdayLabels();
  $: visibleDays = buildVisibleDays(viewDate);
  $: if (open && !inlinePanel) {
    tick().then(updateFloatingPanelPosition);
  }

  onMount(() => {
    document.addEventListener('mousedown', handleDocumentPointerDown);
    document.addEventListener('keydown', handleDocumentKeydown);
    document.addEventListener('scroll', updateFloatingPanelPosition, true);
    window.addEventListener('resize', updateFloatingPanelPosition);
  });

  onDestroy(() => {
    document.removeEventListener('mousedown', handleDocumentPointerDown);
    document.removeEventListener('keydown', handleDocumentKeydown);
    document.removeEventListener('scroll', updateFloatingPanelPosition, true);
    window.removeEventListener('resize', updateFloatingPanelPosition);
  });
</script>

<div class={`localized-date-picker ${inlinePanel ? 'localized-date-picker--inline' : ''}`} bind:this={rootElement}>
  {#if !hideTrigger}
    <button
      type="button"
      class={triggerClass}
      aria-haspopup="dialog"
      aria-expanded={open}
      on:click={togglePanel}
      bind:this={triggerElement}
    >
      <span class="localized-date-picker__trigger-label">{triggerLabel}</span>
      <span class="localized-date-picker__trigger-icon">▾</span>
    </button>
  {/if}

  {#if open}
    <div
      class={`localized-date-picker__popover popover ${inlinePanel ? 'localized-date-picker__popover--inline' : 'localized-date-picker__popover--floating'}`}
      role="dialog"
      aria-modal="false"
      style={inlinePanel ? '' : floatingPanelStyle}
      bind:this={popoverElement}
      use:portalToBody={!inlinePanel}
    >
      <div class="localized-date-picker__header">
        <button type="button" class="localized-date-picker__nav" on:click={() => shiftMonth(-1)} aria-label={t('datePicker.previousMonth')}>‹</button>
        <div class="localized-date-picker__title">{getMonthTitle(viewDate)}</div>
        <button type="button" class="localized-date-picker__nav" on:click={() => shiftMonth(1)} aria-label={t('datePicker.nextMonth')}>›</button>
      </div>

      {#if mode === 'range'}
        <div class="localized-date-picker__selection">
          <div class={`localized-date-picker__selection-chip ${rangeSelectionStage === 'start' ? 'localized-date-picker__selection-chip--active' : ''}`}>
            <span class="localized-date-picker__selection-label">{t('datePicker.startDate')}</span>
            <span class="localized-date-picker__selection-value">{formatSelectionLabel(startDate)}</span>
          </div>
          <div class={`localized-date-picker__selection-chip ${rangeSelectionStage === 'end' ? 'localized-date-picker__selection-chip--active' : ''}`}>
            <span class="localized-date-picker__selection-label">{t('datePicker.endDate')}</span>
            <span class="localized-date-picker__selection-value">{formatSelectionLabel(endDate)}</span>
          </div>
        </div>
        <div class="localized-date-picker__hint">
          {t(rangeSelectionStage === 'start' ? 'datePicker.selectStart' : 'datePicker.selectEnd')}
        </div>
      {/if}

      <div class="localized-date-picker__weekdays">
        {#each weekdayLabels as weekday}
          <span>{weekday}</span>
        {/each}
      </div>

      <div class="localized-date-picker__grid">
        {#each visibleDays as day}
          <button
            type="button"
            disabled={isDisabled(day)}
            class={`localized-date-picker__day ${sameMonth(day, viewDate) ? '' : 'localized-date-picker__day--outside'} ${isSelected(day) ? 'localized-date-picker__day--selected' : ''} ${isInRange(day) ? 'localized-date-picker__day--in-range' : ''} ${isRangeStart(day) ? 'localized-date-picker__day--start' : ''} ${isRangeEnd(day) ? 'localized-date-picker__day--end' : ''}`}
            on:click={() => selectDate(day)}
          >
            <span>{day.getDate()}</span>
          </button>
        {/each}
      </div>

      <div class="localized-date-picker__footer">
        <button type="button" class="localized-date-picker__today" on:click={selectToday}>
          {t('datePicker.today')}
        </button>
      </div>
    </div>
  {/if}
</div>
