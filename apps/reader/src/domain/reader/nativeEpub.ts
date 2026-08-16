import type { TauriInvoke } from '../tauriInvoke';

/** 原生 EPUB 预取命令的稳定边界。 */
export const NATIVE_EPUB_PREFETCH_COMMAND = 'prefetch_managed_epub';
export const NATIVE_EPUB_PREFETCH_PROTOCOL_VERSION = 1;

/** 原生预取只报告平台，不承担平台内的阅读语义。 */
export type NativeEpubPlatform = 'windows' | 'macos' | 'ios' | 'android' | 'unknown';

export type EpubAccelerationFailureKind =
  | 'parity'
  | 'unsupported'
  | 'corrupt'
  | 'budget'
  | 'permission'
  | 'unavailable';

/** 原生返回的 parity 声明；没有通过声明校验就不能使用预取结果。 */
export interface NativeEpubParity {
  protocolVersion: number;
  semanticSource: 'foliate-js';
  platform: NativeEpubPlatform;
  validated: boolean;
  capabilities: readonly string[];
}

export interface NativeEpubPrefetchPayload {
  parity: NativeEpubParity;
  opfPath: string;
  opfBytes: number[] | Uint8Array;
  navPath?: string | null;
  navBytes?: number[] | Uint8Array | null;
  ncxPath?: string | null;
  ncxBytes?: number[] | Uint8Array | null;
  sizes: Record<string, number>;
}

/** 交给 Foliate loader 的机械缓存，不包含 BookDocument 语义。 */
export interface NativeEpubPrefetch {
  textCache: Map<string, string>;
  sizes: Map<string, number>;
  parity: NativeEpubParity;
}

export interface EpubNativeAccelerator {
  /** 任何原生错误均应返回 null，让调用方继续走纯 JavaScript。 */
  prefetch(materialId: string): Promise<NativeEpubPrefetch | null>;
}

export class NativeEpubAccelerationError extends Error {
  override name = 'NativeEpubAccelerationError';

  constructor(
    message: string,
    readonly kind: EpubAccelerationFailureKind,
  ) {
    super(message);
  }
}

const REQUIRED_CAPABILITIES = [
  'container-prefetch',
  'opf-prefetch',
  'navigation-prefetch',
  'resource-sizes',
] as const;

const DEFAULT_ALLOWED_PLATFORMS: readonly NativeEpubPlatform[] = ['windows'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return new Uint8Array(value);
  }
  throw new NativeEpubAccelerationError(`原生 EPUB ${label} 字节载荷无效`, 'corrupt');
}

function decodeUtf8(value: unknown, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(toBytes(value, label));
  } catch (error) {
    if (error instanceof NativeEpubAccelerationError) {
      throw error;
    }
    throw new NativeEpubAccelerationError(`原生 EPUB ${label}不是有效 UTF-8`, 'corrupt');
  }
}

function buildContainerXml(opfPath: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles>' +
    `<rootfile full-path="${escapeXmlAttribute(opfPath)}" media-type="application/oebps-package+xml"/>` +
    '</rootfiles>' +
    '</container>'
  );
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function assertPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.split('/').some((part) => part === '..')
  ) {
    throw new NativeEpubAccelerationError(`原生 EPUB ${label}路径无效`, 'corrupt');
  }
  return value;
}

function assertParity(
  value: unknown,
  allowedPlatforms: ReadonlySet<NativeEpubPlatform>,
): NativeEpubParity {
  if (!isRecord(value)) {
    throw new NativeEpubAccelerationError('原生 EPUB 缺少 parity 声明', 'parity');
  }
  const parity = value as Partial<NativeEpubParity>;
  if (parity.protocolVersion !== NATIVE_EPUB_PREFETCH_PROTOCOL_VERSION) {
    throw new NativeEpubAccelerationError('原生 EPUB 预取协议版本未通过 parity', 'parity');
  }
  if (parity.semanticSource !== 'foliate-js' || parity.validated !== true) {
    throw new NativeEpubAccelerationError('原生 EPUB 未声明 foliate-js 语义 parity', 'parity');
  }
  if (!allowedPlatforms.has(parity.platform as NativeEpubPlatform)) {
    throw new NativeEpubAccelerationError(
      `平台 ${String(parity.platform)} 尚未通过 EPUB parity`,
      'parity',
    );
  }
  const capabilities = Array.isArray(parity.capabilities) ? parity.capabilities : null;
  if (
    !capabilities ||
    REQUIRED_CAPABILITIES.some((capability) => !capabilities.includes(capability))
  ) {
    throw new NativeEpubAccelerationError('原生 EPUB 预取能力未通过 parity', 'parity');
  }
  return {
    protocolVersion: parity.protocolVersion,
    semanticSource: 'foliate-js',
    platform: parity.platform as NativeEpubPlatform,
    validated: true,
    capabilities: [...capabilities],
  };
}

