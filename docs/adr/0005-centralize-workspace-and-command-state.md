---
status: accepted
---

# 集中拥有工作区并统一用户 Command

Workspace Store 唯一拥有 Editor Group、标签顺序、活动 ReadingView、主要阅读材料、侧栏期望状态和可序列化导航历史。Reader Runtime 只保存 Foliate/PDF 实例、加载任务、选择和搜索结果等活对象；每个 Editor Group 只为活动 ReadingView 保留 Reader Runtime，整个工作区最多两个活动渲染器，非活动标签仅保留可序列化状态。

第一版最多两个 Editor Group，可向右或向下拆分。同一组内每种材料只允许一个 ReadingView，跨组允许同时打开同一材料；每个视图拥有自己的位置与视口状态，从书库再次打开当前组已有材料时激活已有标签。主要阅读材料由用户显式指定；焦点变化不得修改它。

所有用户意图使用稳定 Command ID。按钮、菜单、键盘、鼠标和触摸 Adapter 都执行同一 Command；Event 只表达已经完成的事实。

标签激活必须通过 `reader.activateView` Command 完成。该 Command 先 flush 并释放同组旧活动视图的 Runtime，再根据 Workspace Store 保存的位置重建新活动视图；关闭活动标签后按该组新的活动顺序恢复下一个标签。启动恢复为每组重建保存的活动标签，非活动标签不创建阅读器实例。

布局策略按容器宽度计算有效布局，并保留用户期望状态；窄屏隐藏第二组或把侧栏变成抽屉时不得销毁状态。
