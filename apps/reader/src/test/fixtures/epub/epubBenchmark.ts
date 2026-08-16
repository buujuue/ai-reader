import type { EpubFixtureDefinition } from './epubFixtureContract';

export const EPUB_BENCHMARK_PHASES = [
  'import',
  'first-open',
  'chapter-switch',
  'memory',
] as const;

/** 默认跨平台基准场景；其它样书仍由契约测试覆盖。 */
export const EPUB_BENCHMARK_FIXTURE_IDS = [
  'epub3-nav-rich',
  'epub3-fixed-layout',
] as const;

export interface EpubBenchmarkScenario {
  fixtureId: (typeof EPUB_BENCHMARK_FIXTURE_IDS)[number];
  repetitions: 3;
  targetPlatforms: readonly ['windows', 'macos', 'ipados', 'android'];
}

export const EPUB_BENCHMARK_SCENARIOS: readonly EpubBenchmarkScenario[] = [
  {
    fixtureId: 'epub3-nav-rich',
    repetitions: 3,
    targetPlatforms: ['windows', 'macos', 'ipados', 'android'],
  },
  {
    fixtureId: 'epub3-fixed-layout',
    repetitions: 3,
    targetPlatforms: ['windows', 'macos', 'ipados', 'android'],
  },
];

export type EpubBenchmarkPhase = (typeof EPUB_BENCHMARK_PHASES)[number];

export interface EpubBenchmarkSample {
  fixtureId: string;
  platform: string;
  iteration: number;
  phase: EpubBenchmarkPhase;
  durationMs: number | null;
  memoryBytes: number | null;
}

export interface EpubBenchmarkRun {
  schemaVersion: 'epub-benchmark.v1';
  fixtureId: string;
  platform: string;
  repetitions: number;
  samples: readonly EpubBenchmarkSample[];
}

export interface EpubBenchmarkHooks {
  importFixture(fixture: EpubFixtureDefinition): Promise<void>;
  openFixture(fixture: EpubFixtureDefinition): Promise<void>;
  switchChapter(fixture: EpubFixtureDefinition): Promise<void>;
  readMemoryBytes(): number | null;
}

export interface EpubBenchmarkClock {
  now(): number;
}

export const DEFAULT_EPUB_BENCHMARK_CLOCK: EpubBenchmarkClock = {
  now: () => performance.now(),
};

/**
 * 执行可注入的基准场景。生产/Tauri/真实浏览器脚本各自提供 hooks，
 * 结果统一为 JSON 可序列化记录，从而能按平台与重复次数比较。
 */
export async function runEpubBenchmark(options: {
  fixture: EpubFixtureDefinition;
  platform: string;
  repetitions: number;
  hooks: EpubBenchmarkHooks;
  clock?: EpubBenchmarkClock;
}): Promise<EpubBenchmarkRun> {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error('EPUB 基准重复次数必须是正整数');
  }

  const clock = options.clock ?? DEFAULT_EPUB_BENCHMARK_CLOCK;
  const samples: EpubBenchmarkSample[] = [];
  for (let iteration = 1; iteration <= options.repetitions; iteration += 1) {
    samples.push(
      await timedSample(options, iteration, 'import', () =>
        options.hooks.importFixture(options.fixture), clock),
      await timedSample(options, iteration, 'first-open', () =>
        options.hooks.openFixture(options.fixture), clock),
      await timedSample(options, iteration, 'chapter-switch', () =>
        options.hooks.switchChapter(options.fixture), clock),
    );
    samples.push({
      fixtureId: options.fixture.id,
      platform: options.platform,
      iteration,
      phase: 'memory',
      durationMs: null,
      memoryBytes: options.hooks.readMemoryBytes(),
    });
  }

  return {
    schemaVersion: 'epub-benchmark.v1',
    fixtureId: options.fixture.id,
    platform: options.platform,
    repetitions: options.repetitions,
    samples,
  };
}

async function timedSample(
  options: {
    fixture: EpubFixtureDefinition;
    platform: string;
    hooks: EpubBenchmarkHooks;
  },
  iteration: number,
  phase: Exclude<EpubBenchmarkPhase, 'memory'>,
  action: () => Promise<void>,
  clock: EpubBenchmarkClock,
): Promise<EpubBenchmarkSample> {
  const start = clock.now();
  await action();
  return {
    fixtureId: options.fixture.id,
    platform: options.platform,
    iteration,
    phase,
    durationMs: clock.now() - start,
    memoryBytes: options.hooks.readMemoryBytes(),
  };
}
