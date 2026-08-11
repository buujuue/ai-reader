# scripts — 仓库级工具脚本

不属于任何应用或 package 的仓库级脚本。

| 脚本 | 用途 |
| --- | --- |
| `generate-icons.mjs` | 生成 AI Reader 应用图标（PNG 32/128/256/512 + 多尺寸 ICO/ICNS），输出到 `apps/reader/src-tauri/icons/`。用法：`node scripts/generate-icons.mjs` |

## 约定

- `verify-macos-core-config.mjs`：校验 macOS 核心阅读冒烟所需的 Tauri 打包、单窗口和最小权限配置。用法：`node scripts/verify-macos-core-config.mjs`
- `verify-ipados-core-config.mjs`：校验 iPadOS 核心阅读冒烟所需的 Tauri 移动入口、文件选择器、安全区元数据和原生工作流步骤。用法：`node scripts/verify-ipados-core-config.mjs`

- 图标脚本纯 Node 标准库实现，不引入第三方依赖；新增脚本也应保持零依赖或说明理由。
- 修改图标生成逻辑后，重新运行脚本并提交 `apps/reader/src-tauri/icons/` 下的产物。
