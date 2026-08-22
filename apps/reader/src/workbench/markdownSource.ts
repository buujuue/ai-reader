import type { ImportRepository } from '../domain/library/importRepository';
import { readMarkdownSourceText } from '../domain/reader/markdown/markdownSource';

/** Markdown 工作台与 Repository 的窄接线：打开 Source，正文物化仍归 Markdown 领域。 */
export async function readManagedMarkdownText(
  repository: Pick<ImportRepository, 'openManagedFileSource'>,
  materialId: string,
): Promise<string> {
  const source = await repository.openManagedFileSource(materialId);
  return readMarkdownSourceText(source);
}
