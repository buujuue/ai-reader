import { describe, expect, it } from 'vitest';

import {
  getLibraryFolderDepth,
  MAX_LIBRARY_FOLDER_DEPTH,
  normalizeLibraryFolderName,
  sortLibraryFolders,
  validateNewLibraryFolder,
  validateRenamedLibraryFolder,
  type LibraryFolder,
} from './libraryFolder';

function folder(id: string, name: string, parentId: string | null = null): LibraryFolder {
  return { id, name, parentId };
}

describe('书库文件夹领域规则', () => {
  it('去除首尾空格并保留内部空格', () => {
    expect(normalizeLibraryFolderName('  文史  哲  ')).toBe('文史  哲');
  });

  it.each([
    ['', '文件夹名称不能为空'],
    ['   ', '文件夹名称不能为空'],
    ['a/b', '文件夹名称不能包含路径分隔符'],
    ['a\\b', '文件夹名称不能包含路径分隔符'],
    ['a\n', '文件夹名称不能包含控制字符'],
    ['a\n b', '文件夹名称不能包含控制字符'],
  ])('拒绝非法名称 %j 并返回可行动错误', (name, message) => {
    expect(() => normalizeLibraryFolderName(name)).toThrow(message);
  });

  it('名称最多 80 个字符', () => {
    expect(() => normalizeLibraryFolderName('a'.repeat(81))).toThrow('文件夹名称最多 80 个字符');
    expect(normalizeLibraryFolderName('a'.repeat(80))).toHaveLength(80);
  });

  it('深度从顶层开始计算且最多五层', () => {
    const folders = [
      folder('1', '一'),
      folder('2', '二', '1'),
      folder('3', '三', '2'),
      folder('4', '四', '3'),
      folder('5', '五', '4'),
    ];

    expect(getLibraryFolderDepth('1', folders)).toBe(1);
    expect(getLibraryFolderDepth('5', folders)).toBe(MAX_LIBRARY_FOLDER_DEPTH);
    expect(() => validateNewLibraryFolder('六', '5', folders)).toThrow('已达到最多五层');
  });

  it('同一父级名称不区分大小写唯一,不同父级允许同名', () => {
    const folders = [folder('root', '阅读')];

    expect(() => validateNewLibraryFolder(' 阅读 ', null, folders)).toThrow('已有同名文件夹');
    expect(validateNewLibraryFolder('阅读', 'root', folders)).toBe('阅读');
    expect(() => validateNewLibraryFolder('阅读', 'root', [
      ...folders,
      folder('child', '阅读', 'root'),
    ])).toThrow('已有同名文件夹');
  });

  it('改名不改变父级并排除自身的旧名称', () => {
    const folders = [folder('root', '阅读'), folder('sibling', '笔记'), folder('child', '章节', 'root')];

    expect(validateRenamedLibraryFolder(' 新阅读 ', 'root', folders)).toBe('新阅读');
    expect(() => validateRenamedLibraryFolder('笔记', 'root', folders)).toThrow('已有同名文件夹');
    expect(validateRenamedLibraryFolder('章节', 'child', folders)).toBe('章节');
  });

  it('同级按名称稳定排序并不改变输入数组', () => {
    const folders = [folder('2', 'beta'), folder('3', 'Alpha'), folder('1', 'alpha')];

    expect(sortLibraryFolders(folders).map((item) => item.id)).toEqual(['1', '3', '2']);
    expect(folders.map((item) => item.id)).toEqual(['2', '3', '1']);
  });
});
