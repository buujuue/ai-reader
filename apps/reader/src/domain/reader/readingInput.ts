/**
 * 阅读输入(Reading Input)统一层。
 *
 * 键盘、鼠标滚轮、点击/轻触与触摸滑动都表达同一组稳定阅读意图(翻页/导航),
 * 但具体输入形式不同。本模块把每种输入归一化为"翻一页"意图,并统一收敛到
 * 同一组 Command ID 分发,不让不同输入 Adapter 各自实现翻页规则。
 *
 * 本模块不依赖任何 UI 框架或具体渲染器:
 * - 纯解释器(`interpretKeyboard`/`interpretWheel`/`interpretTap`/`interpretSwipe`)
 *   把归一化输入映射为"翻页/忽略",便于独立测试。
 * - `ReadingInputController` 把解释结果转成 Command ID 执行,并承担
 *   分页/滚动模式读取、滚轮限页与选区优先等跨输入的状态。
 * - `attach()` 把内容文档(iframe 内)的原始 DOM 事件归一化为输入并喂给
 *   控制器,同时抑制 foliate 原生触摸滑动,避免同一手势双翻页。
 */

/** 统一的翻页方向。 */
export type ReadingTurnDirection = 'next' | 'prev';

/** 阅读排版的分页/滚动模式。 */
export type ReadingFlowInput = 'paginated' | 'scrolled';

/** 对一次输入的归一化结果。 */
export type InterpretedReading =
  | { kind: 'turn'; direction: ReadingTurnDirection }
  | { kind: 'ignore' };

/**
 * 从内容文档(iframe 内)桥接出来的交互事件。宿主把这些原始 DOM 事件归一化
 * 后交给上层,由上层统一解释并从 Command 分发。
 */
export type ContentInteraction =
  | {
      type: 'wheel';
      deltaX: number;
      deltaY: number;
      /** 分页模式下需要阻止内容帧原生滚动时调用。 */
      preventDefault?: () => void;
    }
  | {
      type: 'click';
      clientX: number;
      /** 内容视口宽度,用于计算左右点击翻页区域。 */
      clientWidth: number;
      /** 点击目标,用于识别交互控件/链接以不误触翻页。 */
      target: unknown;
    }
  | {
      type: 'touch';
      phase: 'start' | 'move' | 'end';
      /** 内容视口坐标(iframe 内)。 */
      x: number;
      y: number;
      /** 内容视口宽度,用于轻触按左右区域翻页。 */
      clientWidth: number;
      timeStamp: number;
      preventDefault?: () => void;
    };

/** 键盘输入归一化入参。 */
export interface KeyboardInput {
  key: string;
  flow: ReadingFlowInput;
  /** 是否按住 Ctrl/Cmd/Alt(避免抢占浏览器或搜索快捷键)。 */
  hasModifier: boolean;
}

/** 滚轮输入归一化入参。 */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  flow: ReadingFlowInput;
}

/** 点击/轻触输入归一化入参。 */
export interface TapInput {
  clientX: number;
  clientWidth: number;
  flow: ReadingFlowInput;
  /** 是否正处于文本选择中(选择优先于翻页)。 */
  hasSelection: boolean;
}

/** 滑动输入归一化入参。 */
export interface SwipeInput {
  deltaX: number;
  deltaY: number;
  flow: ReadingFlowInput;
  hasSelection: boolean;
}

/** 交互控件/链接选择器:点击这些区域不触发翻页。 */
const INTERACTIVE_SELECTOR =
  'a[href], button, [contenteditable], input, textarea, select, [role="button"]';

/**
 * 判断点击目标是否落在交互控件或链接上。这类区域的点击/轻触不应触发翻页。
 */
export function isInteractiveElement(target: unknown): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) {
    return false;
  }
  return target.closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * 解释键盘输入。方向键与 PageUp/PageDown 翻页;上下方向键只在分页模式翻页,
 * 滚动模式保留原生垂直滚动。按住修饰键时不抢占浏览器/搜索快捷键。
 */
