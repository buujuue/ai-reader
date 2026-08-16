import { describe, expect, it } from 'vitest';

import { inspectEpub } from '../../../domain/library/epub/epubInspector';
import { listZipEntries, readZipEntry } from '../../../domain/library/epub/zip';
import {
  EPUB_FIXTURES,
  EPUB_RESOURCE_BUDGET,
  REQUIRED_EPUB_FEATURES,
  evaluateEpubFixture,
  findEpubFixture,
  violatesEpubResourceBudget,
} from './epubFixtureContract';
import { buildEpubFixture, measureEpubFixtureResources } from './epubFixtures';
import {
  EPUB_BENCHMARK_PHASES,
  EPUB_BENCHMARK_SCENARIOS,
  runEpubBenchmark,
} from './epubBenchmark';

describe('EPUB 核心契约与样书集', () => {
  it('覆盖工单要求的全部样书特征', () => {
    const covered = new Set(EPUB_FIXTURES.flatMap((fixture) => fixture.features));

    for (const feature of REQUIRED_EPUB_FEATURES) {
      expect(covered, `缺少样书特征:${feature}`).toContain(feature);
    }
  });

  it('每个样书都有唯一身份、预期结果、用户可见结果和来源记录', () => {
    const ids = new Set<string>();
    for (const fixture of EPUB_FIXTURES) {
      expect(ids.has(fixture.id)).toBe(false);
      ids.add(fixture.id);
      expect(fixture.label.length).toBeGreaterThan(0);
      expect(fixture.features.length).toBeGreaterThan(0);
      expect(['supported', 'degraded', 'rejected']).toContain(fixture.expectedOutcome);
      expect(fixture.userVisibleResult.length).toBeGreaterThan(0);
      expect(fixture.source).toMatchObject({
        kind: 'project-generated',
        license: 'AGPL-3.0',
        reproducible: true,
      });
    }
    expect(new Set(EPUB_FIXTURES.map((fixture) => fixture.expectedOutcome))).toEqual(
      new Set(['supported', 'degraded', 'rejected']),
    );
  });

  it('所有资源预算字段都有明确上限，超限样书的预期结果是拒绝', () => {
    expect(EPUB_RESOURCE_BUDGET).toEqual({
      maxEntryUncompressedBytes: 64 * 1024 * 1024,
      maxTotalUncompressedBytes: 256 * 1024 * 1024,
      maxCompressionRatio: 100,
      maxChapterUncompressedBytes: 8 * 1024 * 1024,
      maxEntryCount: 10_000,
      maxXmlNestingDepth: 64,
    });

    for (const fixture of EPUB_FIXTURES) {
      if (violatesEpubResourceBudget(fixture.resourceProfile)) {
        expect(fixture.expectedOutcome, fixture.id).toBe('rejected');
      }
    }
  });

  it('按独立政策计算出的结果与每个样书声明的预期一致', () => {
    for (const fixture of EPUB_FIXTURES) {
      expect(evaluateEpubFixture(fixture).outcome, fixture.id).toBe(
        fixture.expectedOutcome,
      );
    }
  });

  it('预算边界样书的真实 ZIP 中央目录确实触发预算拒绝', async () => {
    const budgetFixtures = EPUB_FIXTURES.filter((fixture) =>
      fixture.features.some((feature) =>
        [
          'zip-bomb',
          'compression-ratio-limit',
          'chapter-size-limit',
          'entry-count-limit',
          'xml-depth-limit',
        ].includes(feature),
      ),
    );

    for (const fixture of budgetFixtures) {
      const measured = await measureEpubFixtureResources(
        await buildEpubFixture(fixture.id),
      );
      expect(violatesEpubResourceBudget(measured), fixture.id).toBe(true);
    }
  }, 20_000);

  it('DRM 和远程活动资源样书包含可供拒绝/清洗测试识别的真实标记', async () => {
    const drmNames = listZipEntries(await buildEpubFixture('epub3-commercial-drm')).map(
      (entry) => entry.name,
    );
    expect(drmNames).toEqual(
      expect.arrayContaining(['META-INF/rights.xml', 'META-INF/encryption.xml']),
    );

    const remote = new TextDecoder().decode(
      (await readZipEntry(
        await buildEpubFixture('epub3-remote-active-resource'),
        'OEBPS/chapter.xhtml',
      )) ?? new Uint8Array(),
    );
    expect(remote).toContain('remote.js');
    expect(remote).toContain('remote.xhtml');
    expect(remote).toContain('remote.woff');
  });

  it('支持和局部降级样书都能被现有 EPUB 检查器打开', async () => {
    for (const fixture of EPUB_FIXTURES.filter(
      (candidate) => candidate.expectedOutcome !== 'rejected',
    )) {
      const bytes = await buildEpubFixture(fixture.id);
      const result = await inspectEpub(bytes).catch((error: unknown) => {
        throw new Error(`${fixture.id}: ${error instanceof Error ? error.message : String(error)}`);
      });
      expect(result.metadata.title).toBe(fixture.label);
    }
  });

  it('样书生成是确定性的，并保留 NAV/NCX 的可检查结构', async () => {
    const first = await buildEpubFixture('epub3-nav-rich');
    const second = await buildEpubFixture('epub3-nav-rich');
    expect(Array.from(first)).toEqual(Array.from(second));

    const names = listZipEntries(first).map((entry) => entry.name);
    expect(names).toContain('OEBPS/nav.xhtml');
    expect(names).not.toContain('OEBPS/toc.ncx');

    const ncx = await buildEpubFixture('epub2-ncx-flowable');
    expect(listZipEntries(ncx).map((entry) => entry.name)).toContain('OEBPS/toc.ncx');
  });

  it('基准运行器记录导入、首次打开、章节切换和内存四个阶段', async () => {
    const fixture = findEpubFixture('epub3-nav-rich');
    let tick = 0;
    const run = await runEpubBenchmark({
      fixture,
      platform: 'test-platform',
      repetitions: 2,
      clock: { now: () => (tick += 5) },
      hooks: {
        importFixture: async () => undefined,
        openFixture: async () => undefined,
        switchChapter: async () => undefined,
        readMemoryBytes: () => 1234,
      },
    });

    expect(run.schemaVersion).toBe('epub-benchmark.v1');
    expect(run.samples).toHaveLength(8);
    expect(new Set(run.samples.map((sample) => sample.phase))).toEqual(
      new Set(EPUB_BENCHMARK_PHASES),
    );
    expect(run.samples.filter((sample) => sample.phase === 'memory')).toHaveLength(2);
    expect(run.samples.every((sample) => sample.memoryBytes === 1234)).toBe(true);
    expect(EPUB_BENCHMARK_SCENARIOS).toEqual([
      expect.objectContaining({ fixtureId: 'epub3-nav-rich', repetitions: 3 }),
      expect.objectContaining({ fixtureId: 'epub3-fixed-layout', repetitions: 3 }),
    ]);
    expect(
      EPUB_BENCHMARK_SCENARIOS.every((scenario) =>
        scenario.targetPlatforms.includes('windows'),
      ),
    ).toBe(true);
  });
});
