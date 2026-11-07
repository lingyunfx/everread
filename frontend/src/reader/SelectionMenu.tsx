// 选中文字后的浮动菜单，以及点击已有标注时的操作菜单
import clsx from "clsx";
import { Copy, Highlighter, StickyNote, Trash2 } from "lucide-react";
import type { Annotation, HighlightColor } from "../api/types";
import type { SelectionInfo } from "./types";
import { HIGHLIGHT_COLORS } from "./types";

const COLORS = Object.keys(HIGHLIGHT_COLORS) as HighlightColor[];
const COLOR_NAMES: Record<HighlightColor, string> = { yellow: "黄色", green: "绿色", blue: "蓝色", pink: "粉色" };

function position(rect: SelectionInfo["rect"]) {
  const width = 260;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const above = rect.top > 110;
  const top = above ? rect.top - 52 : rect.bottom + 10;
  // 始终保持在视口内
  return { left, top: Math.min(Math.max(56, top), window.innerHeight - 56), width };
}

export function SelectionMenu({
  selection,
  onHighlight,
  onNote,
  onCopy,
}: {
  selection: SelectionInfo;
  onHighlight: (color: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
}) {
  const pos = position(selection.rect);
  return (
    <div
      className="fixed z-40 flex items-center gap-1 rounded-lg border border-border bg-surface p-1.5 shadow-xl"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.preventDefault()}
      data-testid="selection-menu"
    >
      <Highlighter className="mx-1 h-4 w-4 text-muted" />
      {COLORS.map((c) => (
        <button
          key={c}
          title={`${COLOR_NAMES[c]}高亮`}
          aria-label={`${COLOR_NAMES[c]}高亮`}
          onClick={() => onHighlight(c)}
          className="h-6 w-6 rounded-full border border-black/10 hover:scale-110"
          style={{ background: HIGHLIGHT_COLORS[c] }}
        />
      ))}
      <span className="mx-1 h-5 w-px bg-border" />
      <button className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-surface-2" onClick={onNote}>
        <StickyNote className="h-4 w-4" /> 写笔记
      </button>
      <button className="rounded p-1.5 hover:bg-surface-2" title="复制" onClick={onCopy}>
        <Copy className="h-4 w-4" />
      </button>
    </div>
  );
}

export function AnnotationMenu({
  annotation,
  hasNote,
  onColor,
  onNote,
  onDelete,
  onClose,
}: {
  annotation: Annotation;
  hasNote: boolean;
  onColor: (c: HighlightColor) => void;
  onNote: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        className="absolute bottom-6 left-1/2 w-[min(92vw,380px)] -translate-x-1/2 rounded-lg border border-border bg-surface p-3 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="annotation-menu"
      >
        <p className="mb-2 line-clamp-3 border-l-2 border-accent pl-2 text-sm text-muted">{annotation.quote || "（无文字）"}</p>
        <div className="flex items-center gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              aria-label={`改为${COLOR_NAMES[c]}`}
              onClick={() => onColor(c)}
              className={clsx("h-6 w-6 rounded-full border", annotation.color === c ? "border-fg ring-2 ring-accent" : "border-black/10")}
              style={{ background: HIGHLIGHT_COLORS[c] }}
            />
          ))}
          <span className="flex-1" />
          <button className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-surface-2" onClick={onNote}>
            <StickyNote className="h-4 w-4" /> {hasNote ? "查看笔记" : "写笔记"}
          </button>
          <button className="flex items-center gap-1 rounded px-2 py-1 text-sm text-danger hover:bg-surface-2" onClick={onDelete}>
            <Trash2 className="h-4 w-4" /> 删除
          </button>
        </div>
        {hasNote && <p className="mt-2 text-xs text-muted">删除标注后，关联笔记及其引用原文会保留。</p>}
      </div>
    </div>
  );
}
