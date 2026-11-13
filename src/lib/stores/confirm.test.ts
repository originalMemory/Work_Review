import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirm,
  confirmDialog,
  resolveConfirm,
  type ConfirmDialogState,
} from './confirm.ts';

function snapshot(): ConfirmDialogState | null {
  let state: ConfirmDialogState | null = null;
  const unsubscribe = confirmDialog.subscribe((value) => {
    state = value;
  });
  unsubscribe();
  return state;
}

afterEach(() => {
  resolveConfirm(false);
  assert.equal(snapshot(), null);
});

test('confirm 应使用默认中文文案并返回取消结果', async () => {
  const pending = confirm();
  const state = snapshot();
  assert.ok(state);

  assert.deepEqual(
    {
      title: state.title,
      message: state.message,
      confirmText: state.confirmText,
      cancelText: state.cancelText,
      tone: state.tone,
    },
    {
      title: '提示',
      message: '',
      confirmText: '确定',
      cancelText: '取消',
      tone: 'info',
    },
  );

  resolveConfirm(false);
  assert.equal(await pending, false);
});

test('confirm 应去除显式字段首尾空白并返回确认结果', async () => {
  const pending = confirm({
    title: '  删除记录  ',
    message: '  删除后无法恢复  ',
    confirmText: '  删除  ',
    cancelText: '  返回  ',
    tone: 'warning',
  });
  const state = snapshot();
  assert.ok(state);

  assert.deepEqual(
    {
      title: state.title,
      message: state.message,
      confirmText: state.confirmText,
      cancelText: state.cancelText,
      tone: state.tone,
    },
    {
      title: '删除记录',
      message: '删除后无法恢复',
      confirmText: '删除',
      cancelText: '返回',
      tone: 'warning',
    },
  );

  resolveConfirm(true);
  assert.equal(await pending, true);
});

test('连续 confirm 应自动以 false 结束旧 Promise', async () => {
  const firstPending = confirm({ message: '第一个确认' });
  const secondPending = confirm({ message: '第二个确认' });

  assert.equal(await firstPending, false);
  const state = snapshot();
  assert.ok(state);
  assert.equal(state.message, '第二个确认');

  resolveConfirm(true);
  assert.equal(await secondPending, true);
});

test('关闭后重复 resolveConfirm 不应产生副作用或污染下一次确认', async () => {
  const firstPending = confirm({ message: '已关闭确认' });
  resolveConfirm(true);
  assert.equal(await firstPending, true);

  resolveConfirm(false);
  resolveConfirm(true);
  assert.equal(snapshot(), null);

  const secondPending = confirm({ message: '下一次确认' });
  resolveConfirm(false);
  assert.equal(await secondPending, false);
  assert.equal(snapshot(), null);
});
