import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useShellUiStore } from '../workbench/shellUiStore';

/**
 * 启动恢复对话框。只展示队首快照，用户处理后继续展示下一份；版本冲突
 * 只能载入共享脏缓冲区，绝不直接覆盖正式 Markdown。
 */
export function MarkdownRecoveryDialog() {
  const { commands } = useAppServices();
  const snapshot = useShellUiStore((state) => state.markdownRecoverySnapshots[0] ?? null);
  const material = useLibraryStore((state) =>
    snapshot
      ? state.materials.find((candidate) => candidate.id === snapshot.materialId) ?? null
      : null,
  );

  if (!snapshot) return null;

  const choose = (choice: 'restore' | 'discard') => {
    void commands
      .execute(COMMAND_IDS.markdownResolveRecovery, snapshot.materialId, choice)
      .catch(console.error);
  };

  const description =
    snapshot.status === 'corrupt'
      ? '这份恢复快照已经损坏，无法安全载入。正式材料未受影响，你可以丢弃该快照。'
      : snapshot.status === 'conflict'
        ? '正式文档版本已经变化。载入后只会成为未保存内容，请核对差异后再决定是否正式保存。'
        : '检测到上次退出前尚未保存的 Markdown 内容。你可以载入继续编辑，或丢弃快照。';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="恢复未保存的 Markdown"
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <h2 className="mb-2 text-sm font-semibold text-zinc-100">恢复未保存的 Markdown</h2>
        <p className="mb-2 text-sm text-zinc-300">{material?.title ?? snapshot.materialId}</p>
        <p className="mb-4 text-sm leading-6 text-zinc-400">{description}</p>
        <div className="flex flex-col gap-2">
          {snapshot.status !== 'corrupt' ? (
            <button
              type="button"
              onClick={() => choose('restore')}
              className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
            >
              载入未保存内容
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => choose('discard')}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            丢弃快照
          </button>
        </div>
      </div>
    </div>
  );
}
