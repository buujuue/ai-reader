/**
 * 读取 EPUB CFI 中标识 spine 项的前缀。
 *
 * EPUB CFI 的 `!` 之前是 package/spine 路径,之后才是章节内 DOM 路径。
 * 只用字符串解析可以避免为批注回退额外创建 Range 或改变当前阅读位置。
 */
export function getEpubCfiSpinePrefix(value: string | null | undefined): string | null {
  if (!value) return null;
  // foliate 常见的 range 形式是 `epubcfi(/6/4)!/4/...`,而规范完整
  // 形式也可能把 `!` 放在括号内;两者都只取 `!` 之前的 package 路径。
  const match = /^epubcfi\(([^)]*)\)(?:!.*)?$/.exec(value);
  if (!match) return null;
  const inner = match[1]!;
  const separator = inner.indexOf('!');
  const prefix = separator >= 0 ? inner.slice(0, separator) : inner;
  return prefix.startsWith('/') && prefix.length > 1 ? prefix : null;
}

/** 只有能明确解析且 spine 前缀相同的两个 CFI 才视为同一章节。 */
export function isSameEpubCfiSpine(left: string, right: string): boolean {
  const leftPrefix = getEpubCfiSpinePrefix(left);
  const rightPrefix = getEpubCfiSpinePrefix(right);
  return leftPrefix !== null && leftPrefix === rightPrefix;
}
