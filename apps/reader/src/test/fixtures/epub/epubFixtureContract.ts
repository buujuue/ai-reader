/**
 * EPUB 核心阅读循环的可执行验收契约。
 *
 * 这里故意只描述产品承诺和测试资产，不被生产阅读器运行时依赖。
 * 后续 EPUB 解析/导入实现必须以本契约的 outcome 与用户可见结果为准。
 */

import { EPUB_RESOURCE_BUDGET } from '../../../domain/library/epub/epubBudget';

export { EPUB_RESOURCE_BUDGET };
export type { EpubResourceBudget } from '../../../domain/library/epub/epubBudget';

export type EpubAcceptanceOutcome = 'supported' | 'degraded' | 'rejected';

export type EpubFixtureFeature =
  | 'epub2'
  | 'epub3'
  | 'flowable'
  | 'fixed-layout'
  | 'nav'
  | 'ncx'
  | 'rtl'
  | 'vertical'
  | 'obfuscated-font'
  | 'footnote'
  | 'image'
  | 'cover'
  | 'svg'
  | 'mathml'
  | 'missing-toc'
  | 'corrupt-toc'
  | 'corrupt-package'
  | 'commercial-drm'
  | 'audio-video'
  | 'scripted-content'
  | 'remote-active-resource'
  | 'zip-bomb'
  | 'compression-ratio-limit'
  | 'chapter-size-limit'
  | 'entry-count-limit'
  | 'xml-depth-limit';

export interface EpubResourceProfile {
  singleEntryUncompressedBytes: number;
  totalUncompressedBytes: number;
  compressionRatio: number;
  largestChapterUncompressedBytes: number;
  entryCount: number;
  maxXmlNestingDepth: number;
}

export interface EpubFixtureSource {
  kind: 'project-generated';
  generator: string;
  license: 'AGPL-3.0';
  reproducible: true;
}

export interface EpubFixtureDefinition {
  id: string;
  label: string;
  features: readonly EpubFixtureFeature[];
  expectedOutcome: EpubAcceptanceOutcome;
  /** 验收时必须能在界面或导入错误中观察到的结果。 */
  userVisibleResult: string;
  resourceProfile: EpubResourceProfile;
  source: EpubFixtureSource;
}

export interface EpubFixtureEvaluation {
  outcome: EpubAcceptanceOutcome;
  matchedRejectedFeatures: readonly EpubFixtureFeature[];
  matchedDegradedFeatures: readonly EpubFixtureFeature[];
  exceedsResourceBudget: boolean;
}

export const EPUB_FIXTURE_SOURCE: EpubFixtureSource = Object.freeze({
  kind: 'project-generated',
  generator: 'apps/reader/src/test/fixtures/epub/epubFixtures.ts',
  license: 'AGPL-3.0',
  reproducible: true,
});

export const REQUIRED_EPUB_FEATURES: readonly EpubFixtureFeature[] = [
  'epub2',
  'epub3',
  'flowable',
  'fixed-layout',
  'nav',
  'ncx',
  'rtl',
  'vertical',
  'obfuscated-font',
  'footnote',
  'image',
  'cover',
  'svg',
  'mathml',
  'missing-toc',
  'corrupt-toc',
  'corrupt-package',
  'commercial-drm',
  'audio-video',
  'scripted-content',
  'remote-active-resource',
  'zip-bomb',
  'compression-ratio-limit',
  'chapter-size-limit',
  'entry-count-limit',
  'xml-depth-limit',
];

const withinBudget: EpubResourceProfile = {
  singleEntryUncompressedBytes: 32 * 1024,
  totalUncompressedBytes: 96 * 1024,
  compressionRatio: 2,
  largestChapterUncompressedBytes: 16 * 1024,
  entryCount: 8,
  maxXmlNestingDepth: 8,
};

function withResourceProfileOverrides(
  overrides: Partial<EpubResourceProfile>,
): EpubResourceProfile {
  return { ...withinBudget, ...overrides };
}

function defineEpubFixture(
  id: string,
  label: string,
  features: readonly EpubFixtureFeature[],
  expectedOutcome: EpubAcceptanceOutcome,
  userVisibleResult: string,
  resourceProfile: EpubResourceProfile = withinBudget,
): EpubFixtureDefinition {
  return {
    id,
    label,
    features,
    expectedOutcome,
    userVisibleResult,
    resourceProfile,
    source: EPUB_FIXTURE_SOURCE,
  };
}

