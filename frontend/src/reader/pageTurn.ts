// 翻页交互：点击左右两侧区域、方向键 / PageUp / PageDown / 空格、滚轮。
// 拖选文字、点到高亮或可交互元素时不翻页。
import { useEffect, useRef, type RefObject } from "react";

/** 双页需要的最小正文宽度，窄于此自动按单页显示 */
export const MIN_DOUBLE_WIDTH = 760;

/** 点击位置在左侧 30% 返回 -1（上一页），右侧 30% 返回 1（下一页），中间返回 0 */
export function zoneOf(clientX: number, box: DOMRect): -1 | 0 | 1 {
  const r = (clientX - box.left) / box.width;
  if (r < 0.3) return -1;
  if (r > 0.7) return 1;
  return 0;
}

const INTERACTIVE = "button, a, input, textarea, select, mark[data-ann], [data-no-turn]";

export function usePageTurn(
  ref: RefObject<HTMLElement | null>,
  turn: (dir: -1 | 1) => void,
  opts: { wheel?: boolean; isAnnotationHit?: (e: MouseEvent) => boolean } = {},
) {
  const turnRef = useRef(turn);
  const optsRef = useRef(opts);
  useEffect(() => {
    turnRef.current = turn;
    optsRef.current = opts;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let down: { x: number; y: number } | null = null;
    let lastWheel = 0;

    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      const start = down;
      down = null;
      if (e.button !== 0 || !start) return;
      // 拖动过（选字）或存在选区时不翻页
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
      if (!window.getSelection()?.isCollapsed) return;
      if ((e.target as Element).closest?.(INTERACTIVE)) return;
      if (optsRef.current.isAnnotationHit?.(e)) return;
      const dir = zoneOf(e.clientX, el.getBoundingClientRect());
      if (dir) turnRef.current(dir);
    };
    const onWheel = (e: WheelEvent) => {
      if (!optsRef.current.wheel || Math.abs(e.deltaY) < 8) return;
      // 内容可滚动（放大后）时先滚动，到边缘才翻页
      const sc = e.currentTarget as HTMLElement;
      // 只在明显超出（如放大后）时才算可滚动，忽略整页适配的舍入误差
      const canScroll = sc.scrollHeight > sc.clientHeight + 24;
      if (canScroll) {
        const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
        const atTop = sc.scrollTop <= 1;
        if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel < 350) return;
      lastWheel = now;
      turnRef.current(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("mousedown", onDown);
    el.addEventListener("click", onClick);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("click", onClick);
      el.removeEventListener("wheel", onWheel);
    };
  }, [ref]);

  // 键盘翻页（输入框内不处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        turnRef.current(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
        e.preventDefault();
        turnRef.current(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
