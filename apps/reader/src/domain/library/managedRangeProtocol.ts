/**
 * Windows Tauri PDF 的二进制托管范围来源。
 *
 * 读取请求只把稳定 MaterialId 与半开范围交给 Tauri custom URI protocol；
 * WebView 直接接收二进制响应，避免每个 128 KiB 分块再经过 Base64 + invoke。
 * 其它格式和其它平台继续使用 ImportRepository 的现有范围回调。
 */

export const MANAGED_RANGE_PROTOCOL_ORIGIN = 'http://managed-range.localhost';

export interface ManagedRangePlatformEnvironment {
  isTauri: boolean;
  userAgent: string;
  platform: string;
}

export function shouldUseWindowsManagedRangeProtocol(
  environment: ManagedRangePlatformEnvironment,
): boolean {
  return (
    environment.isTauri &&
    /windows|win32/i.test(`${environment.userAgent} ${environment.platform}`)
  );
}

export function isWindowsTauriRuntime(): boolean {
  return shouldUseWindowsManagedRangeProtocol({
    isTauri: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    platform: typeof navigator === 'undefined' ? '' : navigator.platform,
  });
}

export type ManagedRangeFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** 为 ManagedFileSource 提供只返回二进制字节的范围回调。 */
export function createManagedRangeReader(
  materialId: string,
  fetchFn: ManagedRangeFetch = defaultFetch,
): (offset: number, length: number) => Promise<Uint8Array> {
  return async (offset, length) => {
    assertRangeArgument(offset, 'offset');
    assertRangeArgument(length, 'length');

    const query = new URLSearchParams({
      materialId,
      offset: String(offset),
      length: String(length),
    });
    const response = await fetchFn(`${MANAGED_RANGE_PROTOCOL_ORIGIN}/?${query}`);
    if (!response.ok) {
      throw new Error(`托管材料二进制范围请求失败:${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== length) {
      throw new Error(
        `托管材料二进制范围长度不匹配:期望 ${length},实际 ${bytes.byteLength}`,
      );
    }
    return bytes;
  };
}

function assertRangeArgument(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`托管材料二进制范围参数无效:${name}=${value}`);
  }
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') {
    return Promise.reject(new Error('当前运行时不支持二进制托管范围 fetch'));
  }
  return globalThis.fetch(input, init);
}
