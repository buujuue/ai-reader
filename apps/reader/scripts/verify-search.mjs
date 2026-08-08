/**
 * 真实浏览器搜索验证脚本。
 *
 * 它启动 Vite dev server,用系统 Chrome(经 puppeteer-core)打开真实应用,
 * 打开示例书后用 Ctrl+F 打开搜索,断言:
 *  - 搜索异步产生命中(完成后显示命中计数);
 *  - foliate 在正文中渲染命中高亮(overlayer SVG 标注);
 *  - 上一项/下一项在命中间跳转,并使渲染器切换到对应章节(结果跳转);
 *  - 关闭搜索后清理高亮与结果。
 *
 * 说明:foliate-view 使用 closed shadow DOM,正文与高亮 SVG 无法用 document 查询;
 * 但元素暴露公开的 `renderer.getContents()`(含 overlayer.element 与当前 section),
 * 以此验证高亮与章节跳转。headless 下 `lastLocation.cfi` 不可靠,故不据此断言位置。
 *
 * 运行:node scripts/verify-search.mjs
 */
import { spawn, execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5173';
const QUERY = '验证'; // 示例书两章都包含该词,应有两个命中,分属两个章节。

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

/** 统计当前渲染 section 的搜索高亮数量(overlayer SVG 子节点数)。 */
const highlightCount = `
  (() => {
    const view = document.querySelector('foliate-view');
    if (!view || !view.renderer) return -1;
    let total = 0;
    for (const content of view.renderer.getContents()) {
      total += content.overlayer?.element?.children.length ?? 0;
    }
    return total;
  })()
`;

/** 当前渲染的活跃 section index。 */
const activeSection = `
  (() => {
    const view = document.querySelector('foliate-view');
    if (!view || !view.renderer) return -1;
    const contents = view.renderer.getContents();
    return contents[0]?.index ?? -1;
  })()
`;

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

    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(APP_URL, { waitUntil: 'networkidle0' });

    // 导入并打开示例书。
    await page.waitForSelector('button[aria-label="导入 EPUB"]', { timeout: 15000 });
    await page.click('button[aria-label="导入 EPUB"]');
    await page.waitForFunction(() => document.body.innerText.includes('示例书'), { timeout: 15000 });
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('示例书'),
      );
      btn?.click();
    });
    await page.waitForFunction(() => {
      const view = document.querySelector('foliate-view');
      return !!view?.book && !!view?.renderer;
    }, { timeout: 15000 });

    const failures = [];

    // Ctrl+F 打开搜索栏。
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyF');
    await page.keyboard.up('Control');
    await page.waitForSelector('input[aria-label="搜索关键词"]', { timeout: 5000 });

    // 输入查询;防抖 + 异步搜索后,应出现命中计数(2/2)。
    await page.type('input[aria-label="搜索关键词"]', QUERY, { delay: 20 });
    await page.waitForFunction(
      (q) => {
        const input = document.querySelector('input[aria-label="搜索关键词"]');
        return input?.value === q && /\d+\/2/.test(document.body.innerText);
      },
      { timeout: 15000 },
      QUERY,
    );

    const indicator = await page.evaluate(() => document.querySelector('[role="search"]')?.innerText ?? '');
    if (!/\d+\/2/.test(indicator)) failures.push(`搜索未完成或命中数不对:${indicator}`);

    // 命中高亮:foliate 为每个命中在 overlayer SVG 中画一个 `<g>`。
    const highlightsAfterSearch = await page.evaluate(highlightCount);
    if (highlightsAfterSearch < 1) failures.push('未渲染命中高亮(overlayer 无标注)');

    // 结果跳转:两个命中分属两个章节。点击"下一个命中"应使活跃章节切换。
    const sectionBefore = await page.evaluate(activeSection);
    let sectionChanged = false;
    for (let i = 0; i < 3; i++) {
      await page.click('button[aria-label="下一个命中"]');
      await new Promise((r) => setTimeout(r, 600));
      const sectionNow = await page.evaluate(activeSection);
      if (sectionNow !== -1 && sectionNow !== sectionBefore) {
        sectionChanged = true;
        break;
      }
    }
    if (!sectionChanged) failures.push('点击下一个命中未切换活跃章节(结果未跳转)');

    // 关闭搜索:搜索栏关闭,且高亮被清理。
    await page.click('button[aria-label="关闭搜索"]');
    await page.waitForFunction(
      () => !document.querySelector('input[aria-label="搜索关键词"]'),
      { timeout: 5000 },
    );
    await page.waitForFunction(
      () => {
        const view = document.querySelector('foliate-view');
        if (!view || !view.renderer) return true;
        return view.renderer
          .getContents()
          .every((content) => (content.overlayer?.element?.children.length ?? 0) === 0);
      },
      { timeout: 5000 },
    ).catch(() => {
      failures.push('关闭搜索后未清理命中高亮');
    });

    if (pageErrors.length > 0) failures.push(`页面错误:${pageErrors.join('; ')}`);

    await browser.close();

    console.log('真实浏览器搜索验证结果:');
    console.log(JSON.stringify({ query: QUERY, indicator, highlightsAfterSearch, sectionBefore }, null, 2));

    if (failures.length > 0) {
      console.error('失败项:');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log('通过:真实浏览器完成搜索、高亮、结果跳转与清理。');
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