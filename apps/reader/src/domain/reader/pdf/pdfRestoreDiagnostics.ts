/**
 * PDF 回切诊断日志。
 *
 * 默认关闭，避免把阅读过程中的高频位置事件写入生产日志。Windows Tauri
 * 开发者工具中可执行：
 *
 *   window.__aiReaderPdfRestoreDiagnostics.enable()
 *   window.__aiReaderPdfRestoreDiagnostics.export()
 *
 * 也可以在加载应用前把 localStorage 的 `ai-reader.pdf-restore-debug` 设为 `1`。
 * 诊断数据只保留在当前 WebView 的内存环形缓冲区，不进入 Workspace 或书库。
 */

export const PDF_RESTORE_DIAGNOSTIC_PREFIX = '[DEBUG-PDF-RESTORE-v1]';
const PDF_RESTORE_DIAGNOSTIC_STORAGE_KEY = 'ai-reader.pdf-restore-debug';
const MAX_DIAGNOSTIC_EVENTS = 500;

export interface PdfRestoreDiagnosticContext {
  viewId?: string | null;
  materialId?: string | null;
  runtimeId?: string | null;
  transitionId?: string | null;
}

export interface PdfRestoreDiagnosticReporter {
  viewId?: string | null;
  materialId?: string | null;
  runtimeId?: string | null;
  getTransitionId?: () => string | null | undefined;
}

export interface PdfRestoreDiagnosticEvent {
  seq: number;
  at: number;
  phase: string;
  context: PdfRestoreDiagnosticContext;
  details: Record<string, unknown>;
}

export interface PdfRestoreDiagnosticApi {
  enable: () => void;
  disable: () => void;
  clear: () => void;
  getEvents: () => PdfRestoreDiagnosticEvent[];
  export: () => string;
  copy: () => Promise<string>;
  getLastTransition: () => PdfRestoreDiagnosticEvent[];
  exportLastTransition: () => string;
  copyLastTransition: () => Promise<string>;
}

let diagnosticsEnabledOverride: boolean | undefined;
let nextSequence = 0;
let nextRuntimeSequence = 0;
let nextTransitionSequence = 0;
const events: PdfRestoreDiagnosticEvent[] = [];
const runtimeIds = new WeakMap<object, string>();

function getGlobalScope(): typeof globalThis & {
  __AI_READER_PDF_RESTORE_DEBUG__?: boolean;
  __aiReaderPdfRestoreDiagnostics?: PdfRestoreDiagnosticApi;
} {
  return globalThis as typeof globalThis & {
    __AI_READER_PDF_RESTORE_DEBUG__?: boolean;
    __aiReaderPdfRestoreDiagnostics?: PdfRestoreDiagnosticApi;
  };
}

function readStorageFlag(): boolean {
  try {
    return globalThis.localStorage?.getItem(PDF_RESTORE_DIAGNOSTIC_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function isPdfRestoreDiagnosticsEnabled(): boolean {
  if (diagnosticsEnabledOverride !== undefined) return diagnosticsEnabledOverride;
  if (getGlobalScope().__AI_READER_PDF_RESTORE_DEBUG__ === true) return true;
  if (readStorageFlag()) return true;
  try {
    return new URL(globalThis.location?.href ?? '').searchParams.get('debug') === 'pdf-restore';
  } catch {
    return false;
  }
}

export function setPdfRestoreDiagnosticsEnabled(enabled: boolean): void {
  diagnosticsEnabledOverride = enabled;
  getGlobalScope().__AI_READER_PDF_RESTORE_DEBUG__ = enabled;
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(PDF_RESTORE_DIAGNOSTIC_STORAGE_KEY, '1');
    } else {
      globalThis.localStorage?.removeItem(PDF_RESTORE_DIAGNOSTIC_STORAGE_KEY);
    }
  } catch {
    // Tauri/WebView 的 localStorage 可能被策略禁用；内存开关仍然有效。
  }
}

export function clearPdfRestoreDiagnostics(): void {
  events.length = 0;
}

export function getPdfRestoreDiagnostics(): PdfRestoreDiagnosticEvent[] {
  return events.map((event) => ({
    ...event,
    context: { ...event.context },
    details: { ...event.details },
  }));
}

export function exportPdfRestoreDiagnostics(): string {
  return JSON.stringify(
    {
      schemaVersion: 'pdf-restore-diagnostics.v1',
      prefix: PDF_RESTORE_DIAGNOSTIC_PREFIX,
      exportedAt: new Date().toISOString(),
      events: getPdfRestoreDiagnostics(),
    },
    null,
    2,
  );
}

function containsPageOne(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsPageOne);
  return Object.entries(value).some(([key, nested]) =>
    (key === 'page' || key === 'currentPage' || key === 'targetPage') && nested === 1
      ? true
      : containsPageOne(nested),
  );
}

