import { ExternalLink, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from '../workbench/shellUiStore';

/**
 * 外部链接确认对话框:书内点击的外部链接先展示目标,用户确认后才经统一
 * Command 交给系统浏览器。阅读 WebView 自身不导航到外部站点(ADR-0010)。
 */
export function ExternalLinkDialog() {
  const { commands } = useAppServices();
  const url = useShellUiStore((state) => state.externalLinkUrl);
  const close = useShellUiStore((state) => state.closeExternalLinkConfirm);

  if (url === null) {
    return null;
  }

  const handleOpen = async () => {
    try {
      await commands.execute(COMMAND_IDS.readerOpenExternalUrl, url);
    } catch (error) {
      console.error('打开外部链接失败', error);
    } finally {
      close();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="打开外部链接"
      onClick={close}
    >
      <div
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <ExternalLink size={16} aria-hidden />
            打开外部链接
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="关闭"
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <p className="mb-2 text-sm leading-6 text-zinc-300">
          书籍内容中的链接将交由系统浏览器打开,阅读器不会导航到该网站:
        </p>
        <p className="mb-4 break-all rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-sky-300">
          {url}
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleOpen}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500"
          >
            在浏览器打开
          </button>
        </div>
      </div>
    </div>
  );
}