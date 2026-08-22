/**
 * 在 Markdown 领域内把托管来源物化为 UTF-8 文本。
 *
 * Markdown 的解析器需要完整字符串，但读取仍经 ManagedFileSource 兼容来源的 stream()
 * 按受控分块完成；EPUB/PDF 不应复用这个全量文本物化入口。
 */
export async function readMarkdownSourceText(source: Blob): Promise<string> {
  const reader = source.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}