/**
 * 样书目录是唯一的验收基线。每项都可由 epubFixtures.ts 确定性生成，
 * 不从网上下载，也不把版权不明的电子书二进制放进仓库。
 */
export const EPUB_FIXTURES: readonly EpubFixtureDefinition[] = [
  defineEpubFixture(
    'epub2-ncx-flowable',
    'EPUB 2 + NCX + 流式章节',
    ['epub2', 'flowable', 'ncx', 'cover'],
    'supported',
    '导入成功，打开后显示流式正文与分层目录。',
  ),
  defineEpubFixture(
    'epub3-nav-rich',
    'EPUB 3 + NAV + 图片/SVG/脚注',
    ['epub3', 'flowable', 'nav', 'image', 'svg', 'footnote', 'cover'],
    'supported',
    '导入成功，图片、SVG、脚注跳转和 NAV 目录可用。',
  ),
  defineEpubFixture(
    'epub3-fixed-layout',
    'EPUB 3 固定版式',
    ['epub3', 'fixed-layout', 'nav', 'image', 'svg'],
    'supported',
    '导入成功，章节以固定版式显示，目录可跳转。',
  ),
  defineEpubFixture(
    'epub3-rtl-vertical',
    'RTL + 竖排',
    ['epub3', 'flowable', 'nav', 'rtl', 'vertical'],
    'supported',
    '导入成功，阅读方向为 RTL，正文保持竖排方向。',
  ),
  defineEpubFixture(
    'epub3-obfuscated-font',
    '字体混淆',
    ['epub3', 'flowable', 'nav', 'obfuscated-font'],
    'degraded',
    '导入成功；混淆字体不可用时回退到系统字体，并明确提示排版可能变化。',
  ),
  defineEpubFixture(
    'epub3-mathml',
    'MathML 局部降级',
    ['epub3', 'flowable', 'nav', 'mathml'],
    'degraded',
    '正文仍可阅读；无法渲染的公式保留可见替代文本或降级提示。',
  ),
  defineEpubFixture(
    'epub3-missing-toc',
    '缺失目录',
    ['epub3', 'flowable', 'missing-toc'],
    'degraded',
    '导入成功；目录面板显示“此书没有可用目录”，正文仍可打开。',
  ),
  defineEpubFixture(
    'epub3-corrupt-toc',
    '损坏目录',
    ['epub3', 'flowable', 'corrupt-toc'],
    'degraded',
    '导入成功；目录面板说明目录损坏，正文仍可打开并按章节阅读。',
  ),
  defineEpubFixture(
    'epub3-corrupt-package',
    '损坏包',
    ['corrupt-package'],
    'rejected',
    '导入被拒绝，提示 EPUB 包损坏并要求选择另一份文件。',
    withResourceProfileOverrides({ totalUncompressedBytes: 0 }),
  ),
  defineEpubFixture(
    'epub3-commercial-drm',
    '商业 DRM',
    ['epub3', 'commercial-drm'],
    'rejected',
    '导入被拒绝，明确说明不支持商业 DRM，不执行解密或联网授权。',
  ),
  defineEpubFixture(
    'epub3-audio-video',
    '音频/视频媒体',
    ['epub3', 'flowable', 'nav', 'audio-video'],
    'degraded',
    '正文可阅读；音频/视频控件被禁用并显示“媒体不受支持”。',
  ),
  defineEpubFixture(
    'epub3-scripted-content',
    '脚本内容',
    ['epub3', 'flowable', 'nav', 'scripted-content'],
    'degraded',
    '脚本不执行，静态正文可阅读；互动部分显示为不可用。',
  ),
  defineEpubFixture(
    'epub3-remote-active-resource',
    '远程活动资源',
    ['epub3', 'flowable', 'nav', 'remote-active-resource'],
    'degraded',
    '远程脚本、页面、字体和图片不加载；包内静态正文仍可阅读。',
  ),
  defineEpubFixture(
    'epub3-compression-ratio-limit',
    '超高压缩比',
    ['epub3', 'compression-ratio-limit'],
    'rejected',
    '导入被拒绝，提示压缩比超过安全预算，不进行解压。',
    withResourceProfileOverrides({ compressionRatio: 101 }),
  ),
  defineEpubFixture(
    'epub3-chapter-size-limit',
    '超大章节',
    ['epub3', 'chapter-size-limit'],
    'rejected',
    '导入被拒绝，提示章节超过安全大小上限。',
    withResourceProfileOverrides({ largestChapterUncompressedBytes: 8 * 1024 * 1024 + 1 }),
  ),
  defineEpubFixture(
    'epub3-entry-count-limit',
    '条目数量过多',
    ['epub3', 'entry-count-limit'],
    'rejected',
    '导入被拒绝，提示 ZIP 条目数量超过安全上限。',
    withResourceProfileOverrides({ entryCount: 10_001 }),
  ),
  defineEpubFixture(
    'epub3-xml-depth-limit',
    'XML/HTML 嵌套过深',
    ['epub3', 'xml-depth-limit'],
    'rejected',
    '导入被拒绝，提示 XML/HTML 嵌套深度超过安全上限。',
    withResourceProfileOverrides({ maxXmlNestingDepth: 65 }),
  ),
  defineEpubFixture(
    'epub3-zip-bomb',
    '恶意压缩包',
    ['epub3', 'zip-bomb', 'compression-ratio-limit', 'chapter-size-limit'],
    'rejected',
    '导入被拒绝，提示解压资源预算超限，不产生托管文件。',
    withResourceProfileOverrides({
      singleEntryUncompressedBytes: 64 * 1024 * 1024 + 1,
      totalUncompressedBytes: 256 * 1024 * 1024 + 1,
      compressionRatio: 10_000,
      largestChapterUncompressedBytes: 8 * 1024 * 1024 + 1,
    }),
  ),
];