export function interpretKeyboard(input: KeyboardInput): InterpretedReading {
  if (input.hasModifier) {
    return { kind: 'ignore' };
  }
  switch (input.key) {
    case 'ArrowLeft':
    case 'PageUp':
      return { kind: 'turn', direction: 'prev' };
    case 'ArrowRight':
    case 'PageDown':
      return { kind: 'turn', direction: 'next' };
    case 'ArrowUp':
      return input.flow === 'paginated'
        ? { kind: 'turn', direction: 'prev' }
        : { kind: 'ignore' };
    case 'ArrowDown':
      return input.flow === 'paginated'
        ? { kind: 'turn', direction: 'next' }
        : { kind: 'ignore' };
    default:
      return { kind: 'ignore' };
  }
}

/**
 * 解释鼠标滚轮。分页模式下一次滚轮手势(含触控板惯性)最多翻一页,方向由
 * 主滚动轴决定;滚动模式不做解释,保留原生滚动。
 */
export function interpretWheel(input: WheelInput): InterpretedReading {
  if (input.flow === 'scrolled') {
    return { kind: 'ignore' };
  }
  const { deltaX, deltaY } = input;
  if (deltaY === 0 && deltaX === 0) {
    return { kind: 'ignore' };
  }
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    return deltaY > 0 ? { kind: 'turn', direction: 'next' } : { kind: 'turn', direction: 'prev' };
  }
  return deltaX > 0 ? { kind: 'turn', direction: 'next' } : { kind: 'turn', direction: 'prev' };
}

/** 点击翻页的左右区域边界(各占视口宽度的比例)。中间区域不翻页。 */
const TAP_EDGE_RATIO = 1 / 3;

/**
 * 解释点击/轻触。分页模式下点击正文左/右区域翻页,中间区域不翻页;
 * 滚动模式不解释点击;进行文本选择时不翻页。
 */
export function interpretTap(input: TapInput): InterpretedReading {
  if (input.flow !== 'paginated' || input.hasSelection || input.clientWidth <= 0) {
    return { kind: 'ignore' };
  }
  const leftEdge = input.clientWidth * TAP_EDGE_RATIO;
  const rightEdge = input.clientWidth * (1 - TAP_EDGE_RATIO);
  if (input.clientX < leftEdge) {
    return { kind: 'turn', direction: 'prev' };
  }
  if (input.clientX > rightEdge) {
    return { kind: 'turn', direction: 'next' };
  }
  return { kind: 'ignore' };
}

/** 判定为一次水平滑动翻页的最小位移(px)。 */
export const SWIPE_THRESHOLD = 30;

/**
 * 解释触摸滑动。分页模式下水平滑动翻页(向右滑上一页、向左滑下一页),
 * 垂直滑动与滚动模式都保留原生滚动;进行文本选择时不翻页。
 */
export function interpretSwipe(input: SwipeInput): InterpretedReading {
  if (input.flow !== 'paginated' || input.hasSelection) {
    return { kind: 'ignore' };
  }
  if (Math.abs(input.deltaX) <= Math.abs(input.deltaY)) {
    return { kind: 'ignore' };
  }
  if (Math.abs(input.deltaX) < SWIPE_THRESHOLD) {
    return { kind: 'ignore' };
  }
  return input.deltaX > 0
    ? { kind: 'turn', direction: 'prev' }
    : { kind: 'turn', direction: 'next' };
}

/**
 * 滚轮限页闸门:一次滚轮/触控板惯性手势会连续派发多个 wheel 事件,
 * 在冷却窗口内只允许第一次触发翻页,从而"一次手势最多翻一页"。
 */
export class WheelPageGate {
  private lastTurnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly cooldownMs = 350) {}

  /** 当前时刻是否允许一次翻页;允许则记录时刻。 */
  allow(now: number): boolean {
    if (now - this.lastTurnAt < this.cooldownMs) {
      return false;
    }
    this.lastTurnAt = now;
    return true;
  }
}

