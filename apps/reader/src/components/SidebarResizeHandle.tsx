import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

import { COMMAND_IDS } from '../commands/commandRegistry';
import {
  MAX_ACTIVITY_PANEL_WIDTH,
  MIN_ACTIVITY_PANEL_WIDTH,
} from '../domain/workspace/workspaceState';
import { useAppServices } from '../app/AppServicesContext';
import { useWorkspaceStore } from '../workbench/workspaceStore';

interface DragState {
  anchor: number;
  direction: 1 | -1;
  pointerId: number;
  width: number;
}

function getPanelElement(handle: HTMLDivElement | null): HTMLElement | null {
  return handle?.previousElementSibling instanceof HTMLElement
    ? handle.previousElementSibling
    : null;
}

function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_ACTIVITY_PANEL_WIDTH, Math.max(MIN_ACTIVITY_PANEL_WIDTH, width)));
}

export function SidebarResizeHandle() {
  const { commands } = useAppServices();
  const activityPanelWidth = useWorkspaceStore((state) => state.activityPanelWidth);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const executeResize = useCallback(
    (width: number, persist: boolean) => {
      void commands
        .execute(COMMAND_IDS.workbenchSetActivityPanelWidth, clampWidth(width), persist)
        .catch((error: unknown) => {
          console.error('保存侧栏宽度失败', error);
        });
    },
    [commands],
  );

  const finishDrag = useCallback(
    (event?: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;

      executeResize(drag.width, true);
      dragRef.current = null;
      setIsDragging(false);
      document.body.classList.remove('is-resizing-sidebar');
      if (event && handleRef.current?.hasPointerCapture(event.pointerId)) {
        handleRef.current.releasePointerCapture(event.pointerId);
      }
    },
    [executeResize],
  );

  useEffect(
    () => () => {
      dragRef.current = null;
      document.body.classList.remove('is-resizing-sidebar');
    },
    [],
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.isPrimary !== undefined && !event.isPrimary)) return;

    const panel = getPanelElement(handleRef.current);
    if (!panel) return;

    const panelRect = panel.getBoundingClientRect();
    const isRtl = getComputedStyle(panel).direction === 'rtl';
    dragRef.current = {
      anchor: isRtl ? panelRect.right : panelRect.left,
      direction: isRtl ? -1 : 1,
      pointerId: event.pointerId,
      width: activityPanelWidth,
    };
    setIsDragging(true);
    document.body.classList.add('is-resizing-sidebar');
    handleRef.current?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    const width = clampWidth((event.clientX - drag.anchor) * drag.direction);
    drag.width = width;
    executeResize(width, false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = getPanelElement(handleRef.current);
    const isRtl = panel ? getComputedStyle(panel).direction === 'rtl' : false;
    const growKey = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const shrinkKey = isRtl ? 'ArrowRight' : 'ArrowLeft';
    let nextWidth: number | null = null;

    if (event.key === growKey) nextWidth = activityPanelWidth + 12;
    if (event.key === shrinkKey) nextWidth = activityPanelWidth - 12;
    if (event.key === 'Home') nextWidth = MIN_ACTIVITY_PANEL_WIDTH;
    if (event.key === 'End') nextWidth = MAX_ACTIVITY_PANEL_WIDTH;
    if (nextWidth === null) return;

    event.preventDefault();
    executeResize(nextWidth, true);
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-label="调整左侧面板宽度"
      aria-orientation="vertical"
      aria-valuemin={MIN_ACTIVITY_PANEL_WIDTH}
      aria-valuemax={MAX_ACTIVITY_PANEL_WIDTH}
      aria-valuenow={activityPanelWidth}
      data-dragging={isDragging ? 'true' : 'false'}
      className="app-sidebar-resize-handle"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    />
  );
}
