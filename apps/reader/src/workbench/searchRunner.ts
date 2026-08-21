import type { SearchEvent } from '../domain/reader/search';
import { useReaderRuntime } from './readerRuntime';
import { useSearchStore } from './searchStore';

/**
 * 搜索任务的编排与生命周期。每个阅读视图最多一个正在运行的搜索生成器;
 * 新查询、关闭搜索或销毁视图都会取消旧任务,避免异步任务写回错误视图。
 * 这是活对象控制器,不进入持久化状态。
 */

interface SearchController {
  generator: AsyncGenerator<SearchEvent, void, void>;
  cancelled: boolean;
  abortController: AbortController;
}

const controllers = new Map<string, SearchController>();

/** 取消指定视图的搜索:停止生成器并清除命中高亮。 */
export function cancelSearch(viewId: string): void {
  const controller = controllers.get(viewId);
  if (!controller) return;
  controller.cancelled = true;
  controller.abortController.abort();
  useSearchStore.getState().cancel(viewId);
  void controller.generator.return(undefined);
  controllers.delete(viewId);
}

/** 清理指定视图的搜索:取消任务、重置状态并清除正文高亮。 */
export function clearSearch(viewId: string): void {
  cancelSearch(viewId);
  useSearchStore.getState().reset(viewId);
  useReaderRuntime.getState().getDocument(viewId)?.clearSearch();
}

/**
 * 针对指定视图启动一次搜索。同视图已有搜索会被取消。`query` 为空时仅清理。
 * 返回的 Promise 在搜索任务启动后即解析(不做长时间等待)。
 */
export function runSearch(
  viewId: string,
  options: { query: string; matchCase?: boolean; mode?: import('../domain/reader/search').SearchMode },
): void {
  cancelSearch(viewId);
  const document = useReaderRuntime.getState().getDocument(viewId);
  if (!document) return;

  const query = options.query.trim();
  if (!query) {
    clearSearch(viewId);
    return;
  }

  const abortController = new AbortController();
  const searchOptions = {
    query,
    matchCase: options.matchCase ?? false,
    ...(options.mode === 'regex'
      ? { mode: 'regex' as const, signal: abortController.signal }
      : {}),
  };
  const generator = document.search(searchOptions);
  const controller: SearchController = { generator, cancelled: false, abortController };
  controllers.set(viewId, controller);
  useSearchStore.getState().begin(viewId, query, options.matchCase ?? false, options.mode ?? 'text');

  void (async () => {
    try {
      for await (const event of generator) {
        if (controller.cancelled) break;
        if (event.kind === 'progress') {
          useSearchStore.getState().setProgress(viewId, event.progress);
        } else {
          useSearchStore.getState().addMatch(viewId, event.match);
        }
      }
      if (!controller.cancelled) {
        useSearchStore.getState().complete(viewId);
      }
    } catch (error) {
      if (!controller.cancelled) {
        // 预算错误也可能发生在已经绘制了部分结果之后；失败搜索不能把
        // 残留高亮带入下一次查询。
        try {
          document.clearSearch();
        } catch {
          // 保留原始搜索错误，不能让清理异常覆盖它。
        }
        useSearchStore.getState().setError(viewId, error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (controllers.get(viewId) === controller) {
        controllers.delete(viewId);
      }
    }
  })();
}

/** 销毁所有视图的搜索任务(应用关闭时调用)。 */
export function cancelAllSearches(): void {
  for (const viewId of Array.from(controllers.keys())) {
    cancelSearch(viewId);
  }
  useSearchStore.setState({ views: {} });
}
