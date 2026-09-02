import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReadingMaterial } from '../domain/library/material';
import { createInMemoryWorkspaceRepository } from '../domain/workspace/inMemoryWorkspaceRepository';
import type { ReadingLocation } from '../domain/reader/readingLocation';
import { AppServicesProvider } from '../app/AppServicesContext';
import { createAppServices, type AppServices } from '../app/bootstrap';
import { COMMAND_IDS } from '../commands/commandRegistry';
import { useLibraryStore } from '../workbench/libraryStore';
import { useWorkspaceStore } from '../workbench/workspaceStore';
import { InterfaceSidebar } from './InterfaceSidebar';

function makeMaterial(sourceFileName: string): ReadingMaterial {
  const format = sourceFileName.split('.').pop();
  return {
    id: `material-${format}`,
    fingerprint: `fingerprint-${format}`,
    sourceFileName,
    folderId: null,
    source: { title: `当前${format}材料`, author: '测试作者', language: 'zh' },
    override: { title: null, author: null, coverSource: null },
    title: `当前${format}材料`,
    author: '测试作者',
    language: 'zh',
    coverSource: null,
    documentVersion: 0,
    managedFileAvailable: true,
  };
}

function prepareActiveMaterial(
  sourceFileName: string,
  location: ReadingLocation | null = null,
): { material: ReadingMaterial; viewId: string } {
  const material = makeMaterial(sourceFileName);
  useLibraryStore.getState().setMaterials([material]);
  const viewId = useWorkspaceStore.getState().openView(material.id);
  if (location) {
    useWorkspaceStore.getState().setViewLocation(viewId, location);
  }
  return { material, viewId };
}

function renderPanel(services: AppServices) {
  return render(
    <AppServicesProvider services={services}>
      <InterfaceSidebar />
    </AppServicesProvider>,
  );
}

