# `src/app` — 应用外壳与依赖组装

## 功能

- `App.tsx`：默认渲染 C 风格暗色生产工作台，读取 `LayoutPolicy`，为中等/紧凑容器渲染互斥的覆盖式书库/目录抽屉，并保留 Editor Group、侧栏和阅读位置等工作区状态；活动面板宽度由 `Workspace Store` 驱动并由 `SidebarResizeHandle` 调整；材料批注面板是按 materialId 绑定的运行时覆盖层；根容器承接平台安全区。`WorkbenchPrototype` 仍仅用于视觉对比，内含默认极夜黑与四套新增浅色配色、每套对应背景光及临时开关，并在活动栏提供界面面板预览阅读排版；主题配色在面板底部默认折叠，不接入生产主题状态。

- `main.tsx`（位于 `src/` 根，不在本目录）通过 `createRoot` 挂载，组合 `AppServicesProvider` 与 `App`。
- `bootstrap.ts`：组装 `AppServices`（含 `EpubNativeAccelerator`）。`isTauriRuntime()` 检测 `__TAURI_INTERNALS__`，据此选择 Tauri Adapter 或内存 Adapter；Tauri 原生预取默认经过协议、能力、语义来源与平台门控，当前仅启用已验证的 Windows，其他平台返回不可用 Adapter；任意失败由阅读命令透明回退纯 JS。桌面端的 `WindowLifecycle` 只暴露关闭请求监听与销毁窗口两项能力，Android 端通过 Tauri `onBackButtonPress` 注入系统返回事件；`createAppServices()` 注册工作台、书库、批注导出、备份与阅读命令，内存降级时用演示 EPUB 种子化书库，可注入平台窄接口供测试。书库命令与阅读命令共享同一组依赖；重新关联或重新导入资料后，Tauri 端重载应用，浏览器降级端重建该材料的活动阅读视图。
- `filePicker.ts`：`FilePicker` 窄接口，`pickEpubs()` 一次返回多份文件路径。Tauri 端经 `@tauri-apps/plugin-dialog` 打开系统文件选择器（`multiple: true`）；Android 使用文档模式、MIME 类型和 `fileAccessMode: 'copy'`，内存端返回固定演示源路径数组。
- `androidBackButton.ts`：纯函数返回行为解析器，按脏 Markdown/恢复对话框、材料批注覆盖层、其它对话框、搜索、紧凑抽屉和源码模式的优先级生成动作；`App.tsx` 将动作转为既有 Command，避免系统返回键直接销毁窗口。
- `platform.ts`：集中判断当前是否为 Android 原生 WebView，供文件选择器和返回键平台 Adapter 复用。
- `externalUrlOpener.ts`：`ExternalUrlOpener` 窄接口，把外部链接交给系统浏览器。Tauri 端经 `@tauri-apps/plugin-opener` 的 `openUrl`；浏览器降级用 `window.open`。实现 ADR-0010：阅读 WebView 不导航到外部站点。
- `backupDestinationPicker.ts`：备份目标保存对话框窄接口。Tauri 端经 `@tauri-apps/plugin-dialog` 的 `save`；取消返回 `null`，浏览器降级明确不提供目标。
- `annotationExportDestinationPicker.ts`：单本批注 Markdown 的系统保存位置选择器；Tauri 端经 `save` 选择 `.md` 文件，取消返回 `null`，浏览器降级不写任意本地文件。
- `AppServicesContext.tsx`：React 上下文，向组件树提供 `AppServices`；`useAppServices()` 供任意组件取用。
- `App.tsx`：工作台顶层外壳，默认接入 `ApplicationBar`、两入口 `ActivityBar`、真实书库/目录侧栏与材料批注覆盖层；启动时恢复工作区与书库、经 `reader.restoreView` 重建持久化标签，再执行 `markdown.recovery.check` 展示 Recovery Snapshot；组合工作台组件与各类对话框，包括 EPUB 版本迁移确认与恢复快照。Tauri 关闭请求会先阻止默认关闭，等待阅读位置与 Markdown 恢复快照 flush 后销毁窗口；页面隐藏/卸载保留尽力 flush。
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
<!-- 完整书库恢复入口：backupSourcePicker.ts 与 backupCommands.ts 通过 BackupRepository 调用 Rust 恢复事务。 -->
