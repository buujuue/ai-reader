# `src/test` — 测试环境配置

## 功能

- `setup.ts`：Vitest 全局测试环境配置。引入 `@testing-library/jest-dom/vitest` 的匹配器，并在每个用例后执行 `@testing-library/react` 的 `cleanup()`，避免跨用例 DOM 泄漏。

## 依赖其它文件夹（树）

无（仅引入测试库）。

## 被谁依赖（树）

```
vitest.config.ts  ──►  test/setup.ts  ──►  整个 src/ 的测试套件
```

## 依赖方向

`test/` 是测试基础设施，不参与运行时依赖图；被测试套件被动加载。