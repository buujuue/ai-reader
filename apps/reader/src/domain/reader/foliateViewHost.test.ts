import { describe, expect, it, vi } from 'vitest';

import { UpstreamFoliateViewHost } from './foliateViewHost';

interface FakeViewElement {
  open: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  prev: ReturnType<typeof vi.fn>;
  goTo: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  lastLocation?: { cfi?: string };
  book?: { transformTarget?: EventTarget };
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function createFakeElement(): FakeViewElement {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn().mockResolvedValue(undefined),
    goTo: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
  };
}

function createHost(element: FakeViewElement) {
  return new UpstreamFoliateViewHost(
    element as unknown as import('foliate-js/view.js').View & HTMLElement,
    Promise.resolve({} as typeof import('foliate-js/view.js')),
  );
}

describe('UpstreamFoliateViewHost 安全接线', () => {
  it('打开文档后把内容清洗监听器接到 foliate 的 transformTarget(data 事件)', async () => {
    const element = createFakeElement();
    const transformTarget = new EventTarget();
    element.book = { transformTarget };
    const host = createHost(element);

    const listener = vi.fn((_type: string, data: string) => data);
    host.onContentData(listener);
    await host.open({});

    // 模拟 foliate Loader 派发 data 事件。
    const detail = { data: '<p>正文</p>', type: 'application/xhtml+xml' };
    transformTarget.dispatchEvent(new CustomEvent('data', { detail }));

    expect(listener).toHaveBeenCalledWith('application/xhtml+xml', '<p>正文</p>');
  });

  it('拦截外部链接,阻止阅读帧导航到远程资源', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    const externalHandler = element.addEventListener.mock.calls.find(
      ([type]) => type === 'external-link',
    )?.[1] as EventListener | undefined;
    expect(externalHandler).toBeDefined();

    const event = new Event('external-link', { cancelable: true });
    externalHandler?.(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('close 释放渲染器并移除元素', async () => {
    const element = createFakeElement();
    const host = createHost(element);
    await host.open({});

    host.close();

    expect(element.close).toHaveBeenCalled();
    expect(element.remove).toHaveBeenCalled();
  });
});