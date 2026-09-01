import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return existsSync(join(ROOT, relativePath));
}

const packageJson = JSON.parse(read('package.json'));
const tauriConfig = JSON.parse(read('apps/reader/src-tauri/tauri.conf.json'));
const capability = JSON.parse(read('apps/reader/src-tauri/capabilities/default.json'));
const workflow = read('.github/workflows/cross-platform.yml');
const workflowActionReferences = [...workflow.matchAll(/^\s+uses:\s+(\S+)(?:\s+#\s*(.*))?$/gm)].map(
  ([, reference, comment]) => ({ reference, comment: comment?.trim() ?? '' }),
);
const expectedWorkflowActionComments = new Map([
  ['actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0', 'v7.0.0'],
  ['pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271', 'v6'],
  ['actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', 'v6'],
  ['actions/setup-java@0f481fcb613427c0f801b606911222b5b6f3083a', 'v5'],
  ['dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8', 'stable'],
  ['actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', 'v7.0.1'],
  ['reactivecircus/android-emulator-runner@a421e43855164a8197daf9d8d40fe71c6996bb0d', 'v2'],
]);
const csp = tauriConfig.app?.security?.csp ?? '';
const dependencies = Object.keys({
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
}).join('\n');
const rustManifest = read('apps/reader/src-tauri/Cargo.toml');
const androidSmoke = read('.github/scripts/android-emulator-smoke.sh');
const tauriImportAdapter = read('apps/reader/src/domain/library/tauriImportRepository.ts');
const tauriCommands = read('apps/reader/src-tauri/src/lib.rs');
const readerCommands = read('apps/reader/src/workbench/readerCommands.ts');
const performanceScript = read('apps/reader/scripts/verify-reading-performance.mjs');
const runtimeCacheScript = read('apps/reader/scripts/verify-reader-runtime-cache.mjs');
const runtimeCache = read('apps/reader/src/workbench/readerRuntimeCache.ts');
const appStyles = read('apps/reader/src/index.css');

const checks = [
  {
    name: '版本锁定与许可记录存在',
    pass:
      exists('pnpm-lock.yaml') &&
      exists('Cargo.lock') &&
      exists('docs/legal/third-party.md') &&
      packageJson.packageManager === 'pnpm@10.18.2',
  },
  {
    name: '权威项目文档已覆盖最终架构与跨端验证',
    pass:
      exists('AGENTS.md') &&
      exists('CONTEXT.md') &&
      exists('.scratch/reader-foundation/spec.md') &&
      exists('docs/architecture/overview.md') &&
      exists('docs/architecture/cross-platform-validation.md') &&
      exists('docs/architecture/v1-delivery-acceptance.md'),
  },
  {
    name: '跨端工作流包含 Windows、macOS、iPadOS 和 Android 原生 job',
    pass:
      workflow.includes('name: Windows') &&
      workflow.includes('name: macOS') &&
      workflow.includes('name: iPadOS 原生验证') &&
      workflow.includes('name: Android tablet 原生验证') &&
      workflow.includes('pnpm tauri ios build') &&
      workflow.includes('pnpm tauri android build') &&
      androidSmoke.includes('screencap -p'),
  },
  {
    name: '跨端基础 Action 使用 Node.js 24 兼容版本并固定不可变提交',
    pass:
      workflowActionReferences.length > 0 &&
      workflowActionReferences.every(
        ({ reference, comment }) =>
          /^[^@\s]+@[0-9a-f]{40}$/.test(reference) &&
          expectedWorkflowActionComments.get(reference) === comment,
      ),
  },
  {
    name: '书籍内容安全边界已配置且未授予任意文件/命令/数据库权限',
    pass:
      csp.includes("default-src 'self'") &&
      csp.includes("script-src 'self'") &&
      csp.includes("object-src 'none'") &&
      csp.includes('connect-src ipc:') &&
      !capability.permissions.some((permission) => /^(?:fs|shell|sql):/.test(permission)),
  },
  {
    name: '恶意 EPUB/Markdown fixture 已接入清洗测试',
    pass:
      exists('apps/reader/src/test/fixtures/maliciousContent.ts') &&
      read('apps/reader/src/domain/reader/sanitizer.test.ts').includes(
        "../../test/fixtures/maliciousContent",
      ) &&
      read('apps/reader/src/domain/reader/sanitizer.ts').includes('FORBIDDEN_TAGS'),
  },
  {
    name: '危险 URL、外链拦截和 Tauri IPC 边界有测试/实现',
    pass:
      read('apps/reader/src/domain/reader/foliateViewHost.ts').includes(
        'wireExternalLinkBlocking',
      ) &&
      read('apps/reader/src/domain/reader/foliateViewHost.test.ts').includes(
        '外部链接被转发给订阅者并以 preventDefault 阻止默认导航',
      ) &&
      read('apps/reader/src-tauri/src/lib.rs').includes('tauri::generate_handler!'),
  },
  {
    name: '流式导入与 PDF 画布预算有性能约束',
    pass:
      read('apps/reader/src-tauri/src/fs.rs').includes('64 * 1024') &&
      read('apps/reader/src/domain/reader/pdf/pdfPageRenderer.ts').includes(
        'MAX_CANVAS_PIXELS',
      ) &&
      read('apps/reader/src/domain/reader/pdf/pdfPageRenderer.test.ts').includes(
        '画布内存预算',
      ) &&
      read('apps/reader/src/workbench/readerCommands.ts').includes('disposeViewRuntime'),
  },
  {
    name: 'EPUB/PDF/Markdown 阅读边界统一使用 Source 且有性能回归验收',
    pass:
      exists('apps/reader/scripts/verify-reading-performance.mjs') &&
      !tauriImportAdapter.includes("readManaged: 'read_managed_file'") &&
      !tauriCommands.includes('commands::import::read_managed_file,') &&
      readerCommands.includes('openManagedFileSource') &&
      performanceScript.includes('MAX_RANGE_BYTES') &&
      performanceScript.includes('totalReadBytes') &&
      performanceScript.includes('hasValidVisiblePage') &&
      performanceScript.includes('getPageCount') &&
      performanceScript.includes('getReaderRuntimeDocumentForMeasurement') &&
      !performanceScript.includes("import('/src/workbench/readerRuntime.ts')"),
  },
  {
    name: '大型阅读范围性能验收已接入持续集成并上传记录',
    pass:
      workflow.includes('pnpm --dir apps/reader test:reading-performance') &&
      workflow.includes('ai-reader-reading-performance-${{ github.sha }}'),
  },
  {
    name: 'Issue #63 三材料轮换与资源压力总验收入口已接入',
    pass:
      runtimeCacheScript.includes('issue: 63') &&
      runtimeCacheScript.includes("schemaVersion: 'reader-runtime-cache.v6'") &&
      runtimeCacheScript.includes('EPUB→Markdown→PDF→EPUB') &&
      runtimeCacheScript.includes('residentTriple') &&
      runtimeCacheScript.includes('sameFormatTriple') &&
      runtimeCacheScript.includes('pdfResidentTriple') &&
      runtimeCacheScript.includes('fourthResidentPressure') &&
      runtimeCacheScript.includes('resourcePressure') &&
      runtimeCacheScript.includes('lookupMissDiagnostic') &&
      runtimeCacheScript.includes('EPUB↔EPUB') &&
      runtimeCacheScript.includes('Markdown↔Markdown') &&
      runtimeCacheScript.includes('PDF↔PDF') &&
      runtimeCacheScript.includes('formatMatrix') &&
      runtimeCacheScript.includes('shutdownCleanup') &&
      runtimeCacheScript.includes('buildLargePdfFixture') &&
      runtimeCacheScript.includes('pdfDocumentLoads') &&
      runtimeCacheScript.includes('pdfRasterizations') &&
      runtimeCacheScript.includes('bookDocumentCreates') &&
      runtimeCache.includes('lookupMisses') &&
      runtimeCache.includes('admissionRejections') &&
      exists('docs/adr/0043-runtime-stress-and-platform-evidence.md') &&
      workflow.includes('pnpm --dir apps/reader test:reader-runtime-cache') &&
      workflow.includes('ai-reader-reader-runtime-cache-${{ github.sha }}'),
  },
  {
    name: 'TypeScript Repository 与 Tauri Adapter 共用契约测试',
    pass:
      exists('apps/reader/src/domain/workspace/workspaceRepository.contract.ts') &&
      exists('apps/reader/src/domain/library/importRepository.contract.ts') &&
      exists('apps/reader/src/domain/annotation/annotationRepository.contract.ts') &&
      exists('apps/reader/src/domain/library/backupRepository.contract.ts') &&
      exists('apps/reader/src/domain/workspace/inMemoryWorkspaceRepository.test.ts') &&
      exists('apps/reader/src/domain/workspace/tauriWorkspaceRepository.test.ts') &&
      exists('apps/reader/src-tauri/src/db/mod.rs'),
  },
  {
    name: '树型书库在 reduced-motion 与高对比模式下保留可见状态反馈',
    pass:
      appStyles.includes('prefers-reduced-motion') &&
      appStyles.includes('forced-colors: active') &&
      appStyles.includes("data-drop-state='valid'"),
  },
  {
    name: '第一版未引入 AI、Agent、OCR、账号或云同步运行时依赖',
    pass: !/(?:openai|langchain|llama|tesseract|ocr|embedding|vector-db|firebase|supabase|oauth)/i.test(
      `${dependencies}\n${rustManifest}`,
    ),
  },
  {
    name: 'Android/iPadOS/macOS 配置回归脚本与证据文档存在',
    pass:
      exists('scripts/verify-macos-core-config.mjs') &&
      exists('scripts/verify-ipados-core-config.mjs') &&
      exists('scripts/verify-android-core-config.mjs') &&
      exists('docs/architecture/macos-core-smoke.md') &&
      exists('docs/architecture/ipados-core-smoke.md') &&
      exists('docs/architecture/android-core-smoke.md') &&
      read('docs/architecture/macos-core-smoke.md').includes('budgetFallback') &&
      read('docs/architecture/ipados-core-smoke.md').includes('backgroundReturn') &&
      read('docs/architecture/android-core-smoke.md').includes('locationRestored'),
  },
];

const failed = checks.filter((check) => !check.pass);
for (const check of checks) {
  console.log(`${check.pass ? '通过' : '失败'}: ${check.name}`);
}

if (failed.length > 0) {
  console.error(`\n第一版交付静态验收失败，共 ${failed.length} 项。`);
  process.exitCode = 1;
} else {
  console.log('\n第一版交付静态验收通过；仍需按文档执行测试命令和原生人工冒烟。');
}
