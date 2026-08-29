import { describe, expect, it, vi } from 'vitest';

import { CommandRegistry } from '../commands/commandRegistry';
import type { Annotation } from '../domain/annotation/annotation';
import { createInMemoryAnnotationRepository } from '../domain/annotation/inMemoryAnnotationRepository';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import type { SearchEvent } from '../domain/reader/search';
import {
  registerAnnotationCommands,
  loadAnnotationsForView,
} from './annotationCommands';
import { useAnnotationStore } from './annotationStore';
import { useReaderRuntime } from './readerRuntime';
import { useShellUiStore } from './shellUiStore';
import { useWorkspaceStore } from './workspaceStore';
import { useLibraryStore } from './libraryStore';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    materialId: 'material-1',
    anchor: {
      cfi: 'epubcfi(/6/4)!/4/2/2/1:0',
      quote: '被选中的文字',
      before: '前文',
      after: '后文',
      documentVersion: 'fingerprint-1',
      recoveryState: 'resolved',
    },
    style: 'highlight',
    color: '#ffd54f',
    note: '',
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    ...overrides,
  };
}

function createFakeDocument() {
  return {
    getCFI: vi.fn(() => 'epubcfi(/6/4)!/4/2/2/1:0'),
    getCurrentIndex: vi.fn(() => 0),
    addAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
    canResolveAnnotation: vi.fn().mockResolvedValue(false),
    search: vi.fn(() => (async function* (): AsyncGenerator<SearchEvent, void, void> {})()),
    clearSearch: vi.fn(),
    onShowAnnotation: vi.fn(() => () => undefined),
  };
}

function setup() {
  const registry = new CommandRegistry();
  const repository = createInMemoryAnnotationRepository();
  registerAnnotationCommands(registry, { annotationRepository: repository });
  useAnnotationStore.getState().resetToDefault();
  useShellUiStore.getState().setAnnotationUndoTarget(null);
  return { registry, repository };
}

