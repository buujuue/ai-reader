import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

import {
  AndroidWebViewReadyTimeoutError,
  captureAndroidUiHierarchy,
  parseForegroundActivity,
  validateAndroidScreenshot,
  validateAndroidUiHierarchy,
  waitForAndroidWebViewReady,
} from './android-webview-probe.mjs';

const pngChunk = (type, data) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc(4)]);
};

const makeRgbaPng = (pixels, width, height) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  const rowBytes = width * 4;
  for (let offset = 0; offset < pixels.length; offset += rowBytes) {
    rows.push(Buffer.from([0]), pixels.subarray(offset, offset + rowBytes));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

describe('Android WebView 就绪探测', () => {
  it('能解析 Android 前台窗口中以相对类名表示的 Activity', () => {
    assert.deepEqual(
      parseForegroundActivity(
        'mCurrentFocus=Window{abc u0 com.example.reader/.MainActivity}',
      ),
      {
        packageId: 'com.example.reader',
        activity: 'com.example.reader/.MainActivity',
      },
    );
  });

  it('能解析 Android 35 Activity 管理器中的 resumed Activity', () => {
    assert.deepEqual(
      parseForegroundActivity(
        'mResumedActivity: ActivityRecord{8b1f25b u0 com.buujuue.ai_reader/.MainActivity t8}',
      ),
      {
        packageId: 'com.buujuue.ai_reader',
        activity: 'com.buujuue.ai_reader/.MainActivity',
      },
    );
  });

  it('接受包含可见像素差异的截图并拒绝完全一致的空白帧', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-reader-android-probe-'));
    try {
      const visiblePath = join(directory, 'visible.png');
      const blankPath = join(directory, 'blank.png');
      writeFileSync(visiblePath, makeRgbaPng(Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1));
      writeFileSync(blankPath, makeRgbaPng(Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]), 2, 1));

      assert.equal(validateAndroidScreenshot(visiblePath).valid, true);
      assert.equal(validateAndroidScreenshot(blankPath).valid, false);
      assert.match(validateAndroidScreenshot(blankPath).reason, /完全一致/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('接受目标应用语义树并拒绝覆盖工作台的系统 ANR 对话框', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-reader-android-ui-'));
    try {
      const appPath = join(directory, 'app.xml');
      const anrPath = join(directory, 'anr.xml');
      writeFileSync(
        appPath,
        '<hierarchy><node package="com.example.reader" resource-id="com.example.reader:id/root" /></hierarchy>',
      );
      writeFileSync(
        anrPath,
        '<hierarchy><node package="android" resource-id="android:id/aerr_close" text="Close app" /></hierarchy>',
      );

      assert.equal(validateAndroidUiHierarchy(appPath, 'com.example.reader').valid, true);
      const anr = validateAndroidUiHierarchy(anrPath, 'com.example.reader');
      assert.equal(anr.valid, false);
      assert.match(anr.reason, /系统错误对话框/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('UIAutomator 首次返回空文件时会重试并保留可用语义树', async () => {
    const calls = [];
    let dumpCount = 0;
    const result = await captureAndroidUiHierarchy({
      phase: 'start',
      attempts: 3,
      intervalMs: 1,
      sleepFn: async () => {},
      adb: async (args) => {
        calls.push(args);
        if (args[0] === 'shell' && args[1] === 'uiautomator') {
          dumpCount += 1;
          return `UI hierchary dumped to: ${args[3]}`;
        }
        if (args[0] === 'exec-out' && args[1] === 'cat') {
          return dumpCount === 1
            ? ''
            : '<hierarchy><node package="com.example.reader" /></hierarchy>';
        }
        return '';
      },
    });

    assert.equal(result.valid, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.hierarchy.includes('<hierarchy>'), true);
    assert.equal(result.history[0].hasHierarchy, false);
    assert.equal(result.history[1].hasHierarchy, true);
    assert.equal(calls.some((args) => args[0] === 'exec-out' && args[1] === 'cat'), true);
  });

  it('目标应用已在前台且工作台可识别时立即成功', async () => {
    const result = await waitForAndroidWebViewReady(
      async () => ({
        phase: 'start',
        processAlive: true,
        foregroundPackage: 'com.example.reader',
        webViewReachable: true,
        workbenchVisible: true,
        ready: true,
      }),
      {
        phase: 'start',
        packageId: 'com.example.reader',
        timeoutMs: 100,
        intervalMs: 1,
      },
    );

    assert.equal(result.attempts, 1);
    assert.equal(result.status.ready, true);
    assert.equal(result.history.length, 1);
  });

  it('慢速模拟器在重试后成功并保留尝试记录', async () => {
    const snapshots = [
      {
        phase: 'start',
        processAlive: false,
        foregroundPackage: null,
        webViewReachable: false,
        workbenchVisible: false,
        ready: false,
        reason: '目标进程尚未出现',
      },
      {
        phase: 'start',
        processAlive: true,
        foregroundPackage: 'com.example.reader',
        webViewReachable: false,
        workbenchVisible: false,
        ready: false,
        reason: 'WebView 调试端点尚未出现',
      },
      {
        phase: 'start',
        processAlive: true,
        foregroundPackage: 'com.example.reader',
        webViewReachable: true,
        workbenchVisible: true,
        ready: true,
      },
    ];

    const result = await waitForAndroidWebViewReady(
      async () => snapshots.shift(),
      {
        phase: 'start',
        packageId: 'com.example.reader',
        timeoutMs: 100,
        intervalMs: 1,
      },
    );

    assert.equal(result.attempts, 3);
    assert.deepEqual(
      result.history.map((entry) => entry.reason),
      ['目标进程尚未出现', 'WebView 调试端点尚未出现', undefined],
    );
  });

  it('超过有界等待上限时抛出带阶段和最后状态的诊断', async () => {
    await assert.rejects(
      () =>
        waitForAndroidWebViewReady(
          async () => ({
            phase: 'touch',
            processAlive: true,
            foregroundPackage: 'com.example.reader',
            webViewReachable: true,
            workbenchVisible: false,
            ready: false,
            reason: '页面仍为空白',
          }),
          {
            phase: 'touch',
            packageId: 'com.example.reader',
            timeoutMs: 8,
            intervalMs: 1,
          },
        ),
      (error) => {
        assert.ok(error instanceof AndroidWebViewReadyTimeoutError);
        assert.equal(error.diagnostic.phase, 'touch');
        assert.equal(error.diagnostic.packageId, 'com.example.reader');
        assert.equal(error.diagnostic.lastStatus.reason, '页面仍为空白');
        assert.ok(error.diagnostic.attempts > 0);
        assert.match(error.message, /touch/);
        assert.match(error.message, /超时/);
        return true;
      },
    );
  });

  it('单次探测卡住时仍在总上限内结束并保留阶段诊断', async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        waitForAndroidWebViewReady(
          () => new Promise(() => {}),
          {
            phase: 'restart',
            packageId: 'com.example.reader',
            timeoutMs: 8,
            intervalMs: 1,
          },
        ),
      (error) => {
        assert.ok(error instanceof AndroidWebViewReadyTimeoutError);
        assert.equal(error.diagnostic.phase, 'restart');
        assert.equal(error.diagnostic.lastStatus.reason, '探测器异常：restart 阶段单次 WebView 探测超时');
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 250);
  });
});
