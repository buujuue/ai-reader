---
status: accepted
---

# 通过一条应用级 Seam 验收纵向切片

最高测试 Seam 是 Windows Tauri 应用中的完整用户路径：导入、书库、打开、阅读、批注、关闭和重启恢复。每个纵向切片扩展同一路径，不为 React 内部结构建立大量脆弱端到端测试。

Rust 测试负责数据库、文件、指纹、导入恢复和备份；Vitest 负责工作区、Command、布局、身份和锚点；Vitest Browser 使用真实 Foliate 验证三种格式。TypeScript 内存 Repository 与 Rust Adapter 共享契约测试。

macOS、iPadOS 和 Android 平板至少提供原生启动、文件选择、导入、打开、阅读与位置恢复冒烟证据。浏览器设备模拟不算原生移动验收。