describe('Annotation 命令', () => {
  it('从选中文本创建高亮批注并持久化', async () => {
    const { registry, repository } = setup();
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, sourceMode: false, history: { positions: [], index: -1 } }],
          activeViewId: 'view-1',
        },
      ],
    });
    const doc = createFakeDocument();
    useReaderRuntime.setState({ documents: new Map([['view-1', doc as never]]) });
    useLibraryStore.setState({
      materials: [{ id: 'material-1', fingerprint: 'fingerprint-1', title: '示例书', author: null, language: 'zh', sourceFileName: 'book.epub', folderId: null, source: { title: '示例书', author: null, language: 'zh' }, override: { title: null, author: null, coverSource: null }, coverSource: null, documentVersion: 0 }],
    });

    const container = document.createElement('p');
    container.textContent = '前文 被选中的文字 后文';
    document.body.appendChild(container);
    const textNode = [...container.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.setEnd(textNode, 9);

    await registry.execute('annotation.createHighlight', 'view-1', range);

    const list = await repository.listByMaterial('material-1');
    expect(list).toHaveLength(1);
    expect(list[0]?.anchor.quote).toBe('被选中的文字');
    expect(list[0]?.anchor.cfi).toBe('epubcfi(/6/4)!/4/2/2/1:0');
    expect(doc.addAnnotation).toHaveBeenCalledWith({
      value: 'epubcfi(/6/4)!/4/2/2/1:0',
      color: '#ffd54f',
    });
    document.body.removeChild(container);
  });

  it('从扫描 PDF 区域创建页内批注并持久化归一化锚点', async () => {
    const { registry, repository } = setup();
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, sourceMode: false, history: { positions: [], index: -1 } }],
          activeViewId: 'view-1',
        },
      ],
    });
    const doc = createFakeDocument();
    Object.assign(doc, {
      format: 'pdf',
      getAreaAnchor: vi.fn(() => 'pdf-text:2:0.20000:0.20000:0.50000:0.50000'),
    });
    useReaderRuntime.setState({ documents: new Map([['view-1', doc as never]]) });
    useLibraryStore.setState({
      materials: [{ id: 'material-1', fingerprint: 'fingerprint-1', title: '扫描资料', author: null, language: 'zh', sourceFileName: 'scan.pdf', folderId: null, source: { title: '扫描资料', author: null, language: 'zh' }, override: { title: null, author: null, coverSource: null }, coverSource: null, documentVersion: 0 }],
    });

    await registry.execute('annotation.createPdfArea', 'view-1', {
      page: 2,
      rect: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
      clientRect: { left: 10, top: 20, width: 30, height: 40 },
    });

    const [saved] = await repository.listByMaterial('material-1');
    expect(saved).toMatchObject({
      materialId: 'material-1',
      anchor: {
        cfi: 'pdf-text:2:0.20000:0.20000:0.50000:0.50000',
        quote: '',
        before: '',
        after: '',
        documentVersion: 'fingerprint-1',
        recoveryState: 'resolved',
      },
    });
    expect(doc.addAnnotation).toHaveBeenCalledWith({
      value: 'pdf-text:2:0.20000:0.20000:0.50000:0.50000',
      color: '#ffd54f',
    });
  });

  it('编辑文字笔记后持久化并更新运行时', async () => {
    const { registry, repository } = setup();
    const annotation = makeAnnotation();
    await repository.saveAnnotation(annotation);
    useAnnotationStore.getState().upsertAnnotation(annotation);

    await registry.execute('annotation.updateNote', 'material-1', 'ann-1', '这是笔记');

    const list = await repository.listByMaterial('material-1');
    expect(list[0]?.note).toBe('这是笔记');
    expect(useAnnotationStore.getState().byMaterial['material-1']?.[0]?.note).toBe('这是笔记');
  });

  it('删除批注后从材料集合移除并持久化逻辑删除', async () => {
    const { registry, repository } = setup();
    const annotation = makeAnnotation();
    await repository.saveAnnotation(annotation);
    useAnnotationStore.getState().upsertAnnotation(annotation);
    useReaderRuntime.setState({
      documents: new Map([['view-1', createFakeDocument() as never]]),
    });

    await registry.execute('annotation.delete', 'material-1', 'ann-1');

    expect(await repository.listByMaterial('material-1')).toHaveLength(0);
    expect(useAnnotationStore.getState().byMaterial['material-1']).toHaveLength(0);
  });

  it('软删除后可通过恢复命令恢复原批注与原锚点', async () => {
    const { registry, repository } = setup();
    const annotation = makeAnnotation();
    await repository.saveAnnotation(annotation);
    useAnnotationStore.getState().upsertAnnotation(annotation);

    await registry.execute('annotation.delete', 'material-1', 'ann-1');
    await registry.execute('annotation.restore', 'material-1', 'ann-1');

    await expect(repository.listByMaterial('material-1')).resolves.toMatchObject([
      { ...annotation, deletedAt: null, updatedAt: expect.any(Number) },
    ]);
    expect(useAnnotationStore.getState().byMaterial['material-1']).toMatchObject([
      { ...annotation, deletedAt: null, updatedAt: expect.any(Number) },
    ]);
    expect(useShellUiStore.getState().annotationUndoTarget).toBeNull();
    expect(useShellUiStore.getState().statusMessage).toBe('已恢复批注');
  });

  it('加载材料批注时填充运行时集合并重绘到开放视图', async () => {
    const { repository } = setup();
    const annotation = makeAnnotation();
    await repository.saveAnnotation(annotation);
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, sourceMode: false, history: { positions: [], index: -1 } }],
          activeViewId: 'view-1',
        },
      ],
    });
    const document = createFakeDocument();
    useReaderRuntime.setState({ documents: new Map([['view-1', document as never]]) });

    await loadAnnotationsForView({ annotationRepository: repository }, 'view-1');

    expect(useAnnotationStore.getState().byMaterial['material-1']).toHaveLength(1);
    expect(document.addAnnotation).toHaveBeenCalledWith({
      value: 'epubcfi(/6/4)!/4/2/2/1:0',
      color: '#ffd54f',
    });
  });

  it('材料版本变化后唯一命中会迁移锚点并绘制新 CFI', async () => {
    const { repository } = setup();
    const annotation = makeAnnotation({
      anchor: {
        ...makeAnnotation().anchor,
        documentVersion: 'old-fingerprint',
      },
    });
    await repository.saveAnnotation(annotation);
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, sourceMode: false, history: { positions: [], index: -1 } }],
          activeViewId: 'view-1',
        },
      ],
    });
    useLibraryStore.setState({
      materials: [{ id: 'material-1', fingerprint: 'new-fingerprint', title: '示例书', author: null, language: 'zh', sourceFileName: 'book.md', folderId: null, source: { title: '示例书', author: null, language: 'zh' }, override: { title: null, author: null, coverSource: null }, coverSource: null, documentVersion: 1 }],
    });
    const document = createFakeDocument();
    document.search.mockReturnValue(
      (async function* () {
        yield { kind: 'match', match: { cfi: 'epubcfi(/6/4)!/4/4:0', excerpt: { pre: '新的前文', match: '被选中的文字', post: '后文内容' } } } as const;
      })(),
    );
    useReaderRuntime.setState({ documents: new Map([['view-1', document as never]]) });

    await loadAnnotationsForView({ annotationRepository: repository }, 'view-1');

    const [saved] = await repository.listByMaterial('material-1');
    expect(saved?.anchor).toEqual({
      ...annotation.anchor,
      cfi: 'epubcfi(/6/4)!/4/4:0',
      documentVersion: 'new-fingerprint',
      recoveryState: 'reanchored',
    });
    expect(document.clearSearch).toHaveBeenCalledOnce();
    expect(document.addAnnotation).toHaveBeenCalledWith({
      value: 'epubcfi(/6/4)!/4/4:0',
      color: '#ffd54f',
    });
  });

  it('材料版本变化但原 CFI 仍可解析时只更新版本而不启动搜索', async () => {
    const { repository } = setup();
    const annotation = makeAnnotation({
      anchor: {
        ...makeAnnotation().anchor,
        documentVersion: 'old-fingerprint',
      },
    });
    await repository.saveAnnotation(annotation);
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, sourceMode: false, history: { positions: [], index: -1 } }],
          activeViewId: 'view-1',
        },
      ],
    });
    useLibraryStore.setState({
      materials: [{ id: 'material-1', fingerprint: 'new-fingerprint', title: '示例书', author: null, language: 'zh', sourceFileName: 'book.md', folderId: null, source: { title: '示例书', author: null, language: 'zh' }, override: { title: null, author: null, coverSource: null }, coverSource: null, documentVersion: 1 }],
    });
    const document = createFakeDocument();
    document.canResolveAnnotation.mockResolvedValue(true);
    useReaderRuntime.setState({ documents: new Map([['view-1', document as never]]) });

    await loadAnnotationsForView({ annotationRepository: repository }, 'view-1');

    const [saved] = await repository.listByMaterial('material-1');
    expect(saved?.anchor).toEqual({
      ...annotation.anchor,
      documentVersion: 'new-fingerprint',
      recoveryState: 'resolved',
    });
    expect(document.search).not.toHaveBeenCalled();
    expect(document.addAnnotation).toHaveBeenCalledWith({
      value: annotation.anchor.cfi,
      color: '#ffd54f',
    });
  });

  it('材料版本变化后命中不唯一会保留失联批注且不绘制旧 CFI', async () => {
    const { repository } = setup();
    const annotation = makeAnnotation({
      anchor: {
        ...makeAnnotation().anchor,
        documentVersion: 'old-fingerprint',
      },
    });
    await repository.saveAnnotation(annotation);
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, sourceMode: false, history: { positions: [], index: -1 } }],
          activeViewId: 'view-1',
        },
      ],
    });
    useLibraryStore.setState({
      materials: [{ id: 'material-1', fingerprint: 'new-fingerprint', title: '示例书', author: null, language: 'zh', sourceFileName: 'book.md', folderId: null, source: { title: '示例书', author: null, language: 'zh' }, override: { title: null, author: null, coverSource: null }, coverSource: null, documentVersion: 1 }],
    });
    const document = createFakeDocument();
    document.search.mockReturnValue(
      (async function* () {
        yield { kind: 'match', match: { cfi: 'epubcfi(/6/2)!/4/2:0', excerpt: { pre: '', match: '被选中的文字', post: '' } } } as const;
        yield { kind: 'match', match: { cfi: 'epubcfi(/6/3)!/4/2:0', excerpt: { pre: '', match: '被选中的文字', post: '' } } } as const;
      })(),
    );
    useReaderRuntime.setState({ documents: new Map([['view-1', document as never]]) });

    await loadAnnotationsForView({ annotationRepository: repository }, 'view-1');

    const [saved] = await repository.listByMaterial('material-1');
    expect(saved?.anchor).toEqual({ ...annotation.anchor, recoveryState: 'orphaned' });
    expect(document.addAnnotation).not.toHaveBeenCalled();
  });
});
