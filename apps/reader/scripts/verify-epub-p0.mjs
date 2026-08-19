/**
 * EPUB P0 真实浏览器矩阵验证。
 *
 * 它绕过应用演示导入流程，直接在真实 Chrome 中创建 foliate-view，
 * 验证 EPUB 2/NCX、EPUB 3/NAV、固定版式、RTL 与竖排内容确实能打开。
 * 运行：pnpm test:real-epub-p0
 */
import { spawn, execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5173';
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
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(APP_URL, { waitUntil: 'networkidle0' });

    const results = await page.evaluate(async () => {
      const { buildEpubFixture } = await import('/src/test/fixtures/epub/epubFixtures.ts');
      const { EpubBookDocument } = await import('/src/domain/reader/epubBookDocument.ts');
      const { createFoliateViewHostFactory } = await import('/src/domain/reader/foliateViewHost.ts');
      const factory = createFoliateViewHostFactory();

      const createContainer = () => {
        const container = document.createElement('div');
        Object.assign(container.style, {
          position: 'fixed',
          inset: '0',
          width: '900px',
          height: '680px',
          visibility: 'hidden',
        });
        document.body.append(container);
        return container;
      };

      const verifyFixture = async (id, expected) => {
        const bytes = await buildEpubFixture(id);
        const container = createContainer();
        const book = new EpubBookDocument({
          bytes,
          metadata: { title: id, author: null, language: 'zh' },
          viewHostFactory: factory,
        });
        await book.open(container);
        const firstToc = book.getTOC()[0];
        if (firstToc?.href) await book.goToHref(firstToc.href);
        if (expected.navigateToHref) await book.goToHref(expected.navigateToHref);
        const view = container.querySelector('foliate-view');
        const content = view?.renderer?.getContents?.()?.find(
          (item) => item.doc?.body?.textContent?.trim(),
        );
        const body = content?.doc?.body;
        const fontFacePresent = Array.from(body?.ownerDocument.querySelectorAll('style') ?? [])
          .some((style) => style.textContent?.includes('@font-face'));
        const fontStatuses = Array.from(body?.ownerDocument.fonts ?? [])
          .filter((font) => font.family.includes('obfuscated'))
          .map((font) => font.status);
        const result = {
          id,
          toc: book.getTOC(),
          cfi: book.getLocation()?.cfi ?? null,
          progress: book.getReadingProgress(),
          sectionCount: view?.book?.sections?.length ?? 0,
          layout: view?.book?.rendition?.layout ?? null,
          dir: view?.book?.dir ?? null,
          writingMode: body ? getComputedStyle(body).writingMode : null,
          fontFamily: body ? getComputedStyle(body).fontFamily : null,
          fontFacePresent,
          fontStatuses,
          fontOutcome: fontFacePresent && fontStatuses.includes('loaded')
            ? 'loaded'
            : fontFacePresent
              ? 'fallback'
              : 'missing',
          contentText: body?.textContent?.trim() ?? '',
          math: body?.querySelector('math') !== null,
          mathFallback: body?.querySelector('.ai-reader-math-fallback') !== null,
          imageLoaded: Array.from(body?.querySelectorAll('img[alt="测试图片"]') ?? [])
            .some((image) => image.complete && image.naturalWidth > 0),
          svgPresent: body?.querySelector('img[alt="测试 SVG"]') !== null,
          footnotePresent: body?.querySelector('aside') !== null,
        };
        // foliate paginator 在 Chrome 中会在下一帧完成主题背景替换；
        // 先让该异步布局稳定，再关闭测试视图，避免把上游清理竞态误判为样书失败。
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        book.close();
        container.remove();
        if (expected.tocLabel && result.toc[0]?.label !== expected.tocLabel) {
          throw new Error(`${id}: NAV/NCX 目录不可用`);
        }
        if (expected.tocLabel && !result.toc[0]?.href) {
          throw new Error(`${id}: NAV/NCX 目录没有可跳转 href`);
        }
        if (!result.cfi) throw new Error(`${id}: 未产生可恢复 CFI`);
        if (!result.progress || result.progress.fraction === null || !result.progress.section) {
          throw new Error(`${id}: 未产生位置反馈`);
        }
        if (result.sectionCount < 1) throw new Error(`${id}: spine 没有章节`);
        if (!result.contentText) throw new Error(`${id}: 正文没有加载`);
        if (expected.layout && result.layout !== expected.layout) {
          throw new Error(`${id}: 固定版式未生效:${result.layout}`);
        }
        if (expected.dir && result.dir !== expected.dir) {
          throw new Error(`${id}: 阅读方向未生效:${result.dir}`);
        }
        if (expected.writingMode && result.writingMode !== expected.writingMode) {
          throw new Error(`${id}: 竖排未生效:${result.writingMode}`);
        }
        if (expected.font && result.fontOutcome === 'missing') {
          throw new Error(`${id}: 嵌入字体规则没有进入内容文档:${result.fontFamily ?? 'unknown'}`);
        }
        if (expected.fontOutcome && result.fontOutcome !== expected.fontOutcome) {
          throw new Error(`${id}: 字体降级结果不符合预期:${result.fontOutcome}`);
        }
        if (expected.cfiIncludes && !result.cfi?.includes(expected.cfiIncludes)) {
          throw new Error(`${id}: 页内链接没有定位到目标锚点:${result.cfi ?? 'unknown'}`);
        }
        if (expected.math && !result.math && !result.mathFallback) {
          throw new Error(`${id}: MathML 没有原始公式或局部降级文本`);
        }
        if (expected.image && !result.imageLoaded) {
          throw new Error(`${id}: 包内图片没有加载`);
        }
        if (expected.svg && !result.svgPresent) {
          throw new Error(`${id}: SVG 内容没有出现`);
        }
        if (expected.footnote && !result.footnotePresent) {
          throw new Error(`${id}: 脚注内容没有出现`);
        }
        return result;
      };

      return {
        matrix: [
        await verifyFixture('epub2-ncx-flowable', { tocLabel: '第一章' }),
        await verifyFixture('epub3-nav-rich', {
          tocLabel: '第一章',
          navigateToHref: 'OEBPS/chapter.xhtml#note-1',
          cfiIncludes: 'note-1',
          image: true,
          svg: true,
          footnote: true,
        }),
        await verifyFixture('epub3-fixed-layout', { tocLabel: '第一章', layout: 'pre-paginated' }),
        await verifyFixture('epub3-rtl-vertical', { tocLabel: '第一章', dir: 'rtl', writingMode: 'vertical-rl' }),
        await verifyFixture('epub3-obfuscated-font', {
          tocLabel: '第一章',
          font: true,
          fontOutcome: 'fallback',
        }),
        await verifyFixture('epub3-mathml', { tocLabel: '第一章', math: true }),
        ],
        chapterSwitch: await (async () => {
          const { buildEpub } = await import('/src/domain/library/epub/zipWriter.ts');
          const bytes = buildEpub({ title: '章节切换', language: 'zh' });
          const container = createContainer();
          const book = new EpubBookDocument({
            bytes,
            metadata: { title: '章节切换', author: null, language: 'zh' },
            viewHostFactory: factory,
          });
          await book.open(container);
          await book.goToHref('OEBPS/chapter1.xhtml');
          await book.next();
          const savedLocation = book.getLocation();
          const afterNext = book.getReadingProgress()?.section?.current ?? null;
          await book.prev();
          const afterPrev = book.getReadingProgress()?.section?.current ?? null;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          book.close();
          container.remove();
          if (!savedLocation) throw new Error('章节切换后没有可恢复位置');

          const restoredContainer = createContainer();
          const restoredBook = new EpubBookDocument({
            bytes,
            metadata: { title: '章节切换', author: null, language: 'zh' },
            viewHostFactory: factory,
          });
          await restoredBook.open(restoredContainer);
          await restoredBook.goToLocation(savedLocation);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const restored = restoredBook.getReadingProgress()?.section?.current ?? null;
          const restoredCfi = restoredContainer.querySelector('foliate-view')?.lastLocation?.cfi ?? null;
          restoredBook.close();
          restoredContainer.remove();
          return {
            afterNext,
            afterPrev,
            restored,
            savedCfi: savedLocation.cfi,
            restoredCfi,
          };
        })(),
      };
    });

    await browser.close();
    console.log('EPUB P0 真实浏览器矩阵结果:');
    console.log(JSON.stringify(results, null, 2));
    if (results.chapterSwitch.afterNext !== 1 ||
      results.chapterSwitch.afterPrev !== 0 ||
      results.chapterSwitch.restored !== 1 ||
      results.chapterSwitch.savedCfi !== results.chapterSwitch.restoredCfi) {
      throw new Error(`前后章节移动失败:${JSON.stringify(results.chapterSwitch)}`);
    }
    if (pageErrors.length > 0) {
      throw new Error(`页面错误:${pageErrors.join('; ')}`);
    }
    console.log('通过:EPUB 2/3、NAV/NCX、目录/页内链接、位置恢复、固定版式、RTL、竖排、图片/SVG、脚注、嵌入字体与 MathML 均可处理。');
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
    /* already stopped */
  }
}

main().catch((error) => {
  console.error('FAILED', error);
  process.exit(1);
});
