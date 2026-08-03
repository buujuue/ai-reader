---
status: accepted
---

# 按交互语义与数据完整性划分 TypeScript 和 Rust

TypeScript 拥有 React 工作台、Zustand 状态、Command、BookDocument、Foliate Adapter、选择、锚点恢复、Markdown 编辑和用户交互。

Rust 拥有 SQLite、迁移、SQL、事务、托管文件、原子替换、完整内容指纹、导入恢复、备份恢复和平台路径权限。

两侧通过 typed Tauri commands 与 Repository Interface 协作。TS 不发送任意 SQL，也不获得任意文件系统能力；Rust 不理解 React 焦点、标签、Editor Group 或 DOM Range。

前端采用 React、Vite、TypeScript、Zustand、Tailwind、Radix primitives 和 Lucide。第一版只使用简体中文，不建立国际化层。
