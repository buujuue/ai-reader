import { describe, expect, it, vi } from 'vitest';

import {
  createManagedRangeReader,
  shouldUseWindowsManagedRangeProtocol,
} from './managedRangeProtocol';

describe('MaterialId 二进制范围协议', () => {
  it('只在 Tauri Windows WebView 启用', () => {
    expect(
      shouldUseWindowsManagedRangeProtocol({
        isTauri: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
      }),
    ).toBe(true);
    expect(
      shouldUseWindowsManagedRangeProtocol({
        isTauri: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)',
        platform: 'MacIntel',
      }),
    ).toBe(false);
    expect(
      shouldUseWindowsManagedRangeProtocol({
        isTauri: false,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
      }),
    ).toBe(false);
  });

  it('用 MaterialId 和半开范围通过 WebView fetch 读取二进制', async () => {
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0x23, 0x24, 0x25]).buffer,
      }) as Response,
    );
    const readRange = createManagedRangeReader('mat-1', fetchFn);

    await expect(readRange(12, 3)).resolves.toEqual(new Uint8Array([0x23, 0x24, 0x25]));
    expect(fetchFn).toHaveBeenCalledWith(
      'http://managed-range.localhost/?materialId=mat-1&offset=12&length=3',
    );
  });

  it('拒绝 HTTP 错误和响应长度不匹配，避免把错误字节交给 PDF.js', async () => {
    const failedFetch = vi.fn(async () =>
      ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }) as Response,
    );
    await expect(createManagedRangeReader('missing', failedFetch)(0, 1)).rejects.toThrow(
      '托管材料二进制范围请求失败:404',
    );

    const shortFetch = vi.fn(async () =>
      ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer }) as Response,
    );
    await expect(createManagedRangeReader('mat-1', shortFetch)(0, 2)).rejects.toThrow(
      '托管材料二进制范围长度不匹配:期望 2,实际 1',
    );
  });
});
