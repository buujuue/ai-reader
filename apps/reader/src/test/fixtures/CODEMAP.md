# `src/test/fixtures` — 可复用测试夹具

## 功能

- `maliciousContent.ts`：包含脚本、嵌入对象、事件属性和危险 URL 的 EPUB XHTML 与 Markdown 夹具。
- `epub/`：EPUB 核心阅读循环的确定性样书、资源预算契约和可序列化基准记录。

## 依赖其它文件夹（树）

```
src/test/fixtures/  ──► src/domain/reader/sanitizer.test.ts
                   ──► src/test/fixtures/epub/epubCoreContract.test.ts
```

## 被谁依赖（树）

被安全清洗测试和 EPUB 核心契约测试使用，不参与生产运行时。

## 依赖方向

夹具只向测试提供不可信输入；它不依赖生产模块，也不改变应用运行时边界。
