import { BookOpen } from 'lucide-react';

import { useAppServices } from '../app/AppServicesContext';
import { COMMAND_IDS } from '../commands/commandRegistry';
import type { EditorGroupState } from '../domain/workspace/workspaceState';
import type { LayoutPolicy } from '../workbench/layoutPolicy';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { ReadingView } from './ReadingView';

export function EditorArea({ layoutPolicy }: { layoutPolicy: LayoutPolicy }) {
  const splitDirection = useWorkspaceStore((state) => state.splitDirection);
  const editorGroups = useWorkspaceStore((state) => state.editorGroups);
  const activeEditorGroupId = useWorkspaceStore((state) => state.activeEditorGroupId);

  if (editorGroups.length === 0 || (editorGroups.length === 1 && editorGroups[0]!.views.length === 0)) {
    return <EmptyEditorArea />;
  }

  return (
    <section
      aria-label="编辑器区"
      className={`flex min-h-0 min-w-0 flex-1 bg-zinc-950 ${
        !layoutPolicy.showAllEditorGroups || splitDirection === 'down' ? 'flex-col' : 'flex-row'
      }`}
    >
      {!layoutPolicy.showAllEditorGroups && editorGroups.length > 1 ? (
        <CompactEditorGroupPicker groups={editorGroups} activeGroupId={activeEditorGroupId} />
      ) : null}
      {editorGroups.map((group, index) => (
        <EditorGroupPane
          key={group.id}
          group={group}
          index={index}
          visible={layoutPolicy.showAllEditorGroups || group.id === activeEditorGroupId}
        />
      ))}
    </section>
  );
}

function CompactEditorGroupPicker({
  groups,
  activeGroupId,
}: {
  groups: EditorGroupState[];
  activeGroupId: string;
}) {
  const { commands } = useAppServices();

  return (
    <div
      aria-label="紧凑布局编辑器组"
      className="flex shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1"
    >
      {groups.map((group, index) => (
        <button
          key={group.id}
          type="button"
          aria-label={`切换到编辑器组 ${index + 1}`}
          aria-pressed={group.id === activeGroupId}
          onClick={() => {
            void commands
              .execute(COMMAND_IDS.workbenchFocusEditorGroup, group.id)
              .catch(() => undefined);
          }}
          className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 aria-pressed:bg-sky-600/30 aria-pressed:text-sky-200"
        >
          组 {index + 1}
        </button>
      ))}
    </div>
  );
}

function EmptyEditorArea() {
  return (
    <section
      aria-label="编辑器区"
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-zinc-950 px-6"
    >
      <BookOpen size={36} aria-hidden className="text-zinc-600" />
      <h1 className="text-lg font-semibold text-zinc-200">AI Reader</h1>
      <p className="max-w-md text-center text-sm leading-6 text-zinc-500">
        从左侧书库选择一本阅读材料打开，在此处阅读。
      </p>
    </section>
  );
}

function EditorGroupPane({
  group,
  index,
  visible,
}: {
  group: EditorGroupState;
  index: number;
  visible: boolean;
}) {
  const { commands } = useAppServices();
  const activeEditorGroupId = useWorkspaceStore((state) => state.activeEditorGroupId);
  const activeView = group.views.find((view) => view.id === group.activeViewId);

  const focusGroup = () => {
    if (activeEditorGroupId === group.id) return;
    void commands
      .execute(COMMAND_IDS.workbenchFocusEditorGroup, group.id)
      .catch(() => undefined);
  };

  return (
    <section
      aria-label={`编辑器组 ${index + 1}`}
      hidden={!visible}
      onPointerDown={focusGroup}
      className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col"
    >
      {activeView ? (
        <div className="min-h-0 min-w-0 flex-1">
          <ReadingView key={activeView.id} viewId={activeView.id} visible={visible} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-zinc-600">
          从左侧书库打开阅读材料
        </div>
      )}
    </section>
  );
}
