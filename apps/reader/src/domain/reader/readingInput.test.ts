import { describe, expect, it, vi } from 'vitest';

import { COMMAND_IDS } from '../../commands/commandRegistry';
import {
  interpretKeyboard,
  interpretSwipe,
  interpretTap,
  interpretWheel,
  isInteractiveElement,
  ReadingInputController,
  WheelPageGate,
  shouldSuppressNativeTouch,
} from './readingInput';

describe('interpretKeyboard', () => {
  it('左右方向键与 PageUp/PageDown 翻页', () => {
    expect(interpretKeyboard({ key: 'ArrowLeft', flow: 'paginated', hasModifier: false })).toEqual({
      kind: 'turn',
      direction: 'prev',
    });
    expect(interpretKeyboard({ key: 'ArrowRight', flow: 'paginated', hasModifier: false })).toEqual({
      kind: 'turn',
      direction: 'next',
    });
    expect(interpretKeyboard({ key: 'PageUp', flow: 'paginated', hasModifier: false })).toEqual({
      kind: 'turn',
      direction: 'prev',
    });
    expect(interpretKeyboard({ key: 'PageDown', flow: 'paginated', hasModifier: false })).toEqual({
      kind: 'turn',
      direction: 'next',
    });
  });

  it('上下方向键只在分页模式翻页,滚动模式保留原生滚动', () => {
    expect(interpretKeyboard({ key: 'ArrowUp', flow: 'paginated', hasModifier: false })).toEqual({
      kind: 'turn',
      direction: 'prev',
    });
    expect(interpretKeyboard({ key: 'ArrowDown', flow: 'paginated', hasModifier: false })).toEqual({
      kind: 'turn',
      direction: 'next',
    });
    expect(interpretKeyboard({ key: 'ArrowUp', flow: 'scrolled', hasModifier: false })).toEqual({
      kind: 'ignore',
    });
    expect(interpretKeyboard({ key: 'ArrowDown', flow: 'scrolled', hasModifier: false })).toEqual({
      kind: 'ignore',
    });
  });

  it('按住修饰键时不抢占', () => {
    expect(interpretKeyboard({ key: 'ArrowRight', flow: 'paginated', hasModifier: true })).toEqual({
      kind: 'ignore',
    });
  });

  it('无关按键忽略', () => {
    expect(interpretKeyboard({ key: 'Enter', flow: 'paginated', hasModifier: false })).toEqual({
      kind: 'ignore',
    });
  });
});

describe('interpretWheel', () => {
  it('分页模式按主滚动轴方向翻页', () => {
    expect(interpretWheel({ deltaX: 0, deltaY: 100, flow: 'paginated' })).toEqual({
      kind: 'turn',
      direction: 'next',
    });
    expect(interpretWheel({ deltaX: 0, deltaY: -100, flow: 'paginated' })).toEqual({
      kind: 'turn',
      direction: 'prev',
    });
  });

  it('分页模式横向滚轮也翻页', () => {
    expect(interpretWheel({ deltaX: 80, deltaY: 0, flow: 'paginated' })).toEqual({
      kind: 'turn',
      direction: 'next',
    });
    expect(interpretWheel({ deltaX: -80, deltaY: 0, flow: 'paginated' })).toEqual({
      kind: 'turn',
      direction: 'prev',
    });
  });

  it('滚动模式保留原生滚动,不解释', () => {
    expect(interpretWheel({ deltaX: 0, deltaY: 100, flow: 'scrolled' })).toEqual({
      kind: 'ignore',
    });
  });

  it('零位移不翻页', () => {
    expect(interpretWheel({ deltaX: 0, deltaY: 0, flow: 'paginated' })).toEqual({
      kind: 'ignore',
    });
  });
});

