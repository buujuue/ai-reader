---
status: accepted
---

# Markdown 复用全局工作台主题并保持编辑恢复一致

## 决策

Markdown 阅读模式复用可重排 EPUB 已建立的 `WorkbenchAppearance` 五主题入口、正文纸张令牌、精确纯黑转换和 Foliate `setStyles` 生命周期。Markdown 不创建独立主题枚举、颜色映射副本、材料颜色存储或新的持久化通道。科技黑的普通正文为 `#ffffff`，其余四主题的普通正文为 `#000000`，基础正文背景使用当前主题的不透明纸张色。

旧 `ReadingTypography.theme` 仍保留给 PDF 及其它尚未迁移的格式和历史 Workspace State；它不覆盖 EPUB/Markdown 的实际配色。Markdown 的字体、字号、行距、页边距和分页/滚动继续沿用既有全局默认与材料级排版作用域，材料级旧 `theme` 仅作为兼容数据，不作为颜色来源。

## 生命周期与状态边界

工作台主题是本机外观偏好，不进入 Markdown 源文本、共享 `MarkdownDocumentSession` 脏状态、撤销历史、正式版本、Recovery Snapshot、材料记录或完整书库备份。主题改变只更新已经存在的可重排 EPUB/Markdown Runtime；源码模式、打开途中、挂起回切、缓存冷重建和恢复流程在创建 Foliate Runtime 前读取当前本机主题。

Markdown 的内容失效、正式保存、放弃编辑、恢复快照和双 Editor Group 仍由既有 Markdown Command/共享会话边界负责。主题不会触发文本重写、版本变化、位置清理或批注锚点迁移；同一材料的跨组 Runtime 独立渲染但共享会话和主题来源，各自保留位置、模式、选区归属与编辑焦点。

## 样式保真与安全边界

清洗后的 Markdown XHTML/CSS 进入渲染器前复用已有可重排阅读主题转换：默认正文和明确纯黑声明跟随主题，显式灰色、其它彩色及其继承后代、链接、代码、局部背景、图片、SVG/公式、高亮、搜索结果和选区保持原有语义。转换支持内联样式末尾无分号的合法声明，但不扩大 Markdown 清洗器允许的标签、属性、URL 或资源能力。

PDF、固定版式 EPUB、整页图片与其现有主题行为不受影响。主题变化不改变三 resident、两 active 和 PDF 预算边界。

## 参考实现与取舍

Readest `apps/readest-app/src/utils/style.ts` 的样式注入、精确纯黑兼容选择器，以及 `apps/readest-app/src/app/reader/components/FoliateViewer.tsx` 的新章节刷新行为作为参考。AI Reader 只复用既有的 `epubTheme.ts`/`typography.ts`/`foliateViewHost.ts` 窄能力，不复制 Readest 应用层代码，也不引入链接重着色、浅色局部背景修复、图片滤镜或 PDF 主题。