/** 控制器依赖:如何把确定的 Command ID 分发给指定阅读视图。 */
export interface ReadingInputDispatch {
  /** 翻下一页命令的稳定 ID(由装配方传入,本模块不直接依赖 Command Registry)。 */
  nextCommandId: string;
  /** 翻上一页命令的稳定 ID。 */
  prevCommandId: string;
  /** 执行命令。返回被忽略,调用方可选择同步或异步。 */
  execute: (commandId: string, viewId: string) => unknown;
  /** 读取当前阅读视图生效的分页/滚动模式。 */
  getFlow: () => ReadingFlowInput;
  /** 滚轮限页冷却窗口(ms)。 */
  wheelCooldownMs?: number;
}

/**
 * 统一阅读输入控制器。它接收归一化的输入事件,结合当前模式与选区状态
 * 解释成翻页意图,并统一收敛到同一组 Command ID。所有输入 Adapter
 * (键盘、滚轮、点击、滑动)最终都经由它分发,而不是各自改 Store 或渲染器。
 */
export class ReadingInputController {
  private readonly dispatch: ReadingInputDispatch;
  private readonly viewId: string;
  private readonly gate: WheelPageGate;
  private selecting = false;
  private touchStart: { x: number; y: number; timeStamp: number } | null = null;

  constructor(dispatch: ReadingInputDispatch, viewId: string) {
    this.dispatch = dispatch;
    this.viewId = viewId;
    this.gate = new WheelPageGate(dispatch.wheelCooldownMs);
  }

  /** 设置当前是否处于文本选择中(选择优先于翻页)。 */
  setSelecting(value: boolean): void {
    this.selecting = value;
  }

  /** 处理键盘输入(来自内容帧或应用窗口的 keydown)。 */
  handleKey(input: KeyboardInput): void {
    const reading = interpretKeyboard(input);
    if (reading.kind === 'turn') {
      this.exec(reading.direction);
    }
  }

  /** 处理从内容文档桥接出来的交互事件。 */
  handle(detail: ContentInteraction): void {
    const flow = this.dispatch.getFlow();
    switch (detail.type) {
      case 'wheel': {
        const reading = interpretWheel({ deltaX: detail.deltaX, deltaY: detail.deltaY, flow });
        if (reading.kind === 'turn' && this.gate.allow(performance.now())) {
          detail.preventDefault?.();
          this.exec(reading.direction);
        }
        break;
      }
      case 'click': {
        if (isInteractiveElement(detail.target)) {
          break;
        }
        const reading = interpretTap({
          clientX: detail.clientX,
          clientWidth: detail.clientWidth,
          flow,
          hasSelection: this.selecting,
        });
        if (reading.kind === 'turn') {
          this.exec(reading.direction);
        }
        break;
      }
      case 'touch': {
        this.handleTouch(detail, flow);
        break;
      }
    }
  }

