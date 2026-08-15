import { useEffect, useRef, useState } from 'react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useMarkdownSessionStore } from '../workbench/markdownSessionStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import type { EditorView } from 'codemirror';

/**
 * Markdown 源码模式的编辑器(ADR-0009)。CodeMirror 6 仅在首次进入源码模式时
 * 动态加载;提供 Markdown 高亮、撤销重做与查找替换(basicSetup)。
 *
 * 编辑器读写统一的 MarkdownDocumentSession 共享缓冲区;每次编辑都更新会话文本
 * 并标记为脏。Ctrl/Cmd+S 执行稳定保存 Command,由 Rust 原子保存(TS 不写文件)。
 */
export function MarkdownSourceEditor({ viewId }: { viewId: string }) {
  const { commands } = useAppServices();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const applyingSessionTextRef = useRef(false);
  const [loadError, setLoadError] = useState(false);

  const materialId = useWorkspaceStore((state) => {
    for (const group of state.editorGroups) {
      const view = group.views.find((v) => v.id === viewId);
      if (view) return view.materialId;
    }
    return null;
  });
  const session = useMarkdownSessionStore((state) =>
    materialId ? state.sessions[materialId] ?? null : null,
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !materialId) return;

    let cancelled = false;
    void (async () => {
      try {
        const [{ EditorView, basicSetup }, { keymap }, { markdown }] = await Promise.all([
          import('codemirror'),
          import('@codemirror/view'),
          import('@codemirror/lang-markdown'),
        ]);
        if (cancelled) return;
        const current = useMarkdownSessionStore.getState().getSession(materialId);
        const view = new EditorView({
          doc: current?.text ?? '',
          extensions: [
            basicSetup,
            markdown(),
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  void commands.execute(COMMAND_IDS.markdownSave, viewId).catch(console.error);
                  return true;
                },
              },
            ]),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || applyingSessionTextRef.current) return;
              void commands
                .execute(
                  COMMAND_IDS.markdownUpdateBuffer,
                  viewId,
                  update.state.doc.toString(),
                )
                .catch(console.error);
            }),
          ],
          parent: container,
        });
        viewRef.current = view;
      } catch (error) {
        console.error('加载 CodeMirror 失败', error);
        if (!cancelled) setLoadError(true);
      }
    })();

    return () => {
      cancelled = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [materialId, viewId, commands]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !session || view.state.doc.toString() === session.text) return;
    applyingSessionTextRef.current = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: session.text },
      });
    } finally {
      applyingSessionTextRef.current = false;
    }
  }, [session]);

  if (loadError) {
    return (
      <div className="app-reading-source-editor flex h-full items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        源码编辑器加载失败
      </div>
    );
  }

  return (
    <div
      className="app-reading-source-editor h-full w-full overflow-hidden bg-zinc-950"
      ref={containerRef}
    />
  );
}
