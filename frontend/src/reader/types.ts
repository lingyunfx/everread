// 三种格式阅读器（PDF / EPUB / TXT）共用的接口：各自实现定位、选区与正文搜索
import type { RefObject } from "react";
import type { Annotation, BookDetail, Locator, Preferences } from "../api/types";

export interface LocationInfo {
  locator: Locator;
  percent: number;
  label: string; // 如“第 9 / 120 页”“第三章 · 42%”
  sortKey: number; // 书签按位置排序用
}

export interface TocItem {
  title: string;
  level: number;
  target: Locator | string; // EPUB 目录项为 href
}

export interface SelectionPart {
  locator: Locator;
  quote: string;
}

export interface SelectionInfo {
  // 跨页 PDF 选区拆成多段，各自保存为同组的页内标注
  parts: SelectionPart[];
  quote: string;
  rect: { left: number; top: number; bottom: number; width: number }; // 视口坐标，用于定位浮动菜单
}

export interface SearchHit {
  locator: Locator;
  snippet: string;
  label: string;
}

export interface EngineHandle {
  goTo(loc: Locator, opts?: { flash?: boolean }): void;
  goToToc(item: TocItem): void;
  current(): LocationInfo | null;
  /** 当前书内正文搜索：渐进返回结果，可通过 signal 取消 */
  search(q: string, onHit: (h: SearchHit) => void, signal: AbortSignal, onProgress: (ratio: number) => void): Promise<void>;
  clearSelection(): void;
}

export interface EngineProps {
  book: BookDetail;
  prefs: Preferences;
  annotations: Annotation[];
  initial: Locator | null;
  handleRef: RefObject<EngineHandle | null>;
  onReady: (toc: TocItem[]) => void;
  onLocation: (info: LocationInfo) => void;
  onSelection: (sel: SelectionInfo | null) => void;
  onAnnotationClick: (id: string) => void;
  onError: (message: string) => void;
}

export const HIGHLIGHT_COLORS = {
  yellow: "#ffd600",
  green: "#50c878",
  blue: "#50a0ff",
  pink: "#ff6eaa",
} as const;

export function snippetAround(text: string, index: number, len: number, width = 30): string {
  const start = Math.max(0, index - width);
  const end = Math.min(text.length, index + len + width);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
}

/** 浮动菜单的锚点：取选区末尾那一行（大段选区的整体包围盒可能超出视口） */
export function selectionAnchor(range: Range): SelectionInfo["rect"] {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
  const r = rects[rects.length - 1] ?? range.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, width: r.width };
}
