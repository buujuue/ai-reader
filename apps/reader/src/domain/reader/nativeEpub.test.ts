import { describe, expect, it, vi } from 'vitest';

import type { TauriInvoke } from '../tauriInvoke';
import { EpubInspectError } from '../library/epub/epubInspector';
import {
  NATIVE_EPUB_PREFETCH_COMMAND,
  NATIVE_EPUB_REQUIRED_CAPABILITIES,
  classifyNativeEpubError,
  createTauriEpubNativeAccelerator,
} from './nativeEpub';

const validPayload = () => ({
  parity: {
    protocolVersion: 1,
    semanticSource: 'foliate-js' as const,
    platform: 'windows' as const,
    validated: true,
    capabilities: [...NATIVE_EPUB_REQUIRED_CAPABILITIES],
  },
  opfPath: 'OEBPS/content.opf',
  opfBytes: Array.from(new TextEncoder().encode('<package/>')),
  navPath: 'OEBPS/nav.xhtml',
  navBytes: Array.from(new TextEncoder().encode('<nav/>')),
  ncxPath: null,
  ncxBytes: null,
  sizes: {
    'OEBPS/content.opf': 10,
    'OEBPS/nav.xhtml': 6,
  },
});

describe('EPUB 原生预取 parity 与回退', () => {
  it('只在已声明 foliate-js parity 的 Windows 组合启用', async () => {
    let receivedCommand = '';
    let receivedArgs: Record<string, unknown> | undefined;
    const invoke: TauriInvoke = async (command, args) => {
      receivedCommand = command;
      receivedArgs = args;
      return validPayload();
    };

    const accelerator = createTauriEpubNativeAccelerator(invoke);
    const result = await accelerator.prefetch('book-1');

    expect(receivedCommand).toBe(NATIVE_EPUB_PREFETCH_COMMAND);
    expect(receivedArgs).toEqual({ materialId: 'book-1' });
    expect(result?.parity.semanticSource).toBe('foliate-js');
    expect(result?.textCache.get('META-INF/container.xml')).toContain('content.opf');
    expect(result?.textCache.get('OEBPS/nav.xhtml')).toBe('<nav/>');
    expect(result?.sizes.get('OEBPS/content.opf')).toBe(10);
  });

  it('未通过平台 parity 时返回 null,不把原生结果交给阅读器', async () => {
    const onFailure = vi.fn();
    const invoke: TauriInvoke = async () => ({
      ...validPayload(),
      parity: { ...validPayload().parity, platform: 'android' as const },
    });

    const result = await createTauriEpubNativeAccelerator(invoke, { onFailure }).prefetch('book-1');

    expect(result).toBeNull();
    expect(onFailure).toHaveBeenCalledWith('parity', expect.anything());
  });

  it('原生 IPC 或 ZIP/XML 错误透明回退并保留稳定分类', async () => {
    const onFailure = vi.fn();
    const invoke: TauriInvoke = async () => {
      throw new Error('corrupt: OPF XML cannot be parsed');
    };

    const result = await createTauriEpubNativeAccelerator(invoke, { onFailure }).prefetch('book-1');

    expect(result).toBeNull();
    expect(onFailure).toHaveBeenCalledWith('corrupt', expect.any(Error));
    expect(classifyNativeEpubError(new Error('budget: entry too large'))).toBe('budget');
  });

  it('纯 JS 预检与原生错误共享可观察分类', () => {
    expect(classifyNativeEpubError(new EpubInspectError('结构损坏', 'corrupt'))).toBe('corrupt');
    expect(classifyNativeEpubError(new EpubInspectError('超出预算', 'budget'))).toBe('budget');
    expect(classifyNativeEpubError(new EpubInspectError('不支持', 'unsupported'))).toBe('unsupported');
  });

  it('缺少或篡改预取字段时不会形成半原生状态', async () => {
    const onFailure = vi.fn();
    const invoke: TauriInvoke = async () => ({
      ...validPayload(),
      navPath: 'OEBPS/nav.xhtml',
      navBytes: null,
    });

    const result = await createTauriEpubNativeAccelerator(invoke, { onFailure }).prefetch('book-1');

    expect(result).toBeNull();
    expect(onFailure).toHaveBeenCalledWith('corrupt', expect.anything());
  });
});
