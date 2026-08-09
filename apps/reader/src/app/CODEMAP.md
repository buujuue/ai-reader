# `src/app` — 应用外壳与依赖组装

## 功能

- `main.tsx`（位于 `src/` 根，不在本目录）通过 `createRoot` 挂载，组合 `AppServicesProvider` 与 `App`。
- `bootstrap.ts`：组装 `AppServices`（`CommandRegistry` + `WorkspaceRepository` + `ImportRepository` + `FilePicker` + `ExternalUrlOpener` + `WindowLifecycle`）。`isTauriRuntime()` 检测 `__TAURI_INTERNALS__`，据此选择 Tauri Adapter 或内存 Adapter；桌面端的 `WindowLifecycle` 只暴露关闭请求监听与销毁窗口两项能力；`createAppServices()` 注册工作台、书库与阅读命令，内存降级时用演示 EPUB 种子化书库，可注入平台窄接口供测试。
- `filePicker.ts`：`FilePicker` 窄接口，`pickEpubs()` 一次返回多份文件路径。Tauri 端经 `@tauri-apps/plugin-dialog` 打开系统文件选择器（`multiple: true`）；内存端返回固定演示源路径数组。
- `externalUrlOpener.ts`：`ExternalUrlOpener` 窄接口，把外部链接交给系统浏览器。Tauri 端经 `@tauri-apps/plugin-opener` 的 `openUrl`；浏览器降级用 `window.open`。实现 ADR-0010：阅读 WebView 不导航到外部站点。
- `AppServicesContext.tsx`：React 上下文，向组件树提供 `AppServices`；`useAppServices()` 供任意组件取用。
- `App.tsx`：工作台顶层外壳，启动时恢复工作区与书库、经 `reader.restoreView` 重建持久化标签，再执行 `markdown.recovery.check` 展示 Recovery Snapshot；组合工作台组件与各类对话框。Tauri 关闭请求会先阻止默认关闭，等待阅读位置与 Markdown 恢复快照 flush 后销毁窗口；页面隐藏/卸载保留尽力 flush。
- `App.test.tsx`：应用级测试，含“打开 EPUB 并重启续读”验收路径、“关闭请求等待恢复快照落盘”、“回收站:安全删除资料”流程与“目录与外部链接”流程。

## 依赖其它文件夹（树）

```
app/
├── commands/           创建 CommandRegistry
├── domain/workspace/   创建并用 WorkspaceRepository 加载状态
├── domain/library/     创建 ImportRepository 与演示源;zipWriter 生成演示 EPUB
├── domain/reader/      viewHost 类型(测试用伪宿主)
├── workbench/          registerWorkbenchCommands / registerLibraryCommands / registerReaderCommands;
│                       useWorkspaceStore / useShellUiStore / useLibraryStore / useReaderRuntime 状态
└── components/         渲染外壳组件
```

## 被谁依赖（树）

```
src/ main.tsx  ──►  app/
                    ├── App
                    ├── AppServicesProvider
                    └── createAppServices
```

## 依赖方向

`app/` 是组合根：它依赖 `commands/`、`domain/`、`workbench/`、`components/`，但上述目录不反向依赖 `app/`（`useAppServices` 例外，供组件消费服务）。
