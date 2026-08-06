import type { ReadingLocation } from '../domain/reader/readingLocation';

export interface PositionPersisterOptions {
  /** 保存回调(实际写入持久化)。 */
  save: (location: ReadingLocation) => Promise<void>;
  /** 是否已节流写入节流间隔(ms)。 */
  throttledMs?: number;
}

/**
 * 阅读位置节流写入器:高频 relocate 事件被合并为周期写入,关闭时强制 flush。
 * 保证重启后恢复的是用户关闭或离开视图时的最新位置。
 */
export class ThrottledPositionPersister {
  private readonly save: (location: ReadingLocation) => Promise<void>;
  private readonly throttledMs: number;
  private latest: ReadingLocation | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(options: PositionPersisterOptions) {
    this.save = options.save;
    this.throttledMs = options.throttledMs ?? 500;
  }

  /** 记录一次位置变化(节流合并)。 */
  update(location: ReadingLocation): void {
    this.latest = location;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.throttledMs);
  }

  /** 立即把最新位置写入持久化,清空待写状态。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing || !this.latest) {
      return;
    }
    this.flushing = true;
    const location = this.latest;
    this.latest = null;
    try {
      await this.save(location);
    } finally {
      this.flushing = false;
    }
  }

  /** 关闭:取消待写定时器并强制 flush。 */
  async dispose(): Promise<void> {
    await this.flush();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}