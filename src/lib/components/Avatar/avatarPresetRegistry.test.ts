import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer } from 'vite';

test('桌宠预设注册表应只开放原版标准并回退已下线预设', async (context) => {
  const httpServer = createHttpServer();
  const vite = await createViteServer({
    configFile: false,
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
    },
    appType: 'custom',
  });

  context.after(async () => {
    await vite.close();
    httpServer.close();
  });

  const registry = await vite.ssrLoadModule(
    '/src/lib/components/Avatar/avatarPresetRegistry.ts',
  ) as typeof import('./avatarPresetRegistry.ts');

  assert.deepEqual(
    registry.AVATAR_PRESET_OPTIONS.map(({ id }) => id),
    ['original-standard'],
  );
  for (const presetId of ['keyboard-focus', 'minimal-office', 'unknown']) {
    assert.equal(registry.normalizeAvatarPresetId(presetId), 'original-standard');
    assert.equal(registry.getAvatarPresetDefinition(presetId).id, 'original-standard');
    assert.equal(registry.getAvatarPresetOption(presetId).id, 'original-standard');
  }
});
