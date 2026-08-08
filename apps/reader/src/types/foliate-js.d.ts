/** foliate-js 的最小类型声明。foliate-js 无官方类型,这里只声明用到的窄面。 */
declare module 'foliate-js/view.js' {
  export interface FoliateLocation {
    cfi?: string;
  }

  export class View {
    lastLocation?: FoliateLocation;
    open(book: unknown): Promise<void>;
    init(options: { lastLocation?: unknown } | { showTextStart?: boolean }): Promise<void>;
    next(): Promise<void>;
    prev(): Promise<void>;
    goTo(target: unknown): Promise<unknown>;
    search(opts: unknown): AsyncGenerator<unknown, void, unknown>;
    clearSearch(): void;
    close(): void;
    getCFI(index: number, range: Range): string;
    addAnnotation(annotation: { value: string; color?: string }, remove?: boolean): unknown;
  }

  export function makeBook(file: File | string): Promise<unknown>;
}

/** foliate-js 覆盖层(Overlayer)的最小类型声明,用于高亮批注绘制。 */
declare module 'foliate-js/overlayer.js' {
  export class Overlayer {
    static highlight(
      rects: Array<{ left: number; top: number; right: number; bottom: number }>,
      options?: { color?: string; padding?: number; radius?: number; vertical?: boolean },
    ): SVGElement;
  }
}