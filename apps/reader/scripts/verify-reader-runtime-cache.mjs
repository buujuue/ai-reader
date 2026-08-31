/**
 * Reader Runtime 有界缓存的真实浏览器总验收（工单 #62，继承 #61/#60/#57）。
 *
 * 在真实 Chrome 中使用 library.openBook / reader.activateView Command 构造
 * EPUB、PDF 与 Markdown 的同格式/跨格式 A→B→A 流程，并新增三视图
 * EPUB→Markdown→PDF→EPUB resident 流程；对 PDF pair 额外执行
 * A→B→A→B→A 连续回切，记录冷启动与缓存回切的
 * 可交互时间、文档/renderer 创建、ManagedFileSource 范围读取、Runtime 资源和可获得的堆内存。
 * PDF 回切额外验证当前页 DOM/Canvas/文本层/覆盖层的首帧节点复用，以及首帧前不发生
 * 页面取得或光栅化，邻页工作在首帧后再恢复。
 * 门槛从同一台机器的冷启动中位数派生，不写死毫秒数。
 *
 * 运行：pnpm test:reader-runtime-cache
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5173';
const ARTIFACT = 'scripts/artifacts/reader-runtime-cache.json';
const VITE_CLI = resolve(process.cwd(), 'node_modules/vite/bin/vite.js');
const runCount = Math.max(3, Number.parseInt(process.env.READER_RUNTIME_CACHE_RUNS ?? '5', 10) || 5);
let dev = null;
let failureReport = null;
let appPage = null;

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

async function flushRuntimeInPage(page) {
  if (!page) return;
  await page.evaluate(async () => {
    try {
      const { flushAndCloseAllReaderViews } = await import('/src/workbench/readerCommands.ts');
      await flushAndCloseAllReaderViews();
    } catch {
      /* 页面已关闭或应用尚未完成初始化;关闭浏览器仍会释放 WebView 运行时。 */
    }
  }).catch(() => undefined);
}