/** 只保留最近一次切换事务,并压掉高频重复通知;页码 1 相关事件始终保留。 */
export function getLastPdfRestoreTransition(): PdfRestoreDiagnosticEvent[] {
  const transitionId = [...events]
    .reverse()
    .find((event) => event.context.transitionId)?.context.transitionId;
  if (!transitionId) return events.slice(-100);
  const noisyPhases = new Set([
    'renderer.scroll',
    'document.notify-location',
    'position.location-event',
  ]);
  return events.filter((event) => {
    if (event.context.transitionId !== transitionId) return false;
    return !noisyPhases.has(event.phase) || containsPageOne(event.details);
  });
}

export function exportLastPdfRestoreTransition(): string {
  return JSON.stringify(
    {
      schemaVersion: 'pdf-restore-diagnostics.v1',
      scope: 'last-transition',
      prefix: PDF_RESTORE_DIAGNOSTIC_PREFIX,
      exportedAt: new Date().toISOString(),
      events: getLastPdfRestoreTransition(),
    },
    null,
    2,
  );
}

export async function copyLastPdfRestoreTransition(): Promise<string> {
  const value = exportLastPdfRestoreTransition();
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) return value;
  try {
    await clipboard.writeText(value);
  } catch {
    // DevTools 聚焦时 WebView document 可能失焦,Clipboard API 会抛出
    // NotAllowedError;返回文本让调用方交给 DevTools 的 copy() 函数。
  }
  return value;
}

export async function copyPdfRestoreDiagnostics(): Promise<string> {
  const value = exportPdfRestoreDiagnostics();
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) return value;
  try {
    await clipboard.writeText(value);
  } catch {
    // 同 copyLastPdfRestoreTransition:页面失焦时回退为返回 JSON,不阻断采集。
  }
  return value;
}

export function createPdfRestoreRuntimeId(): string {
  nextRuntimeSequence += 1;
  return `pdf-runtime-${nextRuntimeSequence}`;
}

export function getPdfRestoreRuntimeId(value: object): string {
  const existing = runtimeIds.get(value);
  if (existing) return existing;
  const created = createPdfRestoreRuntimeId();
  runtimeIds.set(value, created);
  return created;
}

export function createPdfRestoreTransitionId(): string {
  nextTransitionSequence += 1;
  return `pdf-transition-${nextTransitionSequence}`;
}

function normalizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!details) return {};
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value instanceof Error) {
      normalized[key] = { name: value.name, message: value.message };
    } else if (typeof value === 'bigint') {
      normalized[key] = value.toString();
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function logPdfRestoreDiagnostic(
  phase: string,
  context: PdfRestoreDiagnosticContext = {},
  details?: Record<string, unknown>,
): void {
  if (!isPdfRestoreDiagnosticsEnabled()) return;
  const event: PdfRestoreDiagnosticEvent = {
    seq: ++nextSequence,
    at: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    phase,
    context: { ...context },
    details: normalizeDetails(details),
  };
  events.push(event);
  if (events.length > MAX_DIAGNOSTIC_EVENTS) events.splice(0, events.length - MAX_DIAGNOSTIC_EVENTS);
  // JSON keeps the event copy/pasteable and makes DevTools filtering reliable.
  console.log(`${PDF_RESTORE_DIAGNOSTIC_PREFIX} ${JSON.stringify(event)}`);
}

const diagnosticApi: PdfRestoreDiagnosticApi = {
  enable: () => setPdfRestoreDiagnosticsEnabled(true),
  disable: () => setPdfRestoreDiagnosticsEnabled(false),
  clear: clearPdfRestoreDiagnostics,
  getEvents: getPdfRestoreDiagnostics,
  export: exportPdfRestoreDiagnostics,
  copy: copyPdfRestoreDiagnostics,
  getLastTransition: getLastPdfRestoreTransition,
  exportLastTransition: exportLastPdfRestoreTransition,
  copyLastTransition: copyLastPdfRestoreTransition,
};

getGlobalScope().__aiReaderPdfRestoreDiagnostics = diagnosticApi;