describe('界面侧栏的书籍范围', () => {
  beforeEach(() => {
    useLibraryStore.getState().resetToDefault();
    useWorkspaceStore.getState().resetToDefault();
  });

  it('没有活动阅读材料时禁用书籍范围并给出下一步说明', () => {
    const services = createAppServices({
      workspaceRepository: createInMemoryWorkspaceRepository(),
    });

    renderPanel(services);

    const booksScope = screen.getByRole('region', { name: '书籍' });
    expect(booksScope).toHaveAttribute('aria-disabled', 'true');
    expect(booksScope).toHaveTextContent('请先打开一份 EPUB、PDF 或 Markdown 阅读材料');
    expect(within(booksScope).queryByRole('slider', { name: '字号' })).not.toBeInTheDocument();
  });

  it('显示活动材料的有效排版值、覆盖状态，并经 Command 修改与恢复', async () => {
    const services = createAppServices({
      workspaceRepository: createInMemoryWorkspaceRepository(),
    });
    const { material, viewId } = prepareActiveMaterial('当前材料.epub');
    useWorkspaceStore.getState().setMaterialTypography(material.id, {
      fontSize: 22,
      theme: 'dark',
    });
    const execute = vi.spyOn(services.commands, 'execute');
    const user = userEvent.setup();

    renderPanel(services);

    const booksScope = screen.getByRole('region', { name: '书籍' });
    expect(booksScope).toHaveTextContent('当前epub材料');
    expect(booksScope).toHaveTextContent('EPUB');
    expect(booksScope).toHaveTextContent('材料级覆盖');
    expect(booksScope).toHaveTextContent('字号');
    expect(booksScope).toHaveTextContent('22px');
    expect(booksScope).toHaveTextContent('主题');
    expect(booksScope).toHaveTextContent('深色');

    await user.click(within(booksScope).getByRole('button', { name: '衬线' }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerApplyTypography, viewId, {
        fontFamily: 'serif',
      });
    });

    await user.click(within(booksScope).getByRole('button', { name: '恢复默认阅读排版' }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerResetTypography, viewId);
    });
  });

  it.each([
    ['EPUB', 'book.epub', false],
    ['Markdown', 'notes.md', false],
    ['PDF', 'paper.pdf', true],
  ])('%s 都显示通用排版控件，PDF 额外显示当前视图控件', (label, sourceFileName, isPdf) => {
    const services = createAppServices({
      workspaceRepository: createInMemoryWorkspaceRepository(),
    });
    const location: ReadingLocation | null = isPdf
      ? { kind: 'pdf', page: 3, scrollTop: 12, zoom: 125, fit: 'height' }
      : null;
    prepareActiveMaterial(sourceFileName, location);

    renderPanel(services);

    const booksScope = screen.getByRole('region', { name: '书籍' });
    expect(within(booksScope).getByRole('group', { name: '字体' })).toBeInTheDocument();
    expect(within(booksScope).getByRole('slider', { name: '字号' })).toBeInTheDocument();
    expect(within(booksScope).getByRole('slider', { name: '行距' })).toBeInTheDocument();
    expect(within(booksScope).getByRole('slider', { name: '页边距' })).toBeInTheDocument();
    expect(within(booksScope).getByRole('button', { name: '恢复默认阅读排版' })).toBeDisabled();
    expect(booksScope).toHaveTextContent(label);

    if (isPdf) {
      expect(within(booksScope).getByRole('group', { name: '页面适配' })).toBeInTheDocument();
      expect(within(booksScope).getByRole('slider', { name: '缩放' })).toHaveValue('125');
    } else {
      expect(within(booksScope).queryByRole('group', { name: '页面适配' })).not.toBeInTheDocument();
      expect(within(booksScope).queryByRole('slider', { name: '缩放' })).not.toBeInTheDocument();
    }
  });

  it.each([
    ['EPUB', 'book.epub', COMMAND_IDS.readerApplyTypography, { flow: 'scrolled' }],
    ['Markdown', 'notes.md', COMMAND_IDS.readerApplyTypography, { flow: 'scrolled' }],
    ['PDF', 'paper.pdf', COMMAND_IDS.readerSetPdfFlow, 'scrolled'],
  ])('%s 的阅读模式控件调用对应的稳定 Command', async (label, sourceFileName, commandId, value) => {
    const services = createAppServices({
      workspaceRepository: createInMemoryWorkspaceRepository(),
    });
    const { viewId } = prepareActiveMaterial(sourceFileName, label === 'PDF'
      ? { kind: 'pdf', page: 1, scrollTop: 0, zoom: 100, fit: 'width' }
      : null);
    const execute = vi.spyOn(services.commands, 'execute');
    const user = userEvent.setup();

    renderPanel(services);

    const booksScope = screen.getByRole('region', { name: '书籍' });
    await user.click(within(booksScope).getByRole('button', { name: '滚动' }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(commandId, viewId, value));
  });

  it('PDF 页面适配和缩放只调用当前视图的视口 Command，不写材料排版覆盖', async () => {
    const services = createAppServices({
      workspaceRepository: createInMemoryWorkspaceRepository(),
    });
    const { material, viewId } = prepareActiveMaterial('paper.pdf', {
      kind: 'pdf',
      page: 3,
      scrollTop: 12,
      zoom: 125,
      fit: 'height',
    });
    const execute = vi.spyOn(services.commands, 'execute');
    const user = userEvent.setup();

    renderPanel(services);

    const booksScope = screen.getByRole('region', { name: '书籍' });
    await user.click(within(booksScope).getByRole('button', { name: '整页' }));
    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerSetPdfViewport, viewId, 125, 'page');
    });

    fireEvent.change(within(booksScope).getByRole('slider', { name: '缩放' }), {
      target: { value: '150' },
    });
    await waitFor(() => {
      expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerSetPdfViewport, viewId, 150, 'page');
    });
    expect(useWorkspaceStore.getState().materialTypography[material.id]).toBeUndefined();
  });
});
