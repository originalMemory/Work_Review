import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { aiStore, type AiStoreState } from './ai.ts';

function snapshot(): AiStoreState {
  let state: AiStoreState | undefined;
  const unsubscribe = aiStore.subscribe((value) => {
    state = value;
  });
  unsubscribe();
  assert.ok(state);
  return state;
}

const getConfigHashFromUnknown = aiStore.getConfigHash as (
  config?: unknown
) => string | null;

afterEach(() => {
  aiStore.reset();
});

test('aiStore 初始状态应表示尚未测试且未验证', () => {
  assert.deepEqual(snapshot(), {
    textTestStatus: null,
    textTestMessage: '',
    textConnectionVerified: false,
    lastTestedConfigHash: null,
  });
});

test('startTesting 应清空消息但保留旧验证状态和配置指纹', () => {
  aiStore.setSuccess('旧测试成功');
  aiStore.setConfigHash('provider|endpoint|model|key');

  aiStore.startTesting();

  assert.deepEqual(snapshot(), {
    textTestStatus: 'testing',
    textTestMessage: '',
    textConnectionVerified: true,
    lastTestedConfigHash: 'provider|endpoint|model|key',
  });
});

test('startTesting 应保留未验证状态并清空旧错误消息', () => {
  aiStore.setError('旧测试失败');
  aiStore.setConfigHash('failed-provider|endpoint|model|key');

  aiStore.startTesting();

  assert.deepEqual(snapshot(), {
    textTestStatus: 'testing',
    textTestMessage: '',
    textConnectionVerified: false,
    lastTestedConfigHash: 'failed-provider|endpoint|model|key',
  });
});

test('setSuccess 应保存消息、标记验证成功并保留配置指纹', () => {
  aiStore.setConfigHash('saved-hash');

  aiStore.setSuccess('连接成功');

  assert.deepEqual(snapshot(), {
    textTestStatus: 'success',
    textTestMessage: '连接成功',
    textConnectionVerified: true,
    lastTestedConfigHash: 'saved-hash',
  });
});

test('setError 应保存消息、取消验证并保留配置指纹', () => {
  aiStore.setSuccess('之前成功');
  aiStore.setConfigHash('failed-hash');

  aiStore.setError('连接失败');

  assert.deepEqual(snapshot(), {
    textTestStatus: 'error',
    textTestMessage: '连接失败',
    textConnectionVerified: false,
    lastTestedConfigHash: 'failed-hash',
  });
});

test('reset 应恢复四个状态字段', () => {
  aiStore.setSuccess('连接成功');
  aiStore.setConfigHash('saved-hash');

  aiStore.reset();

  assert.deepEqual(snapshot(), {
    textTestStatus: null,
    textTestMessage: '',
    textConnectionVerified: false,
    lastTestedConfigHash: null,
  });
});

test('setConfigHash 应只更新配置指纹并允许清空', () => {
  aiStore.setError('保留错误');

  aiStore.setConfigHash('');
  assert.deepEqual(snapshot(), {
    textTestStatus: 'error',
    textTestMessage: '保留错误',
    textConnectionVerified: false,
    lastTestedConfigHash: '',
  });

  aiStore.setConfigHash('new-hash');
  assert.deepEqual(snapshot(), {
    textTestStatus: 'error',
    textTestMessage: '保留错误',
    textConnectionVerified: false,
    lastTestedConfigHash: 'new-hash',
  });

  aiStore.setConfigHash(null);
  assert.deepEqual(snapshot(), {
    textTestStatus: 'error',
    textTestMessage: '保留错误',
    textConnectionVerified: false,
    lastTestedConfigHash: null,
  });
});

test('getConfigHash 应按原顺序拼接模型配置并折叠假值 API Key', () => {
  assert.equal(aiStore.getConfigHash(), null);
  assert.equal(aiStore.getConfigHash(null), null);
  assert.equal(aiStore.getConfigHash({}), null);
  assert.equal(aiStore.getConfigHash({ text_model: null }), null);
  assert.equal(
    aiStore.getConfigHash({
      text_model: { provider: '', endpoint: '', model: '', api_key: '' },
    }),
    '|||'
  );
  assert.equal(
    aiStore.getConfigHash({
      text_model: {
        provider: 'openai',
        endpoint: 'https://example.com/v1',
        model: 'model-a',
        api_key: 'secret',
      },
    }),
    'openai|https://example.com/v1|model-a|secret'
  );

  for (const api_key of ['', 0, false, Number.NaN, null, undefined]) {
    assert.equal(
      getConfigHashFromUnknown({
        text_model: { provider: 'p', endpoint: 'e', model: 'm', api_key },
      }),
      'p|e|m|'
    );
  }
});

test('getConfigHash 应保留缺失字段和数字字段的既有字符串化语义', () => {
  assert.equal(
    getConfigHashFromUnknown({ text_model: {} }),
    'undefined|undefined|undefined|'
  );
  assert.equal(
    getConfigHashFromUnknown({
      text_model: { provider: 0, endpoint: 1, model: 2, api_key: 3 },
    }),
    '0|1|2|3'
  );
});
