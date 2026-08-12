import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const tauriConfig = JSON.parse(read('apps/reader/src-tauri/tauri.conf.json'));
const capability = JSON.parse(read('apps/reader/src-tauri/capabilities/default.json'));
const cargoManifest = read('apps/reader/src-tauri/Cargo.toml');
const workflow = read('.github/workflows/cross-platform.yml');
const viewport = read('apps/reader/index.html');
const filePicker = read('apps/reader/src/app/filePicker.ts');
const bootstrap = read('apps/reader/src/app/bootstrap.ts');
const backButton = read('apps/reader/src/app/androidBackButton.ts');
const backButtonTest = read('apps/reader/src/app/androidBackButton.test.ts');
const readingInput = read('apps/reader/src/domain/reader/readingInput.ts');
const readingInputTest = read('apps/reader/src/domain/reader/readingInput.test.ts');
const layoutPolicy = read('apps/reader/src/workbench/layoutPolicy.ts');
const layoutPolicyTest = read('apps/reader/src/workbench/layoutPolicy.test.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const permissions = capability.permissions ?? [];
const csp = tauriConfig.app?.security?.csp ?? '';

assert(tauriConfig.bundle?.active === true, 'Tauri bundle must be active');
assert(tauriConfig.bundle?.targets === 'all', 'Tauri bundle targets must include every host platform');
assert(
  cargoManifest.includes('crate-type = ["staticlib", "cdylib", "lib"]'),
  'The Tauri library must expose mobile crate types',
);
assert(
  bootstrap.includes("onBackButtonPress") && backButton.includes('resolveAndroidBackAction'),
  'Android back handling must use the Tauri back button event and a tested resolver',
);
assert(viewport.includes('viewport-fit=cover'), 'The frontend viewport must extend into Android safe areas');
assert(filePicker.includes("fileAccessMode: 'copy'"), 'Android imports must copy files into the app sandbox');
assert(filePicker.includes("pickerMode: 'document'"), 'Android imports must use the system document picker');
for (const mimeType of ['application/epub+zip', 'application/pdf', 'text/markdown']) {
  assert(filePicker.includes(mimeType), `Android picker must include MIME type ${mimeType}`);
}
assert(!permissions.some((permission) => /^fs:|^shell:|^sql:/.test(permission)), 'Android must not receive broad filesystem or shell permissions');
assert(csp.includes("script-src 'self'"), 'Book content must not broaden executable script sources');
assert(csp.includes("object-src 'none'"), 'Book content must not embed arbitrary objects');
assert(workflow.includes('name: Android tablet'), 'The cross-platform workflow must include Android tablet validation');
assert(workflow.includes('runs-on: ubuntu-24.04'), 'Android validation must run on a Linux Android-capable runner');
assert(
  workflow.includes('libwebkit2gtk-4.1-dev') && workflow.includes('libayatana-appindicator3-dev'),
  'The Android Linux runner must install Tauri host build dependencies before Rust checks',
);
assert(workflow.includes('pnpm tauri android init'), 'The Android job must generate the native project');
assert(workflow.includes('pnpm tauri android build'), 'The Android job must build a native APK');
assert(workflow.includes('android-emulator-runner'), 'The Android job must use a real Android emulator');
assert(workflow.includes('adb install'), 'The Android job must install the generated APK');
assert(workflow.includes('screencap -p'), 'The Android job must capture real WebView tablet evidence');
assert(workflow.includes('adb logcat'), 'The Android job must upload Android runtime logs');
assert(workflow.includes('actions/upload-artifact@v7'), 'The workflow must use the Node 24 artifact action');
assert(readingInput.includes("type: 'touch'"), 'Touch input must remain part of the reader input seam');
assert(readingInput.includes('setSelecting'), 'Touch input must preserve text-selection priority');
assert(backButtonTest.includes('delegateToWebView'), 'Back behavior must have resolver tests');
assert(readingInputTest.includes('hasSelection: true'), 'Touch selection priority must have a test');
assert(layoutPolicy.includes('COMPACT_LAYOUT_MAX_WIDTH'), 'Compact tablet layout must remain explicitly tested');
assert(layoutPolicyTest.includes("mode: 'compact'"), 'Compact tablet layout must have a test');

console.log('Android tablet core configuration is valid');
