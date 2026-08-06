# `src/types` — 第三方/全局类型声明

## 功能

- `foliate-js.d.ts`：`foliate-js` 的最小类型声明。foliate-js 无官方类型，这里只声明本项目用到的窄面（`View` 的 open/init/next/prev/goTo/close 与 `makeBook`），供 `domain/reader/foliateViewHost.ts` 使用。

## 依赖其它文件夹（树）

无（类型声明不依赖任何 `src/` 文件夹）。

## 被谁依赖（树）

```
types/
└── domain/reader/   foliateViewHost.ts 引用 foliate-js 类型
```

## 依赖方向

`types/` 是纯类型声明层，不参与运行时逻辑；它只为引入的第三方模块（foliate-js）补齐类型信息。新增第三方无类型声明时在此登记对应 `.d.ts`。