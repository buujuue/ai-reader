import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from '../workbench/shellUiStore';

/**
 * 脏 Markdown 文档关闭/退出源码模式确认对话框。
 * 提供「保存」「放弃」「取消」三个选择;任一选择都不会静默丢失或误提交内容。
 */
export function MarkdownDirtyCloseDialog() {
  const { commands } = useAppServices();
  const viewId = useShellUiStore((state) => state.markdownDirtyCloseViewId);
  const close = useShellUiStore((state) => state.closeMarkdownDirtyClose);

  if (!viewId) {
    return null;
  }

  const choose = (choice: 'save' | 'discard' | 'cancel') => {
    void commands.execute(COMMAND_IDS.markdownCloseDirty, viewId, choice).catch(console.error);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="未保存的 Markdown 修改"
      onClick={() => choose('cancel')}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-2 text-sm font-semibold text-zinc-100">未保存的修改</h2>
        <p className="mb-4 text-sm leading-6 text-zinc-400">
          此 Markdown 有未保存的修改。保存后将正式更新文档版本;放弃将丢弃这些修改。
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => choose('save')}
            className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => choose('discard')}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            放弃修改
          </button>
          <button
            type="button"
            onClick={() => choose('cancel')}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}