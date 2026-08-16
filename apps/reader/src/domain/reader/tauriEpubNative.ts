import { invoke } from '@tauri-apps/api/core';

import {
  createTauriEpubNativeAccelerator,
  type EpubNativeAccelerator,
} from './nativeEpub';

/** 生产环境的 Tauri typed invoke 适配器；具体 parity 校验仍在 nativeEpub.ts。 */
export function createDefaultTauriEpubNativeAccelerator(): EpubNativeAccelerator {
  return createTauriEpubNativeAccelerator((command, args) => invoke(command, args));
}
