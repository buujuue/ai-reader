import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPdfRestoreDiagnostics,
  createPdfRestoreRuntimeId,
  createPdfRestoreTransitionId,
  exportPdfRestoreDiagnostics,
  getPdfRestoreDiagnostics,
  getPdfRestoreRuntimeId,
  getLastPdfRestoreTransition,
  logPdfRestoreDiagnostic,
  setPdfRestoreDiagnosticsEnabled,
} from './pdfRestoreDiagnostics';

describe('PDF 回切诊断日志', () => {
  beforeEach(() => {
    setPdfRestoreDiagnosticsEnabled(false);
    clearPdfRestoreDiagnostics();
    vi.restoreAllMocks();
  });

  it('默认关闭且启用后保留可导出的结构化事件', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logPdfRestoreDiagnostic('ignored');
    expect(getPdfRestoreDiagnostics()).toEqual([]);

    setPdfRestoreDiagnosticsEnabled(true);
    logPdfRestoreDiagnostic(
      'position.persist.begin',
      { viewId: 'view-1', materialId: 'material-1', transitionId: 'transition-1' },
      { location: { kind: 'pdf', page: 5, scrollTop: 1234 } },
    );

    const events = getPdfRestoreDiagnostics();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'position.persist.begin',
      context: { viewId: 'view-1', materialId: 'material-1', transitionId: 'transition-1' },
    });
    expect(events[0]!.seq).toBeGreaterThan(0);
    expect(exportPdfRestoreDiagnostics()).toContain('pdf-restore-diagnostics.v1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG-PDF-RESTORE-v1]'));
  });

  it('为同一个 Runtime 保持稳定 ID,并为切换事务生成不同 ID', () => {
    const runtime = {};
    expect(getPdfRestoreRuntimeId(runtime)).toBe(getPdfRestoreRuntimeId(runtime));
    expect(createPdfRestoreRuntimeId()).not.toBe(createPdfRestoreRuntimeId());
    expect(createPdfRestoreTransitionId()).not.toBe(createPdfRestoreTransitionId());
  });

  it('可只导出最近一次切换并保留页码 1 相关事件', () => {
    setPdfRestoreDiagnosticsEnabled(true);
    logPdfRestoreDiagnostic('transition.begin', { transitionId: 'transition-old' });
    logPdfRestoreDiagnostic('renderer.scroll', { transitionId: 'transition-old' }, { page: 4 });
    logPdfRestoreDiagnostic('transition.begin', { transitionId: 'transition-new' });
    logPdfRestoreDiagnostic('renderer.scroll', { transitionId: 'transition-new' }, { page: 1 });
    logPdfRestoreDiagnostic('renderer.scroll', { transitionId: 'transition-new' }, { page: 5 });

    const events = getLastPdfRestoreTransition();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.phase)).toEqual(['transition.begin', 'renderer.scroll']);
    expect(events[1]!.details).toEqual({ page: 1 });
  });
});
