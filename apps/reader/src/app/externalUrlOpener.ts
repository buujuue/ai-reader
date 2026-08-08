import { openUrl } from '@tauri-apps/plugin-opener';

import { isTauriRuntime } from './bootstrap';

/**
 * 外部链接打开器窄接口。外部链接先向用户展示目标,确认后经本接口交给系统浏览器。
 * 这实现 ADR-0010:阅读 WebView 不导航到外部站点。
 */
export interface ExternalUrlOpener {
  /** 在系统浏览器中打开目标 URL。 */
  open(url: string): Promise<void>;
}

/** Tauri 实现:经 opener 插件交给系统浏览器。 */
export function createTauriExternalUrlOpener(): ExternalUrlOpener {
  return {
    async open(url: string): Promise<void> {
      await openUrl(url);
    },
  };
}

/** 浏览器降级实现:用 window.open 打开新标签页。 */
export function createBrowserExternalUrlOpener(): ExternalUrlOpener {
  return {
    async open(url: string): Promise<void> {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };
}

export function createDefaultExternalUrlOpener(): ExternalUrlOpener {
  return isTauriRuntime()
    ? createTauriExternalUrlOpener()
    : createBrowserExternalUrlOpener();
}