export function findEpubFixture(id: string): EpubFixtureDefinition {
  const found = EPUB_FIXTURES.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`未知 EPUB 验收样书:${id}`);
  }
  return found;
}

const REJECTED_EPUB_FEATURES: ReadonlySet<EpubFixtureFeature> = new Set([
  'corrupt-package',
  'commercial-drm',
  'zip-bomb',
]);

const DEGRADED_EPUB_FEATURES: ReadonlySet<EpubFixtureFeature> = new Set([
  'obfuscated-font',
  'mathml',
  'missing-toc',
  'corrupt-toc',
  'audio-video',
  'scripted-content',
  'remote-active-resource',
]);

/**
 * 按冻结的产品政策从样书事实计算结果；expectedOutcome 只用于测试对照，
 * 不参与这个判定，避免目录把错误结果也“自证”为正确。
 */
export function evaluateEpubFixture(
  definition: EpubFixtureDefinition,
): EpubFixtureEvaluation {
  const matchedRejectedFeatures = definition.features.filter((feature) =>
    REJECTED_EPUB_FEATURES.has(feature),
  );
  const matchedDegradedFeatures = definition.features.filter((feature) =>
    DEGRADED_EPUB_FEATURES.has(feature),
  );
  const exceedsResourceBudget = violatesEpubResourceBudget(definition.resourceProfile);
  const outcome: EpubAcceptanceOutcome =
    matchedRejectedFeatures.length > 0 || exceedsResourceBudget
      ? 'rejected'
      : matchedDegradedFeatures.length > 0
        ? 'degraded'
        : 'supported';

  return {
    outcome,
    matchedRejectedFeatures,
    matchedDegradedFeatures,
    exceedsResourceBudget,
  };
}

export function violatesEpubResourceBudget(profile: EpubResourceProfile): boolean {
  return (
    profile.singleEntryUncompressedBytes > EPUB_RESOURCE_BUDGET.maxEntryUncompressedBytes ||
    profile.totalUncompressedBytes > EPUB_RESOURCE_BUDGET.maxTotalUncompressedBytes ||
    profile.compressionRatio > EPUB_RESOURCE_BUDGET.maxCompressionRatio ||
    profile.largestChapterUncompressedBytes > EPUB_RESOURCE_BUDGET.maxChapterUncompressedBytes ||
    profile.entryCount > EPUB_RESOURCE_BUDGET.maxEntryCount ||
    profile.maxXmlNestingDepth > EPUB_RESOURCE_BUDGET.maxXmlNestingDepth
  );
}
