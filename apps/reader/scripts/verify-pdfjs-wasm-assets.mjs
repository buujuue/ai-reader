import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(appRoot, 'node_modules/pdfjs-dist/wasm');
const outputDir = resolve(appRoot, 'dist/pdfjs/wasm');
const workerDir = resolve(appRoot, 'dist/assets');

const runtimeFiles = readdirSync(sourceDir).filter((fileName) =>
  /\.(?:wasm|js)$/.test(fileName),
);
const missingFiles = runtimeFiles.filter((fileName) => !existsSync(resolve(outputDir, fileName)));
if (missingFiles.length > 0) {
  throw new Error(`PDF.js WASM 资源未打包: ${missingFiles.join(', ')}`);
}

const workerFile = readdirSync(workerDir).find((fileName) =>
  /^pdf\.worker(?:\.min)?-.*\.mjs$/.test(fileName),
);
if (!workerFile) {
  throw new Error('未找到构建后的 PDF.js Worker');
}

const workerSource = readFileSync(resolve(workerDir, workerFile), 'utf8');
if (!workerSource.includes('jbig2.wasm')) {
  throw new Error(`PDF.js Worker 未包含 JBIG2 解码器引用: ${workerFile}`);
}

console.log(`PDF.js WASM 资源校验通过: ${runtimeFiles.length} 个文件, ${workerFile}`);
