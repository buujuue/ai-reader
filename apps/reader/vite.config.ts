import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const pdfjsWasmSourceDir = fileURLToPath(
  new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url),
);
const pdfjsWasmFiles = readdirSync(pdfjsWasmSourceDir).filter((fileName) =>
  /\.(?:wasm|js)$/.test(fileName),
);
const pdfjsWasmFileSet = new Set(pdfjsWasmFiles);

/**
 * pdfjs-dist 5.x 的图片解码器在运行时从 wasmUrl 读取 WASM 与 JS fallback。
 * 这些文件不通过 import 进入 Vite 模块图，因此开发服务器和构建产物都需要
 * 显式提供同一组静态资源。
 */
function pdfjsWasmAssets(): Plugin {
  return {
    name: 'ai-reader:pdfjs-wasm-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = (request as unknown as { url?: string }).url?.split('?')[0] ?? '';
        const marker = '/pdfjs/wasm/';
        const markerIndex = requestPath.indexOf(marker);
        if (markerIndex < 0) {
          next();
          return;
        }

        let fileName: string;
        try {
          fileName = decodeURIComponent(requestPath.slice(markerIndex + marker.length));
        } catch {
          next();
          return;
        }
        if (!pdfjsWasmFileSet.has(fileName)) {
          next();
          return;
        }

        const contentType = fileName.endsWith('.wasm')
          ? 'application/wasm'
          : 'text/javascript; charset=utf-8';
        response.statusCode = 200;
        response.setHeader('Content-Type', contentType);
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        response.end(readFileSync(`${pdfjsWasmSourceDir}/${fileName}`));
      });
    },
    generateBundle() {
      for (const fileName of pdfjsWasmFiles) {
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs/wasm/${fileName}`,
          source: readFileSync(`${pdfjsWasmSourceDir}/${fileName}`),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsWasmAssets()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
