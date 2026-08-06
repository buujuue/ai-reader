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
    close(): void;
  }

  export function makeBook(file: File | string): Promise<unknown>;
}