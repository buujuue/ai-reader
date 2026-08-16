# `src/test/fixtures/epub` — EPUB 验收样书

## 功能

- `epubFixtureContract.ts`：EPUB 支持/降级/拒绝结果、资源预算、特征覆盖和来源登记。
- `epubFixtures.ts`：只用标准 API 确定性生成最小 EPUB/ZIP 样书，不含第三方电子书正文。
- `epubBenchmark.ts`：把导入、首次打开、章节切换和内存读数统一为可序列化基准记录。
- `epubCoreContract.test.ts`：自动检查覆盖矩阵、预算边界、ZIP 结构和基准阶段。

## 依赖其它文件夹

```
src/test/fixtures/epub/ ──► src/domain/library/epub/epubInspector.ts
                        ──► src/domain/library/epub/zip.ts
```

## 被谁依赖

仅被 EPUB 核心契约测试与后续真实浏览器/Tauri 基准脚本使用，不参与生产运行时。

## 依赖方向与边界

夹具只向测试提供不可信 EPUB 字节和验收元数据；生产阅读器不能依赖本目录，
也不能把夹具生成器当作导入或解压实现。