describe('interpretTap', () => {
  it('分页模式点击左/右区域翻页,中间区域忽略', () => {
    expect(interpretTap({ clientX: 80, clientWidth: 900, flow: 'paginated', hasSelection: false })).toEqual({
      kind: 'turn',
      direction: 'prev',
    });
    expect(interpretTap({ clientX: 820, clientWidth: 900, flow: 'paginated', hasSelection: false })).toEqual({
      kind: 'turn',
      direction: 'next',
    });
    expect(
      interpretTap({ clientX: 450, clientWidth: 900, flow: 'paginated', hasSelection: false }),
    ).toEqual({ kind: 'ignore' });
  });

  it('选择中点击不翻页', () => {
    expect(interpretTap({ clientX: 50, clientWidth: 900, flow: 'paginated', hasSelection: true })).toEqual({
      kind: 'ignore',
    });
  });

  it('滚动模式不解释点击', () => {
    expect(interpretTap({ clientX: 50, clientWidth: 900, flow: 'scrolled', hasSelection: false })).toEqual({
      kind: 'ignore',
    });
  });
});

describe('interpretSwipe', () => {
  it('分页模式水平滑动翻页(右滑上一页、左滑下一页)', () => {
    expect(
      interpretSwipe({ deltaX: 120, deltaY: 10, flow: 'paginated', hasSelection: false }),
    ).toEqual({ kind: 'turn', direction: 'prev' });
    expect(
      interpretSwipe({ deltaX: -120, deltaY: 10, flow: 'paginated', hasSelection: false }),
    ).toEqual({ kind: 'turn', direction: 'next' });
  });

  it('垂直滑动与不足阈值不翻页', () => {
    expect(
      interpretSwipe({ deltaX: 10, deltaY: 120, flow: 'paginated', hasSelection: false }),
    ).toEqual({ kind: 'ignore' });
    expect(
      interpretSwipe({ deltaX: 10, deltaY: 5, flow: 'paginated', hasSelection: false }),
    ).toEqual({ kind: 'ignore' });
  });

  it('滚动模式与选择中不翻页', () => {
    expect(
      interpretSwipe({ deltaX: 120, deltaY: 10, flow: 'scrolled', hasSelection: false }),
    ).toEqual({ kind: 'ignore' });
    expect(
      interpretSwipe({ deltaX: -120, deltaY: 10, flow: 'paginated', hasSelection: true }),
    ).toEqual({ kind: 'ignore' });
  });
});

describe('shouldSuppressNativeTouch', () => {
  it('在文本选择过程中始终保留 WebView 原生触摸行为', () => {
    expect(
      shouldSuppressNativeTouch({
        phase: 'move',
        deltaX: 100,
        deltaY: 4,
        flow: 'paginated',
        hasSelection: true,
      }),
    ).toBe(false);
  });

  it('只在明确的横向翻页手势中拦截原生触摸', () => {
    expect(
      shouldSuppressNativeTouch({
        phase: 'move',
        deltaX: -24,
        deltaY: 3,
        flow: 'paginated',
        hasSelection: false,
      }),
    ).toBe(true);
    expect(
      shouldSuppressNativeTouch({
        phase: 'move',
        deltaX: 3,
        deltaY: 24,
        flow: 'paginated',
        hasSelection: false,
      }),
    ).toBe(false);
  });

  it('不会在滚动模式或触摸开始阶段拦截事件', () => {
    expect(
      shouldSuppressNativeTouch({
        phase: 'start',
        deltaX: 0,
        deltaY: 0,
        flow: 'paginated',
        hasSelection: false,
      }),
    ).toBe(false);
    expect(
      shouldSuppressNativeTouch({
        phase: 'move',
        deltaX: 100,
        deltaY: 0,
        flow: 'scrolled',
        hasSelection: false,
      }),
    ).toBe(false);
  });
});

describe('isInteractiveElement', () => {
  it('识别链接与按钮为交互控件', () => {
    const link = document.createElement('a');
    link.setAttribute('href', '#x');
    expect(isInteractiveElement(link)).toBe(true);
    const button = document.createElement('button');
    expect(isInteractiveElement(button)).toBe(true);
    const span = document.createElement('span');
    span.textContent = '正文';
    expect(isInteractiveElement(span)).toBe(false);
  });

  it('非元素目标不视为交互控件', () => {
    expect(isInteractiveElement(null)).toBe(false);
    expect(isInteractiveElement(undefined)).toBe(false);
  });
});

