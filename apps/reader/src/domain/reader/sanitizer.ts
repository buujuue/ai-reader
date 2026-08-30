/**
 * EPUB 内容清洗器:把进入渲染器的文本资源当作不可信输入处理。
 * 永久移除脚本、iframe、对象嵌入、表单、可执行属性与危险 URL,阻止主动远程
 * 资源在阅读 WebView 中执行或取得 Tauri IPC。
 *
 * 这是 ADR-0010 的实现承载:不提供"信任此书"开关,清洗是打开 EPUB 的必经步骤。
 */

/** 明确禁止的 URL 协议(大小写不敏感)。其余未列出的协议也一律拒绝。 */
const BLOCKED_URL_PROTOCOLS = /^(?:javascript|vbscript|file|cid|jar):/i;

/** 清洗规则版本；任何输出语义变化都必须递增，令 Reader Runtime 缓存失效。 */
export const EPUB_SANITIZER_VERSION = 'sanitizer-v1';

/** 允许的 data: URI(仅安全的栅格图片),避免把 SVG 当作主动内容载荷。 */
const ALLOWED_DATA_IMAGE_URI =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)(?:;[a-z0-9=.-]+)*,/i;

const FORBIDDEN_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'form',
  'frame',
  'audio',
  'video',
  'source',
  'track',
  'portal',
]);

/** 危险属性:事件处理器与可注入脚本载荷的属性。 */
const FORBIDDEN_ATTR_PREFIX = /^on/i;
const FORBIDDEN_ATTRS = new Set([
  'srcdoc',
  'formaction',
  'srcset',
  'imagesrcset',
  'ping',
]);

const SCRIPT_MEDIA_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
]);

/**
 * 按资源 MIME 类型执行统一的失效安全清洗。
 * 未知二进制资源不经过此文本接口;已知的主动 MIME 类型则返回空内容,
 * 绝不在清洗失败时把原始脚本交回渲染器。
 */
export function sanitizeEpubResource(type: string, input: string): string {
  const mediaType = type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (SCRIPT_MEDIA_TYPES.has(mediaType)) {
    return '';
  }
  try {
    if (mediaType === 'text/css') {
      return sanitizeEpubStylesheet(input);
    }
    if (
      mediaType === 'application/xhtml+xml' ||
      mediaType === 'text/html' ||
      mediaType === 'image/svg+xml'
    ) {
      return sanitizeEpubContent(input);
    }
  } catch {
    // 已知可执行/可解析文本资源清洗失败时必须丢弃,不能回传原文。
    return '';
  }
  return input;
}

/**
 * 清洗一段 XHTML/HTML 内容,返回清洗后的完整文档字符串。
 * 对已解析的 DOM 原地清理,不依赖第三方库。
 *
 * 先按 XHTML 解析;若因格式不严(如 srcdoc 属性内出现裸 `<script>`)导致解析失败,
 * 回退到宽松的 HTML 解析。任何情况下都不把未清洗的原始内容直接返回。
 */
export function sanitizeEpubContent(input: string): string {
  const doc = parseDocument(input);
  const root = doc.documentElement;
  if (root) {
    sanitizeElementTree(root);
  }
  return new XMLSerializer().serializeToString(doc);
}

/**
 * 清洗一段 HTML 片段(如 Markdown 渲染结果),返回清洗后的 body 内部 HTML。
 * 与 `sanitizeEpubContent` 共用同一套标签/属性/URL 黑名单,落实 ADR-0010。
 * 片段解析使用宽松的 `text/html`,不要求完整文档结构。
 */
export function sanitizeHtmlFragment(input: string): string {
  const doc = new DOMParser().parseFromString(input, 'text/html');
  sanitizeElementTree(doc.body);
  return doc.body.innerHTML;
}

/**
 * 清洗 EPUB 包内 CSS。Foliate 已经把包内资源替换成 blob URL,所以这里
 * 只允许 blob、片段、data 图片和非绝对相对路径;所有网络、文件和未知协议
 * 的资源都被替换为无副作用的 `none`。
 */
