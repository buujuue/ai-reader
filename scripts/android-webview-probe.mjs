import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import http from 'node:http';
import zlib from 'node:zlib';

const execFileAsync = promisify(execFile);

export const ANDROID_WEBVIEW_PROBE_SCHEMA = 'android-webview-probe.v1';
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_READY_INTERVAL_MS = 500;
export const DEFAULT_CDP_PORT = 9333;
const MAX_DIAGNOSTIC_HISTORY = 24;

const sleep = (durationMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const boundedPush = (items, item) => {
  items.push(item);
  if (items.length > MAX_DIAGNOSTIC_HISTORY) items.shift();
};

export class AndroidWebViewReadyTimeoutError extends Error {
  constructor(diagnostic) {
    super(
      `Android ${diagnostic.phase} 阶段等待真实 WebView 工作台就绪超时 ` +
        `（${diagnostic.timeoutMs}ms，已尝试 ${diagnostic.attempts} 次）`,
    );
    this.name = 'AndroidWebViewReadyTimeoutError';
    this.diagnostic = diagnostic;
  }
}

/**
 * Wait for an observable Android WebView state instead of sleeping for a
 * fixed amount of time. The probe is intentionally injected so the retry
 * policy can be tested without an emulator.
 */
export async function waitForAndroidWebViewReady(
  probe,
  {
    phase,
    packageId,
    timeoutMs = DEFAULT_READY_TIMEOUT_MS,
    intervalMs = DEFAULT_READY_INTERVAL_MS,
    now = () => Date.now(),
    sleepFn = sleep,
  },
) {
  const startedAt = now();
  const deadline = startedAt + Math.max(1, timeoutMs);
  const history = [];
  let attempts = 0;
  let lastStatus = {
    phase,
    ready: false,
    reason: '尚未开始探测',
  };

  while (now() < deadline || attempts === 0) {
    attempts += 1;
    try {
      const probed = await withTimeout(
        probe(),
        Math.max(1, deadline - now()),
        `${phase} 阶段单次 WebView 探测超时`,
      );
      lastStatus = probed && typeof probed === 'object'
        ? probed
        : { phase, ready: false, reason: '探测器没有返回状态' };
    } catch (error) {
      lastStatus = {
        phase,
        ready: false,
        reason: `探测器异常：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    boundedPush(history, {
      attempt: attempts,
      elapsedMs: Math.max(0, now() - startedAt),
      ...lastStatus,
    });

    if (lastStatus.ready === true) {
      return {
        attempts,
        elapsedMs: Math.max(0, now() - startedAt),
        status: lastStatus,
        history,
      };
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(Math.max(1, intervalMs), remainingMs));
  }

  throw new AndroidWebViewReadyTimeoutError({
    phase,
    packageId,
    timeoutMs,
    intervalMs,
    attempts,
    elapsedMs: Math.max(0, now() - startedAt),
    lastStatus,
    history,
  });
}

export function parseProcessId(output) {
  const match = String(output ?? '').match(/\b(\d+)\b/);
  return match ? match[1] : null;
}

export function parseForegroundActivity(output) {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .filter((line) =>
      /mCurrentFocus|mFocusedApp|mResumedActivity|topResumedActivity|ResumedActivity/.test(line),
    );
  for (const line of lines) {
    const match = line.match(/\b([A-Za-z][\w.-]*)\/([A-Za-z0-9_.$-]+)\b/);
    if (match) {
      return {
        packageId: match[1],
        activity: `${match[1]}/${match[2]}`,
      };
    }
  }
  return { packageId: null, activity: null };
}

export function isAndroidWebViewWorkbenchReady(status, packageId) {
  return (
    status?.processAlive === true &&
    status?.foregroundPackage === packageId &&
    status?.webViewReachable === true &&
    status?.workbenchVisible === true &&
    status?.ready === true
  );
}

function pngChunkType(buffer, offset) {
  return buffer.subarray(offset, offset + 4).toString('ascii');
}

/**
 * Validate the PNG produced by `adb screencap -p` and reject a uniform frame.
 * Android screenshots are normally non-interlaced 8-bit RGB/RGBA PNGs; those
 * are decoded here with Node's standard library so a blank compositor frame
 * cannot pass evidence validation merely because the file has bytes.
 */
export function validateAndroidScreenshot(path) {
  let png;
  try {
    png = readFileSync(path);
  } catch (error) {
    return { valid: false, reason: `无法读取截图：${safeErrorMessage(error)}` };
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < signature.length || !png.subarray(0, 8).equals(signature)) {
    return { valid: false, reason: '截图不是有效 PNG' };
  }

  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlaceMethod;
  const compressedRows = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) return { valid: false, reason: 'PNG chunk 超出文件边界' };
    const type = pngChunkType(png, dataStart - 4);
    const data = png.subarray(dataStart, dataEnd);
    if (type === 'IHDR' && data.length >= 13) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlaceMethod = data[12];
    } else if (type === 'IDAT') {
      compressedRows.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height || !compressedRows.length) {
    return { valid: false, reason: 'PNG 缺少图像头或像素数据' };
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlaceMethod !== 0) {
    return { valid: false, reason: '不支持的 Android 截图像素格式' };
  }

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(compressedRows));
  } catch (error) {
    return { valid: false, reason: `PNG 像素数据解压失败：${safeErrorMessage(error)}` };
  }

  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const expectedBytes = height * (rowBytes + 1);
  if (raw.length < expectedBytes) return { valid: false, reason: 'PNG 像素数据不完整' };

  let previous = new Uint8Array(rowBytes);
  let firstPixel;
  let hasDifferentPixel = false;
  let hasVisiblePixel = false;
  let rawOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[rawOffset++];
    const current = new Uint8Array(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= channels ? current[index - channels] : 0;
      const above = previous[index] ?? 0;
      const upperLeft = index >= channels ? previous[index - channels] ?? 0 : 0;
      const value = raw[rawOffset++];
      if (filter === 0) current[index] = value;
      else if (filter === 1) current[index] = (value + left) & 0xff;
      else if (filter === 2) current[index] = (value + above) & 0xff;
      else if (filter === 3) current[index] = (value + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        const estimate = left + above - upperLeft;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - above);
        const pc = Math.abs(estimate - upperLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
        current[index] = (value + predictor) & 0xff;
      } else {
        return { valid: false, reason: `PNG 使用未知行过滤器：${filter}` };
      }
    }

    for (let pixel = 0; pixel < width; pixel += 1) {
      const pixelOffset = pixel * channels;
      const currentPixel = Buffer.from(current.subarray(pixelOffset, pixelOffset + channels));
      if (!firstPixel) firstPixel = currentPixel;
      else if (!currentPixel.equals(firstPixel)) hasDifferentPixel = true;
      if (colorType === 2 || current[pixelOffset + 3] > 0) hasVisiblePixel = true;
    }
    previous = current;
  }

  if (!hasVisiblePixel) return { valid: false, width, height, reason: '截图像素全部透明' };
  if (!hasDifferentPixel) return { valid: false, width, height, reason: '截图像素完全一致，疑似空白界面' };
  return { valid: true, width, height, nonUniform: true };
}

export function validateAndroidUiHierarchy(path, packageId) {
  let hierarchy;
  try {
    hierarchy = readFileSync(path, 'utf8');
  } catch (error) {
    return { valid: false, reason: `无法读取 UIAutomator 语义树：${safeErrorMessage(error)}` };
  }

  if (!hierarchy.includes('<hierarchy')) {
    return { valid: false, reason: 'UIAutomator 语义树格式无效' };
  }
  if (hierarchy.includes('android:id/aerr_')) {
    return { valid: false, reason: '系统错误对话框覆盖了目标应用工作台' };
  }
  if (
    packageId
    && !hierarchy.includes(`package="${packageId}"`)
    && !hierarchy.includes(`package='${packageId}'`)
  ) {
    return { valid: false, reason: `UIAutomator 语义树不包含目标包 ${packageId}` };
  }
  return { valid: true };
}

function safeErrorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/\s+/g, ' ').slice(0, 240);
}

function createAdbRunner() {
  return async (args, timeoutMs = 10_000) => {
    const result = await execFileAsync('adb', args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return String(result.stdout ?? '');
  };
}

async function safeAdb(adb, args, timeoutMs = 10_000) {
  try {
    return { ok: true, stdout: await adb(args, timeoutMs), error: null };
  } catch (error) {
    return { ok: false, stdout: '', error: safeErrorMessage(error) };
  }
}

function httpGetJson(port, path, timeoutMs = 2_500) {
  return new Promise((resolvePromise, reject) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { Host: 'localhost' },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(`CDP ${path} 返回 HTTP ${response.statusCode ?? 'unknown'}`));
            return;
          }
          try {
            resolvePromise(JSON.parse(body));
          } catch (error) {
            reject(new Error(`CDP ${path} 返回无效 JSON：${safeErrorMessage(error)}`));
          }
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`CDP ${path} 请求超时`)));
  });
}

class CdpPage {
  static async connect(target, timeoutMs = 2_500) {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node.js 不支持 WebSocket，无法探测 Android WebView');
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('CDP WebSocket 连接超时'));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolvePromise();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败'));
      }, { once: true });
    });
    const page = new CdpPage(socket, timeoutMs);
    try {
      await page.send('Runtime.enable');
      return page;
    } catch (error) {
      page.close();
      throw error;
    }
  }

  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP 调用失败'));
      else pending.resolve(message);
    });
  }

  send(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 调用超时`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
    const exception = response.result?.exceptionDetails;
    if (exception) {
      throw new Error(
        `工作台探测脚本异常：${exception.exception?.description ?? exception.text ?? 'unknown'}`,
      );
    }
    return response.result?.result?.value;
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP 页面连接已关闭'));
    }
    this.pending.clear();
    this.socket.close();
  }
}

const WORKBENCH_PROBE_EXPRESSION = `(() => {
  const root = document.querySelector('#root');
  const shell = document.querySelector('.app-shell');
  const banner = document.querySelector('[role="banner"][aria-label="应用顶栏"]');
  const appMark = document.querySelector('[aria-label="AI Reader"]');
  const readerMain = document.querySelector('#reader-main');
  const editorArea = document.querySelector('[aria-label="编辑器区"]');
  const isVisible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const rect = shell?.getBoundingClientRect();
  const rootRect = root?.getBoundingClientRect();
  const workbenchVisible = Boolean(
    isVisible(shell) && rect && rect.width > 0 && rect.height > 0 &&
    rootRect && rootRect.width > 0 && rootRect.height > 0,
  );
  const recognizableIdentity = isVisible(appMark) || isVisible(banner);
  const structureReady = [banner, appMark, readerMain, editorArea].every(isVisible);
  return {
    documentReadyState: document.readyState,
    appShell: Boolean(shell),
    applicationBar: Boolean(banner),
    aiReaderMark: Boolean(appMark),
    readerMain: Boolean(readerMain),
    editorArea: Boolean(editorArea),
    workbenchVisible,
    recognizableIdentity,
    structureReady,
    ready: document.readyState === 'complete' && workbenchVisible && recognizableIdentity && structureReady,
  };
})()`;

function emptyStatus(phase, reason) {
  return {
    schemaVersion: ANDROID_WEBVIEW_PROBE_SCHEMA,
    phase,
    ready: false,
    processAlive: false,
    pid: null,
    foregroundPackage: null,
    foregroundActivity: null,
    devtoolsSocket: null,
    forwardedPort: null,
    webViewReachable: false,
    targetId: null,
    targetUrl: null,
    documentReadyState: null,
    appShell: false,
    applicationBar: false,
    aiReaderMark: false,
    readerMain: false,
    editorArea: false,
    workbenchVisible: false,
    recognizableIdentity: false,
    structureReady: false,
    reason,
  };
}

async function probeAndroidWebViewOnce({ adb, packageId, port, phase }) {
  const status = emptyStatus(phase, '等待目标应用启动');
  const processResult = await safeAdb(adb, ['shell', 'pidof', packageId]);
  const pid = parseProcessId(processResult.stdout);
  status.pid = pid;
  status.processAlive = Boolean(pid);

  const activityResult = await safeAdb(adb, ['shell', 'dumpsys', 'activity', 'activities']);
  const foreground = parseForegroundActivity(activityResult.stdout);
  status.foregroundPackage = foreground.packageId;
  status.foregroundActivity = foreground.activity;

  if (!status.processAlive) {
    status.reason = processResult.error ? '读取目标进程失败' : '目标进程尚未出现';
    return status;
  }
  if (status.foregroundPackage !== packageId) {
    status.reason = activityResult.error
      ? '读取前台 Activity 失败'
      : `目标应用尚未位于前台（当前：${status.foregroundPackage ?? '未知'}）`;
    return status;
  }

  const socketResult = await safeAdb(adb, ['shell', 'cat', '/proc/net/unix']);
  const socketName = `webview_devtools_remote_${pid}`;
  if (!socketResult.stdout.includes(`@${socketName}`)) {
    status.reason = socketResult.error ? '读取 WebView 调试 socket 失败' : 'WebView 调试端点尚未出现';
    return status;
  }

  status.devtoolsSocket = socketName;
  const removeForward = () => safeAdb(adb, ['forward', '--remove', `tcp:${port}`]);
  await removeForward();
  const forwardResult = await safeAdb(
    adb,
    ['forward', `tcp:${port}`, `localabstract:${socketName}`],
    10_000,
  );
  if (!forwardResult.ok) {
    status.reason = 'WebView 调试端口转发失败';
    return status;
  }
  status.forwardedPort = port;

  let page;
  try {
    const targets = await httpGetJson(port, '/json/list');
    const target = Array.isArray(targets)
      ? targets.find((candidate) => candidate?.type === 'page' && candidate?.webSocketDebuggerUrl)
      : null;
    if (!target) {
      status.webViewReachable = true;
      status.reason = 'WebView 已响应但尚未暴露页面目标';
      return status;
    }
    status.webViewReachable = true;
    status.targetId = target.id ?? null;
    status.targetUrl = target.url ?? null;
    page = await CdpPage.connect({
      ...target,
      // The WebView advertises its device-side websocket URL. After adb
      // forwarding, always connect through the host port we own instead of
      // trusting the device-side port in that URL.
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${target.id}`,
    });
    const domStatus = await page.evaluate(WORKBENCH_PROBE_EXPRESSION);
    Object.assign(status, domStatus ?? {});
    status.ready = isAndroidWebViewWorkbenchReady(status, packageId)
      && status.documentReadyState === 'complete'
      && status.recognizableIdentity === true
      && status.structureReady === true;
    status.reason = status.ready ? null : 'WebView 页面已连接但工作台尚未完成绘制';
    return status;
  } catch (error) {
    status.reason = `WebView 探测失败：${safeErrorMessage(error)}`;
    return status;
  } finally {
    page?.close();
    await removeForward();
  }
}

export async function runAndroidWebViewProbe({
  phase,
  packageId,
  port = DEFAULT_CDP_PORT,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_READY_INTERVAL_MS,
  adb = createAdbRunner(),
  now,
  sleepFn,
}) {
  try {
    const result = await waitForAndroidWebViewReady(
      () => probeAndroidWebViewOnce({ adb, packageId, port, phase }),
      { phase, packageId, timeoutMs, intervalMs, now, sleepFn },
    );
    return {
      schemaVersion: ANDROID_WEBVIEW_PROBE_SCHEMA,
      phase,
      packageId,
      result: 'ready',
      ...result,
    };
  } catch (error) {
    if (!(error instanceof AndroidWebViewReadyTimeoutError)) throw error;
    return {
      schemaVersion: ANDROID_WEBVIEW_PROBE_SCHEMA,
      phase,
      packageId,
      result: 'timeout',
      attempts: error.diagnostic.attempts,
      elapsedMs: error.diagnostic.elapsedMs,
      timeoutMs,
      intervalMs,
      status: error.diagnostic.lastStatus,
      history: error.diagnostic.history,
      diagnostic: error.diagnostic,
    };
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2).replaceAll('-', '_');
    values[key] = argv[index + 1];
    index += 1;
  }
  const required = ['phase', 'package_id', 'output'];
  for (const key of required) {
    if (!values[key]) throw new Error(`缺少参数 --${key.replaceAll('_', '-')}`);
  }
  return {
    phase: values.phase,
    packageId: values.package_id,
    port: Number(values.port ?? DEFAULT_CDP_PORT),
    timeoutMs: Number(values.timeout_ms ?? DEFAULT_READY_TIMEOUT_MS),
    intervalMs: Number(values.interval_ms ?? DEFAULT_READY_INTERVAL_MS),
    output: resolve(values.output),
  };
}

async function main() {
  if (process.argv[2] === '--validate-png') {
    const path = process.argv[3];
    const result = path
      ? validateAndroidScreenshot(path)
      : { valid: false, reason: '缺少 PNG 路径' };
    if (result.valid) console.log(`Android 截图有效且包含可见内容：${result.width}x${result.height}`);
    else console.error(`Android 截图校验失败：${result.reason}`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }
  if (process.argv[2] === '--validate-ui') {
    const path = process.argv[3];
    const packageArgumentIndex = process.argv.indexOf('--package-id');
    const packageId = packageArgumentIndex >= 0 ? process.argv[packageArgumentIndex + 1] : null;
    const result = path
      ? validateAndroidUiHierarchy(path, packageId)
      : { valid: false, reason: '缺少 UIAutomator 语义树路径' };
    if (result.valid) console.log(`Android UIAutomator 语义树有效且属于目标包：${packageId}`);
    else console.error(`Android UIAutomator 语义树校验失败：${result.reason}`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(options.output), { recursive: true });
  let report;
  try {
    report = await runAndroidWebViewProbe(options);
  } catch (error) {
    report = {
      schemaVersion: ANDROID_WEBVIEW_PROBE_SCHEMA,
      phase: options.phase,
      packageId: options.packageId,
      result: 'error',
      error: safeErrorMessage(error),
    };
  }
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `Android ${options.phase} WebView 探测：${report.result}，尝试 ${report.attempts ?? 0} 次`,
  );
  if (report.result !== 'ready') {
    console.error(`Android ${options.phase} 阶段失败：${report.status?.reason ?? report.error ?? '未知原因'}`);
    process.exitCode = 1;
  }
}

const modulePath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && existsSync(process.argv[1])
  && resolve(process.argv[1]) === resolve(modulePath);

if (isMain) await main();
