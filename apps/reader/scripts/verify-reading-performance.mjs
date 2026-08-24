/**
 * 工单 #46:真实大型 PDF 首屏性能门禁。
 *
 * 默认运行浏览器降级基线和完整 Reader Command + ManagedFileSource 路径:
 *   pnpm test:reading-performance
 *
 * Windows Tauri 生产范围协议验收需要先以 WebView2 远程调试端口启动 Tauri:
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
 *   pnpm tauri dev
 *   $env:READING_PERFORMANCE_MODE='tauri'
 *   $env:READING_PERFORMANCE_TAURI_DEBUG_URL='http://127.0.0.1:9222'
 *   $env:READING_PERFORMANCE_PDF_PATH='C:\\private\\large-sample.pdf'
 *   pnpm test:reading-performance
 *
 * 性能夹具在浏览器中确定性生成;外部样本只能通过显式本地路径接入,路径和正文
 * 均不写入报告。所有阶段都在 finally 中关闭文档、浏览器、Vite 和样本服务器。
 */
import { createServer } from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const APP_URL = process.env.READING_PERFORMANCE_APP_URL ?? 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MODE = process.env.READING_PERFORMANCE_MODE ?? 'browser';
const TAURI_DEBUG_URL = process.env.READING_PERFORMANCE_TAURI_DEBUG_URL ?? '';
const LOCAL_PDF_PATH = process.env.READING_PERFORMANCE_PDF_PATH ?? '';
const RUN_COUNT = parsePositiveInteger(process.env.READING_PERFORMANCE_RUNS ?? '3', '测量次数');
const OUTPUT = resolve(
  process.env.READING_PERFORMANCE_OUTPUT ?? 'scripts/artifacts/reading-performance.json',
);

const EXPECTED_FIXTURE_PAGE_COUNT = 640;
const EXPECTED_FIXTURE_CONTENT_BYTES_PER_PAGE = 16 * 1024;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_READ_RATIO = 1.1;
const MAX_PEAK_MEMORY_BYTES = 512 * 1024 * 1024;

let devServerProcess = null;
let sampleServer = null;
let browser = null;
let connectedToExternalBrowser = false;
let failureReport = null;

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label}必须是正整数`);
  }
  return parsed;
}

function waitForServer(url, timeoutMs = 30_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolvePromise();
          return;
        }
      } catch {
        /* 服务仍在启动。 */
      }
      if (Date.now() - started > timeoutMs) {
        rejectPromise(new Error(`服务未在 ${timeoutMs}ms 内启动:${url.replace(/:\d+\b/, ':<port>')}`));
        return;
      }
      setTimeout(poll, 300);
    };
    poll();
  });
}

async function startSampleServer(filePath) {
  const stats = statSync(filePath);
  if (!stats.isFile()) throw new Error('READING_PERFORMANCE_PDF_PATH 不是文件');

  const server = createServer((request, response) => {
    if (request.url !== '/sample.pdf') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'no-store');
    const rangeHeader = request.headers.range;
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? '');
    if (!match) {
      response.setHeader('Content-Length', stats.size);
      createReadStream(filePath).pipe(response);
      return;
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : stats.size - 1;
    const end = Math.min(requestedEnd, stats.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stats.size) {
      response.writeHead(416).end();
      return;
    }
    response.statusCode = 206;
    response.setHeader('Content-Length', end - start + 1);
    response.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    createReadStream(filePath, { start, end }).pipe(response);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  sampleServer = server;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('样本服务器地址不可用');
  return `http://127.0.0.1:${address.port}/sample.pdf`;
}

async function launchBrowser() {
  if (MODE === 'tauri') {
    if (!TAURI_DEBUG_URL) {
      throw new Error('Tauri 模式必须设置 READING_PERFORMANCE_TAURI_DEBUG_URL');
    }
    browser = await puppeteer.connect({ browserURL: TAURI_DEBUG_URL });
    connectedToExternalBrowser = true;
    const pages = await browser.pages();
    for (const candidate of pages) {
      try {
        if (await candidate.evaluate(() => Boolean(window.__TAURI_INTERNALS__))) {
          return candidate;
        }
      } catch {
        /* 不是目标 WebView 页面。 */
      }
    }
    throw new Error('远程调试浏览器中没有找到 Tauri WebView 页面');
  }

  devServerProcess = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['dev', '--host'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  await waitForServer(APP_URL);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--enable-precise-memory-info',
    ],
  });
  return browser.newPage();
}

