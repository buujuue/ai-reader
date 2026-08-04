import { BookOpen } from 'lucide-react';

export function EditorArea() {
  return (
    <section
      aria-label="编辑器区"
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-zinc-950 px-6"
    >
      <BookOpen size={36} aria-hidden className="text-zinc-600" />
      <h1 className="text-lg font-semibold text-zinc-200">AI Reader</h1>
      <p className="max-w-md text-center text-sm leading-6 text-zinc-500">
        阅读工作区底座已就绪。阅读材料打开后,将在此处以标签与编辑器组的形式呈现。
      </p>
    </section>
  );
}
