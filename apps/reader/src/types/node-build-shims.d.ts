/**
 * Vite 配置使用的最小 Node.js 类型声明。
 * 应用本身不引入 Node 运行时 API,这里只为 Vite 配置的资源复制插件提供类型。
 */
declare module 'node:fs' {
  export function readFileSync(path: string): Uint8Array;
  export function readdirSync(path: string): string[];
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string;
}