async function closeSampleServer() {
  if (!sampleServer) return;
  const server = sampleServer;
  sampleServer = null;
  await new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function killDevServer() {
  if (!devServerProcess) return;
  const processToKill = devServerProcess;
  devServerProcess = null;
  if (process.platform !== 'win32') {
    processToKill.kill();
    return;
  }
  try {
    execSync(`taskkill /F /T /PID ${processToKill.pid}`, { stdio: 'ignore' });
  } catch {
    /* 进程已经退出。 */
  }
}

async function closeBrowser() {
  if (!browser) return;
  const current = browser;
  browser = null;
  if (connectedToExternalBrowser) {
    current.disconnect();
    connectedToExternalBrowser = false;
  } else {
    await current.close();
  }
}

function writeFailureArtifact(error) {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(
    OUTPUT,
    `${JSON.stringify(
      {
        schemaVersion: 'reading-performance.v2',
        issue: 46,
        status: 'failed',
        mode: MODE,
        fixture: LOCAL_PDF_PATH ? 'explicit-local-path' : 'deterministic-generated',
        error: sanitizeError(error),
        cleanup: {
          devServerClosed: devServerProcess === null,
          sampleServerClosed: sampleServer === null,
          browserClosed: browser === null,
        },
      },
      null,
      2,
    )}\n`,
  );
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (LOCAL_PDF_PATH ? message.replaceAll(LOCAL_PDF_PATH, '<explicit-local-pdf>') : message)
    .replaceAll(/%PDF-[\s\S]{0,120}/g, '<pdf-content-redacted>')
    .slice(0, 2000);
}

async function main() {
  if (MODE !== 'browser' && MODE !== 'tauri') {
    throw new Error(`READING_PERFORMANCE_MODE 不支持:${MODE}`);
  }
  if (MODE === 'tauri' && !LOCAL_PDF_PATH) {
    throw new Error('Tauri 模式必须通过 READING_PERFORMANCE_PDF_PATH 指定本地 PDF');
  }
  if (LOCAL_PDF_PATH) {
    sampleServer = null;
    statSync(LOCAL_PDF_PATH);
  }

  const page = await launchBrowser();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(sanitizeError(error)));
  if (MODE === 'browser') {
    const sampleUrl = LOCAL_PDF_PATH ? await startSampleServer(LOCAL_PDF_PATH) : null;
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${APP_URL}?prototype=workbench`, { waitUntil: 'networkidle0' });
    const result = await page.evaluate(runPerformanceMeasurements, {
      mode: MODE,
      sampleUrl,
      runCount: RUN_COUNT,
      expectedPageCount: EXPECTED_FIXTURE_PAGE_COUNT,
      expectedContentBytesPerPage: EXPECTED_FIXTURE_CONTENT_BYTES_PER_PAGE,
      maxRangeBytes: MAX_RANGE_BYTES,
      maxTotalReadRatio: MAX_TOTAL_READ_RATIO,
      maxPeakMemoryBytes: MAX_PEAK_MEMORY_BYTES,
    });
    if (pageErrors.length > 0) throw new Error(`页面错误:${pageErrors.join('; ')}`);
    const browserDescription = await getBrowserDescription();
    await closeBrowser();
    await closeSampleServer();
    killDevServer();
    const output = {
      ...result,
      recordedAt: new Date().toISOString(),
      browser: browserDescription,
      cleanup: { devServerClosed: true, sampleServerClosed: true, browserClosed: true },
    };
    writeReport(output);
    printSummary(output);
    return;
  }

  await page.bringToFront();
  const tauriPageUrl = new URL(await page.url());
  tauriPageUrl.searchParams.set('prototype', 'workbench');
  await page.goto(tauriPageUrl.toString(), { waitUntil: 'networkidle0' });
  const result = await page.evaluate(runPerformanceMeasurements, {
    mode: MODE,
    sampleUrl: null,
    localPdfPath: LOCAL_PDF_PATH,
    runCount: RUN_COUNT,
    expectedPageCount: EXPECTED_FIXTURE_PAGE_COUNT,
    expectedContentBytesPerPage: EXPECTED_FIXTURE_CONTENT_BYTES_PER_PAGE,
    maxRangeBytes: MAX_RANGE_BYTES,
    maxTotalReadRatio: MAX_TOTAL_READ_RATIO,
    maxPeakMemoryBytes: MAX_PEAK_MEMORY_BYTES,
  });
  if (pageErrors.length > 0) throw new Error(`Tauri WebView 页面错误:${pageErrors.join('; ')}`);
  const browserDescription = await getBrowserDescription();
  await closeBrowser();
  killDevServer();
  const output = {
    ...result,
    recordedAt: new Date().toISOString(),
    browser: browserDescription,
    cleanup: { devServerClosed: true, sampleServerClosed: true, browserClosed: true },
  };
  writeReport(output);
  printSummary(output);
}

async function getBrowserDescription() {
  if (!browser) return null;
  try {
    return await browser.version();
  } catch {
    return null;
  }
}

function writeReport(result) {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
}

function printSummary(result) {
  const managed = result.summary?.managed;
  const direct = result.summary?.directFile;
  console.log('大型 PDF 首屏性能验收结果:');
  console.log(
    JSON.stringify(
      {
        mode: result.mode,
        fixture: result.fixture,
        directFileMedianFirstVisibleMs: direct?.medianFirstVisibleMs ?? null,
        managedMedianFirstVisibleMs: managed?.medianFirstVisibleMs ?? null,
        managedToDirectMedianRatio: result.checks?.managedToDirectMedianRatio ?? null,
        pdfDocumentLoadsPerRun: result.checks?.pdfDocumentLoadsPerRun ?? null,
        maxRangeBytes: result.checks?.maxRangeBytes ?? null,
        totalReadRatio: result.checks?.maxTotalReadRatio ?? null,
        cleanup: result.cleanup,
      },
      null,
      2,
    ),
  );
  console.log(`记录: ${OUTPUT}`);
  console.log('通过: 首屏包含有效 Canvas 与文字层/无文字状态,打开只创建一份 PDF.js 文档,范围读取与滚动窗口均未读取整本文件。');
}

/** 运行在真实 Chrome 或 Tauri WebView 内的性能测量函数。 */
async function runPerformanceMeasurements(config) {
  const {
    mode,
    sampleUrl,
    localPdfPath,
    runCount,
    expectedPageCount,
    expectedContentBytesPerPage,
    maxRangeBytes,
    maxTotalReadRatio,
    maxPeakMemoryBytes,
  } = config;
  const [
    { ManagedFileSource },
    { createAppServices },
    { createInMemoryFilePicker },
    { COMMAND_IDS },
    { mountViewDocument, flushAndCloseAllReaderViews },
    { useReaderRuntime },
    { useWorkspaceStore },
    { createInMemoryImportRepository, addInMemorySource },
    { EpubBookDocument },
    { createFoliateViewHostFactory },
    { PdfBookDocument },
    { buildLargeEpubFixture },
    { buildLargePdfFixture },
    { loadPdfLib },
    { inspectPdf },
    { createPdfSourceFromBytes },
    { MANAGED_RANGE_PROTOCOL_ORIGIN },
  ] = await Promise.all([
    import('/src/domain/library/managedFileSource.ts'),
    import('/src/app/bootstrap.ts'),
    import('/src/app/filePicker.ts'),
    import('/src/commands/commandRegistry.ts'),
    import('/src/workbench/readerCommands.ts'),
    import('/src/workbench/readerRuntime.ts'),
    import('/src/workbench/workspaceStore.ts'),
    import('/src/domain/library/inMemoryImportRepository.ts'),
    import('/src/domain/reader/epubBookDocument.ts'),
    import('/src/domain/reader/foliateViewHost.ts'),
    import('/src/domain/reader/pdf/pdfBookDocument.ts'),
    import('/src/test/fixtures/epub/epubFixtures.ts'),
    import('/src/test/fixtures/pdf/pdfFixtures.ts'),
    import('/src/domain/reader/pdf/pdfLibrary.ts'),
    import('/src/domain/reader/pdf/pdfInspector.ts'),
    import('/src/domain/reader/pdf/pdfLibrary.ts'),
    import('/src/domain/library/managedRangeProtocol.ts'),
  ]);

  const isTauri = Boolean(window.__TAURI_INTERNALS__);
  if (mode === 'tauri' && !isTauri) throw new Error('Tauri 性能模式没有运行在 Tauri WebView');
  if (mode === 'tauri' && !/windows|win32/i.test(`${navigator.userAgent} ${navigator.platform}`)) {
    throw new Error('Tauri 生产范围性能门禁只允许 Windows WebView');
  }

  // page.evaluate 只会序列化传入的函数,所以性能测量使用的全部 helper
  // 必须定义在这个浏览器侧闭包内,不能依赖 Node 侧同名函数。
  function createRangeTracker() {
    const tracker = {
      ranges: [],
      totalReadBytes: 0,
      fileSize: 0,
      inFlightBytes: 0,
      peakInFlightBytes: 0,
      phasePeakInFlightBytes: 0,
      phasePeakHeapBytes: null,
      pdfDocumentLoads: 0,
      pageGets: 0,
      phaseTotalBytes: 0,
      phaseTotalRequests: 0,
      phaseLargestRange: 0,
      binaryRangeResponses: 0,
      nonBinaryRangeResponses: 0,
      startPhase() {
        this.phasePeakInFlightBytes = 0;
        this.phasePeakHeapBytes = null;
        this.phaseTotalBytes = 0;
        this.phaseTotalRequests = 0;
        this.phaseLargestRange = 0;
        this.sampleMemory();
      },
      record(offset, length) {
        this.ranges.push({ offset, length });
        this.totalReadBytes += length;
        this.phaseTotalBytes += length;
        this.phaseTotalRequests += 1;
        this.phaseLargestRange = Math.max(this.phaseLargestRange, length);
        this.inFlightBytes += length;
        this.peakInFlightBytes = Math.max(this.peakInFlightBytes, this.inFlightBytes);
        this.phasePeakInFlightBytes = Math.max(this.phasePeakInFlightBytes, this.inFlightBytes);
        this.sampleMemory();
        queueMicrotask(() => {
          this.inFlightBytes -= length;
          this.sampleMemory();
        });
      },
      sampleMemory() {
        const heapBytes = performance.memory?.usedJSHeapSize;
        if (typeof heapBytes === 'number') {
          this.phasePeakHeapBytes = Math.max(this.phasePeakHeapBytes ?? 0, heapBytes);
        }
      },
      finishPhase(values) {
        this.sampleMemory();
        return {
          elapsedMs: values.elapsedMs ?? values.firstVisibleMs ?? 0,
          firstVisibleMs: values.firstVisibleMs ?? null,
          cumulativeReadBytes: this.phaseTotalBytes,
          requestCount: this.phaseTotalRequests,
          maxRangeBytes: this.phaseLargestRange,
          peakInFlightBytes: this.phasePeakInFlightBytes,
          peakMemoryBytes: this.phasePeakHeapBytes,
          memorySampleAvailable: this.phasePeakHeapBytes !== null,
        };
      },
      finishTotal(fileSize, rangeLimit) {
        this.fileSize = fileSize;
        const maxObservedRange = Math.max(0, ...this.ranges.map((range) => range.length));
        return {
          cumulativeReadBytes: this.totalReadBytes,
          requestCount: this.ranges.length,
          maxRangeBytes: maxObservedRange,
          readRatio: fileSize > 0 ? this.totalReadBytes / fileSize : null,
          maxPeakInFlightBytes: this.peakInFlightBytes,
          noOversizedRange: maxObservedRange <= rangeLimit,
        };
      },
    };
    return tracker;
  }

  function instrumentPdfLib(pdfLib, tracker) {
    return new Proxy(pdfLib, {
      get(target, property, receiver) {
        if (property === 'getDocument') {
          return (options) => {
            tracker.pdfDocumentLoads += 1;
            const loadingTask = target.getDocument(options);
            return {
              promise: loadingTask.promise.then((pdfDocument) => new Proxy(pdfDocument, {
                get(documentTarget, documentProperty, documentReceiver) {
                  if (documentProperty === 'getPage') {
                    return async (pageNumber) => {
                      tracker.pageGets += 1;
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
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  function installManagedFetchTracker(origin, tracker) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const inputUrl = typeof input === 'string' ? input : input?.url ?? String(input);
      if (inputUrl.startsWith(origin)) {
        const query = new URL(inputUrl).searchParams;
        tracker.record(Number(query.get('offset')), Number(query.get('length')));
      }
      const response = await originalFetch(input, init);
      if (inputUrl.startsWith(origin)) {
        if (response.headers.get('content-type')?.toLowerCase().includes('application/octet-stream')) {
          tracker.binaryRangeResponses += 1;
        } else {
          tracker.nonBinaryRangeResponses += 1;
        }
      }
      return response;
    };
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  function makeContainer(className) {
    const container = document.createElement('div');
    container.className = className;
    Object.assign(container.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '900px',
      height: '760px',
      visibility: 'visible',
    });
    document.body.append(container);
    return container;
  }

  async function waitFor(predicate, label, timeoutMs = 45_000) {
    const started = performance.now();
    while (!predicate()) {
      if (performance.now() - started > timeoutMs) throw new Error(`等待${label}超时`);
      await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    }
  }

  function hasValidVisiblePage(container, pageNumber) {
    const page = container.querySelector(`.pdf-page[data-page="${pageNumber}"]`);
    const canvas = page?.querySelector('canvas');
    if (!(page instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return false;
    if (canvas.width <= 0 || canvas.height <= 0 || page.dataset.textSelectable === 'pending') return false;
    const context = canvas.getContext('2d');
    if (!context) return false;
    const sampleWidth = Math.max(1, Math.min(canvas.width, 8));
    const sampleHeight = Math.max(1, Math.min(canvas.height, 8));
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const x = Math.min(canvas.width - 1, Math.floor((column / 7) * (canvas.width - sampleWidth)));
        const y = Math.min(canvas.height - 1, Math.floor((row / 7) * (canvas.height - sampleHeight)));
        const pixels = context.getImageData(x, y, sampleWidth, sampleHeight).data;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index] !== 0 || pixels[index + 1] !== 0 || pixels[index + 2] !== 0 || pixels[index + 3] !== 0) return true;
        }
      }
    }
    return false;
  }

  function countActiveCanvases(container) {
    return [...container.querySelectorAll('.pdf-page canvas')]
      .filter((canvas) => canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0)
      .length;
  }

  function validateMemory(phases, memoryLimit) {
    for (const phase of phases) {
      if (phase.memorySampleAvailable && phase.peakMemoryBytes > memoryLimit) {
        throw new Error(`阶段峰值 JS 内存超过 ${memoryLimit} 字节`);
      }
    }
  }

  async function measureBook({ book, container, tracker, fileSize, rangeLimit, memoryLimit }) {
    tracker.startPhase();
    const started = performance.now();
    await book.open(container);
    await waitFor(() => hasValidVisiblePage(container, book.getCurrentIndex()), 'PDF File 首屏');
    const open = tracker.finishPhase({ firstVisibleMs: performance.now() - started });
    open.activeCanvasCount = countActiveCanvases(container);

    tracker.startPhase();
    const nextStarted = performance.now();
    await book.next();
    await waitFor(() => book.getCurrentIndex() === 2 && hasValidVisiblePage(container, 2), 'PDF File 第二页');
    const nextPage = tracker.finishPhase({ elapsedMs: performance.now() - nextStarted });
    nextPage.activeCanvasCount = countActiveCanvases(container);

    tracker.startPhase();
    const scrollStarted = performance.now();
    book.applyTypography({ fontFamily: 'sansSerif', fontSize: 18, lineHeight: 1.6, margin: 48, gap: 7, flow: 'scrolled', theme: 'light' });
    await waitFor(() => container.querySelectorAll('.pdf-page-placeholder').length === book.getPageCount(), 'PDF File 滚动占位');
    const target = container.querySelector('[data-page="320"]');
    if (!(target instanceof HTMLElement)) throw new Error('PDF File 滚动第 320 页占位不存在');
    const targetScrollTop = Number.parseFloat(target.style.top);
    const getsBeforeJump = tracker.pageGets;
    await book.goToLocation({ kind: 'pdf', page: 320, scrollTop: Number.isFinite(targetScrollTop) ? targetScrollTop : 0, zoom: 100, fit: 'width' });
    await waitFor(() => book.getCurrentIndex() === 320 && hasValidVisiblePage(container, 320), 'PDF File 滚动位置');
    const scrollFirstVisibleMs = performance.now() - scrollStarted;
    const scrollWindow = tracker.finishPhase({ elapsedMs: scrollFirstVisibleMs, firstVisibleMs: scrollFirstVisibleMs });
    scrollWindow.activeCanvasCount = countActiveCanvases(container);
    scrollWindow.pageGetsForJump = tracker.pageGets - getsBeforeJump;
    const total = tracker.finishTotal(fileSize, rangeLimit);
    validateMemory([open, nextPage, scrollWindow], memoryLimit);
    if (scrollWindow.activeCanvasCount > 12) throw new Error(`PDF File 滚动活跃 Canvas 超过 12:${scrollWindow.activeCanvasCount}`);
    if (scrollWindow.pageGetsForJump >= 20) throw new Error(`PDF File 滚动跳页取得页面过多:${scrollWindow.pageGetsForJump}`);
    return { pageCount: book.getPageCount(), pdfDocumentLoads: tracker.pdfDocumentLoads, phases: { open, nextPage, scrollWindow }, scrollWindow, total, memorySampleAvailable: [open, nextPage, scrollWindow].some((phase) => phase.memorySampleAvailable), firstVisibleMs: open.firstVisibleMs };
  }

  async function measureDirectFile({ PdfBookDocument, loadPdfLib: getPdfLib, pdfBytes, maxRangeBytes: rangeLimit, maxPeakMemoryBytes: memoryLimit }) {
    const tracker = createRangeTracker();
    const file = new File([pdfBytes], 'direct-file-baseline.pdf', { type: 'application/pdf' });
    const source = {
      size: file.size,
      slice(begin = 0, end = file.size) {
        const blob = file.slice(begin, end);
        return { arrayBuffer: async () => { const bytes = await blob.arrayBuffer(); tracker.record(begin, bytes.byteLength); return bytes; } };
      },
    };
    const book = new PdfBookDocument({ source, metadata: { title: '浏览器 File 基线', author: null, language: 'zh' }, pdfLib: instrumentPdfLib(await getPdfLib(), tracker) });
    const container = makeContainer('pdf-performance-direct-file');
    try {
      return await measureBook({ book, container, tracker, fileSize: pdfBytes.byteLength, rangeLimit, memoryLimit });
    } finally {
      book.close();
      container.remove();
    }
  }

  async function measureReaderCommand({
    mode: scenarioMode,
    ManagedFileSource: Source,
    createAppServices: makeServices,
    createInMemoryFilePicker: makeFilePicker,
    createInMemoryImportRepository: makeRepository,
    addInMemorySource: addSource,
    loadPdfLib: getPdfLib,
    pdfBytes: bytes,
    localPdfPath: path,
    materialId: targetMaterialId,
    MANAGED_RANGE_PROTOCOL_ORIGIN: managedOrigin,
    COMMAND_IDS: ids,
    mountViewDocument: mount,
    flushAndCloseAllReaderViews: flush,
    useReaderRuntime: runtime,
    useWorkspaceStore: workspace,
    maxRangeBytes: rangeLimit,
    maxPeakMemoryBytes: memoryLimit,
  }) {
    const tracker = createRangeTracker();
    const pdfLib = instrumentPdfLib(await getPdfLib(), tracker);
    let services;
    let material;
    let restoreFetch = () => undefined;
    let transport = 'browser-managed-source';
    if (scenarioMode === 'tauri') {
      restoreFetch = installManagedFetchTracker(managedOrigin, tracker);
      services = makeServices({ pdfLib });
      material = (await services.importRepository.listMaterials()).find((candidate) => candidate.id === targetMaterialId);
      if (!material) throw new Error(`Tauri 书库中没有刚导入的 PDF:${path ? '<explicit-local-pdf>' : '<sample>'}`);
      transport = 'windows-managed-range';
    } else {
      const sources = new Map();
      addSource(sources, 'performance.pdf', bytes);
      const baseRepository = makeRepository(sources);
      const staged = await baseRepository.stageImport('performance.pdf');
      material = await baseRepository.commitImport(staged, { title: '大型 PDF 性能样本', author: null, language: 'zh' });
      const openManagedFileSource = baseRepository.openManagedFileSource.bind(baseRepository);
      baseRepository.openManagedFileSource = async (materialId) => {
        const source = await openManagedFileSource(materialId);
        return new Source({ name: source.name, size: source.size, type: source.type }, async (offset, length) => {
          const range = await source.readRange(offset, length);
          tracker.record(offset, range.byteLength);
          return range;
        });
      };
      services = makeServices({ importRepository: baseRepository, filePicker: makeFilePicker([]), pdfLib });
    }
    workspace.getState().resetToDefault();
    runtime.setState({ documents: new Map(), documentStates: new Map() });
    const container = makeContainer('pdf-performance-reader-command');
    let viewId = null;
    try {
      tracker.startPhase();
      const firstVisibleStarted = performance.now();
      await services.commands.execute(ids.libraryOpenBook, material);
      viewId = workspace.getState().editorGroups[0]?.activeViewId ?? null;
      if (!viewId) throw new Error('library.openBook 没有创建活动阅读视图');
      const book = runtime.getState().getDocument(viewId);
      if (!book) throw new Error('library.openBook 没有创建 BookDocument');
      mount(book, viewId, container, null, { importRepository: services.importRepository, workspaceRepository: services.workspaceRepository, annotationRepository: services.annotationRepository });
      await waitFor(() => hasValidVisiblePage(container, book.getCurrentIndex()), 'Reader Command 首屏');
      const firstVisibleMs = performance.now() - firstVisibleStarted;
      const open = tracker.finishPhase({ firstVisibleMs });
      open.activeCanvasCount = countActiveCanvases(container);

      tracker.startPhase();
      const nextStarted = performance.now();
      await services.commands.execute(ids.readerNextPage, viewId);
      await waitFor(() => book.getCurrentIndex() === 2 && hasValidVisiblePage(container, 2), 'Reader Command 第二页');
      const nextPage = tracker.finishPhase({ elapsedMs: performance.now() - nextStarted });
      nextPage.activeCanvasCount = countActiveCanvases(container);

      tracker.startPhase();
      const scrollStarted = performance.now();
      await services.commands.execute(ids.readerSetPdfFlow, viewId, 'scrolled');
      await waitFor(() => container.querySelectorAll('.pdf-page-placeholder').length === book.getPageCount(), 'Reader Command 滚动占位');
      const target = container.querySelector('[data-page="320"]');
      if (!(target instanceof HTMLElement)) throw new Error('Reader Command 滚动第 320 页占位不存在');
      const targetScrollTop = Number.parseFloat(target.style.top);
      const getsBeforeJump = tracker.pageGets;
      await book.goToLocation({ kind: 'pdf', page: 320, scrollTop: Number.isFinite(targetScrollTop) ? targetScrollTop : 0, zoom: 100, fit: 'width' });
      await waitFor(() => book.getCurrentIndex() === 320 && hasValidVisiblePage(container, 320), 'Reader Command 滚动位置');
      const scrollFirstVisibleMs = performance.now() - scrollStarted;
      const scrollWindow = tracker.finishPhase({ elapsedMs: scrollFirstVisibleMs, firstVisibleMs: scrollFirstVisibleMs });
      scrollWindow.activeCanvasCount = countActiveCanvases(container);
      scrollWindow.pageGetsForJump = tracker.pageGets - getsBeforeJump;
      const total = tracker.finishTotal(bytes.byteLength, rangeLimit);
      total.binaryRangeResponses = tracker.binaryRangeResponses;
      total.nonBinaryRangeResponses = tracker.nonBinaryRangeResponses;
      validateMemory([open, nextPage, scrollWindow], memoryLimit);
      if (scrollWindow.activeCanvasCount > 12) throw new Error(`滚动模式活跃 Canvas 超过 12:${scrollWindow.activeCanvasCount}`);
      if (scrollWindow.pageGetsForJump >= 20) throw new Error(`滚动跳页取得页面过多:${scrollWindow.pageGetsForJump}`);
      return { pageCount: book.getPageCount(), pdfDocumentLoads: tracker.pdfDocumentLoads, phases: { open, nextPage, scrollWindow }, scrollWindow, total, memorySampleAvailable: [open, nextPage, scrollWindow].some((phase) => phase.memorySampleAvailable), firstVisibleMs };
    } finally {
      if (viewId) await services.commands.execute(ids.readerCloseView, viewId).catch(() => undefined);
      await flush().catch(() => undefined);
      restoreFetch();
      container.remove();
    }
  }

  async function measureEpub({
    ManagedFileSource: Source,
    EpubBookDocument: Book,
    createFoliateViewHostFactory: createHost,
    buildLargeEpubFixture: buildFixture,
    maxRangeBytes: rangeLimit,
    maxTotalReadRatio: readRatioLimit,
    maxPeakMemoryBytes: memoryLimit,
  }) {
    const bytes = await buildFixture();
    if (bytes.byteLength <= rangeLimit) throw new Error(`EPUB 性能样本必须大于 ${rangeLimit} 字节`);
    const tracker = createRangeTracker();
    const source = new Source(
      { name: 'large-range.epub', size: bytes.byteLength },
      async (offset, length) => {
        tracker.record(offset, length);
        return bytes.slice(offset, offset + length);
      },
    );
    const book = new Book({
      source,
      metadata: { title: '大型范围读取 EPUB', author: null, language: 'zh' },
      viewHostFactory: createHost(),
    });
    const container = makeContainer('epub-performance');
    let resourceLoaded = false;
    try {
      tracker.startPhase();
      const started = performance.now();
      await book.open(container);
      await waitFor(
        () => book.getContentDocs().some((doc) => Boolean(doc.body?.textContent?.trim())),
        'EPUB 首次可见内容',
      );
      const open = tracker.finishPhase({ firstVisibleMs: performance.now() - started });

      tracker.startPhase();
      const images = () => book.getContentDocs().flatMap((doc) => Array.from(doc.images));
      await waitFor(() => images().some((image) => image.complete && image.naturalWidth > 0), 'EPUB 资源加载');
      resourceLoaded = true;
      const resource = tracker.finishPhase({ elapsedMs: 0 });

      tracker.startPhase();
      const switchStarted = performance.now();
      await book.goToHref('OEBPS/chapter2.xhtml');
      await waitFor(
        () => book.getContentDocs().some((doc) => doc.body?.textContent?.includes('章节切换内容')),
        'EPUB 章节切换',
      );
      const chapterSwitch = tracker.finishPhase({ elapsedMs: performance.now() - switchStarted });
      const total = tracker.finishTotal(bytes.byteLength, rangeLimit);
      validateMemory([open, resource, chapterSwitch], memoryLimit);
      if (total.readRatio > readRatioLimit) throw new Error('EPUB 阶段累计读取超过文件大小预算');
      return {
        sizeBytes: bytes.byteLength,
        resourceLoaded,
        firstVisibleMs: open.firstVisibleMs,
        phases: { open, resource, chapterSwitch },
        total,
      };
    } finally {
      book.close();
      container.remove();
    }
  }

  function summarizeRuns(samples) {
    const firstVisible = samples
      .map((sample) => sample.firstVisibleMs)
      .filter((value) => typeof value === 'number');
    return {
      count: samples.length,
      firstVisibleMs: firstVisible,
      medianFirstVisibleMs: median(firstVisible),
      totalReadBytes: samples.map((sample) => sample.total.cumulativeReadBytes),
      maxReadRatio: Math.max(...samples.map((sample) => sample.total.readRatio)),
      maxRangeBytes: Math.max(...samples.map((sample) => sample.total.maxRangeBytes)),
    };
  }

  function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  }

  let preparedTauriMaterialId = null;
  let pdfBytes;
  if (sampleUrl) {
    pdfBytes = new Uint8Array(await (await fetch(sampleUrl)).arrayBuffer());
  } else if (mode === 'tauri') {
    const prepared = await prepareTauriMaterial(
      localPdfPath,
      createAppServices,
      loadPdfLib,
      inspectPdf,
      createPdfSourceFromBytes,
    );
    pdfBytes = prepared.bytes;
    preparedTauriMaterialId = prepared.material.id;
  } else {
    pdfBytes = buildLargePdfFixture({
      pageCount: expectedPageCount,
      contentBytesPerPage: expectedContentBytesPerPage,
    });
  }
  if (pdfBytes.byteLength <= maxRangeBytes) {
    throw new Error(`PDF 性能样本必须大于 ${maxRangeBytes} 字节`);
  }

  const epub = mode === 'browser'
    ? await measureEpub({
        ManagedFileSource,
        EpubBookDocument,
        createFoliateViewHostFactory,
        buildLargeEpubFixture,
        maxRangeBytes,
        maxTotalReadRatio,
        maxPeakMemoryBytes,
      })
    : null;

  const runs = [];
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const direct = await measureDirectFile({ PdfBookDocument, loadPdfLib, pdfBytes, maxRangeBytes, maxPeakMemoryBytes });
    const managed = await measureReaderCommand({
      mode,
      PdfBookDocument,
      ManagedFileSource,
      createAppServices,
      createInMemoryFilePicker,
      createInMemoryImportRepository,
      addInMemorySource,
      loadPdfLib,
      pdfBytes,
      localPdfPath,
      materialId: preparedTauriMaterialId,
      MANAGED_RANGE_PROTOCOL_ORIGIN,
      COMMAND_IDS,
      mountViewDocument,
      flushAndCloseAllReaderViews,
      useReaderRuntime,
      useWorkspaceStore,
      maxRangeBytes,
      maxTotalReadRatio,
      maxPeakMemoryBytes,
    });
    runs.push({ run: runIndex + 1, directFile: direct, managed });
  }
  if (
    !sampleUrl &&
    mode === 'browser' &&
    runs.some((run) => run.managed.pageCount !== expectedPageCount)
  ) {
    throw new Error(`确定性 PDF 页数异常:${runs.map((run) => run.managed.pageCount).join(',')}`);
  }

  const summary = {
    directFile: summarizeRuns(runs.map((run) => run.directFile)),
    managed: summarizeRuns(runs.map((run) => run.managed)),
    epub: epub
      ? {
          firstVisibleMs: epub.firstVisibleMs,
          totalReadBytes: epub.total.cumulativeReadBytes,
          readRatio: epub.total.readRatio,
        }
      : null,
  };
  const ratio = summary.directFile.medianFirstVisibleMs > 0
    ? summary.managed.medianFirstVisibleMs / summary.directFile.medianFirstVisibleMs
    : null;
  const allSamples = runs.flatMap((run) => [run.directFile, run.managed]);
  const checks = {
    measurementCount: runCount,
    atLeastThreeMeasurements: runCount >= 3,
    managedToDirectMedianRatio: ratio,
    managedToDirectMedianWithinTwoX: mode !== 'tauri' || (ratio !== null && ratio <= 2),
    pdfDocumentLoadsPerRun: Math.max(...allSamples.map((sample) => sample.pdfDocumentLoads)),
    singlePdfDocumentPerRun: allSamples.every((sample) => sample.pdfDocumentLoads === 1),
    maxRangeBytes: Math.max(...allSamples.map((sample) => sample.total.maxRangeBytes)),
    noOversizedRange: allSamples.every((sample) => sample.total.maxRangeBytes <= maxRangeBytes),
    maxTotalReadRatio: Math.max(...allSamples.map((sample) => sample.total.readRatio)),
    noFullFileRead: allSamples.every((sample) => sample.total.maxRangeBytes < pdfBytes.byteLength),
    totalReadWithinBudget: allSamples.every((sample) => sample.total.readRatio <= maxTotalReadRatio),
    memorySamples: allSamples.map((sample) => sample.memorySampleAvailable),
    scrollCanvasWindowed: allSamples.every((sample) => sample.scrollWindow.activeCanvasCount <= 12),
    tauriBinaryManagedRange:
      mode !== 'tauri' || runs.every((run) =>
        run.managed.transport === 'windows-managed-range' &&
        run.managed.total.binaryRangeResponses > 0 &&
        run.managed.total.nonBinaryRangeResponses === 0,
      ),
    epubRangeWithinBudget:
      epub === null ||
      (epub.total.maxRangeBytes <= maxRangeBytes && epub.total.readRatio <= maxTotalReadRatio),
  };
  if (!checks.atLeastThreeMeasurements) throw new Error('性能门禁至少需要三次测量');
  if (!checks.singlePdfDocumentPerRun) {
    throw new Error(`同一次打开创建了多份 PDF.js 文档:${allSamples.map((sample) => sample.pdfDocumentLoads).join(',')}`);
  }
  if (!checks.noOversizedRange) throw new Error('出现超过 8 MiB 的底层范围请求');
  if (!checks.noFullFileRead) throw new Error('出现整本 PDF 范围请求');
  if (!checks.totalReadWithinBudget) throw new Error('累计底层读取超过文件大小的 110%');
  if (!checks.scrollCanvasWindowed) throw new Error('滚动模式活跃 Canvas 超过 12 个');
  if (!checks.managedToDirectMedianWithinTwoX) throw new Error('Windows Tauri 首屏中位数超过浏览器 File 基线的 2 倍');
  if (!checks.tauriBinaryManagedRange) throw new Error('Windows Tauri 没有使用 managed-range 二进制协议');
  if (!checks.epubRangeWithinBudget) throw new Error('EPUB 性能阶段超出范围读取预算');

  return {
    schemaVersion: 'reading-performance.v2',
    issue: 46,
    status: 'passed',
    mode,
    fixture: {
      kind: sampleUrl || mode === 'tauri' ? 'explicit-local-path' : 'deterministic-generated',
      sizeBytes: pdfBytes.byteLength,
      pageCount: runs[0]?.managed.pageCount ?? null,
      generatedPageCount: sampleUrl || mode === 'tauri' ? null : expectedPageCount,
      generatedContentBytesPerPage: sampleUrl || mode === 'tauri' ? null : expectedContentBytesPerPage,
      epub: epub
        ? {
            sizeBytes: epub.sizeBytes,
            resourceLoaded: epub.resourceLoaded,
            phases: epub.phases,
            total: epub.total,
          }
        : null,
    },
    environment: {
      isTauri,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      devicePixelRatio: window.devicePixelRatio,
    },
    runs,
    summary,
    checks,
  };

  async function prepareTauriMaterial(path, makeServices, getPdfLib, inspect, makePdfSource) {
    if (!path) throw new Error('Tauri 样本路径为空');
    const preparationServices = makeServices();
    const staged = await preparationServices.importRepository.stageImport(path);
    const bytes = await preparationServices.importRepository.readStagedFile(staged);
    const inspection = await inspect(makePdfSource(bytes), await getPdfLib(), { includeCover: false });
    const material = await preparationServices.importRepository.commitImport(staged, {
      ...inspection.metadata,
      title: inspection.metadata.title || '大型 PDF 性能样本',
    });
    return { bytes, material };
  }
}

main().catch(async (error) => {
  failureReport = sanitizeError(error);
  try {
    await closeBrowser();
    await closeSampleServer();
    killDevServer();
  } finally {
    writeFailureArtifact(error);
    console.error(`大型 PDF 性能验收失败:${failureReport}`);
    process.exitCode = 1;
  }
});
