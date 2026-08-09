import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppServicesProvider } from '../app/AppServicesContext';
import { createAppServices } from '../app/bootstrap';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useMarkdownSessionStore } from '../workbench/markdownSessionStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { MarkdownSourceEditor } from './MarkdownSourceEditor';

describe('Markdown 源码编辑器', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().resetToDefault();
    useMarkdownSessionStore.getState().resetToDefault();
    Range.prototype.getClientRects = () =>
      ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
  });

  it('恢复快照后把外部会话内容同步到已挂载的 CodeMirror', async () => {
    const services = createAppServices();
    const execute = vi.spyOn(services.commands, 'execute');
    const materialId = 'markdown-material';
    const viewId = useWorkspaceStore.getState().openView(materialId);
    useMarkdownSessionStore.getState().openSession(materialId, '# 正式内容', 0);

    const { container } = render(
      <AppServicesProvider services={services}>
        <MarkdownSourceEditor viewId={viewId} />
      </AppServicesProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector('.cm-content')).toHaveTextContent('正式内容');
    }, { timeout: 5_000 });
    execute.mockClear();

    useMarkdownSessionStore.getState().restoreRecovery(materialId, '# 恢复内容', 0);

    await waitFor(() => {
      expect(container.querySelector('.cm-content')).toHaveTextContent('恢复内容');
      expect(container.querySelector('.cm-content')).not.toHaveTextContent('正式内容');
    }, { timeout: 5_000 });
    expect(execute).not.toHaveBeenCalledWith(
      COMMAND_IDS.markdownUpdateBuffer,
      viewId,
      '# 恢复内容',
    );
  });
});
