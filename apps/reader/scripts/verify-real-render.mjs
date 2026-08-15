/**
 * 真实浏览器渲染冒烟测试。
 *
 * 它启动 Vite dev server,用系统 Chrome(经 puppeteer-core)打开真实应用,
 * 走"导入示例书 → 打开标签"的完整流程,断言 foliate 真实渲染出阅读位置(CFI)
 * 且容器与渲染器有非零尺寸。
 *
 * 这是规格要求的"Vitest Browser"之外的一条真实浏览器验证路径,用于确认
 * EPUB 在真实浏览器中确实能打开并渲染,而不只是伪宿主上的编排逻辑通过。
 *
 * 运行:node scripts/verify-real-render.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5173';
const SCREENSHOT = 'scripts/artifacts/real-render.png';

/** 由 main 启动的 dev server 子进程,供 finally 清理。 */
let dev = null;

function waitForServer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`dev server 未在 ${timeoutMs}ms 内启动`));
      }
      setTimeout(poll, 500);
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
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(APP_URL, { waitUntil: 'networkidle0' });

    await page.waitForSelector('button[aria-label="导入 EPUB"]', { timeout: 15000 });
    await page.click('button[aria-label="导入 EPUB"]');
    await page.waitForFunction(
      () => document.body.innerText.includes('示例书'),
      { timeout: 15000 },
    );
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('示例书'),
      );
      btn?.click();
    });

    // 等待 foliate 完成排版并创建真实内容文档。CFI 在无布局或部分 WebView
    // 环境中可能不会及时暴露，不能作为图片资源已加载的前置条件。
    await page.waitForFunction(
      () => {
        const view = document.querySelector('foliate-view');
        return !!view?.book && !!view?.renderer?.getContents?.()?.some((content) =>
          content.doc?.querySelector('img[alt="测试图片"]'),
        );
      },
      { timeout: 15000 },
    );

    const state = await page.evaluate(() => {
      const view = document.querySelector('foliate-view');
      const container = view?.parentElement;
      const image = view?.renderer?.getContents?.()
        ?.flatMap((content) => Array.from(content.doc?.images ?? []))
        ?.find((candidate) => candidate.getAttribute('data-image-marker') === 'body-image')
        ?? view?.renderer?.getContents?.()
          ?.flatMap((content) => Array.from(content.doc?.querySelectorAll('img') ?? []))
          ?.find((candidate) => candidate.getAttribute('alt') === '测试图片');
      const rect = container ? container.getBoundingClientRect() : null;
      return {
        hasView: !!view,
        hasBook: !!view?.book,
        title: view?.book?.metadata?.title ?? null,
        sectionCount: view?.book?.sections?.length ?? 0,
        cfi: view?.lastLocation?.cfi ?? null,
        viewHeight: view ? getComputedStyle(view).height : null,
        containerRect: rect ? { w: rect.width, h: rect.height } : null,
        image: image ? {
          src: image.getAttribute('src'),
          complete: image.complete,
          naturalWidth: image.naturalWidth,
        } : null,
      };
    });

    mkdirSync('scripts/artifacts', { recursive: true });
    await page.screenshot({ path: SCREENSHOT });

    await browser.close();

    const failures = [];
    if (!state.hasView) failures.push('未创建 foliate-view 元素');
    if (!state.hasBook) failures.push('未挂载 BookDocument');
    if (!state.cfi) failures.push('未产生阅读位置(CFI),但这不阻断内容与图片资源验收');
    if (!state.viewHeight || state.viewHeight === '0px') failures.push('渲染器高度为 0');
    if (!state.containerRect || state.containerRect.h === 0) failures.push('容器高度为 0');
    if (!state.image) failures.push('未找到 EPUB 正文图片元素');
    else if (!state.image.complete || state.image.naturalWidth === 0) failures.push(`EPUB 图片未加载:${JSON.stringify(state.image)}`);
    if (pageErrors.length > 0) failures.push(`页面错误:${pageErrors.join('; ')}`);

    console.log('真实渲染冒烟结果:');
    console.log(JSON.stringify(state, null, 2));
    console.log(`截图: ${SCREENSHOT}`);

    if (failures.length > 0) {
      console.error('失败项:');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log('通过:真实浏览器成功渲染 EPUB。');
  } finally {
    killDevServer();
  }
}

/** Windows 上递归杀掉 vite 进程树,避免 dev server 残留。 */
function killDevServer() {
  if (process.platform !== 'win32') {
    dev?.kill();
    return;
  }
  try {
    execSync('taskkill /F /T /PID ' + dev.pid, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

main().catch((error) => {
  console.error('FAILED', error);
  process.exit(1);
});
