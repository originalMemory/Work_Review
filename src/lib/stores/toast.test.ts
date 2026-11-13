import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearToast, showToast, toast, type ToastState } from './toast.ts';

interface ScheduledTask {
  runAt: number;
  callback: () => void;
}

interface FakeTimers {
  tick(milliseconds: number): void;
  pendingCount(): number;
  restore(): void;
}

function snapshot(): ToastState | null {
  let state: ToastState | null = null;
  const unsubscribe = toast.subscribe((value) => {
    state = value;
  });
  unsubscribe();
  return state;
}

function installFakeTimers(): FakeTimers {
  const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
  const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout');
  const scheduled = new Map<number, ScheduledTask>();
  let currentTime = 0;
  let nextId = 1;

  const fakeSetTimeout = (
    callback: (...args: unknown[]) => void,
    delay = 0,
    ...args: unknown[]
  ): number => {
    const id = nextId;
    nextId += 1;
    scheduled.set(id, {
      runAt: currentTime + Number(delay),
      callback: () => callback(...args),
    });
    return id;
  };

  const fakeClearTimeout = (id: unknown): void => {
    if (typeof id === 'number') {
      scheduled.delete(id);
    }
  };

  Object.defineProperty(globalThis, 'setTimeout', {
    configurable: true,
    writable: true,
    value: fakeSetTimeout,
  });
  Object.defineProperty(globalThis, 'clearTimeout', {
    configurable: true,
    writable: true,
    value: fakeClearTimeout,
  });

  return {
    tick(milliseconds: number): void {
      const targetTime = currentTime + milliseconds;

      while (true) {
        const next = [...scheduled.entries()]
          .filter(([, task]) => task.runAt <= targetTime)
          .sort((left, right) => left[1].runAt - right[1].runAt || left[0] - right[0])[0];

        if (!next) break;
        const [id, task] = next;
        scheduled.delete(id);
        currentTime = task.runAt;
        task.callback();
      }

      currentTime = targetTime;
    },
    pendingCount(): number {
      return scheduled.size;
    },
    restore(): void {
      if (originalSetTimeout) {
        Object.defineProperty(globalThis, 'setTimeout', originalSetTimeout);
      } else {
        Reflect.deleteProperty(globalThis, 'setTimeout');
      }

      if (originalClearTimeout) {
        Object.defineProperty(globalThis, 'clearTimeout', originalClearTimeout);
      } else {
        Reflect.deleteProperty(globalThis, 'clearTimeout');
      }
    },
  };
}

let fakeTimers: FakeTimers | null = null;

beforeEach(() => {
  clearToast();
  fakeTimers = installFakeTimers();
});

afterEach(() => {
  clearToast();
  fakeTimers?.restore();
  fakeTimers = null;
});

test('showToast 应去除消息首尾空白', () => {
  showToast('  保存成功  ', 'success');

  const state = snapshot();
  assert.ok(state);
  assert.equal(state.message, '保存成功');
});

test('showToast 应忽略非字符串、空字符串和无效字面文本', () => {
  showToast('保留消息', 'info');
  const originalState = snapshot();
  assert.ok(originalState);

  for (const invalidMessage of [42, {}, null, undefined, '', '   ', 'undefined', ' NULL ']) {
    showToast(invalidMessage, 'error');
    assert.strictEqual(snapshot(), originalState);
  }
});

test('showToast 应记录类型并为新消息递增 id', () => {
  showToast('第一条', 'warning');
  const firstState = snapshot();
  assert.ok(firstState);

  showToast('第二条', 'error');
  const secondState = snapshot();
  assert.ok(secondState);

  assert.equal(firstState.type, 'warning');
  assert.equal(secondState.type, 'error');
  assert.equal(secondState.id, firstState.id + 1);
});

test('新 toast 不应被旧 toast 的隐藏定时器清除', () => {
  assert.ok(fakeTimers);
  showToast('旧消息', 'info', 10);
  showToast('新消息', 'success', 100);

  fakeTimers.tick(10);

  const state = snapshot();
  assert.ok(state);
  assert.equal(state.message, '新消息');
  assert.equal(state.type, 'success');
  assert.equal(fakeTimers.pendingCount(), 1);
});

test('当前 toast 应在完整持续时间后自动隐藏', () => {
  assert.ok(fakeTimers);
  showToast('短暂消息', 'info', 10);

  fakeTimers.tick(9);
  const visibleState = snapshot();
  assert.ok(visibleState);
  assert.equal(visibleState.message, '短暂消息');
  assert.equal(fakeTimers.pendingCount(), 1);

  fakeTimers.tick(1);
  assert.equal(snapshot(), null);
  assert.equal(fakeTimers.pendingCount(), 0);
});

test('clearToast 应清空状态并取消当前隐藏定时器', () => {
  assert.ok(fakeTimers);
  showToast('待关闭消息', 'info', 10);
  assert.equal(fakeTimers.pendingCount(), 1);

  clearToast();
  fakeTimers.tick(10);

  assert.equal(snapshot(), null);
  assert.equal(fakeTimers.pendingCount(), 0);
});
