/**
 * 大型 EPUB/PDF 统一 Source 性能回归验收。
 *
 * 运行：pnpm test:reading-performance
 * 结果写入 scripts/artifacts/reading-performance.json（该目录已忽略）。
 * 夹具、阶段和阈值固定；脚本只在真实 Chrome 中执行，避免 jsdom 把
 * 分页/Canvas 性能伪装成通过。
 * 浏览器降级只验证 ManagedFileSource 语义；Windows Tauri 的 managed-range
 * 二进制协议还必须按 ADR-0032 的人工步骤记录网络栈证据。
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5173';
const OUTPUT = process.env.READING_PERFORMANCE_OUTPUT ?? 'scripts/artifacts/reading-performance.json';
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_PEAK_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_READ_RATIO = 0.5;
let dev = null;

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
        return reject(new Error(`dev server 未在 ${timeoutMs}ms 内启动`));
      }
      setTimeout(poll, 300);
    };
    poll();
  });
}

async function main() {
  const isWin = process.platform === 'win32';
  dev = spawn(isWin ? 'pnpm.cmd' : 'pnpm', ['dev', '--host'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true,
    shell: isWin,
  });

  try {
    await waitForServer(APP_URL);
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(APP_URL, { waitUntil: 'networkidle0' });

    const result = await page.evaluate(async ({ maxRangeBytes, maxPeakMemoryBytes, maxTotalReadRatio }) => {
      const { ManagedFileSource } = await import('/src/domain/library/managedFileSource.ts');
      const { EpubBookDocument } = await import('/src/domain/reader/epubBookDocument.ts');
      const { createFoliateViewHostFactory } = await import('/src/domain/reader/foliateViewHost.ts');
      const { buildLargeEpubFixture } = await import('/src/test/fixtures/epub/epubFixtures.ts');
      const { PdfBookDocument } = await import('/src/domain/reader/pdf/pdfBookDocument.ts');
      const { buildLargePdfFixture } = await import('/src/test/fixtures/pdf/pdfFixtures.ts');
      const { loadPdfLib } = await import('/src/domain/reader/pdf/pdfLibrary.ts');

      const waitFor = async (predicate, label, timeoutMs = 15_000) => {
        const started = performance.now();
        while (!predicate()) {
          if (performance.now() - started > timeoutMs) {
            throw new Error(`等待${label}超时`);
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      };

      const makeContainer = (className) => {
        const container = document.createElement('div');
        container.className = className;
        Object.assign(container.style, {
          position: 'fixed',
          left: '-10000px',
          top: '0',
          width: '900px',
          height: '760px',
          visibility: 'hidden',
        });
        document.body.append(container);
        return container;
      };

      const trackedSource = (bytes, name) => {
        const ranges = [];
        let cumulativeReadBytes = 0;
        let inFlightBytes = 0;
        let peakInFlightBytes = 0;
        let peakHeapBytes = 0;
        const sampleHeap = () => {
          const heapBytes = performance.memory?.usedJSHeapSize;
          if (typeof heapBytes === 'number') peakHeapBytes = Math.max(peakHeapBytes, heapBytes);
        };
        sampleHeap();
        const source = new ManagedFileSource(
          { name, size: bytes.byteLength },
          async (offset, length) => {
            ranges.push({ offset, length });
            cumulativeReadBytes += length;
            inFlightBytes += length;
            peakInFlightBytes = Math.max(peakInFlightBytes, inFlightBytes);
            sampleHeap();
            try {
              await Promise.resolve();
              sampleHeap();
              return bytes.slice(offset, offset + length);
            } finally {
              inFlightBytes -= length;
              sampleHeap();
            }
          },
        );
        return {
          source,
          startMemorySampling() {
            let active = true;
            const interval = setInterval(sampleHeap, 8);
            const sampleFrame = () => {
              sampleHeap();
              if (active) requestAnimationFrame(sampleFrame);
            };
            requestAnimationFrame(sampleFrame);
            return () => {
              active = false;
              clearInterval(interval);
            };
          },
          snapshot() {
            sampleHeap();
            return {
              cumulativeReadBytes,
              requestCount: ranges.length,
              maxRangeBytes: Math.max(0, ...ranges.map((range) => range.length)),
              peakMemoryBytes: peakHeapBytes > 0 ? peakHeapBytes : null,
              memorySampleAvailable: peakHeapBytes > 0,
              peakInFlightBytes,
            };
          },
          ranges,
        };
      };

      const phase = async (tracker, action, { firstVisible = false } = {}) => {
        const before = tracker.snapshot();
        const started = performance.now();
        const stopMemorySampling = tracker.startMemorySampling();
        let after;
        try {
          await action();
        } finally {
          stopMemorySampling();
          after = tracker.snapshot();
        }
        const elapsedMs = performance.now() - started;
        return {
          elapsedMs,
          firstVisibleMs: firstVisible ? elapsedMs : null,
          cumulativeReadBytes: after.cumulativeReadBytes - before.cumulativeReadBytes,
          peakMemoryBytes: after.peakMemoryBytes,
          memorySampleAvailable: after.memorySampleAvailable,
          peakInFlightBytes: after.peakInFlightBytes,
          requestCount: after.requestCount - before.requestCount,
          maxRangeBytes: after.maxRangeBytes,
        };
      };

      const epubBytes = await buildLargeEpubFixture();
      const epubTracker = trackedSource(epubBytes, 'large-range.epub');
      const epubContainer = makeContainer('large-epub-performance');
      const epubBook = new EpubBookDocument({
        source: epubTracker.source,
        metadata: { title: '大型范围读取 EPUB', author: null, language: 'zh' },
        viewHostFactory: createFoliateViewHostFactory(),
      });
      let epubResourceLoaded = false;
      const epubOpen = await phase(epubTracker, async () => {
        await epubBook.open(epubContainer);
        await waitFor(
          () => epubBook.getContentDocs().some((doc) => Boolean(doc.body?.textContent?.trim())),
          'EPUB 首次可见内容',
        );
      }, { firstVisible: true });
      const epubImages = () => epubBook
        .getContentDocs()
        .flatMap((doc) => Array.from(doc.images));
      const epubResource = await phase(epubTracker, async () => {
        await waitFor(
          () => epubImages().some((image) => image.complete && image.naturalWidth > 0),
          'EPUB 资源加载',
        );
        epubResourceLoaded = true;
      });
      const epubSwitch = await phase(epubTracker, async () => {
        await epubBook.goToHref('OEBPS/chapter2.xhtml');
        await waitFor(
          () => epubBook.getContentDocs().some((doc) => doc.body?.textContent?.includes('章节切换内容')),
          'EPUB 章节切换',
        );
      });
      const epubTotalReadBytes = epubTracker.snapshot().cumulativeReadBytes;
      epubBook.close();
      epubContainer.remove();

      const pdfBytes = buildLargePdfFixture({ pageCount: 640, paddingBytes: 80 * 1024 * 1024 });
      const pdfTracker = trackedSource(pdfBytes, 'large-range.pdf');
      const pdfContainer = makeContainer('large-pdf-performance');
      const loadedPdfLib = await loadPdfLib();
      let pdfDocumentLoads = 0;
      const pdfLib = new Proxy(loadedPdfLib, {
        get(target, property, receiver) {
          if (property === 'getDocument') {
            return (options) => {
              pdfDocumentLoads += 1;
              return target.getDocument(options);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const pdfBook = new PdfBookDocument({
        source: pdfTracker.source,
        metadata: { title: '大型范围读取 PDF', author: null, language: 'zh' },
        pdfLib,
      });
      const pdfOpen = await phase(pdfTracker, async () => {
        await pdfBook.open(pdfContainer);
        await waitFor(() => pdfBook.getCurrentIndex() === 1, 'PDF 首屏');
      }, { firstVisible: true });
      const pdfNext = await phase(pdfTracker, async () => {
        await pdfBook.next();
        await waitFor(() => pdfBook.getCurrentIndex() === 2, 'PDF 翻页');
      });
      const pdfPageCount = pdfBook.getPageCount();
      if (pdfPageCount !== 640) throw new Error(`PDF 文档信息页数异常:${pdfPageCount}`);
      if (pdfDocumentLoads !== 1) {
        throw new Error(`PDF 首次打开创建了 ${pdfDocumentLoads} 份 PDF.js 文档,预期为 1`);
      }
      const pdfTotalReadBytes = pdfTracker.snapshot().cumulativeReadBytes;
      pdfBook.close();
      pdfContainer.remove();

      const validate = (label, bytes, phases, requiredRequestPhases) => {
        if (bytes.byteLength <= maxRangeBytes) throw new Error(`${label} 性能夹具没有超过单次范围上限`);
        const totalReadBytes = Object.values(phases)
          .reduce((sum, sample) => sum + sample.cumulativeReadBytes, 0);
        if (totalReadBytes >= bytes.byteLength) throw new Error(`${label} 多阶段累计读取了整本文件`);
        if (totalReadBytes > bytes.byteLength * maxTotalReadRatio) {
          throw new Error(`${label} 多阶段累计读取超过夹具的 50% 结构阈值`);
        }
        for (const [phaseName, sample] of Object.entries(phases)) {
          if (requiredRequestPhases.includes(phaseName) && sample.requestCount < 1) {
            throw new Error(`${label}/${phaseName} 没有范围请求`);
          }
          if (sample.maxRangeBytes > maxRangeBytes) throw new Error(`${label}/${phaseName} 单次范围超过 8 MiB`);
          if (sample.cumulativeReadBytes >= bytes.byteLength) throw new Error(`${label}/${phaseName} 读取了整本文件`);
          if (sample.peakMemoryBytes !== null && sample.peakMemoryBytes > maxPeakMemoryBytes) {
            throw new Error(`${label}/${phaseName} 峰值内存超过 512 MiB`);
          }
          if (!sample.memorySampleAvailable) {
            throw new Error(`${label}/${phaseName} Chrome 未提供 performance.memory 峰值采样`);
          }
        }
      };
      validate('EPUB', epubBytes, { open: epubOpen, resource: epubResource, chapterSwitch: epubSwitch }, ['open']);
      validate('PDF', pdfBytes, { open: pdfOpen, nextPage: pdfNext }, ['open', 'nextPage']);
      if (!epubResourceLoaded) throw new Error('EPUB 性能夹具资源没有加载');

      return {
        schemaVersion: 'reading-performance.v1',
        fixtures: {
          epub: {
            sizeBytes: epubBytes.byteLength,
            firstVisible: epubOpen,
            resourceLoad: epubResource,
            chapterSwitch: epubSwitch,
            resourceLoaded: epubResourceLoaded,
            totalReadBytes: epubTotalReadBytes,
            ranges: epubTracker.ranges,
          },
          pdf: {
            sizeBytes: pdfBytes.byteLength,
            pageCount: pdfPageCount,
            firstVisible: pdfOpen,
            nextPage: pdfNext,
            totalReadBytes: pdfTotalReadBytes,
            ranges: pdfTracker.ranges,
          },
        },
      };
    }, {
      maxRangeBytes: MAX_RANGE_BYTES,
      maxPeakMemoryBytes: MAX_PEAK_MEMORY_BYTES,
      maxTotalReadRatio: MAX_TOTAL_READ_RATIO,
    });

    await browser.close();
    if (pageErrors.length > 0) throw new Error(`页面错误:${pageErrors.join('; ')}`);
    mkdirSync('scripts/artifacts', { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify({ ...result, recordedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log('阅读范围性能验收结果:');
    console.log(JSON.stringify(result, null, 2));
    console.log(`记录: ${OUTPUT}`);
    console.log('通过: EPUB 首屏/章节切换/资源加载与 PDF 文档信息/首屏/翻页均未发出整本范围请求。');
  } finally {
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
  console.error('FAILED', error);
  process.exit(1);
});