  /**
   * 把内容文档(iframe 内)的原始 DOM 事件归一化并喂给本控制器,同时
   * 在分页模式下用捕获期 `stopImmediatePropagation` 抑制 foliate 原生触摸
   * 滑动,避免同一水平滑动手势被翻两次页;滚动模式保留原生垂直滚动。
   * 返回取消订阅函数。
   */
  attach(doc: Document): () => void {
    const onWheel = (event: Event) => {
      const wheel = event as WheelEvent;
      if (this.dispatch.getFlow() === 'paginated') {
        wheel.preventDefault();
      }
      this.handle({
        type: 'wheel',
        deltaX: wheel.deltaX,
        deltaY: wheel.deltaY,
        preventDefault: () => wheel.preventDefault(),
      });
    };
    const onClick = (event: Event) => {
      const mouse = event as MouseEvent;
      this.handle({
        type: 'click',
        clientX: mouse.clientX,
        clientWidth: doc.defaultView?.innerWidth ?? 0,
        target: event.target,
      });
    };
    const suppressNativeTouch = (event: Event) => {
      if (this.dispatch.getFlow() === 'paginated') {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    };
    const onTouchStart = (event: Event) => {
      suppressNativeTouch(event);
      const touch = (event as TouchEvent).changedTouches[0];
      this.handle({
        type: 'touch',
        phase: 'start',
        x: touch?.clientX ?? 0,
        y: touch?.clientY ?? 0,
        clientWidth: doc.defaultView?.innerWidth ?? 0,
        timeStamp: event.timeStamp,
        preventDefault: () => event.preventDefault(),
      });
    };
    const onTouchMove = (event: Event) => {
      suppressNativeTouch(event);
      const touch = (event as TouchEvent).changedTouches[0];
      this.handle({
        type: 'touch',
        phase: 'move',
        x: touch?.clientX ?? 0,
        y: touch?.clientY ?? 0,
        clientWidth: doc.defaultView?.innerWidth ?? 0,
        timeStamp: event.timeStamp,
      });
    };
    const onTouchEnd = (event: Event) => {
      suppressNativeTouch(event);
      const touch = (event as TouchEvent).changedTouches[0];
      this.handle({
        type: 'touch',
        phase: 'end',
        x: touch?.clientX ?? 0,
        y: touch?.clientY ?? 0,
        clientWidth: doc.defaultView?.innerWidth ?? 0,
        timeStamp: event.timeStamp,
        preventDefault: () => event.preventDefault(),
      });
    };
    const onSelectionChange = () => {
      const selection = doc.getSelection?.();
      this.setSelecting(!!selection && !selection.isCollapsed);
    };
    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      this.handleKey({
        key: key.key,
        flow: this.dispatch.getFlow(),
        hasModifier: key.ctrlKey || key.metaKey || key.altKey,
      });
    };

    const capture = { capture: true, passive: false } as AddEventListenerOptions;
    doc.addEventListener('wheel', onWheel, { passive: false });
    doc.addEventListener('click', onClick);
    doc.addEventListener('touchstart', onTouchStart, capture);
    doc.addEventListener('touchmove', onTouchMove, capture);
    doc.addEventListener('touchend', onTouchEnd, capture);
    doc.addEventListener('selectionchange', onSelectionChange);
    doc.addEventListener('keydown', onKeyDown);

    return () => {
      doc.removeEventListener('wheel', onWheel);
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('touchstart', onTouchStart, capture);
      doc.removeEventListener('touchmove', onTouchMove, capture);
      doc.removeEventListener('touchend', onTouchEnd, capture);
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }

  private handleTouch(detail: Extract<ContentInteraction, { type: 'touch' }>, flow: ReadingFlowInput): void {
    if (detail.phase === 'start') {
      this.touchStart = { x: detail.x, y: detail.y, timeStamp: detail.timeStamp };
      return;
    }
    if (detail.phase === 'end') {
      if (this.touchStart) {
        const deltaX = detail.x - this.touchStart.x;
        const deltaY = detail.y - this.touchStart.y;
        const swipe = interpretSwipe({
          deltaX,
          deltaY,
          flow,
          hasSelection: this.selecting,
        });
        if (swipe.kind === 'turn') {
          detail.preventDefault?.();
          this.exec(swipe.direction);
        } else if (
          Math.abs(deltaX) < SWIPE_THRESHOLD &&
          Math.abs(deltaY) < SWIPE_THRESHOLD
        ) {
          // 位移很小:视为轻触,按左右区域翻页(AC #3)。
          const tap = interpretTap({
            clientX: detail.x,
            clientWidth: detail.clientWidth,
            flow,
            hasSelection: this.selecting,
          });
          if (tap.kind === 'turn') {
            this.exec(tap.direction);
          }
        }
      }
      this.touchStart = null;
    }
  }

  private exec(direction: ReadingTurnDirection): void {
    const commandId = direction === 'next' ? this.dispatch.nextCommandId : this.dispatch.prevCommandId;
    this.dispatch.execute(commandId, this.viewId);
  }
}