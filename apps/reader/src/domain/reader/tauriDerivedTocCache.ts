import { invoke } from '@tauri-apps/api/core';

import type { TauriInvoke } from '../tauriInvoke';
import type { EpubDerivedTocCache } from './derivedToc';

export const DERIVED_TOC_CACHE_COMMANDS = {
  read: 'read_epub_derived_toc_cache',
  write: 'write_epub_derived_toc_cache',
} as const;

/** Tauri 私有文件缓存的 typed 前端适配器。 */
export function createTauriEpubDerivedTocCache(
  invokeCommand: TauriInvoke,
): EpubDerivedTocCache {
  return {
    async get(key) {
      const value = await invokeCommand(DERIVED_TOC_CACHE_COMMANDS.read, { key });
      return typeof value === 'string' ? value : undefined;
    },
    async set(key, value) {
      await invokeCommand(DERIVED_TOC_CACHE_COMMANDS.write, { key, value });
    },
  };
}

export function createDefaultTauriEpubDerivedTocCache(): EpubDerivedTocCache {
  return createTauriEpubDerivedTocCache((command, args) => invoke(command, args));
}
