import test from 'node:test';
import assert from 'node:assert/strict';

import { getViewportPopoverPlacement } from './popoverPosition.ts';

test('Popover 在下方空间充足时应向下展开并限制在视口内', () => {
  const anchor = { top: 100, bottom: 140, left: 500, right: 620, width: 120 };
  assert.deepEqual(
    getViewportPopoverPlacement(
      anchor,
      { viewportWidth: 640, viewportHeight: 900, preferredWidth: 352 }
    ),
    { placement: 'bottom', left: 268, width: 352, maxHeight: 740, top: 148, bottom: null }
  );
});

test('Popover 靠近底部时应向上翻转，并在窄屏保留安全边距', () => {
  const anchor = { top: 760, bottom: 800, left: 8, right: 200, width: 192 };
  assert.deepEqual(
    getViewportPopoverPlacement(
      anchor,
      { viewportWidth: 320, viewportHeight: 820, preferredWidth: 352 }
    ),
    { placement: 'top', left: 12, width: 296, maxHeight: 740, top: null, bottom: 68 }
  );
});
