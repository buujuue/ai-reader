import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppServicesProvider } from '../app/AppServicesContext';
import { createAppServices } from '../app/bootstrap';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useShellUiStore } from '../workbench/shellUiStore';
import { MarkdownRecoveryDialog } from './MarkdownRecoveryDialog';

describe('Markdown 恢复对话框', () => {
  beforeEach(() => {
    useShellUiStore.setState({ markdownRecoverySnapshots: [] });
  });

  it('版本冲突时明确提示且只允许载入为未保存内容', async () => {
    const services = createAppServices();
    const execute = vi.spyOn(services.commands, 'execute').mockResolvedValue(undefined);
    useShellUiStore.setState({
      markdownRecoverySnapshots: [
        {
          materialId: 'material-1',
          content: '# 崩溃前内容',
          baseDocumentVersion: 0,
          updatedAt: 1,
          status: 'conflict',
        },
      ],
    });
    const user = userEvent.setup();

    render(
      <AppServicesProvider services={services}>
        <MarkdownRecoveryDialog />
      </AppServicesProvider>,
    );

    expect(screen.getByRole('dialog', { name: '恢复未保存的 Markdown' })).toHaveTextContent(
      '正式文档版本已经变化',
    );
    await user.click(screen.getByRole('button', { name: '载入未保存内容' }));
    expect(execute).toHaveBeenCalledWith(
      COMMAND_IDS.markdownResolveRecovery,
      'material-1',
      'restore',
    );
  });

  it('损坏快照只允许安全丢弃', () => {
    const services = createAppServices();
    useShellUiStore.setState({
      markdownRecoverySnapshots: [
        {
          materialId: 'material-2',
          content: null,
          baseDocumentVersion: null,
          updatedAt: null,
          status: 'corrupt',
        },
      ],
    });

    render(
      <AppServicesProvider services={services}>
        <MarkdownRecoveryDialog />
      </AppServicesProvider>,
    );

    expect(screen.getByText(/快照已经损坏/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '载入未保存内容' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '丢弃快照' })).toBeInTheDocument();
  });
});