async function main() {
  dev = spawn(process.execPath, [VITE_CLI, '--host'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });

  let browser = null;
  try {
    await waitForServer(APP_URL);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--enable-precise-memory-info'],
    });
    appPage = await browser.newPage();
    await appPage.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    appPage.on('pageerror', (error) => pageErrors.push(error.stack ?? String(error)));
    await appPage.goto(APP_URL, { waitUntil: 'networkidle0' });
    // 等待应用自身的异步工作区恢复完成，避免测量 harness 与启动恢复争用全局 Runtime Store。
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const result = await appPage.evaluate(async ({ runCount: requestedRuns }) => {
      const [commandModule, commandRegistryModule, importModule, epubWriterModule, epubInspectorModule,
        markdownInspectorModule, workspaceRepoModule, workspaceStoreModule, readerRuntimeModule, readerRuntimeCacheModule,
        managedSourceModule, hostModule, bootstrapModule, filePickerModule, libraryStoreModule,
        markdownSessionModule, workbenchCommandsModule, pdfLibraryModule, pdfFixtureModule] = await Promise.all([
        import('/src/workbench/readerCommands.ts'),
        import('/src/commands/commandRegistry.ts'),
        import('/src/domain/library/inMemoryImportRepository.ts'),
        import('/src/domain/library/epub/zipWriter.ts'),
        import('/src/domain/library/epub/epubInspector.ts'),
        import('/src/domain/reader/markdown/markdownInspector.ts'),
        import('/src/domain/workspace/inMemoryWorkspaceRepository.ts'),
        import('/src/workbench/workspaceStore.ts'),
        import('/src/workbench/readerRuntime.ts'),
        import('/src/workbench/readerRuntimeCache.ts'),
        import('/src/domain/library/managedFileSource.ts'),
        import('/src/domain/reader/foliateViewHost.ts'),
        import('/src/app/bootstrap.ts'),
        import('/src/app/filePicker.ts'),
        import('/src/workbench/libraryStore.ts'),
        import('/src/workbench/markdownSessionStore.ts'),
        import('/src/workbench/workbenchCommands.ts'),
        import('/src/domain/reader/pdf/pdfLibrary.ts'),
        import('/src/test/fixtures/pdf/pdfFixtures.ts'),
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
      const { useReaderRuntime } = readerRuntimeModule;
      const { useLibraryStore } = libraryStoreModule;
      const { useMarkdownSessionStore } = markdownSessionModule;
      const { serializeWorkspaceState } = workbenchCommandsModule;
      const { ManagedFileSource } = managedSourceModule;
      const { createFoliateViewHostFactory } = hostModule;
      const { createAppServices } = bootstrapModule;
      const { createInMemoryFilePicker } = filePickerModule;
      const { loadPdfLib } = pdfLibraryModule;
      const { buildLargePdfFixture } = pdfFixtureModule;
      const { COMMAND_IDS } = commandRegistryModule;
      const {
        flushAndCloseAllReaderViews,
      } = commandModule;

      const bytes = new Map();
      addInMemorySource(bytes, 'cache-a.epub', buildEpub({ title: '缓存基线 EPUB' }));
      addInMemorySource(bytes, 'cache-b.md', new TextEncoder().encode(
        '# 缓存基线 Markdown\n\n这是用于 A→B→A Runtime 测量的正文。',
      ));
      addInMemorySource(bytes, 'cache-b.epub', buildEpub({ title: '缓存矩阵 EPUB' }));
      addInMemorySource(bytes, 'cache-c.md', new TextEncoder().encode(
        '# 缓存矩阵 Markdown\n\n这是用于同格式回切的第二份正文。',
      ));
      addInMemorySource(
        bytes,
        'cache-a.pdf',
        buildLargePdfFixture({ pageCount: 4, contentBytesPerPage: 1024 }),
      );
      addInMemorySource(
        bytes,
        'cache-b.pdf',
        buildLargePdfFixture({ pageCount: 4, contentBytesPerPage: 1025 }),
      );
      const importRepository = createInMemoryImportRepository(bytes);
      const workspaceRepository = createInMemoryWorkspaceRepository();
      const materials = [];
      for (const name of [
        'cache-a.epub',
        'cache-b.md',
        'cache-b.epub',
        'cache-c.md',
        'cache-a.pdf',
        'cache-b.pdf',
      ]) {
        const staged = await importRepository.stageImport(name);
        const content = await importRepository.readStagedFile(staged);
        const metadata = name.endsWith('.epub')
          ? (await inspectEpub(content)).metadata
          : name.endsWith('.md')
            ? (await inspectMarkdown(content, name)).metadata
            : {
                title: name === 'cache-a.pdf' ? '缓存基线 PDF' : '缓存矩阵 PDF',
                author: null,
                language: 'zh',
              };
        materials.push(await importRepository.commitImport(staged, metadata));
      }
      useLibraryStore.setState({ materials, trashedMaterials: [] });

      const counters = {
        sourceOpens: 0,
        rangeReads: 0,
        rangeBytes: 0,
        rendererCreates: 0,
        pdfDocumentLoads: 0,
        pdfPageGets: 0,
        pdfRasterizations: 0,
        bookDocumentCreates: 0,
      };
      const observedDocuments = new WeakSet();
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
      const pdfLib = new Proxy(await loadPdfLib(), {
        get(target, property, receiver) {
          if (property !== 'getDocument') return Reflect.get(target, property, receiver);
          return (options) => {
            counters.pdfDocumentLoads += 1;
            const loadingTask = target.getDocument(options);
            return {
              ...loadingTask,
              promise: loadingTask.promise.then((pdfDocument) => new Proxy(pdfDocument, {
                get(documentTarget, documentProperty, documentReceiver) {
                  if (documentProperty === 'getPage') {
                    return async (pageNumber) => {
                      counters.pdfPageGets += 1;
                      return documentTarget.getPage(pageNumber);
                    };
                  }
                  const value = Reflect.get(documentTarget, documentProperty, documentReceiver);
                  return typeof value === 'function' ? value.bind(documentTarget) : value;
                },
              })),
              destroy: loadingTask.destroy?.bind(loadingTask),
            };
          };
        },
      });
      const pdfRasterize = (page, canvas, scale) => {
        counters.pdfRasterizations += 1;
        const canvasContext = canvas.getContext('2d');
        if (!canvasContext) {
          return { promise: Promise.resolve(), cancel: () => undefined };
        }
        return page.render({ canvasContext, viewport: page.getViewport({ scale }) });
      };
      const cache = new readerRuntimeCacheModule.ReaderRuntimeCache();
      // 使用应用正式服务组装器，确保总验收走与实际应用相同的 Command/Repository
      // 注册路径，而不是只手工注册阅读命令。
      const services = createAppServices({
        importRepository,
        filePicker: createInMemoryFilePicker([
          'cache-a.epub',
          'cache-b.md',
          'cache-b.epub',
          'cache-c.md',
          'cache-a.pdf',
          'cache-b.pdf',
        ]),
        workspaceRepository,
        viewHostFactory,
        pdfLib,
        pdfRasterize,
        readerRuntimeCache: cache,
      });
      const registry = services.commands;

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
        pdfDocumentLoads: counters.pdfDocumentLoads - before.pdfDocumentLoads,
        pdfPageGets: counters.pdfPageGets - before.pdfPageGets,
        pdfRasterizations: counters.pdfRasterizations - before.pdfRasterizations,
        bookDocumentCreates: counters.bookDocumentCreates - before.bookDocumentCreates,
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
        if (!observedDocuments.has(book)) {
          observedDocuments.add(book);
          counters.bookDocumentCreates += 1;
        }
        await waitFor(
          () => {
            const status = commandModule.getReaderRuntimeStatusForMeasurement(viewId);
            if (status?.status === 'error') throw new Error(`${material.title} 首次打开失败:${status.message}`);
            if (book.format === 'pdf') {
              return Boolean(book.isRuntimeReady?.()) && book.getCurrentIndex() !== null;
            }
            return Boolean(book.isRuntimeReady?.()) && book.getContentDocs().some((content) => Boolean(content.body?.textContent?.trim()));
          },
          `${material.title} 首次可见`,
        );
        const firstVisibleMs = performance.now() - started;
        await waitForInteractive({ viewId, book }, `${material.title} 首次可交互`);
        const firstInteractiveMs = performance.now() - started;
        await waitFrames(4);
        const workspaceLocation = useWorkspaceStore.getState().editorGroups
          .flatMap((group) => group.views)
          .find((view) => view.id === viewId)?.location ?? null;
        return {
          viewId,
          book,
          locationBeforeSwitch: workspaceLocation ?? book.getLocation(),
          tocBeforeSwitch: book.getTOC(),
          format: book.format,
          firstVisibleMs,
          firstInteractiveMs,
        };
      };

      const waitForInteractive = async (sample, label) => {
        await waitFor(() => {
          const status = commandModule.getReaderRuntimeStatusForMeasurement(sample.viewId);
          if (status?.status === 'error') throw new Error(`${label} 打开失败:${status.message}`);
          if (sample.book.format === 'pdf') {
            const container = document.querySelector(`[data-view-id="${sample.viewId}"]`);
            return Boolean(sample.book.isRuntimeReady?.()) &&
              sample.book.getCurrentIndex() !== null &&
              Boolean(container?.querySelector('.pdf-page canvas'));
          }
          return status?.status === 'ready' &&
            sample.book.getContentDocs().some((content) => content.defaultView?.frameElement?.isConnected);
        }, label);
      };
      const readPdfRestoreState = (viewId, expectedLocation) => {
        if (expectedLocation?.kind !== 'pdf') {
          return {
            scrollModeRestored: null,
            scrollPositionRestored: null,
            visiblePageRestored: null,
            container: null,
          };
        }
        const container = document.querySelector(`[data-view-id="${viewId}"]`);
        if (!(container instanceof HTMLElement)) {
          return {
            scrollModeRestored: false,
            scrollPositionRestored: false,
            visiblePageRestored: false,
            container: null,
          };
        }
        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        const visiblePage = [...container.querySelectorAll('.pdf-page')]
          .filter((page) => {
            const rect = page.getBoundingClientRect();
            const pageTop = rect.top - containerRect.top + scrollTop;
            return pageTop <= scrollTop + 1;
          })
          .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
          .at(-1);
        return {
          scrollModeRestored: getComputedStyle(container).overflowY === 'auto',
          scrollPositionRestored: Math.abs(scrollTop - expectedLocation.scrollTop) <= 1,
          visiblePageRestored: Number(visiblePage?.dataset.page ?? 0) === expectedLocation.page,
          container,
        };
      };
      const readPdfFirstFrameState = (viewId, expectedLocation, preservedNodes) => {
        if (expectedLocation?.kind !== 'pdf') {
          return {
            currentPagePresent: null,
            canvasReady: null,
            textLayerPresent: null,
            highlightLayerPresent: null,
            pagePreserved: null,
            canvasPreserved: null,
            textLayerPreserved: null,
            highlightLayerPreserved: null,
            scrollPositionRestored: null,
          };
        }
        const container = document.querySelector(`[data-view-id="${viewId}"]`);
        const page = container?.querySelector(`.pdf-page[data-page="${expectedLocation.page}"]`);
        const canvas = page?.querySelector('canvas');
        const textLayer = page?.querySelector('.pdf-text-layer');
        const highlightLayer = page?.querySelector('.pdf-highlight-layer');
        return {
          currentPagePresent: Boolean(page),
          canvasReady: Boolean(canvas && canvas.width > 0 && canvas.height > 0),
          textLayerPresent: Boolean(textLayer),
          highlightLayerPresent: Boolean(highlightLayer),
          pagePreserved: page === preservedNodes?.page,
          canvasPreserved: canvas === preservedNodes?.canvas,
          textLayerPreserved: textLayer === preservedNodes?.textLayer,
          highlightLayerPreserved: highlightLayer === preservedNodes?.highlightLayer,
          scrollPositionRestored:
            container instanceof HTMLElement &&
            Math.abs(container.scrollTop - expectedLocation.scrollTop) <= 1,
        };
      };
      const capturePdfCurrentNodes = (viewId, location) => {
        if (location?.kind !== 'pdf') return null;
        const container = document.querySelector(`[data-view-id="${viewId}"]`);
        const page = container?.querySelector(`.pdf-page[data-page="${location.page}"]`);
        return page
          ? {
              page,
              canvas: page.querySelector('canvas'),
              textLayer: page.querySelector('.pdf-text-layer'),
              highlightLayer: page.querySelector('.pdf-highlight-layer'),
            }
          : null;
      };

      const resetHarness = async () => {
        await waitFrames(4);
        await flushAndCloseAllReaderViews();
        await waitFrames();
        cache.reset();
        useWorkspaceStore.getState().resetToDefault();
      };

      const measurePair = async (firstMaterial, secondMaterial, label) => {
        await resetHarness();
        const first = await openAndWait(firstMaterial, COMMAND_IDS.libraryOpenBook);
        if (first.book.format === 'pdf') {
          await registry.execute(COMMAND_IDS.readerSetPdfFlow, first.viewId, 'scrolled');
          await waitFor(() => {
            const container = document.querySelector(`[data-view-id="${first.viewId}"]`);
            if (!(container instanceof HTMLElement)) return false;
            const targetPage = container.querySelector('.pdf-page-placeholder[data-page="3"]');
            return getComputedStyle(container).overflowY === 'auto' &&
              Number.parseFloat(targetPage?.style.top ?? '0') > 0 &&
              Number.parseFloat(targetPage?.style.height ?? '0') > 0;
          }, `${label} PDF 滚动布局`);
          const container = document.querySelector(`[data-view-id="${first.viewId}"]`);
          const targetPage = container?.querySelector('.pdf-page-placeholder[data-page="3"]');
          const targetPageTop = Number.parseFloat(targetPage?.style.top ?? '0');
          const targetPageHeight = Number.parseFloat(targetPage?.style.height ?? '0');
          const setPdfRestoreLocation = (scrollTop) => first.book.goToLocation({
            kind: 'pdf',
            page: 3,
            scrollTop,
            zoom: 125,
            fit: 'width',
          });
          // 先滚到占位页附近让目标页实际加载,再用真实页面尺寸构造
          // 页间距位置,避免把占位尺寸校正误差混入恢复断言。
          await setPdfRestoreLocation(targetPageTop + targetPageHeight + 10);
          await waitFor(
            () => Boolean(container?.querySelector('.pdf-page[data-page="3"] canvas')),
            `${label} PDF 目标页渲染`,
          );
          const renderedTargetPage = container?.querySelector('.pdf-page[data-page="3"]');
          const renderedPageTop = Number.parseFloat(renderedTargetPage?.style.top ?? '0');
          const renderedPageHeight = Number.parseFloat(renderedTargetPage?.style.height ?? '0');
          const expectedScrollTop = renderedPageTop + renderedPageHeight + 10;
          // 页间距是合法的绝对滚动位置,也是“按单页底部错误裁剪”
          // 会把位置吸附回页顶的回归边界。
          await setPdfRestoreLocation(expectedScrollTop);
          await waitFor(
            () => Math.abs((container?.scrollTop ?? 0) - expectedScrollTop) <= 1,
            `${label} PDF 滚动位置设置`,
          );
          await waitFrames(8);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        const firstLocation = first.book.getLocation();
        const firstPdfNodes = capturePdfCurrentNodes(first.viewId, firstLocation);
        const second = await openAndWait(secondMaterial, COMMAND_IDS.libraryOpenBook);
        const hitBefore = cache.getDiagnostics().hits;
        const suspendedBefore = cache.getDiagnostics().entries.find(
          (entry) => entry.viewId === first.viewId && entry.state === 'suspended',
        );
        const countersBefore = snapshotCounters();
        const returnStarted = performance.now();
        await registry.execute(COMMAND_IDS.readerActivateView, first.viewId, firstMaterial);
        await waitForInteractive(first, `${label} 缓存回切`);
        const firstFrameCounters = diffCounters(countersBefore);
        const firstFrameState = readPdfFirstFrameState(
          first.viewId,
          firstLocation,
          firstPdfNodes,
        );
        // 真实 ResizeObserver / 页面尺寸校正可能晚于首个 Canvas；必须等其收敛后
        // 再判断用户最终看到的页面，不能只读取刚 attach 时的瞬时位置。
        await waitFrames(12);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const cacheReturnInteractiveMs = performance.now() - returnStarted;
        const locationAfter = first.book.getLocation();
        const workspaceLocationAfter = useWorkspaceStore.getState().editorGroups
          .flatMap((group) => group.views)
          .find((view) => view.id === first.viewId)?.location ?? null;
        const locationPreserved = firstLocation !== null &&
          JSON.stringify(locationAfter) === JSON.stringify(firstLocation);
        const workspaceLocationPreserved = workspaceLocationAfter !== null &&
          JSON.stringify(workspaceLocationAfter) === JSON.stringify(locationAfter);
        let pdfScrollModeRestored = null;
        let pdfScrollPositionRestored = null;
        let pdfVisiblePageRestored = null;
        let pdfScrollAdvancedAfterReturn = null;
        let pdfFirstFrameCurrentPagePresent = null;
        let pdfFirstFrameCanvasReady = null;
        let pdfFirstFrameTextLayerPresent = null;
        let pdfFirstFrameHighlightLayerPresent = null;
        let pdfFirstFramePagePreserved = null;
        let pdfFirstFrameCanvasPreserved = null;
        let pdfFirstFrameTextLayerPreserved = null;
        let pdfFirstFrameHighlightLayerPreserved = null;
        let pdfFirstFrameScrollPositionRestored = null;
        let pdfFirstFrameNoPageWork = null;
        if (first.book.format === 'pdf') {
          pdfFirstFrameCurrentPagePresent = firstFrameState.currentPagePresent;
          pdfFirstFrameCanvasReady = firstFrameState.canvasReady;
          pdfFirstFrameTextLayerPresent = firstFrameState.textLayerPresent;
          pdfFirstFrameHighlightLayerPresent = firstFrameState.highlightLayerPresent;
          pdfFirstFramePagePreserved = firstFrameState.pagePreserved;
          pdfFirstFrameCanvasPreserved = firstFrameState.canvasPreserved;
          pdfFirstFrameTextLayerPreserved = firstFrameState.textLayerPreserved;
          pdfFirstFrameHighlightLayerPreserved = firstFrameState.highlightLayerPreserved;
          pdfFirstFrameScrollPositionRestored = firstFrameState.scrollPositionRestored;
          pdfFirstFrameNoPageWork =
            firstFrameCounters.pdfPageGets === 0 && firstFrameCounters.pdfRasterizations === 0;
          const restoredState = readPdfRestoreState(first.viewId, firstLocation);
          pdfScrollModeRestored = restoredState.scrollModeRestored;
          pdfScrollPositionRestored = restoredState.scrollPositionRestored;
          pdfVisiblePageRestored = restoredState.visiblePageRestored;
          const resumedScrollTop = restoredState.container?.scrollTop ?? 0;
          const nextScrollTop = Math.min(
            (restoredState.container?.scrollHeight ?? 0) -
              (restoredState.container?.clientHeight ?? 0),
            resumedScrollTop + 160,
          );
          if (restoredState.container && nextScrollTop > resumedScrollTop) {
            restoredState.container.scrollTop = nextScrollTop;
            restoredState.container.dispatchEvent(new Event('scroll'));
            await waitFor(
              () => first.book.getLocation()?.kind === 'pdf' &&
                Math.abs(first.book.getLocation().scrollTop - nextScrollTop) <= 1,
              `${label} PDF 回切后继续滚动`,
            );
            pdfScrollAdvancedAfterReturn = true;
          } else {
            pdfScrollAdvancedAfterReturn = false;
          }
        }
        const locationAfterFirstRound = first.book.getLocation();
        const firstRoundDiagnostics = cache.getDiagnostics();
        const firstRoundCounters = diffCounters(countersBefore);
        let secondRoundCacheHit = null;
        let secondRoundLocationPreserved = null;
        let secondRoundWorkspaceLocationPreserved = null;
        let secondRoundCounters = null;
        let secondRoundPdfScrollModeRestored = null;
        let secondRoundPdfScrollPositionRestored = null;
        let secondRoundPdfVisiblePageRestored = null;
        let secondRoundPdfFirstFrameNoPageWork = null;
        let secondRoundPdfFirstFramePagePreserved = null;
        let secondRoundPdfFirstFrameCanvasPreserved = null;
        let secondRoundPdfFirstFrameTextLayerPreserved = null;
        let secondRoundPdfFirstFrameHighlightLayerPreserved = null;
        let secondRoundFirstFrameState = null;
        if (first.book.format === 'pdf') {
          const secondRoundHitBefore = cache.getDiagnostics().hits;
          const secondRoundCountersBefore = snapshotCounters();
          const secondRoundLocationBeforeReturn = first.book.getLocation();
          const secondRoundPdfNodes = capturePdfCurrentNodes(
            first.viewId,
            secondRoundLocationBeforeReturn,
          );
          await registry.execute(COMMAND_IDS.readerActivateView, second.viewId, secondMaterial);
          await waitForInteractive(second, `${label} 第二轮 B 缓存回切可交互`);
          await waitFrames(12);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const secondRoundReturnCountersBefore = snapshotCounters();
          await registry.execute(COMMAND_IDS.readerActivateView, first.viewId, firstMaterial);
          await waitForInteractive(first, `${label} 第二轮 A 缓存回切可交互`);
          const secondRoundFirstFrameCounters = diffCounters(secondRoundReturnCountersBefore);
          secondRoundFirstFrameState = readPdfFirstFrameState(
            first.viewId,
            secondRoundLocationBeforeReturn,
            secondRoundPdfNodes,
          );
          secondRoundPdfFirstFrameNoPageWork =
            secondRoundFirstFrameCounters.pdfPageGets === 0 &&
            secondRoundFirstFrameCounters.pdfRasterizations === 0;
          secondRoundPdfFirstFramePagePreserved = secondRoundFirstFrameState.pagePreserved;
          secondRoundPdfFirstFrameCanvasPreserved = secondRoundFirstFrameState.canvasPreserved;
          secondRoundPdfFirstFrameTextLayerPreserved = secondRoundFirstFrameState.textLayerPreserved;
          secondRoundPdfFirstFrameHighlightLayerPreserved =
            secondRoundFirstFrameState.highlightLayerPreserved;
          await waitFrames(12);
          await new Promise((resolve) => setTimeout(resolve, 250));
          const secondRoundLocationAfter = first.book.getLocation();
          const secondRoundWorkspaceLocationAfter = useWorkspaceStore.getState().editorGroups
            .flatMap((group) => group.views)
            .find((view) => view.id === first.viewId)?.location ?? null;
          const secondRoundDiagnostics = cache.getDiagnostics();
          secondRoundCacheHit = secondRoundDiagnostics.hits - secondRoundHitBefore === 2;
          secondRoundLocationPreserved = locationAfterFirstRound !== null &&
            JSON.stringify(secondRoundLocationAfter) === JSON.stringify(locationAfterFirstRound);
          secondRoundWorkspaceLocationPreserved = secondRoundWorkspaceLocationAfter !== null &&
            JSON.stringify(secondRoundWorkspaceLocationAfter) === JSON.stringify(secondRoundLocationAfter);
          secondRoundCounters = diffCounters(secondRoundCountersBefore);
          const restoredState = readPdfRestoreState(first.viewId, locationAfterFirstRound);
          secondRoundPdfScrollModeRestored = restoredState.scrollModeRestored;
          secondRoundPdfScrollPositionRestored = restoredState.scrollPositionRestored;
          secondRoundPdfVisiblePageRestored = restoredState.visiblePageRestored;
        }
        return {
          label,
          firstFormat: first.book.format,
          secondFormat: second.book.format,
          firstVisibleMs: first.firstVisibleMs,
          secondVisibleMs: second.firstVisibleMs,
          cacheReturnInteractiveMs,
          cacheHit: firstRoundDiagnostics.hits - hitBefore === 1,
          locationBefore: firstLocation,
          locationAfter,
          locationPreserved,
          workspaceLocationAfter,
          workspaceLocationPreserved,
          secondRoundCacheHit,
          secondRoundLocationPreserved,
          secondRoundWorkspaceLocationPreserved,
          secondRoundCounters,
          pdfScrollModeRestored,
          pdfScrollPositionRestored,
          pdfVisiblePageRestored,
          pdfScrollAdvancedAfterReturn,
          pdfFirstFrameCurrentPagePresent,
          pdfFirstFrameCanvasReady,
          pdfFirstFrameTextLayerPresent,
          pdfFirstFrameHighlightLayerPresent,
          pdfFirstFramePagePreserved,
          pdfFirstFrameCanvasPreserved,
          pdfFirstFrameTextLayerPreserved,
          pdfFirstFrameHighlightLayerPreserved,
          pdfFirstFrameScrollPositionRestored,
          pdfFirstFrameNoPageWork,
          secondRoundPdfScrollModeRestored,
          secondRoundPdfScrollPositionRestored,
          secondRoundPdfVisiblePageRestored,
          secondRoundPdfFirstFrameNoPageWork,
          secondRoundPdfFirstFramePagePreserved,
          secondRoundPdfFirstFrameCanvasPreserved,
          secondRoundPdfFirstFrameTextLayerPreserved,
          secondRoundPdfFirstFrameHighlightLayerPreserved,
          noNewSourceOpen: firstRoundCounters.sourceOpens === 0,
          noNewFoliateRenderer: firstRoundCounters.rendererCreates === 0,
          noNewPdfDocument: firstRoundCounters.pdfDocumentLoads === 0,
          // 邻页预取允许在首帧之后恢复;“无新范围读取”只约束当前页首帧窗口。
          noNewRanges: firstFrameCounters.rangeReads === 0,
          suspendedResourceUsage: suspendedBefore?.usage ?? null,
          counters: firstRoundCounters,
          budget: cache.getBudget(),
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

      const pairCases = [
        [materials[0], materials[2], 'EPUB↔EPUB'],
        [materials[1], materials[3], 'Markdown↔Markdown'],
        [materials[4], materials[5], 'PDF↔PDF'],
        [materials[0], materials[4], 'EPUB↔PDF'],
        [materials[4], materials[1], 'PDF↔Markdown'],
        [materials[1], materials[0], 'Markdown↔EPUB'],
      ];
      const formatMatrix = [];
      for (const [firstMaterial, secondMaterial, label] of pairCases) {
        formatMatrix.push(await measurePair(firstMaterial, secondMaterial, label));
      }

      const measureResidentTriple = async (run) => {
        await resetHarness();
        const [firstMaterial, secondMaterial, thirdMaterial] = [materials[0], materials[1], materials[4]];
        const sequenceStarted = snapshotCounters();
        const first = await openAndWait(firstMaterial, COMMAND_IDS.libraryOpenBook);
        const second = await openAndWait(secondMaterial, COMMAND_IDS.libraryOpenBook);
        const third = await openAndWait(thirdMaterial, COMMAND_IDS.libraryOpenBook);
        const expectedViewIds = [first.viewId, second.viewId, third.viewId];
        const residentBeforeReturn = cache.getDiagnostics().entries.filter(
          (entry) => expectedViewIds.includes(entry.viewId),
        );
        const firstLocationBeforeReturn = first.book.getLocation();
        const firstWorkspaceLocationBeforeReturn = useWorkspaceStore.getState().editorGroups
          .flatMap((group) => group.views)
          .find((view) => view.id === first.viewId)?.location ?? null;
        const hitsBeforeReturn = cache.getDiagnostics().hits;
        const countersBeforeReturn = snapshotCounters();
        const returnStarted = performance.now();
        await registry.execute(COMMAND_IDS.readerActivateView, first.viewId, firstMaterial);
        await waitForInteractive(first, 'EPUB→Markdown→PDF→EPUB 回切首次可交互');
        await waitFrames(8);
        const residentAfterReturn = cache.getDiagnostics().entries.filter(
          (entry) => expectedViewIds.includes(entry.viewId),
        );
        const returnedDocument = commandModule.getReaderRuntimeDocumentForMeasurement(first.viewId);
        const firstLocationAfterReturn = first.book.getLocation();
        const firstWorkspaceLocationAfterReturn = useWorkspaceStore.getState().editorGroups
          .flatMap((group) => group.views)
          .find((view) => view.id === first.viewId)?.location ?? null;
        const returnCounters = diffCounters(countersBeforeReturn);
        const sequenceCounters = diffCounters(sequenceStarted);
        return {
          run,
          label: 'EPUB→Markdown→PDF→EPUB',
          firstFormat: first.book.format,
          secondFormat: second.book.format,
          thirdFormat: third.book.format,
          viewIds: expectedViewIds,
          firstVisibleMs: {
            epub: first.firstVisibleMs,
            markdown: second.firstVisibleMs,
            pdf: third.firstVisibleMs,
          },
          firstInteractiveMs: {
            epub: first.firstInteractiveMs,
            markdown: second.firstInteractiveMs,
            pdf: third.firstInteractiveMs,
          },
          returnInteractiveMs: performance.now() - returnStarted,
          cacheHit: cache.getDiagnostics().hits - hitsBeforeReturn === 1,
          residentBeforeReturn,
          residentAfterReturn,
          residentCountBeforeReturn: residentBeforeReturn.length,
          residentCountAfterReturn: residentAfterReturn.length,
          suspendedCountBeforeReturn: residentBeforeReturn.filter((entry) => entry.state === 'suspended').length,
          suspendedCountAfterReturn: residentAfterReturn.filter((entry) => entry.state === 'suspended').length,
          activeCountAfterReturn: residentAfterReturn.filter((entry) => entry.state === 'active').length,
          runtimeIdentityPreserved: returnedDocument === first.book,
          locationPreserved: firstLocationBeforeReturn !== null &&
            JSON.stringify(firstLocationAfterReturn) === JSON.stringify(firstLocationBeforeReturn),
          workspaceLocationPreserved: firstWorkspaceLocationBeforeReturn !== null &&
            JSON.stringify(firstWorkspaceLocationAfterReturn) === JSON.stringify(firstLocationAfterReturn),
          noNewSourceOpen: returnCounters.sourceOpens === 0,
          noNewBookDocument: returnCounters.bookDocumentCreates === 0 &&
            returnedDocument === first.book,
          noNewFoliateRenderer: returnCounters.rendererCreates === 0,
          noNewPdfDocument: returnCounters.pdfDocumentLoads === 0,
          noNewPdfPageGet: returnCounters.pdfPageGets === 0,
          noNewPdfRasterization: returnCounters.pdfRasterizations === 0,
          noNewRanges: returnCounters.rangeReads === 0,
          counters: {
            sequence: sequenceCounters,
            return: returnCounters,
          },
          budget: cache.getBudget(),
        };
      };

      const residentTripleSamples = [];
      for (let run = 0; run < requestedRuns; run += 1) {
        residentTripleSamples.push(await measureResidentTriple(run + 1));
      }
      const residentTriple = {
        label: 'EPUB→Markdown→PDF→EPUB',
        runCount: residentTripleSamples.length,
        samples: residentTripleSamples,
      };

      // 双 Editor Group 也必须遵守同一 resident 容量：拆分会生成同材料的独立
      // ReadingView，第三份材料进入时淘汰最旧的 suspended View，而不是跨组共享
      // renderer 或静默淘汰活动 Runtime。
      const measureDualGroupResident = async (run) => {
        await resetHarness();
        const first = await openAndWait(materials[0], COMMAND_IDS.libraryOpenBook);
        await registry.execute(COMMAND_IDS.workbenchSplitEditorGroupRight);
        await waitFor(
          () => useWorkspaceStore.getState().editorGroups.length === 2,
          '双组拆分完成',
        );
        const copiedViewId = useWorkspaceStore.getState().editorGroups[1]?.views[0]?.id;
        if (!copiedViewId) throw new Error('双组验收没有创建复制的 ReadingView');
        const copiedBook = commandModule.getReaderRuntimeDocumentForMeasurement(copiedViewId);
        if (!copiedBook) throw new Error('双组验收没有创建复制的 BookDocument');
        await waitForInteractive(
          { viewId: copiedViewId, book: copiedBook },
          '双组复制的 EPUB Runtime 可交互',
        );

        const second = await openAndWait(materials[1], COMMAND_IDS.libraryOpenBook);
        await registry.execute(COMMAND_IDS.workbenchFocusEditorGroup, 'group-1');
        const third = await openAndWait(materials[4], COMMAND_IDS.libraryOpenBook);
        const expectedViewIds = [first.viewId, second.viewId, third.viewId];
        const beforeReturn = cache.getDiagnostics();
        const returnedDocumentBefore = commandModule.getReaderRuntimeDocumentForMeasurement(first.viewId);
        const hitsBefore = beforeReturn.hits;
        await registry.execute(COMMAND_IDS.readerActivateView, first.viewId, materials[0]);
        await waitForInteractive(first, '双组三 resident A→B→C→A 回切');
        const afterReturn = cache.getDiagnostics();
        const returnedDocument = commandModule.getReaderRuntimeDocumentForMeasurement(first.viewId);
        return {
          run,
          label: '双 Editor Group EPUB→Markdown→PDF→EPUB',
          firstFormat: first.book.format,
          secondFormat: second.book.format,
          thirdFormat: third.book.format,
          firstViewId: first.viewId,
          copiedViewId,
          secondViewId: second.viewId,
          thirdViewId: third.viewId,
          residentCountBeforeReturn: beforeReturn.entries.length,
          residentCountAfterReturn: afterReturn.entries.length,
          activeCountAfterReturn: afterReturn.entries.filter((entry) => entry.state === 'active').length,
          copiedRuntimeIndependent: copiedBook !== first.book,
          copiedRuntimeEvicted: !afterReturn.entries.some((entry) => entry.viewId === copiedViewId),
          copiedBookStillInRuntime: commandModule.getReaderRuntimeDocumentForMeasurement(copiedViewId) !== undefined,
          cacheHit: afterReturn.hits - hitsBefore === 1,
          runtimeIdentityPreserved: returnedDocument === first.book,
          noNewBookDocument: returnedDocumentBefore === first.book && returnedDocument === returnedDocumentBefore,
          residentViewIds: afterReturn.entries.map((entry) => entry.viewId),
          expectedViewIds,
          budget: cache.getBudget(),
        };
      };

      const dualGroupResidentSamples = [];
      for (let run = 0; run < requestedRuns; run += 1) {
        dualGroupResidentSamples.push(await measureDualGroupResident(run + 1));
      }
      const dualGroupResident = {
        label: '双 Editor Group EPUB→Markdown→PDF→EPUB',
        runCount: dualGroupResidentSamples.length,
        samples: dualGroupResidentSamples,
      };

      // 双组基线会故意留下两个 Editor Group；源码模式/重启回归从干净的
      // 单组 Workspace 开始，避免旧组的活动视图污染后续命令。
      await resetHarness();
      await registry.execute(COMMAND_IDS.libraryOpenBook, materials[0]);
      await registry.execute(COMMAND_IDS.libraryOpenBook, materials[1]);

      // 在真实 Chrome 中验证 Markdown 源码模式的 Runtime 生命周期：进入源码模式
      // 后 Foliate 挂起，编辑会使旧对象失效，放弃修改并退出时按共享会话重建。
      const markdownViewId = viewIdForMaterial(materials[1].id);
      if (!markdownViewId) throw new Error('源码模式验收没有找到 Markdown ReadingView');
      // 三 resident 流程结束时 EPUB 是活动视图；源码模式只对当前活动
      // ReadingView 有意义，因此先通过正式 Command 把 Markdown 提升为 active。
      await registry.execute(COMMAND_IDS.readerActivateView, markdownViewId, materials[1]);
      const activeMarkdownDocument = commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId);
      if (!activeMarkdownDocument) throw new Error('源码模式验收没有找到活动 Markdown Runtime');
      await waitForInteractive(
        { viewId: markdownViewId, book: activeMarkdownDocument },
        '源码模式验收前 Markdown Runtime 可交互',
      );
      const sourceModeBefore = commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId);
      await registry.execute(COMMAND_IDS.markdownToggleSourceMode, markdownViewId);
      const sourceModeEntered = useWorkspaceStore.getState().editorGroups
        .flatMap((group) => group.views)
        .find((view) => view.id === markdownViewId)?.sourceMode === true;
      let sourceRuntimeSuspended = false;
      await waitFor(() => {
        sourceRuntimeSuspended =
          commandModule.getReaderRuntimeStatusForMeasurement(markdownViewId)?.status !== 'error' &&
          commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId) !== undefined &&
          cache.getEntries().some((entry) => entry.viewId === markdownViewId && entry.state === 'suspended');
        return sourceRuntimeSuspended;
      }, 'Markdown 源码模式 Runtime 挂起');
      await registry.execute(COMMAND_IDS.markdownUpdateBuffer, markdownViewId, '# 真实浏览器编辑\n\n临时正文');
      const sourceRuntimeInvalidated =
        commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId) === undefined;
      await registry.execute(COMMAND_IDS.markdownToggleSourceMode, markdownViewId);
      await registry.execute(COMMAND_IDS.markdownCloseDirty, markdownViewId, 'discard');
      await waitFor(
        () => commandModule.getReaderRuntimeStatusForMeasurement(markdownViewId)?.status === 'ready',
        'Markdown 源码模式退出后恢复阅读 Runtime',
      );
      const sourceModeRestored = useWorkspaceStore.getState().editorGroups
        .flatMap((group) => group.views)
        .find((view) => view.id === markdownViewId)?.sourceMode === false;
      const sourceRuntimeRebuilt =
        commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId) !== sourceModeBefore;

      const markdownMaterial = useLibraryStore.getState().materials.find(
        (material) => material.id === materials[1].id,
      );
      if (!markdownMaterial) throw new Error('源码模式验收没有找到当前 Markdown 材料');
      const versionBeforeSave = markdownMaterial.documentVersion;
      await registry.execute(COMMAND_IDS.markdownToggleSourceMode, markdownViewId);
      await registry.execute(
        COMMAND_IDS.markdownUpdateBuffer,
        markdownViewId,
        '# 真实浏览器保存\n\n正式正文',
      );
      await registry.execute(COMMAND_IDS.markdownSave, markdownViewId);
      const savedMarkdownMaterial = useLibraryStore.getState().materials.find(
        (material) => material.id === materials[1].id,
      );
      const formalSaveInvalidated =
        commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId) === undefined;
      const formalSaveAdvancedVersion =
        (savedMarkdownMaterial?.documentVersion ?? versionBeforeSave) > versionBeforeSave;
      await registry.execute(COMMAND_IDS.markdownToggleSourceMode, markdownViewId);
      await waitFor(
        () => commandModule.getReaderRuntimeStatusForMeasurement(markdownViewId)?.status === 'ready',
        'Markdown 正式保存后恢复阅读 Runtime',
      );

      const beforeRecovery = commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId);
      await importRepository.writeMarkdownRecovery(
        materials[1].id,
        '# 真实浏览器恢复\n\n快照正文',
        savedMarkdownMaterial?.documentVersion ?? versionBeforeSave + 1,
      );
      await registry.execute(COMMAND_IDS.markdownCheckRecoveries);
      await registry.execute(COMMAND_IDS.markdownResolveRecovery, materials[1].id, 'restore');
      const recoveryRuntimeRebuilt =
        commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId) !== beforeRecovery;
      await registry.execute(COMMAND_IDS.markdownDiscard, markdownViewId);

      // 重启只保留可序列化 Workspace；源码模式恢复时先初始化共享会话，
      // 再由用户退出源码模式创建阅读 Runtime。
      await registry.execute(COMMAND_IDS.markdownToggleSourceMode, markdownViewId);
      const restartWorkspace = structuredClone(serializeWorkspaceState());
      await waitFrames(4);
      await flushAndCloseAllReaderViews();
      cache.reset();
      useMarkdownSessionStore.getState().resetToDefault();
      useWorkspaceStore.getState().hydrate(restartWorkspace);
      await registry.execute(
        COMMAND_IDS.readerRestoreView,
        markdownViewId,
        savedMarkdownMaterial ?? markdownMaterial,
        restartWorkspace.editorGroups
          .flatMap((group) => group.views)
          .find((view) => view.id === markdownViewId)?.location ?? null,
      );
      const restartSessionLoaded =
        useMarkdownSessionStore.getState().getSession(materials[1].id)?.text ===
        '# 真实浏览器保存\n\n正式正文';
      await registry.execute(COMMAND_IDS.markdownToggleSourceMode, markdownViewId);
      await waitFor(
        () => commandModule.getReaderRuntimeStatusForMeasurement(markdownViewId)?.status === 'ready',
        'Markdown 重启后退出源码模式恢复阅读 Runtime',
      );
      await waitFrames(4);

      let firstGroupDocument = commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId);
      await registry.execute(COMMAND_IDS.workbenchSplitEditorGroupRight);
      const splitState = useWorkspaceStore.getState();
      const secondGroupViewId = splitState.editorGroups[1]?.views[0]?.id;
      if (!secondGroupViewId) throw new Error('Markdown 双 Editor Group 没有复制 ReadingView');
      await waitFor(
        () => {
          firstGroupDocument = commandModule.getReaderRuntimeDocumentForMeasurement(markdownViewId);
          const secondGroupDocument = commandModule.getReaderRuntimeDocumentForMeasurement(secondGroupViewId);
          return Boolean(firstGroupDocument?.isRuntimeReady?.() && secondGroupDocument?.isRuntimeReady?.());
        },
        'Markdown 双 Editor Group Runtime 就绪',
      );
      const secondGroupDocument = commandModule.getReaderRuntimeDocumentForMeasurement(secondGroupViewId);
      const dualGroupRuntimeIndependent =
        Boolean(firstGroupDocument && secondGroupDocument && firstGroupDocument !== secondGroupDocument);
      const sharedSessionPresent =
        useMarkdownSessionStore.getState().getSession(materials[1].id)?.text ===
        '# 真实浏览器保存\n\n正式正文';
      // LRU 淘汰在 ReaderRuntimeCache 公共 seam 上验证，避免为门禁额外打开
      // 第三份真实 renderer，减少浏览器分页器的并发噪声。
      const evictionProbe = new readerRuntimeCacheModule.ReaderRuntimeCache({
        budget: { ...cache.getBudget(), maxSuspendedRuntimes: 1 },
      });
      const probeEntry = (viewId) => ({
        viewId,
        materialId: `probe-${viewId}`,
        format: 'markdown',
        key: `probe-key-${viewId}`,
        document: { viewId },
        usage: {
          iframeCount: 0,
          canvasCount: 0,
          decodedPageCount: 0,
          rangeCacheBytes: 0,
          estimatedBytes: 0,
        },
      });
      evictionProbe.suspend(probeEntry('a'));
      evictionProbe.suspend(probeEntry('b'));
      const runtimeEvictionObserved = evictionProbe.getDiagnostics().evictions === 1;

      await waitFrames(4);
      await flushAndCloseAllReaderViews();
      // Harness 显式拥有注入的缓存实例；页面正式 App 也注册了自己的缓存，
      // 因此总验收 teardown 直接清空本实例，避免模块级注册指针的测试顺序干扰。
      cache.clear();
      await waitFrames();
      const shutdownCleanup = {
        runtimeStoreEmpty: useReaderRuntime.getState().documents.size === 0,
        cacheEmpty: cache.getEntries().length === 0,
        noOrphanReaderDom: document.querySelectorAll('.pdf-page, foliate-view').length === 0,
        workspaceStateSerializable: (() => {
          try {
            JSON.stringify(serializeWorkspaceState());
            return true;
          } catch {
            return false;
          }
        })(),
      };
      return {
        schemaVersion: 'reader-runtime-cache.v5',
        issue: 62,
        inheritedFromIssue: 61,
        inheritedFromIssues: [61, 60, 57],
        status: 'measured',
        runCount: requestedRuns,
        samples,
        formatMatrix,
        residentTriple,
        dualGroupResident,
        shutdownCleanup,
        sourceMode: {
          entered: sourceModeEntered,
          runtimeSuspended: sourceRuntimeSuspended,
          runtimeInvalidated: sourceRuntimeInvalidated,
          restored: sourceModeRestored,
          runtimeRebuilt: sourceRuntimeRebuilt,
          formalSaveInvalidated,
          formalSaveAdvancedVersion,
          recoveryRuntimeRebuilt,
          restartSessionLoaded,
          dualGroupRuntimeIndependent,
          sharedSessionPresent,
          runtimeEvictionObserved,
        },
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
      formatMatrixCovered: result.formatMatrix.length === 6,
      everyFormatPairHitsCache: result.formatMatrix.every((pair) => pair.cacheHit),
      everyFormatPairPreservesLocation: result.formatMatrix.every((pair) => pair.locationPreserved),
      everyFormatPairPreservesWorkspaceLocation: result.formatMatrix.every((pair) => pair.workspaceLocationPreserved),
      everyFormatPairAvoidsNewSource: result.formatMatrix.every((pair) => pair.noNewSourceOpen),
      everyFormatPairAvoidsNewRenderer: result.formatMatrix.every((pair) => pair.noNewFoliateRenderer),
      everyFormatPairAvoidsNewPdfDocument: result.formatMatrix.every((pair) => pair.noNewPdfDocument),
      everyFormatPairAvoidsNewRanges: result.formatMatrix.every((pair) => pair.noNewRanges),
      everyPdfPairCompletesSecondRound: result.formatMatrix
        .filter((pair) => pair.firstFormat === 'pdf')
        .every((pair) =>
          pair.secondRoundCacheHit === true &&
          pair.secondRoundLocationPreserved === true &&
          pair.secondRoundWorkspaceLocationPreserved === true &&
          pair.secondRoundCounters?.sourceOpens === 0 &&
          pair.secondRoundCounters?.rendererCreates === 0 &&
          pair.secondRoundCounters?.pdfDocumentLoads === 0 &&
          pair.secondRoundCounters?.rangeReads === 0,
        ),
      sameFormatPairsCovered: result.formatMatrix
        .filter((pair) => pair.firstFormat === pair.secondFormat)
        .length === 3,
      mixedFormatPairsCovered: result.formatMatrix
        .filter((pair) => pair.firstFormat !== pair.secondFormat)
        .length === 3,
      pdfSuspendedUsageWithinBudget: result.formatMatrix
        .filter((pair) => pair.firstFormat === 'pdf')
        .every((pair) =>
          pair.suspendedResourceUsage !== null &&
          pair.suspendedResourceUsage.canvasCount <= pair.budget.maxSuspendedCanvases &&
          pair.suspendedResourceUsage.decodedPageCount <= pair.budget.maxSuspendedDecodedPages &&
          (pair.suspendedResourceUsage.inFlightRangeReadCount ?? 0) === 0,
        ),
      everyPdfPairRestoresScrollableContainer: result.formatMatrix
        .filter((pair) => pair.firstFormat === 'pdf')
        .every((pair) =>
          pair.pdfScrollModeRestored === true &&
          pair.pdfScrollPositionRestored === true &&
          pair.pdfVisiblePageRestored === true &&
          pair.pdfScrollAdvancedAfterReturn === true &&
          pair.secondRoundPdfScrollModeRestored === true &&
          pair.secondRoundPdfScrollPositionRestored === true &&
          pair.secondRoundPdfVisiblePageRestored === true,
        ),
      everyPdfPairRestoresPdfFirstFrame: result.formatMatrix
        .filter((pair) => pair.firstFormat === 'pdf')
        .every((pair) =>
          pair.pdfFirstFrameCurrentPagePresent === true &&
          pair.pdfFirstFrameCanvasReady === true &&
          pair.pdfFirstFrameTextLayerPresent === true &&
          pair.pdfFirstFrameHighlightLayerPresent === true &&
          pair.pdfFirstFramePagePreserved === true &&
          pair.pdfFirstFrameCanvasPreserved === true &&
          pair.pdfFirstFrameTextLayerPreserved === true &&
          pair.pdfFirstFrameHighlightLayerPreserved === true &&
          pair.pdfFirstFrameScrollPositionRestored === true &&
          pair.pdfFirstFrameNoPageWork === true,
        ),
      everyPdfPairRestoresSecondPdfFirstFrame: result.formatMatrix
        .filter((pair) => pair.firstFormat === 'pdf')
        .every((pair) =>
          pair.secondRoundPdfFirstFrameNoPageWork === true &&
          pair.secondRoundPdfFirstFramePagePreserved === true &&
          pair.secondRoundPdfFirstFrameCanvasPreserved === true &&
          pair.secondRoundPdfFirstFrameTextLayerPreserved === true &&
          pair.secondRoundPdfFirstFrameHighlightLayerPreserved === true,
        ),
      shutdownCleanup: result.shutdownCleanup.runtimeStoreEmpty &&
        result.shutdownCleanup.cacheEmpty &&
        result.shutdownCleanup.noOrphanReaderDom &&
        result.shutdownCleanup.workspaceStateSerializable,
      sourceModeLifecycle: result.sourceMode.entered &&
        result.sourceMode.runtimeSuspended &&
        result.sourceMode.runtimeInvalidated &&
        result.sourceMode.restored &&
        result.sourceMode.runtimeRebuilt &&
        result.sourceMode.formalSaveInvalidated &&
        result.sourceMode.formalSaveAdvancedVersion &&
        result.sourceMode.recoveryRuntimeRebuilt &&
        result.sourceMode.restartSessionLoaded &&
        result.sourceMode.dualGroupRuntimeIndependent &&
        result.sourceMode.sharedSessionPresent &&
        result.sourceMode.runtimeEvictionObserved,
      residentTripleCovered: result.residentTriple.label === 'EPUB→Markdown→PDF→EPUB' &&
        result.residentTriple.runCount >= 3 &&
        result.residentTriple.samples.every((sample) =>
          sample.firstFormat === 'epub' &&
          sample.secondFormat === 'markdown' &&
          sample.thirdFormat === 'pdf',
        ),
      residentTripleKeepsThreeResidents: result.residentTriple.samples.every((sample) =>
        sample.residentCountBeforeReturn === 3 &&
        sample.residentCountAfterReturn === 3 &&
        sample.suspendedCountBeforeReturn === 2 &&
        sample.suspendedCountAfterReturn === 2 &&
        sample.activeCountAfterReturn === 1,
      ),
      residentTripleCacheHit: result.residentTriple.samples.every((sample) =>
        sample.cacheHit &&
        sample.runtimeIdentityPreserved &&
        sample.locationPreserved &&
        sample.workspaceLocationPreserved,
      ),
      residentTripleInitialMetrics: result.residentTriple.samples.every((sample) =>
        sample.counters.sequence.sourceOpens >= 3 &&
        sample.counters.sequence.rendererCreates >= 2 &&
        sample.counters.sequence.pdfDocumentLoads >= 1 &&
        sample.counters.sequence.pdfPageGets >= 1 &&
        sample.counters.sequence.pdfRasterizations >= 1 &&
        sample.counters.sequence.rangeReads >= 1,
      ),
      residentTripleCacheHitCreatesNoReaderObjects: result.residentTriple.samples.every((sample) =>
        sample.noNewSourceOpen &&
        sample.noNewBookDocument &&
        sample.noNewFoliateRenderer &&
        sample.noNewPdfDocument &&
        sample.noNewPdfPageGet &&
        sample.noNewPdfRasterization &&
        sample.noNewRanges,
      ),
      dualGroupResidentCovered: result.dualGroupResident.label ===
        '双 Editor Group EPUB→Markdown→PDF→EPUB' &&
        result.dualGroupResident.runCount >= 3 &&
        result.dualGroupResident.samples.every((sample) =>
          sample.firstFormat === 'epub' &&
          sample.secondFormat === 'markdown' &&
          sample.thirdFormat === 'pdf',
        ),
      dualGroupResidentKeepsCapacityAndActiveLimit: result.dualGroupResident.samples.every((sample) =>
        sample.residentCountBeforeReturn === 3 &&
        sample.residentCountAfterReturn === 3 &&
        sample.activeCountAfterReturn === 2 &&
        sample.residentViewIds.includes(sample.firstViewId) &&
        sample.residentViewIds.includes(sample.secondViewId) &&
        sample.residentViewIds.includes(sample.thirdViewId),
      ),
      dualGroupResidentSeparatesAndEvictsCopiedView: result.dualGroupResident.samples.every((sample) =>
        sample.copiedRuntimeIndependent === true &&
        sample.copiedRuntimeEvicted === true &&
        sample.copiedBookStillInRuntime === false,
      ),
      dualGroupResidentCacheHitPreservesRuntime: result.dualGroupResident.samples.every((sample) =>
        sample.cacheHit === true &&
        sample.runtimeIdentityPreserved === true &&
        sample.noNewBookDocument === true,
      ),
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
      console.error(`Reader Runtime 缓存附加验收详情:${JSON.stringify(result.sourceMode)}`);
      console.error(`Reader Runtime 格式矩阵详情:${JSON.stringify(result.formatMatrix)}`);
      throw new Error(`Reader Runtime 缓存门禁失败:${JSON.stringify(checks)}`);
    }
    mkdirSync('scripts/artifacts', { recursive: true });
    writeFileSync(ARTIFACT, JSON.stringify(result, null, 2));
    console.log('Reader Runtime 缓存真实浏览器基线结果:');
    console.log(JSON.stringify(result, null, 2));
    console.log(`报告:${ARTIFACT}`);
    console.log('通过:三 resident 单组/双组回切、按 View 隔离的 LRU 淘汰、PDF 首帧复用及既有格式矩阵均符合门禁。');
  } catch (error) {
    failureReport = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await flushRuntimeInPage(appPage);
    appPage = null;
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
  dev.kill();
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
