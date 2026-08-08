import { describe, expect, it, vi } from 'vitest';

import { CommandRegistry } from '../commands/commandRegistry';
import type { Annotation } from '../domain/annotation/annotation';
import { createInMemoryAnnotationRepository } from '../domain/annotation/inMemoryAnnotationRepository';
import type { AnnotationRepository } from '../domain/annotation/annotationRepository';
import {
  registerAnnotationCommands,
  loadAnnotationsForView,
} from './annotationCommands';
import { useAnnotationStore } from './annotationStore';
import { useReaderRuntime } from './readerRuntime';
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
    onShowAnnotation: vi.fn(() => () => undefined),
  };
}

function setup() {
  const registry = new CommandRegistry();
  const repository = createInMemoryAnnotationRepository();
  registerAnnotationCommands(registry, { annotationRepository: repository });
  useAnnotationStore.getState().resetToDefault();
  return { registry, repository };
}

describe('Annotation 命令', () => {
  it('从选中文本创建高亮批注并持久化', async () => {
    const { registry, repository } = setup();
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, history: { positions: [], index: -1 } }],
          activeViewId: 'view-1',
        },
      ],
    });
    const doc = createFakeDocument();
    useReaderRuntime.setState({ documents: new Map([['view-1', doc as never]]) });
    useLibraryStore.setState({
      materials: [{ id: 'material-1', fingerprint: 'fingerprint-1', title: '示例书', author: null, language: 'zh', sourceFileName: 'book.epub', source: { title: '示例书', author: null, language: 'zh' }, override: { title: null, author: null, coverSource: null }, coverSource: null }],
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

  it('加载材料批注时填充运行时集合并重绘到开放视图', async () => {
    const { repository } = setup();
    const annotation = makeAnnotation();
    await repository.saveAnnotation(annotation);
    useWorkspaceStore.setState({
      editorGroups: [
        {
          id: 'group-1',
          views: [{ id: 'view-1', materialId: 'material-1', location: null, history: { positions: [], index: -1 } }],
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
});