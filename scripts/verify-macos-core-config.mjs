import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tauriConfig = JSON.parse(
  readFileSync(join(root, 'apps', 'reader', 'src-tauri', 'tauri.conf.json'), 'utf8'),
);
const capability = JSON.parse(
  readFileSync(join(root, 'apps', 'reader', 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const windows = tauriConfig.app?.windows ?? [];
const permissions = capability.permissions ?? [];
const csp = tauriConfig.app?.security?.csp ?? '';

assert(tauriConfig.bundle?.active === true, 'Tauri bundle must be active');
assert(tauriConfig.bundle?.targets === 'all', 'Tauri bundle targets must include every host platform');
assert(
  tauriConfig.bundle?.macOS?.minimumSystemVersion === '12.0',
  'macOS minimum system version must remain explicit at 12.0',
);
assert(windows.length === 1, 'The desktop app must have exactly one native window');
assert(windows[0]?.label === 'main', 'The native window must use the main label');
assert(windows[0]?.minWidth >= 720 && windows[0]?.minHeight >= 480, 'The native window must keep the reader minimum size');
assert(tauriConfig.build?.beforeDevCommand === 'pnpm dev', 'Native development must use the shared Vite entrypoint');
assert(tauriConfig.build?.beforeBuildCommand === 'pnpm build', 'Native builds must use the shared frontend build');
assert(capability.windows?.length === 1 && capability.windows[0] === 'main', 'The default capability must only target the main window');
assert(permissions.includes('dialog:allow-open'), 'The main window needs the system open dialog');
assert(permissions.includes('dialog:allow-save'), 'The main window needs the system save dialog');
assert(permissions.includes('opener:allow-open-url'), 'The main window needs the system URL opener');
for (const broadPermission of ['dialog:default', 'opener:default', 'fs:default', 'shell:default', 'sql:default']) {
  assert(!permissions.includes(broadPermission), `Broad permission must not be granted: ${broadPermission}`);
}
assert(csp.includes("script-src 'self'"), 'Book content must not broaden executable script sources');
assert(csp.includes("object-src 'none'"), 'Book content must not embed arbitrary objects');
assert(!/script-src[^;]*(?:https?:|http:)/.test(csp), 'Book content must not load remote scripts');

console.log('macOS core configuration is valid');
