import { describe, expect, it } from 'vitest';

import { normalizeCoverBlob } from './cover';

describe('normalizeCoverBlob', () => {
  it('拒绝超过资源预算的来源封面而不把它带入导入提交', async () => {
    const oversized = new Blob([new Uint8Array(64 * 1024 * 1024 + 1)], {
      type: 'image/png',
    });

    await expect(normalizeCoverBlob(oversized)).resolves.toBeNull();
  });

  it('没有可用安全解码器时将损坏封面降级为无封面', async () => {
    const invalid = new Blob(['not-an-image'], { type: 'image/png' });

    await expect(normalizeCoverBlob(invalid)).resolves.toBeNull();
  });
});
