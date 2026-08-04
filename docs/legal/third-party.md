# 第三方许可与来源

AI Reader 本身以 AGPL-3.0 发布(见根目录 `LICENSE`)。本文件记录当前底座实际使用的第三方组件及后续切片计划复用的关键来源,确保署名与许可义务清晰。

## 当前底座使用的组件

### JavaScript / TypeScript

| 组件 | 版本策略 | 许可证 | 用途 |
| --- | --- | --- | --- |
| React / react-dom | ^19 | MIT | 工作台界面 |
| Zustand | ^5 | MIT | Workspace Store |
| lucide-react | ^1 | ISC | 活动栏图标 |
| Vite / @vitejs/plugin-react | ^7 / ^5 | MIT | 构建与开发服务器 |
| TypeScript | ~5.9 | Apache-2.0 | 类型系统 |
| Vitest / jsdom / Testing Library | ^4 / ^30 / ^16 | MIT 等 | 前端测试 |
| Tailwind CSS | ^4 | MIT | 样式 |
| @tauri-apps/api / @tauri-apps/cli | ^2 | MIT / Apache-2.0 | Tauri IPC 与工具链 |

精确版本以 `pnpm-lock.yaml` 为准。

### Rust

| crate | 版本策略 | 许可证 | 用途 |
| --- | --- | --- | --- |
| tauri / tauri-build | ^2 | MIT / Apache-2.0 | 应用框架 |
| rusqlite(bundled SQLite) | ^0.40 | MIT | SQLite 绑定;SQLite 本身为公有领域(public domain) |
| serde / serde_json | ^1 | MIT / Apache-2.0 | typed 命令序列化 |
| thiserror | ^2 | MIT / Apache-2.0 | 错误类型 |

精确版本以 `Cargo.lock` 为准。

## 计划复用的阅读内核

后续切片将按 `docs/adr/0001` 与规格的选择性复用原则引入:

- **foliate-js**(Readest 分支):MIT 许可。引入时将在 `packages/foliate-js` 保留上游版权声明、许可文本与固定来源记录。
- **PDF.js**:Apache-2.0 许可。引入时保留版权声明与 NOTICE 要求。

引入任一组件的切片必须同时提交其许可文本与来源记录,不先行创建空包。

## 借鉴说明

本项目架构与阅读行为大量参考 [readest/readest](https://github.com/readest/readest)(AGPL-3.0),但为独立重写,不复制其应用层代码、状态模型或用户数据格式。若未来直接移植任何 Readest 代码片段,将逐处登记来源、许可与署名。