describe('WheelPageGate', () => {
  it('冷却窗口内只允许一次翻页', () => {
    const gate = new WheelPageGate(100);
    expect(gate.allow(0)).toBe(true);
    expect(gate.allow(50)).toBe(false);
    expect(gate.allow(120)).toBe(true);
  });
});

describe('ReadingInputController', () => {
  function createController(flow: 'paginated' | 'scrolled' = 'paginated') {
    const execute = vi.fn();
    const dispatch = {
      nextCommandId: COMMAND_IDS.readerNextPage,
      prevCommandId: COMMAND_IDS.readerPrevPage,
      execute,
      getFlow: () => flow,
      wheelCooldownMs: 0,
    };
    const controller = new ReadingInputController(dispatch, 'view-1');
    return { controller, execute };
  }

  it('滚轮输入调用同一组翻页 Command ID', () => {
    const { controller, execute } = createController();
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: 100 });
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: -100 });
    expect(execute).toHaveBeenNthCalledWith(1, COMMAND_IDS.readerNextPage, 'view-1');
    expect(execute).toHaveBeenNthCalledWith(2, COMMAND_IDS.readerPrevPage, 'view-1');
  });

  it('点击左右区域调用同一组翻页 Command ID', () => {
    const { controller, execute } = createController();
    controller.handle({ type: 'click', clientX: 50, clientWidth: 900, target: null });
    controller.handle({ type: 'click', clientX: 850, clientWidth: 900, target: null });
    expect(execute).toHaveBeenNthCalledWith(1, COMMAND_IDS.readerPrevPage, 'view-1');
    expect(execute).toHaveBeenNthCalledWith(2, COMMAND_IDS.readerNextPage, 'view-1');
  });

  it('键盘输入调用同一组翻页 Command ID', () => {
    const { controller, execute } = createController();
    controller.handleKey({ key: 'ArrowRight', flow: 'paginated', hasModifier: false });
    controller.handleKey({ key: 'PageUp', flow: 'paginated', hasModifier: false });
    expect(execute).toHaveBeenNthCalledWith(1, COMMAND_IDS.readerNextPage, 'view-1');
    expect(execute).toHaveBeenNthCalledWith(2, COMMAND_IDS.readerPrevPage, 'view-1');
  });

  it('触摸水平滑动调用同一组翻页 Command ID(与其它输入一致)', () => {
    const { controller, execute } = createController();
    controller.handle({ type: 'touch', phase: 'start', x: 300, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 100, y: 205, clientWidth: 900, timeStamp: 100 });
    expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerNextPage, 'view-1');
  });

  it('轻触(无滑动位移)按左右区域调用同一组翻页 Command ID', () => {
    const { controller, execute } = createController();
    controller.handle({ type: 'touch', phase: 'start', x: 60, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 62, y: 201, clientWidth: 900, timeStamp: 60 });
    expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerPrevPage, 'view-1');
    controller.handle({ type: 'touch', phase: 'start', x: 840, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 838, y: 201, clientWidth: 900, timeStamp: 60 });
    expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerNextPage, 'view-1');
  });

  it('扫描 PDF 区域拖选优先于触摸滑动,不会误发翻页 Command', () => {
    const { controller, execute } = createController();
    const page = document.createElement('div');
    page.className = 'pdf-page';
    page.dataset.textSelectable = 'false';

    controller.handle({
      type: 'touch',
      phase: 'start',
      x: 300,
      y: 200,
      clientWidth: 900,
      timeStamp: 0,
      target: page,
    });
    controller.handle({
      type: 'touch',
      phase: 'end',
      x: 180,
      y: 205,
      clientWidth: 900,
      timeStamp: 100,
      target: page,
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('交互控件上的点击不触发翻页', () => {
    const { controller, execute } = createController();
    const link = document.createElement('a');
    link.setAttribute('href', '#x');
    controller.handle({ type: 'click', clientX: 50, clientWidth: 900, target: link });
    expect(execute).not.toHaveBeenCalled();
  });

  it('选择中点击与滑动不触发翻页', () => {
    const { controller, execute } = createController();
    controller.setSelecting(true);
    controller.handle({ type: 'click', clientX: 50, clientWidth: 900, target: null });
    controller.handle({ type: 'touch', phase: 'start', x: 300, y: 200, clientWidth: 900, timeStamp: 0 });
    controller.handle({ type: 'touch', phase: 'end', x: 100, y: 205, clientWidth: 900, timeStamp: 100 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('滚动模式下滚轮与点击不触发翻页', () => {
    const { controller, execute } = createController('scrolled');
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: 100 });
    controller.handle({ type: 'click', clientX: 50, clientWidth: 900, target: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it('attach 只接收指定正文根节点内的点击,不会劫持工作台其它区域', () => {
    const { controller, execute } = createController();
    const readerRoot = document.createElement('div');
    const workbench = document.createElement('div');
    document.body.append(readerRoot, workbench);
    Object.defineProperty(readerRoot, 'clientWidth', { configurable: true, value: 900 });

    const detach = controller.attach(document, readerRoot);
    readerRoot.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 850 }));
    workbench.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 850 }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(COMMAND_IDS.readerNextPage, 'view-1');

    detach();
    readerRoot.remove();
    workbench.remove();
  });

  it('attach 按正文容器本地坐标划分左右区域', () => {
    const { controller, execute } = createController();
    const readerRoot = document.createElement('div');
    Object.defineProperty(readerRoot, 'clientWidth', { configurable: true, value: 600 });
    vi.spyOn(readerRoot, 'getBoundingClientRect').mockReturnValue({
      left: 300,
      top: 0,
      width: 600,
      height: 500,
      right: 900,
      bottom: 500,
      x: 300,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    document.body.append(readerRoot);
    const detach = controller.attach(document, readerRoot);

    readerRoot.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 350 }));
    readerRoot.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 850 }));

    expect(execute).toHaveBeenNthCalledWith(1, COMMAND_IDS.readerPrevPage, 'view-1');
    expect(execute).toHaveBeenNthCalledWith(2, COMMAND_IDS.readerNextPage, 'view-1');
    detach();
    readerRoot.remove();
  });

  it('触摸轻触后的浏览器兼容 click 不会把一次手势翻成两页', () => {
    const { controller, execute } = createController();
    const readerRoot = document.createElement('div');
    Object.defineProperty(readerRoot, 'clientWidth', { configurable: true, value: 900 });
    document.body.append(readerRoot);
    const detach = controller.attach(document, readerRoot);
    const touchEvent = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'changedTouches', {
        configurable: true,
        value: [{ clientX: x, clientY: y }],
      });
      return event;
    };

    readerRoot.dispatchEvent(touchEvent('touchstart', 850, 200));
    readerRoot.dispatchEvent(touchEvent('touchend', 850, 200));
    readerRoot.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 850 }));

    expect(execute).toHaveBeenCalledTimes(1);
    detach();
    readerRoot.remove();
  });

  it('交互控件上的轻触不触发翻页', () => {
    const { controller, execute } = createController();
    const link = document.createElement('a');
    link.href = '#section';
    controller.handle({
      type: 'touch',
      phase: 'start',
      x: 50,
      y: 200,
      clientWidth: 900,
      timeStamp: 0,
      target: link,
    });
    controller.handle({
      type: 'touch',
      phase: 'end',
      x: 50,
      y: 200,
      clientWidth: 900,
      timeStamp: 80,
      target: link,
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('滚轮限页:一次惯性手势只翻一页', () => {
    const execute = vi.fn();
    const controller = new ReadingInputController(
      {
        nextCommandId: COMMAND_IDS.readerNextPage,
        prevCommandId: COMMAND_IDS.readerPrevPage,
        execute,
        getFlow: () => 'paginated',
        wheelCooldownMs: 500,
      },
      'view-1',
    );
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: 100 });
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: 80 });
    controller.handle({ type: 'wheel', deltaX: 0, deltaY: 60 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
