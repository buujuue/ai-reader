/**
 * EPUB 内容清洗器:把进入渲染器的 XHTML 内容当作不可信输入处理。
 * 永久移除脚本、iframe、对象嵌入、表单、可执行属性与危险 URL,阻止主动远程
 * 资源在阅读 WebView 中执行或取得 Tauri IPC。
 *
 * 这是 ADR-0010 的实现承载:不提供"信任此书"开关,清洗是打开 EPUB 的必经步骤。
 */

/** 明确禁止的 URL 协议(大小写不敏感)。这些方案可执行脚本或访问本地文件。 */
const BLOCKED_URL_PROTOCOLS = /^(?:javascript|vbscript|file|cid|jar)/i;

/** 允许的显式 URL 协议。其余未列出的方案一律拒绝。 */
const ALLOWED_URL_PROTOCOLS = /^(?:https?|ftp|mailto|tel|callto|sms|blob):/i;

/** 允许的 data: URI(仅图片),满足"必要的 blob/data 图片"边界。 */
const ALLOWED_DATA_URI = /^data:image\/[a-z0-9.+-]+(?:;base64)?,/i;

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'form', 'frame']);

/** 危险属性:事件处理器与可注入脚本载荷的属性。 */
const FORBIDDEN_ATTR_PREFIX = /^on/i;
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'formaction', 'xlink:href', 'srcset']);

/**
 * 清洗一段 XHTML/HTML 内容,返回清洗后的完整文档字符串。
 * 对已解析的 DOM 原地清理,不依赖第三方库。
 *
 * 先按 XHTML 解析;若因格式不严(如 srcdoc 属性内出现裸 `<script>`)导致解析失败,
 * 回退到宽松的 HTML 解析。任何情况下都不把未清洗的原始内容直接返回。
 */
export function sanitizeEpubContent(input: string): string {
  const doc = parseDocument(input);
  sanitizeElementTree(doc.documentElement ?? doc.createElement('body'));
  return new XMLSerializer().serializeToString(doc);
}

function parseDocument(input: string): Document {
  const xhtml = new DOMParser().parseFromString(input, 'application/xhtml+xml');
  if (!xhtml.documentElement || xhtml.getElementsByTagName('parsererror').length > 0) {
    return new DOMParser().parseFromString(input, 'text/html');
  }
  return xhtml;
}

function sanitizeElementTree(root: Element): void {
  const elements = Array.from(root.getElementsByTagName('*'));
  for (const element of elements) {
    if (FORBIDDEN_TAGS.has(element.localName.toLowerCase())) {
      element.remove();
      continue;
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
      if (!isAllowedUrl(value)) {
        element.removeAttribute(attr.name);
      }
    }
  }
}

function isUrlAttribute(lower: string): boolean {
  return lower === 'href' || lower === 'src' || lower === 'action' || lower === 'background';
}

function isAllowedUrl(value: string): boolean {
  if (!value) {
    return true;
  }
  if (BLOCKED_URL_PROTOCOLS.test(value)) {
    return false;
  }
  if (value.startsWith('data:')) {
    return ALLOWED_DATA_URI.test(value);
  }
  if (ALLOWED_URL_PROTOCOLS.test(value) || value.startsWith('#')) {
    return true;
  }
  // 走完协议判断后:允许相对路径(不以 ":" 开头的非协议串)。
  return !/^[a-z][a-z0-9+.-]*:/i.test(value);
}