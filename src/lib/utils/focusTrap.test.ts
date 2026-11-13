import assert from 'node:assert/strict';
import test from 'node:test';

import { trapFocus } from './focusTrap.ts';

interface FakeDocument {
  activeElement: FakeHTMLElement | null;
}

interface FakeElementOptions {
  visible?: boolean;
}

interface FakeTabOptions {
  shiftKey?: boolean;
}

class FakeKeyboardEvent {
  readonly key = 'Tab';
  readonly shiftKey: boolean;
  defaultPrevented = false;

  constructor({ shiftKey = false }: FakeTabOptions = {}) {
    this.shiftKey = shiftKey;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type FakeEventListener = (event: FakeKeyboardEvent) => void;

class FakeHTMLElement {
  readonly ownerDocument: FakeDocument;
  readonly offsetParent: object | null;
  parentNode: FakeHTMLElement | null = null;
  focusCount = 0;
  queryResults: FakeHTMLElement[] = [];
  readonly listeners = new Map<string, Set<FakeEventListener>>();

  constructor(ownerDocument: FakeDocument, { visible = true }: FakeElementOptions = {}) {
    this.ownerDocument = ownerDocument;
    this.offsetParent = visible ? {} : null;
  }

  focus(): void {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  contains(element: FakeHTMLElement | null): boolean {
    for (let current = element; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  querySelectorAll(): FakeHTMLElement[] {
    return this.queryResults;
  }

  addEventListener(type: string, listener: FakeEventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeEventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: FakeKeyboardEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface FakeDomHarness {
  document: FakeDocument;
  element(options?: FakeElementOptions): FakeHTMLElement & HTMLElement;
  restore(): void;
}

function installFakeDom(): FakeDomHarness {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const document: FakeDocument = { activeElement: null };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: document,
  });
  Object.defineProperty(globalThis, 'HTMLElement', {
    configurable: true,
    writable: true,
    value: FakeHTMLElement,
  });

  return {
    document,
    element(options: FakeElementOptions = {}) {
      return new FakeHTMLElement(document, options) as FakeHTMLElement & HTMLElement;
    },
    restore(): void {
      restoreGlobal('document', originalDocument);
      restoreGlobal('HTMLElement', originalHTMLElement);
    },
  };
}

function restoreGlobal(
  name: 'document' | 'HTMLElement',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

function setFocusableChildren(
  container: FakeHTMLElement,
  children: readonly FakeHTMLElement[],
): void {
  for (const child of children) child.parentNode = container;
  container.queryResults = [...children];
}

function dispatchTab(
  container: FakeHTMLElement,
  options: FakeTabOptions = {},
): FakeKeyboardEvent {
  const event = new FakeKeyboardEvent(options);
  container.dispatch('keydown', event);
  return event;
}

test('在微任务中聚焦首个可见的可聚焦项', async (t) => {
  const dom = installFakeDom();
  t.after(dom.restore);
  const previous = dom.element();
  const container = dom.element();
  const hidden = dom.element({ visible: false });
  const firstVisible = dom.element();
  const secondVisible = dom.element();
  previous.focus();
  setFocusableChildren(container, [hidden, firstVisible, secondVisible]);

  trapFocus(container);

  assert.equal(dom.document.activeElement, previous);
  await Promise.resolve();
  assert.equal(dom.document.activeElement, firstVisible);
  assert.equal(hidden.focusCount, 0);
});

test('Tab 与 Shift+Tab 在首尾可聚焦项之间循环', async (t) => {
  const dom = installFakeDom();
  t.after(dom.restore);
  const container = dom.element();
  const first = dom.element();
  const middle = dom.element();
  const last = dom.element();
  setFocusableChildren(container, [first, middle, last]);
  trapFocus(container);
  await Promise.resolve();

  last.focus();
  const forwardEvent = dispatchTab(container);
  assert.equal(forwardEvent.defaultPrevented, true);
  assert.equal(dom.document.activeElement, first);

  first.focus();
  const backwardEvent = dispatchTab(container, { shiftKey: true });
  assert.equal(backwardEvent.defaultPrevented, true);
  assert.equal(dom.document.activeElement, last);
});

test('焦点在容器外时按 Tab 会按方向拉回容器', async (t) => {
  const dom = installFakeDom();
  t.after(dom.restore);
  const container = dom.element();
  const first = dom.element();
  const last = dom.element();
  const outside = dom.element();
  setFocusableChildren(container, [first, last]);
  trapFocus(container);
  await Promise.resolve();

  outside.focus();
  const forwardEvent = dispatchTab(container);
  assert.equal(forwardEvent.defaultPrevented, true);
  assert.equal(dom.document.activeElement, first);

  outside.focus();
  const backwardEvent = dispatchTab(container, { shiftKey: true });
  assert.equal(backwardEvent.defaultPrevented, true);
  assert.equal(dom.document.activeElement, last);
});

test('没有可聚焦项时阻止 Tab 的默认行为', async (t) => {
  const dom = installFakeDom();
  t.after(dom.restore);
  const container = dom.element();
  trapFocus(container);
  await Promise.resolve();

  const event = dispatchTab(container);

  assert.equal(event.defaultPrevented, true);
  assert.equal(dom.document.activeElement, container);
});

test('destroy 移除 keydown 监听并恢复原焦点', async (t) => {
  const dom = installFakeDom();
  t.after(dom.restore);
  const previous = dom.element();
  const container = dom.element();
  const first = dom.element();
  const last = dom.element();
  previous.focus();
  setFocusableChildren(container, [first, last]);

  const action = trapFocus(container);
  await Promise.resolve();
  assert.equal(container.listenerCount('keydown'), 1);

  action.destroy();

  assert.equal(container.listenerCount('keydown'), 0);
  assert.equal(dom.document.activeElement, previous);
  last.focus();
  const event = dispatchTab(container);
  assert.equal(event.defaultPrevented, false);
  assert.equal(dom.document.activeElement, last);
});

test('初始聚焦微任务执行前 destroy 不应再次把焦点移入容器', async (t) => {
  const dom = installFakeDom();
  t.after(dom.restore);
  const previous = dom.element();
  const container = dom.element();
  const first = dom.element();
  previous.focus();
  setFocusableChildren(container, [first]);

  const action = trapFocus(container);
  action.destroy();
  await Promise.resolve();

  assert.equal(container.listenerCount('keydown'), 0);
  assert.equal(dom.document.activeElement, previous);
  assert.equal(first.focusCount, 0);
});
