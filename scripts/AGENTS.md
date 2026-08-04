# scripts — 仓库级工具脚本

不属于任何应用或 package 的仓库级脚本。

| 脚本 | 用途 |
| --- | --- |
| `generate-icons.mjs` | 生成 AI Reader 应用图标（PNG 32/128/256/512 + 多尺寸 ICO），输出到 `apps/reader/src-tauri/icons/`。用法：`node scripts/generate-icons.mjs` |

## 约定

- 图标脚本纯 Node 标准库实现，不引入第三方依赖；新增脚本也应保持零依赖或说明理由。
- 修改图标生成逻辑后，重新运行脚本并提交 `apps/reader/src-tauri/icons/` 下的产物。
