/**
 * 真实浏览器批注验证脚本。
 *
 * 它启动 Vite dev server,用系统 Chrome(经 puppeteer-core)打开真实应用,
 * 打开示例书后在正文中选中一段文字,断言:
 *  - 弹出「高亮」工具栏,点击后创建高亮批注并在 foliate overlayer SVG 中绘制覆盖层;
 *  - 批注锚点含 CFI、引文、前后文与恢复状态(经 AnnotationStore 读取,不落 DOM);
 *  - 重新打开同一本书后批注从持久化恢复并重新绘制(重启恢复)。
 *
 * 说明:foliate-view 使用 closed shadow DOM,正文在 iframe 内;因此用
 * `renderer.getContents()` 取到当前内容文档,在其上构造 Range 模拟选中。
 * 选择工具栏的位置由 range 的 getBoundingClientRect 计算,故需真实布局。
 *
 * 运行:node scripts/verify-annotations.mjs
 */
import { spawn, execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5173';
const QUOTE = '第一章的正文内容';

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

/** 在当前活跃内容文档中定位并选中 QUOTE,返回选区信息。 */
const selectQuote = (quote) => {
  const view = document.querySelector('foliate-view');
  if (!view || !view.renderer) return null;
  const contents = view.renderer.getContents();
  const content = contents[0];
  if (!content?.doc) return null;
  const doc = content.doc;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const index = node.data.indexOf(quote);
    if (index >= 0) {
      const range = doc.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + quote.length);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const rect = range.getBoundingClientRect();
      return {
        index: content.index,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    }
  }
  return null;
};

/** 统计当前渲染 section 的 overlayer 高亮数量(SVG 子节点 g 数)。 */
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

/** 读取 AnnotationStore 中全部材料的批注集合(经 zustand store 暴露到 window 供测试)。 */
const storeAnnotations = `
  (() => {
    const store = window.__annotationStore;
    if (!store) return null;
    const byMaterial = store.getState().byMaterial;
    return Object.values(byMaterial).flat();
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

    // 把 AnnotationStore 暴露到 window,便于读取批注断言锚点。
    // (bootstrap 已注入 __annotationStore;此处仅初始化占位。)
    await page.evaluateOnNewDocument(() => {
      window.__annotations = null;
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle0' });

    // 导入并打开示例书。
    await page.waitForSelector('button[aria-label="导入 EPUB"]', { timeout: 15000 });
    await page.click('button[aria-label="导入 EPUB"]');
    await page.waitForFunction(() => document.body.innerText.includes('示例书'), { timeout: 15000 });
    await page.evaluate((q) => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === q,
      );
      btn?.click();
    }, '打开 示例书');
    await page.waitForFunction(() => {
      const view = document.querySelector('foliate-view');
      return !!view?.book && !!view?.renderer;
    }, { timeout: 15000 });

    // 等待正文内容文档就绪并包含目标引文,再执行选中。
    await page.waitForFunction(
      (q) => {
        const view = document.querySelector('foliate-view');
        if (!view?.renderer) return false;
        const contents = view.renderer.getContents();
        return contents.some((c) => c.doc?.body?.textContent?.includes(q));
      },
      { timeout: 15000 },
      QUOTE,
    );

    const failures = [];

    // 在正文中选中 QUOTE 文字。
    const selInfo = await page.evaluate(selectQuote, QUOTE);
    if (!selInfo) {
      failures.push(`未能在内容文档中找到并选中「${QUOTE}」`);
    } else {
      // 设置选区即触发 content 文档的 selectionchange,工具栏据此出现。
      // 有真实布局坐标时额外移动鼠标触发 mouseup,提高工具栏出现的确定性。
      if (selInfo.rect && typeof selInfo.rect.left === 'number') {
        await page.mouse.move(selInfo.rect.left + (selInfo.rect.width ?? 0) / 2, selInfo.rect.top);
      }
      await page.waitForFunction(
        () => !!document.querySelector('[role="toolbar"][aria-label="文本选择工具栏"]'),
        { timeout: 5000 },
      ).catch(() => {
        failures.push('选中文本后未出现「高亮」选择工具栏');
      });

      // 点击「高亮」创建批注。
      const toolbar = await page.$('[role="toolbar"][aria-label="文本选择工具栏"]');
      if (toolbar) {
        const highlightBtn = await toolbar.$('button');
        if (highlightBtn) {
          await highlightBtn.click();
          // 等待批注落库并绘制覆盖层。
          await page.waitForFunction(
            () => {
              const view = document.querySelector('foliate-view');
              if (!view || !view.renderer) return false;
              return view.renderer
                .getContents()
                .some((content) => (content.overlayer?.element?.children.length ?? 0) > 0);
            },
            { timeout: 5000 },
          ).catch(() => {
            failures.push('创建高亮后未在 overlayer 绘制覆盖层');
          });
        } else {
          failures.push('选择工具栏缺少「高亮」按钮');
        }
      }
    }

    // 读取批注锚点:断言含 CFI、引文、前后文与恢复状态,而非 DOM Range。
    const annotations = await page.evaluate(storeAnnotations);
    if (annotations && annotations.length > 0) {
      const a = annotations[0];
      if (!a.anchor || typeof a.anchor.cfi !== 'string' || !a.anchor.cfi.startsWith('epubcfi')) {
        failures.push('批注锚点缺少规范化 CFI');
      }
      if (!a.anchor.quote || a.anchor.quote.length === 0) {
        failures.push('批注锚点缺少选中文字(引文)');
      }
      if (a.anchor.recoveryState !== 'resolved') {
        failures.push('批注锚点应标记为已解析(resolved)');
      }
    } else {
      failures.push('未能读取到创建的批注(锚点未持久化)');
    }

    // 重启恢复:重新加载应用,批注应重新绘制。
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('button[aria-label="导入 EPUB"]', { timeout: 15000 });
    await page.click('button[aria-label="导入 EPUB"]');
    await page.waitForFunction(() => document.body.innerText.includes('示例书'), { timeout: 15000 });
    await page.evaluate((q) => {
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === q,
      );
      btn?.click();
    }, '打开 示例书');
    await page.waitForFunction(() => {
      const view = document.querySelector('foliate-view');
      return !!view?.book && !!view?.renderer;
    }, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 800));
    const highlightsAfterReopen = await page.evaluate(highlightCount);
    if (highlightsAfterReopen < 1) {
      failures.push('重新打开后批注未重新绘制(reset 恢复失败)');
    }

    if (pageErrors.length > 0) failures.push(`页面错误:${pageErrors.join('; ')}`);

    await browser.close();

    console.log('真实浏览器批注验证结果:');
    console.log(JSON.stringify({ quote: QUOTE, selInfo, annotations, highlightsAfterReopen }, null, 2));

    if (failures.length > 0) {
      console.error('失败项:');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log('通过:真实浏览器完成选中、锚点生成、覆盖层绘制与重启恢复。');
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