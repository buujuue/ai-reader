import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPerformanceThresholds } from './reader-runtime-cache-metrics.mjs';

test('小样本中单次轮询抖动不应击穿 EPUB 缓存命中 P95 门禁', () => {
  const thresholds = buildPerformanceThresholds(
    [69, 70, 70],
    [104, 105, 107],
  );

  assert.equal(thresholds.epub.hitReturnInteractiveMedianMs, 70);
  assert.equal(thresholds.epub.hitReturnInteractiveP95Ms, 95);
  assert.equal(76 <= thresholds.epub.hitReturnInteractiveP95Ms, true);
  assert.equal(100 <= thresholds.epub.hitReturnInteractiveP95Ms, false);
});
