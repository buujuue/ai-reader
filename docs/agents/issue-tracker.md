# 事项追踪器：GitHub

本仓库的事项通过 `buujuue/ai-reader` 的 GitHub Issues 管理，使用 `gh` CLI 操作。

## 约定

- 创建、读取、评论、标记和关闭事项均使用 `gh issue`。
- 仓库身份从当前 Git 远程自动推断。
- 技能要求“发布到事项追踪器”时，创建一个 GitHub Issue。
- 技能要求“读取相关工单”时，读取 Issue 正文、评论和标签。
- Pull Request 不作为需求或分诊入口。

## 依赖关系

优先使用 GitHub 原生 Issue Dependencies 表示阻塞关系。若仓库暂不支持，则在工单正文的 `Blocked by` 部分引用阻塞工单。

只有全部阻塞工单均已关闭的事项才进入可执行前沿。
