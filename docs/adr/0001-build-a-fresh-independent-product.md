---
status: accepted
---

# 从空仓库构建独立产品

AI Reader 在新仓库中从最小纵向切片逐步构建，不从 Readest main 建立长期分支，也不承诺 Readest 数据兼容。Readest 是实现参照和选择性代码来源，而不是产品升级路径。

项目采用 AGPL-3.0。复用 Readest 应用代码时保留来源与许可；`foliate-js` 和 PDF.js 分别遵循自身第三方许可。

## Consequences

- 每次架构决定先核对 Readest 的真实实现及修复背景。
- 只引入当前纵向切片需要的代码、依赖和平台权限。
- 不创建空的 AI、同步或 SDK Module。
- 旧决定“从当前 main 裁剪首版”在本项目中失效。
