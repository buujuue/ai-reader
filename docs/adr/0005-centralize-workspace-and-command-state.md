---
status: accepted
---

# 集中拥有工作区并统一用户 Command

Workspace Store 唯一拥有 Editor Group、标签顺序、活动 ReadingView、主要阅读材料、侧栏期望状态和可序列化导航历史。Reader Runtime 只保存 Foliate 实例、加载任务、选择和搜索结果等活对象。

第一版最多两个 Editor Group，可向右或向下拆分。同一材料可以创建多个 ReadingView，各自拥有位置与视口状态。主要阅读材料由用户显式指定；焦点变化不得修改它。

所有用户意图使用稳定 Command ID。按钮、菜单、键盘、鼠标和触摸 Adapter 都执行同一 Command；Event 只表达已经完成的事实。

布局策略按容器宽度计算有效布局，并保留用户期望状态；窄屏隐藏第二组或把侧栏变成抽屉时不得销毁状态。
