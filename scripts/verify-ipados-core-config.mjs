import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const tauriConfig = JSON.parse(read('apps/reader/src-tauri/tauri.conf.json'));
const capability = JSON.parse(read('apps/reader/src-tauri/capabilities/default.json'));
const workflow = read('.github/workflows/cross-platform.yml');
const viewport = read('apps/reader/index.html');
const rustEntry = read('apps/reader/src-tauri/src/lib.rs');
const filePicker = read('apps/reader/src/app/filePicker.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const permissions = capability.permissions ?? [];
const csp = tauriConfig.app?.security?.csp ?? '';

assert(tauriConfig.bundle?.active === true, 'Tauri bundle must be active');
assert(tauriConfig.bundle?.targets === 'all', 'Tauri bundle targets must include every host platform');
assert(
  rustEntry.includes('#[cfg_attr(mobile, tauri::mobile_entry_point)]'),
  'The Rust entry point must opt into Tauri mobile initialization',
);
assert(
  viewport.includes('viewport-fit=cover'),
  'The frontend viewport must extend into iPadOS safe areas',
);
assert(
  filePicker.includes("['epub', 'pdf', 'md', 'markdown']"),
  'The native picker must expose EPUB, PDF and Markdown materials',
);
assert(permissions.includes('dialog:allow-open'), 'The main window needs the system open dialog');
assert(csp.includes("script-src 'self'"), 'Book content must not broaden executable script sources');
assert(csp.includes("object-src 'none'"), 'Book content must not embed arbitrary objects');
assert(workflow.includes('name: iPadOS'), 'The main cross-platform workflow must include iPadOS');
assert(workflow.includes('pnpm tauri ios init'), 'The iPadOS job must generate the native Xcode project');
assert(workflow.includes('pnpm tauri ios build'), 'The iPadOS job must build a native simulator app');
assert(workflow.includes('xcrun simctl launch'), 'The iPadOS job must launch the native app');
assert(workflow.includes('xcrun simctl io'), 'The iPadOS job must capture real WebView evidence');

console.log('iPadOS core configuration is valid');