function assertSizes(value: unknown): Map<string, number> {
  if (!isRecord(value)) {
    throw new NativeEpubAccelerationError('原生 EPUB 资源尺寸表无效', 'corrupt');
  }
  const sizes = new Map<string, number>();
  for (const [path, size] of Object.entries(value)) {
    assertPath(path, '资源');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new NativeEpubAccelerationError(`原生 EPUB 资源尺寸无效:${path}`, 'corrupt');
    }
    sizes.set(path, size);
  }
  return sizes;
}

function normalizePrefetch(
  raw: unknown,
  allowedPlatforms: ReadonlySet<NativeEpubPlatform>,
): NativeEpubPrefetch {
  if (!isRecord(raw)) {
    throw new NativeEpubAccelerationError('原生 EPUB 预取响应无效', 'corrupt');
  }
  const parity = assertParity(raw.parity, allowedPlatforms);
  const opfPath = assertPath(raw.opfPath, 'OPF');
  const opfText = decodeUtf8(raw.opfBytes, 'OPF');
  if (!opfText.includes('<')) {
    throw new NativeEpubAccelerationError('原生 EPUB OPF 内容无效', 'corrupt');
  }

  const textCache = new Map<string, string>([
    ['META-INF/container.xml', buildContainerXml(opfPath)],
    [opfPath, opfText],
  ]);
  for (const [pathKey, bytesKey, label] of [
    ['navPath', 'navBytes', 'NAV'],
    ['ncxPath', 'ncxBytes', 'NCX'],
  ] as const) {
    const pathValue = raw[pathKey];
    const bytesValue = raw[bytesKey];
    if (pathValue == null && bytesValue == null) {
      continue;
    }
    if (pathValue == null || bytesValue == null) {
      throw new NativeEpubAccelerationError(`原生 EPUB ${label}预取载荷不完整`, 'corrupt');
    }
    textCache.set(assertPath(pathValue, label), decodeUtf8(bytesValue, label));
  }

  return { textCache, sizes: assertSizes(raw.sizes), parity };
}

/** 把 Rust/IPC 的错误归一化为可测试的原生失败分类。 */
export function classifyNativeEpubError(error: unknown): EpubAccelerationFailureKind {
  if (error instanceof NativeEpubAccelerationError) {
    return error.kind;
  }
  if (isRecord(error) && typeof error.kind === 'string') {
    if (error.kind === 'budget') return 'budget';
    if (error.kind === 'unsupported' || error.kind === 'empty') return 'unsupported';
    if (error.kind === 'corrupt' || error.kind === 'drm') return 'corrupt';
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/parity|protocol|semantic source/i.test(text)) return 'parity';
  if (/budget|limit|超限|预算/i.test(text)) return 'budget';
  if (/permission|denied|权限/i.test(text)) return 'permission';
  if (/unsupported|不支持/i.test(text)) return 'unsupported';
  if (/corrupt|invalid|zip|xml|opf|container|损坏|无效/i.test(text)) return 'corrupt';
  return 'unavailable';
}

export interface CreateTauriEpubNativeAcceleratorOptions {
  allowedPlatforms?: readonly NativeEpubPlatform[];
  onFailure?: (kind: EpubAccelerationFailureKind, error: unknown) => void;
}

/** 创建可选的 Tauri 原生加速器；调用失败只返回 null，绝不阻断纯 JS 阅读。 */
export function createTauriEpubNativeAccelerator(
  invokeFn: TauriInvoke,
  options: CreateTauriEpubNativeAcceleratorOptions = {},
): EpubNativeAccelerator {
  const allowedPlatforms = new Set(
    options.allowedPlatforms ?? DEFAULT_ALLOWED_PLATFORMS,
  );
  return {
    async prefetch(materialId: string): Promise<NativeEpubPrefetch | null> {
      if (!materialId) return null;
      try {
        const raw = await invokeFn(NATIVE_EPUB_PREFETCH_COMMAND, { materialId });
        return normalizePrefetch(raw, allowedPlatforms);
      } catch (error) {
        options.onFailure?.(classifyNativeEpubError(error), error);
        return null;
      }
    },
  };
}

export function createUnavailableEpubNativeAccelerator(): EpubNativeAccelerator {
  return { prefetch: async () => null };
}

export const NATIVE_EPUB_REQUIRED_CAPABILITIES = REQUIRED_CAPABILITIES;
