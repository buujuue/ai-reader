import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CaseSensitive, X } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useSearchStore } from '../workbench/searchStore';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * 当前阅读视图的搜索栏。所有用户意图经 Command 执行;输入做轻量防抖后触发
 * 增量搜索,上一项/下一项与点击结果在命中间跳转(经导航历史),关闭时清理高亮与结果。
 */
export function SearchBar({ viewId }: { viewId: string }) {
  const { commands } = useAppServices();
  const view = useSearchStore((state) => state.views[viewId]);
  const [draft, setDraft] = useState(view?.query ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (view?.active) {
      inputRef.current?.focus();
    }
  }, [view?.active]);

  useEffect(() => {
    if (!view?.active) {
      setDraft('');
      return;
    }
    setDraft(view.query);
  }, [view?.active, view?.query]);

  // 输入防抖:停止输入一段时间后才真正运行搜索,避免每次击键都起一个新任务。
  useEffect(() => {
    if (!view?.active) return;
    const timer = setTimeout(() => {
      void commands.execute(COMMAND_IDS.readerSearchRun, viewId, draft).catch(() => undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, view?.active, viewId]);

  if (!view?.active) {
    return null;
  }

  const handleChange = (value: string) => {
    setDraft(value);
  };

  const handleClose = () => {
    void commands.execute(COMMAND_IDS.readerSearchClose, viewId).catch(() => undefined);
  };

  const handleToggleCase = () => {
    void commands
      .execute(COMMAND_IDS.readerSearchToggleCase, viewId, draft)
      .catch(() => undefined);
  };

  const handleNext = () => {
    void commands.execute(COMMAND_IDS.readerSearchNext, viewId).catch(() => undefined);
  };

  const handlePrev = () => {
    void commands.execute(COMMAND_IDS.readerSearchPrev, viewId).catch(() => undefined);
  };

  const handleGoTo = (cfi: string) => {
    void commands.execute(COMMAND_IDS.readerSearchGoTo, viewId, cfi).catch(() => undefined);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        handlePrev();
      } else {
        handleNext();
      }
    }
  };

  const total = view.matches.length;
  const current = view.currentIndex >= 0 ? view.currentIndex + 1 : 0;
  const searching = view.status === 'searching';

  return (
    <div className="absolute inset-x-0 top-0 z-20 flex flex-col border-b border-zinc-800 bg-zinc-900/95 shadow-lg">
      <div role="search" aria-label="在当前阅读材料中搜索" className="flex items-center gap-1 px-2 py-1.5">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          spellCheck={false}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="在当前阅读材料中搜索…"
          aria-label="搜索关键词"
          className="h-8 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-sky-500 focus:outline-none"
        />
        <span aria-live="polite" className="shrink-0 px-1 text-xs tabular-nums text-zinc-400">
          {searching ? `${Math.round(view.progress * 100)}%` : `${current}/${total}`}
        </span>
        <button
          type="button"
          aria-label="切换大小写匹配"
          aria-pressed={view.matchCase}
          title={view.matchCase ? '区分大小写' : '忽略大小写'}
          onClick={handleToggleCase}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          <CaseSensitive size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="上一个命中"
          title={searching ? '搜索中' : '上一个命中(Shift+Enter)'}
          onClick={handlePrev}
          disabled={searching || total === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-40"
        >
          <ArrowUp size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="下一个命中"
          title={searching ? '搜索中' : '下一个命中(Enter)'}
          onClick={handleNext}
          disabled={searching || total === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 disabled:opacity-40"
        >
          <ArrowDown size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="关闭搜索"
          title="关闭搜索(Esc)"
          onClick={handleClose}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      {view.matches.length > 0 && (
        <ul
          aria-label="搜索结果"
          className="max-h-48 overflow-y-auto border-t border-zinc-800 px-2 py-1"
        >
          {view.matches.map((match, index) => (
            <li key={match.cfi}>
              <button
                type="button"
                aria-label={`跳转到第 ${index + 1} 个命中`}
                onClick={() => handleGoTo(match.cfi)}
                className={`block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors hover:bg-zinc-800 ${
                  index === view.currentIndex ? 'text-sky-300' : 'text-zinc-400'
                }`}
              >
                {match.excerpt.pre}
                <span className="font-semibold text-zinc-100">{match.excerpt.match}</span>
                {match.excerpt.post}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}