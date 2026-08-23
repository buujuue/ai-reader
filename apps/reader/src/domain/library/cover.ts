import type { CoverAsset } from './material';

/**
 * 封面是导入阶段的派生资源，不参与材料指纹、文档版本或批注锚点。
 * 解析在 TypeScript 侧完成，Rust 只接收已经受控的位图字节并负责持久化。
 */
export const COVER_MAX_BYTES = 64 * 1024 * 1024;
export const COVER_MAX_LONG_EDGE = 512;
export const COVER_JPEG_QUALITY = 0.85;
/** 解码后的 RGBA 预算约为 64 MiB,避免小文件图片造成解码炸弹。 */
export const COVER_MAX_DECODED_PIXELS = 16 * 1024 * 1024;


/** 将 Foliate 返回的来源封面转换为可持久化的安全缩略图。失败返回 null。 */
export async function normalizeCoverBlob(blob: Blob | null | undefined): Promise<CoverAsset | null> {
  if (!blob || blob.size <= 0 || blob.size > COVER_MAX_BYTES) {
    return null;
  }

  const originalMimeType = normalizeImageMimeType(blob.type) ?? sniffImageMimeType(await blobBytes(blob));
  if (!originalMimeType) {
    return null;
  }

  const source = originalMimeType === 'image/svg+xml'
    ? await sanitizeSvgBlob(blob)
    : blob;
  if (!source) {
    return null;
  }

  const decoded = await decodeCover(source);
  if (!decoded) {
    return null;
  }

  const { image, width, height, close } = decoded;
  let canvas: HTMLCanvasElement | null = null;
  try {
    const longEdge = Math.max(width, height);
    const pixelCount = width * height;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      !Number.isSafeInteger(Math.ceil(pixelCount)) ||
      pixelCount > COVER_MAX_DECODED_PIXELS
    ) {
      return null;
    }
    const needsRasterization = originalMimeType === 'image/svg+xml' ||
      longEdge > COVER_MAX_LONG_EDGE;
    if (!needsRasterization) {
      return {
        bytes: await blobBytes(blob),
        mimeType: originalMimeType,
      };
    }

    const scale = Math.min(1, COVER_MAX_LONG_EDGE / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
    const rasterized = await canvasToBlob(canvas, 'image/jpeg', COVER_JPEG_QUALITY);
    if (!rasterized || rasterized.size <= 0 || rasterized.size > COVER_MAX_BYTES) {
      return null;
    }
    return { bytes: await blobBytes(rasterized), mimeType: 'image/jpeg' };
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    close();
  }
}

function normalizeImageMimeType(value: string): string | null {
  const mimeType = value.trim().toLowerCase().split(';', 1)[0] ?? '';
  return mimeType.startsWith('image/') ? mimeType : null;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function sniffImageMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 6 &&
    (String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF87a' ||
      String.fromCharCode(...bytes.subarray(0, 6)) === 'GIF89a')) {
    return 'image/gif';
  }
  return null;
}

async function sanitizeSvgBlob(blob: Blob): Promise<Blob | null> {
  const text = await blob.text();
  if (
    text.length > COVER_MAX_BYTES ||
    /<\s*(?:script|foreignObject)\b/i.test(text) ||
    /@import\b|url\s*\(\s*["']?(?:https?:|file:|\/\/)/i.test(text)
  ) {
    return null;
  }
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return null;
  }
  const documentNode = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (documentNode.querySelector('parsererror') || !documentNode.documentElement) {
    return null;
  }
  for (const element of Array.from(documentNode.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on') || /(?:javascript|https?|file|data:text\/html):/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const serialized = new XMLSerializer().serializeToString(documentNode.documentElement);
  return new Blob([serialized], { type: 'image/svg+xml' });
}

interface DecodedCover {
  image: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  close: () => void;
}

async function decodeCover(blob: Blob): Promise<DecodedCover | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const image = await createImageBitmap(blob);
      if (image.width > 0 && image.height > 0) {
        return {
          image,
          width: image.width,
          height: image.height,
          close: () => image.close(),
        };
      }
      image.close();
    } catch {
      // 继续尝试 HTMLImageElement；两种解码器都不可用时降级封面而不阻断导入。
    }
  }
  if (
    typeof Image === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return null;
  }
  const image = new Image();
  const objectUrl = URL.createObjectURL(blob);
  return await new Promise<DecodedCover | null>((resolve) => {
    const cleanup = () => URL.revokeObjectURL?.(objectUrl);
    image.onload = () => {
      cleanup();
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        resolve(null);
        return;
      }
      resolve({
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => {
          image.onload = null;
          image.onerror = null;
          image.src = '';
        },
      });
    };
    image.onerror = () => {
      cleanup();
      resolve(null);
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
