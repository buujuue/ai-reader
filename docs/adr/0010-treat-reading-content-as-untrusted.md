---
status: accepted
---

# 将所有阅读内容视为不可信

第一版永久禁用 EPUB 和 Markdown 中的书籍脚本，不提供“信任此书”开关。脚本、iframe、对象嵌入、危险属性和可执行 URL 在进入渲染器前清理。

书籍不得主动加载远程脚本、页面、字体或图片；只允许包内资源、应用托管资源以及必要的 blob/data 图片。外部链接交给统一 Command，展示目标后由系统浏览器打开。

Tauri CSP、Capability 和 Command scope 使用最小白名单。Foliate 内部因 WebKit 事件所需的脚本权限只服务于应用打包的阅读器桥接代码，不允许书籍脚本或远程来源取得 IPC。

未来互动 EPUB 若进入范围，必须运行在无 Tauri IPC 权限的独立隔离环境中。