export function sanitizeEpubStylesheet(input: string): string {
  let output = input;
  output = output.replace(
    /@import\s+url\(\s*(['"]?)([^'"\)\r\n]*)\1\s*\)\s*;?/gi,
    (_match, _quote: string, value: string) =>
      isAllowedCssUrl(value) ? `@import url("${value.trim()}");` : '',
  );
  output = output.replace(
    /@import\s+(['"])([^'"\r\n]*)\1\s*;?/gi,
    (_match, _quote: string, value: string) =>
      isAllowedCssUrl(value) ? `@import url("${value.trim()}");` : '',
  );
  output = output.replace(
    /url\(\s*(['"]?)([^'"\)\r\n]*)\1\s*\)/gi,
    (_match, _quote: string, value: string) =>
      isAllowedCssUrl(value) ? `url("${value.trim()}")` : 'none',
  );
  // 这些旧式 CSS 执行入口在部分 WebView/兼容模式中可能重新获得行为语义。
  return output.replace(
    /(?:expression|behavior|-moz-binding)\s*:[^;{}]*(?:;|(?=}))/gi,
    '',
  );
}

function parseDocument(input: string): Document {
  const xhtml = new DOMParser().parseFromString(input, 'application/xhtml+xml');
  if (!xhtml.documentElement || xhtml.getElementsByTagName('parsererror').length > 0) {
    return new DOMParser().parseFromString(input, 'text/html');
  }
  return xhtml;
}

function sanitizeElementTree(root: Element): void {
  if (FORBIDDEN_TAGS.has(root.localName.toLowerCase())) {
    root.remove();
    return;
  }
  const elements = [root, ...Array.from(root.getElementsByTagName('*'))];
  for (const element of elements) {
    if (FORBIDDEN_TAGS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
    }
    if (
      element.localName.toLowerCase() === 'meta' &&
      element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh'
    ) {
      element.remove();
      continue;
    }
    if (element.localName.toLowerCase() === 'style') {
      element.textContent = sanitizeEpubStylesheet(element.textContent ?? '');
    }
    sanitizeAttributes(element);
  }
}

function sanitizeAttributes(element: Element): void {
  const attributes = Array.from(element.attributes);
  for (const attr of attributes) {
    const lower = attr.name.toLowerCase();

    if (FORBIDDEN_ATTR_PREFIX.test(lower) || FORBIDDEN_ATTRS.has(lower)) {
      element.removeAttribute(attr.name);
      continue;
    }

    if (isUrlAttribute(lower)) {
      const value = attr.value.trim();
      if (!isAllowedUrl(value, element, lower)) {
        element.removeAttribute(attr.name);
      }
    } else if (lower === 'style') {
      element.setAttribute(attr.name, sanitizeEpubStylesheet(attr.value));
    }
  }
}

function isUrlAttribute(lower: string): boolean {
  return (
    lower === 'href' ||
    lower === 'xlink:href' ||
    lower === 'src' ||
    lower === 'action' ||
    lower === 'background'
  );
}

function isAllowedUrl(value: string, element: Element, attribute: string): boolean {
  if (!value) {
    return true;
  }
  const normalized = normalizeUrlForProtocolCheck(value);
  if (BLOCKED_URL_PROTOCOLS.test(normalized)) {
    return false;
  }
  // 协议相对 URL(以 // 开头)是网络路径引用,会解析到当前协议下的远程主机,
  // 不是真正安全的相对路径。阅读内容一律视为不可信,予以拒绝。
  if (/^\/\//.test(normalized)) {
    return false;
  }
  if (/^data:/i.test(normalized)) {
    return isImageResourceAttribute(element, attribute) && ALLOWED_DATA_IMAGE_URI.test(normalized);
  }
  if (normalized.startsWith('#')) {
    return true;
  }
  // 书内外链由宿主拦截后交给系统浏览器；其它元素上的显式远程 URL 都是
  // 资源加载请求，不能让阅读内容借此访问网络。包内图片、样式和字体在
  // Foliate Loader 中会先替换成 blob URL,因此这里不保留资源相对路径。
  if (/^blob:/i.test(normalized)) {
    return isLocalBlobAttribute(element, attribute);
  }
  if (/^https?:/i.test(normalized)) {
    const tagName = element.localName.toLowerCase();
    // Foliate 的外链接管只覆盖 a[href],其它元素不能绕过统一确认流程。
    return attribute === 'href' && tagName === 'a';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return false;
  }
  // 绝对路径会从宿主应用 origin 解析,不是 EPUB 包内资源。
  if (/^[\\/]/.test(normalized)) {
    return false;
  }
  const tagName = element.localName.toLowerCase();
  // 仅保留书内导航的相对链接;包内图片/样式应已由 Foliate 替换为 blob。
  return attribute === 'href' && tagName === 'a';
}

function isAllowedCssUrl(value: string): boolean {
  const normalized = normalizeUrlForProtocolCheck(value.trim());
  if (!normalized || normalized.startsWith('#')) {
    return true;
  }
  if (/^data:/i.test(normalized)) {
    return ALLOWED_DATA_IMAGE_URI.test(normalized);
  }
  if (/^blob:/i.test(normalized)) {
    return true;
  }
  if (/^[\\/]/.test(normalized) || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return false;
  }
  return true;
}

function normalizeUrlForProtocolCheck(value: string): string {
  return value.replace(/[\u0000-\u0020]+/g, '');
}

function isImageResourceAttribute(element: Element, attribute: string): boolean {
  const tagName = element.localName.toLowerCase();
  return (
    (attribute === 'src' && tagName === 'img') ||
    ((attribute === 'href' || attribute === 'xlink:href') && tagName === 'image') ||
    attribute === 'background'
  );
}

function isLocalBlobAttribute(element: Element, attribute: string): boolean {
  const tagName = element.localName.toLowerCase();
  if (attribute === 'src' && tagName === 'img') {
    return true;
  }
  if ((attribute === 'href' || attribute === 'xlink:href') && tagName === 'image') {
    return true;
  }
  if (attribute === 'href' && tagName === 'link') {
    const rel = element.getAttribute('rel')?.toLowerCase().split(/\s+/) ?? [];
    return rel.includes('stylesheet') || rel.includes('alternate stylesheet');
  }
  return false;
}
