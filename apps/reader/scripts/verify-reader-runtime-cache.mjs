/**
 * Reader Runtime 有界缓存的真实浏览器基线（工单 #53/#54）。
 *
 * 在真实 Chrome 中使用 library.openBook / reader.activateView Command 构造
 * EPUB 与 Markdown 的 A→B→A 流程，分别记录冷启动与缓存回切的可交互时间、
 * 文档/renderer 创建、ManagedFileSource 范围读取、Runtime 资源和可获得的堆内存。
 * 门槛从同一台机器的冷启动中位数派生，不写死毫秒数。
 *
 * 运行：pnpm test:reader-runtime-cache
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5173';
const ARTIFACT = 'scripts/artifacts/reader-runtime-cache.json';
const runCount = Math.max(3, Number.parseInt(process.env.READER_RUNTIME_CACHE_RUNS ?? '5', 10) || 5);
let dev = null;
let failureReport = null;

function waitForServer(url, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch {
        /* server is still starting */
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Vite 未在 ${timeoutMs}ms 内启动`));
      }
      setTimeout(poll, 300);
    };
    poll();
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function main() {
  const isWin = process.platform === 'win32';
  dev = spawn(isWin ? 'pnpm.cmd' : 'pnpm', ['dev', '--host'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    shell: isWin,
  });

  let browser = null;
  try {
    await waitForServer(APP_URL);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? String(error)));
    await page.goto(APP_URL, { waitUntil: 'networkidle0' });
    // 等待应用自身的异步工作区恢复完成，避免测量 harness 与启动恢复争用全局 Runtime Store。
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const result = await page.evaluate(async ({ runCount: requestedRuns }) => {
      const [commandModule, commandRegistryModule, importModule, epubWriterModule, epubInspectorModule,
        markdownInspectorModule, workspaceRepoModule, workspaceStoreModule, readerRuntimeCacheModule,
        managedSourceModule, hostModule] = await Promise.all([
        import('/src/workbench/readerCommands.ts'),
        import('/src/commands/commandRegistry.ts'),
        import('/src/domain/library/inMemoryImportRepository.ts'),
        import('/src/domain/library/epub/zipWriter.ts'),
        import('/src/domain/library/epub/epubInspector.ts'),
        import('/src/domain/reader/markdown/markdownInspector.ts'),
        import('/src/domain/workspace/inMemoryWorkspaceRepository.ts'),
        import('/src/workbench/workspaceStore.ts'),
        import('/src/workbench/readerRuntimeCache.ts'),
        import('/src/domain/library/managedFileSource.ts'),
        import('/src/domain/reader/foliateViewHost.ts'),
      ]);
      const {
        addInMemorySource,
        createInMemoryImportRepository,
      } = importModule;
      const { buildEpub } = epubWriterModule;
      const { inspectEpub } = epubInspectorModule;
      const { inspectMarkdown } = markdownInspectorModule;
      const { createInMemoryWorkspaceRepository } = workspaceRepoModule;
      const { useWorkspaceStore } = workspaceStoreModule;
      const { ManagedFileSource } = managedSourceModule;
      const { createFoliateViewHostFactory } = hostModule;
      const { COMMAND_IDS, CommandRegistry } = commandRegistryModule;
      const {
        registerReaderCommands,
        flushAndCloseAllReaderViews,
      } = commandModule;

      const bytes = new Map();
      addInMemorySource(bytes, 'cache-a.epub', buildEpub({ title: '缓存基线 EPUB' }));
      addInMemorySource(bytes, 'cache-b.md', new TextEncoder().encode(
        '# 缓存基线 Markdown\n\n这是用于 A→B→A Runtime 测量的正文。',
      ));
      const importRepository = createInMemoryImportRepository(bytes);
      const workspaceRepository = createInMemoryWorkspaceRepository();
      const materials = [];
      for (const name of ['cache-a.epub', 'cache-b.md']) {
        const staged = await importRepository.stageImport(name);
        const content = await importRepository.readStagedFile(staged);
        const metadata = name.endsWith('.epub')
          ? (await inspectEpub(content)).metadata
          : (await inspectMarkdown(content, name)).metadata;
        materials.push(await importRepository.commitImport(staged, metadata));
      }

      const counters = {
        sourceOpens: 0,
        rangeReads: 0,
        rangeBytes: 0,
        rendererCreates: 0,
      };
      const originalOpenManagedFileSource = importRepository.openManagedFileSource.bind(importRepository);
      importRepository.openManagedFileSource = async (materialId) => {
        counters.sourceOpens += 1;
        const source = await originalOpenManagedFileSource(materialId);
        return new ManagedFileSource(
          { name: source.name, size: source.size, type: source.type },
          async (offset, length) => {
            counters.rangeReads += 1;
            const resultBytes = new Uint8Array(await source.readRange(offset, length));
            counters.rangeBytes += resultBytes.byteLength;
            return resultBytes;
          },
        );
      };

      const nativeFactory = createFoliateViewHostFactory();
      const viewHostFactory = (container) => {
        counters.rendererCreates += 1;
        return nativeFactory(container);
      };
      const cache = new readerRuntimeCacheModule.ReaderRuntimeCache();
      const registry = new CommandRegistry();
      registerReaderCommands(registry, {
        importRepository,
        workspaceRepository,
        viewHostFactory,
        readerRuntimeCache: cache,
      });

      const waitFor = async (predicate, label, timeoutMs = 20_000) => {
        const started = performance.now();
        while (performance.now() - started < timeoutMs) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`${label} 未在 ${timeoutMs}ms 内完成`);
      };
      const waitFrames = (count = 2) => new Promise((resolve) => {
        const tick = (remaining) => {
          if (remaining <= 0) return resolve();
          requestAnimationFrame(() => tick(remaining - 1));
        };
        tick(count);
      });
      const heap = () => performance.memory?.usedJSHeapSize ?? null;
      const snapshotCounters = () => ({ ...counters, heapBytes: heap() });
      const diffCounters = (before) => ({
        sourceOpens: counters.sourceOpens - before.sourceOpens,
        rangeReads: counters.rangeReads - before.rangeReads,
        rangeBytes: counters.rangeBytes - before.rangeBytes,
        rendererCreates: counters.rendererCreates - before.rendererCreates,
        heapDeltaBytes:
          before.heapBytes === null || heap() === null ? null : heap() - before.heapBytes,
      });
      const viewIdForMaterial = (materialId) => useWorkspaceStore.getState().editorGroups
        .flatMap((group) => group.views)
        .find((view) => view.materialId === materialId)?.id ?? null;
      const openAndWait = async (material, commandId) => {
        const started = performance.now();
        const commandViewId = await registry.execute(commandId, material);
        const viewId = typeof commandViewId === 'string'
          ? commandViewId
          : viewIdForMaterial(material.id);
        if (!viewId) throw new Error(`没有创建 ${material.title} 的 ReadingView:${JSON.stringify(useWorkspaceStore.getState())}`);
        const commandStatus = commandModule.getReaderRuntimeStatusForMeasurement(viewId);
        if (commandStatus?.status === 'error') throw new Error(`${material.title} Command 打开失败:${commandStatus.message}`);
        await waitFor(() => commandModule.getReaderRuntimeDocumentForMeasurement(viewId) !== undefined, `${material.title} BookDocument 创建`);
        const book = commandModule.getReaderRuntimeDocumentForMeasurement(viewId);
        if (!book) throw new Error(`没有创建 ${material.title} 的 BookDocument`);
        await waitFor(
          () => {
            const status = commandModule.getReaderRuntimeStatusForMeasurement(viewId);
            if (status?.status === 'error') throw new Error(`${material.title} 首次打开失败:${status.message}`);
            return Boolean(book.isRuntimeReady?.()) && book.getContentDocs().some((content) => Boolean(content.body?.textContent?.trim()));
          },
          `${material.title} 首次可见`,
        );
        await waitFrames(4);
        const workspaceLocation = useWorkspaceStore.getState().editorGroups
          .flatMap((group) => group.views)
          .find((view) => view.id === viewId)?.location ?? null;
        return {
          viewId,
          book,
          locationBeforeSwitch: workspaceLocation ?? book.getLocation(),
          tocBeforeSwitch: book.getTOC(),
          firstVisibleMs: performance.now() - started,
        };
      };

      const samples = [];
      for (let run = 0; run < requestedRuns; run += 1) {
        await waitFrames(4);
        await flushAndCloseAllReaderViews();
        await waitFrames();
        cache.reset();
        useWorkspaceStore.getState().resetToDefault();
        const [epub, markdown] = materials;

        const firstBefore = snapshotCounters();
        const first = await openAndWait(epub, COMMAND_IDS.libraryOpenBook);
        const secondSwitchStarted = performance.now();
        const second = await openAndWait(markdown, COMMAND_IDS.libraryOpenBook);
        const switchOutAndSecondVisibleMs = performance.now() - secondSwitchStarted;
        const hitBefore = cache.getDiagnostics().hits;
        const hitCountersBefore = snapshotCounters();
        const returnStarted = performance.now();
        await registry.execute(COMMAND_IDS.readerActivateView, first.viewId, epub);
        await waitFor(
          () => commandModule.getReaderRuntimeStatusForMeasurement(first.viewId)?.status === 'ready' &&
            first.book.getContentDocs().some((content) => content.defaultView?.frameElement?.isConnected),
          'EPUB 缓存回切可交互',
        );
        const hitReturnInteractiveMs = performance.now() - returnStarted;
        const hitCounters = diffCounters(hitCountersBefore);
        const hitDiagnostics = cache.getDiagnostics();
        const cachedResourceUsage = first.book.getRuntimeResourceUsage?.() ?? null;
        const locationPreserved =
          first.locationBeforeSwitch !== null &&
          JSON.stringify(first.book.getLocation()) === JSON.stringify(first.locationBeforeSwitch);
        const tocPreserved =
          JSON.stringify(first.book.getTOC()) === JSON.stringify(first.tocBeforeSwitch);

        const markdownHitCountersBefore = snapshotCounters();
        const markdownReturnStarted = performance.now();
        await registry.execute(COMMAND_IDS.readerActivateView, second.viewId, markdown);
        await waitFor(
          () => commandModule.getReaderRuntimeStatusForMeasurement(second.viewId)?.status === 'ready' &&
            second.book.getContentDocs().some((content) => content.defaultView?.frameElement?.isConnected),
          'Markdown 缓存回切可交互',
        );
        const markdownHitReturnInteractiveMs = performance.now() - markdownReturnStarted;
        const markdownHitCounters = diffCounters(markdownHitCountersBefore);
        const markdownHitDiagnostics = cache.getDiagnostics();

        // 清空运行时和缓存后在同一浏览器/同一材料上测冷回切，作为同机门槛来源。
        await waitFrames(4);
        await flushAndCloseAllReaderViews();
        await waitFrames();
        cache.reset();
        useWorkspaceStore.getState().setActiveView('group-1', first.viewId);
        const coldBefore = snapshotCounters();
        const coldStarted = performance.now();
        await registry.execute(COMMAND_IDS.readerActivateView, first.viewId, epub);
        const coldBook = commandModule.getReaderRuntimeDocumentForMeasurement(first.viewId);
        if (!coldBook) throw new Error('冷回切没有重建 EPUB BookDocument');
        await waitFor(
          () => commandModule.getReaderRuntimeStatusForMeasurement(first.viewId)?.status === 'ready' &&
            coldBook.getContentDocs().some((content) => content.defaultView?.frameElement?.isConnected),
          'EPUB 冷回切可交互',
        );
        const coldReturnInteractiveMs = performance.now() - coldStarted;
        const coldCounters = diffCounters(coldBefore);
        const coldDiagnostics = cache.getDiagnostics();
        const markdownColdBefore = snapshotCounters();
        const markdownColdStarted = performance.now();
        await registry.execute(COMMAND_IDS.readerActivateView, second.viewId, markdown);
        const markdownColdBook = commandModule.getReaderRuntimeDocumentForMeasurement(second.viewId);
        if (!markdownColdBook) throw new Error('冷回切没有重建 Markdown BookDocument');
        await waitFor(
          () => commandModule.getReaderRuntimeStatusForMeasurement(second.viewId)?.status === 'ready' &&
            markdownColdBook.getContentDocs().some((content) => content.defaultView?.frameElement?.isConnected),
          'Markdown 冷回切可交互',
        );
        const markdownColdReturnInteractiveMs = performance.now() - markdownColdStarted;
        const markdownColdCounters = diffCounters(markdownColdBefore);
        samples.push({
          run: run + 1,
          epub: {
            firstVisibleMs: first.firstVisibleMs,
            secondSwitchAndVisibleMs: switchOutAndSecondVisibleMs,
            hitReturnInteractiveMs,
            locationPreserved,
            tocPreserved,
            coldReturnInteractiveMs,
            cacheHitDelta: hitDiagnostics.hits - hitBefore,
            hitCounters,
            coldCounters,
            resourceUsage: cachedResourceUsage,
            heapBytes: heap(),
          },
          markdown: {
            format: second.book.format,
            firstVisibleMs: second.firstVisibleMs,
            hitReturnInteractiveMs: markdownHitReturnInteractiveMs,
            cacheHitDelta: markdownHitDiagnostics.hits - hitDiagnostics.hits,
            hitCounters: markdownHitCounters,
            coldReturnInteractiveMs: markdownColdReturnInteractiveMs,
            coldCounters: markdownColdCounters,
          },
          counters: {
            fromFirstOpen: diffCounters(firstBefore),
          },
          cache: {
            hitDiagnostics,
            coldDiagnostics,
          },
        });
      }

      await waitFrames(4);
      await flushAndCloseAllReaderViews();
      await waitFrames();
      return {
        schemaVersion: 'reader-runtime-cache.v1',
        issue: 54,
        status: 'measured',
        runCount: requestedRuns,
        samples,
      };
    }, { runCount });

    if (pageErrors.length > 0) throw new Error(`页面错误:${pageErrors.join('; ')}`);
    const hitValues = result.samples.map((sample) => sample.epub.hitReturnInteractiveMs);
    const coldValues = result.samples.map((sample) => sample.epub.coldReturnInteractiveMs);
    const markdownHitValues = result.samples.map((sample) => sample.markdown.hitReturnInteractiveMs);
    const markdownColdValues = result.samples.map((sample) => sample.markdown.coldReturnInteractiveMs);
    const thresholds = {
      source: '同一 Chrome 进程、同一材料、同一机器的冷回切中位数与 P95',
      epub: {
        hitReturnInteractiveMedianMs: median(coldValues),
        hitReturnInteractiveP95Ms: percentile(coldValues, 0.95),
      },
      markdown: {
        hitReturnInteractiveMedianMs: median(markdownColdValues),
        hitReturnInteractiveP95Ms: percentile(markdownColdValues, 0.95),
      },
      stableMeasurementCount: result.runCount,
    };
    const checks = {
      atLeastThreeMeasurements: result.runCount >= 3,
      markdownCovered: result.samples.every((sample) => sample.markdown.format === 'markdown'),
      everyRunHasCacheHit: result.samples.every((sample) => sample.epub.cacheHitDelta === 1),
      everyRunHasMarkdownCacheHit: result.samples.every((sample) => sample.markdown.cacheHitDelta === 1),
      everyRunPreservesEpubLocation: result.samples.every((sample) => sample.epub.locationPreserved),
      everyRunPreservesEpubToc: result.samples.every((sample) => sample.epub.tocPreserved),
      cacheHitCreatesNoDocument: result.samples.every((sample) => sample.epub.hitCounters.sourceOpens === 0),
      cacheHitCreatesNoRenderer: result.samples.every((sample) => sample.epub.hitCounters.rendererCreates === 0),
      cacheHitReadsNoRanges: result.samples.every((sample) => sample.epub.hitCounters.rangeReads === 0),
      markdownCacheHitCreatesNoDocument: result.samples.every((sample) => sample.markdown.hitCounters.sourceOpens === 0),
      markdownCacheHitCreatesNoRenderer: result.samples.every((sample) => sample.markdown.hitCounters.rendererCreates === 0),
      markdownCacheHitReadsNoRanges: result.samples.every((sample) => sample.markdown.hitCounters.rangeReads === 0),
      epubHitMedianWithinSameMachineColdMedian: median(hitValues) <= thresholds.epub.hitReturnInteractiveMedianMs,
      epubHitP95WithinSameMachineColdP95: percentile(hitValues, 0.95) <= thresholds.epub.hitReturnInteractiveP95Ms,
      markdownHitMedianWithinSameMachineColdMedian: median(markdownHitValues) <= thresholds.markdown.hitReturnInteractiveMedianMs,
      markdownHitP95WithinSameMachineColdP95: percentile(markdownHitValues, 0.95) <= thresholds.markdown.hitReturnInteractiveP95Ms,
    };
    result.thresholds = thresholds;
    result.summary = {
      cacheHitReturnInteractiveMs: { median: median(hitValues), p95: percentile(hitValues, 0.95) },
      coldReturnInteractiveMs: { median: median(coldValues), p95: percentile(coldValues, 0.95) },
      markdownCacheHitReturnInteractiveMs: { median: median(markdownHitValues), p95: percentile(markdownHitValues, 0.95) },
      markdownColdReturnInteractiveMs: { median: median(markdownColdValues), p95: percentile(markdownColdValues, 0.95) },
    };
    result.checks = checks;
    if (Object.values(checks).some((value) => value !== true)) {
      throw new Error(`Reader Runtime 缓存门禁失败:${JSON.stringify(checks)}`);
    }
    mkdirSync('scripts/artifacts', { recursive: true });
    writeFileSync(ARTIFACT, JSON.stringify(result, null, 2));
    console.log('Reader Runtime 缓存真实浏览器基线结果:');
    console.log(JSON.stringify(result, null, 2));
    console.log(`报告:${ARTIFACT}`);
    console.log('通过:EPUB/Markdown A→B→A 缓存命中不重复创建 BookDocument、renderer 或范围读取。');
  } catch (error) {
    failureReport = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    killDevServer();
  }
}

function killDevServer() {
  if (!dev) return;
  if (process.platform !== 'win32') {
    dev.kill();
    return;
  }
  try {
    execSync(`taskkill /F /T /PID ${dev.pid}`, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

main().catch((error) => {
  console.error(`Reader Runtime 缓存验收失败:${failureReport ?? String(error)}`);
  process.exitCode = 1;
});
