// 左侧栏：目录、书签（多书签、命名、备注、名称筛选）、标注列表
import clsx from "clsx";
import { BookmarkPlus, Check, Pencil, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Annotation, Bookmark, Locator } from "../api/types";
import { Input } from "../components/ui";
import type { TocItem } from "./types";
import { HIGHLIGHT_COLORS } from "./types";

export type LeftTab = "toc" | "bookmarks" | "annotations";

function locatorOrder(l: Locator): number {
  if (l.type === "pdf") return l.page * 1e4 - (l.rects?.[0]?.[3] ?? 0);
  if (l.type === "txt") return l.para * 1e4 + Math.min(l.offset, 9999);
  return l.percent ?? 0;
}

export function locatorLabel(l: Locator | null, pageCount?: number | null): string {
  if (!l) return "";
  if (l.type === "pdf") return `第 ${l.page}${pageCount ? ` / ${pageCount}` : ""} 页`;
  if (l.type === "txt") return `第 ${l.para + 1} 段`;
  return l.percent != null ? `${Math.round(l.percent)}%` : "";
}

export function LeftPanel({
  tab,
  setTab,
  toc,
  bookmarks,
  annotations,
  canJump,
  canCreate,
  pageCount,
  onToc,
  onJump,
  onAddBookmark,
  onUpdateBookmark,
  onDeleteBookmark,
  onAnnotation,
}: {
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  toc: TocItem[];
  bookmarks: Bookmark[];
  annotations: Annotation[];
  canJump: boolean;
  canCreate: boolean;
  pageCount?: number | null;
  onToc: (t: TocItem) => void;
  onJump: (l: Locator) => void;
  onAddBookmark: () => void;
  onUpdateBookmark: (id: string, data: { name?: string; memo?: string }) => void;
  onDeleteBookmark: (id: string) => void;
  onAnnotation: (a: Annotation) => void;
}) {
  const [filter, setFilter] = useState("");
  const shownBookmarks = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? bookmarks.filter((b) => (b.name + b.memo).toLowerCase().includes(f)) : bookmarks;
  }, [bookmarks, filter]);
  const sortedAnns = useMemo(() => {
    // 跨页标注同组只列一次
    const seen = new Set<string>();
    return [...annotations]
      .sort((a, b) => locatorOrder(a.locator) - locatorOrder(b.locator))
      .filter((a) => !a.group_id || (!seen.has(a.group_id) && seen.add(a.group_id)));
  }, [annotations]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-border text-sm" role="tablist">
        {(
          [
            ["toc", "目录"],
            ["bookmarks", `书签 ${bookmarks.length || ""}`],
            ["annotations", `标注 ${sortedAnns.length || ""}`],
          ] as [LeftTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={clsx("flex-1 py-2", tab === id ? "border-b-2 border-accent font-medium" : "text-muted")}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {tab === "toc" &&
          (toc.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted">这本书没有目录</p>
          ) : (
            <ul className="py-1 text-sm">
              {toc.map((t, i) => (
                <li key={i}>
                  <button
                    disabled={!canJump}
                    onClick={() => onToc(t)}
                    className="block w-full truncate py-1.5 pr-3 text-left hover:bg-surface-2"
                    style={{ paddingLeft: 12 + (t.level - 1) * 14 }}
                    title={t.title}
                  >
                    {t.title}
                    {typeof t.target !== "string" && t.target.type === "pdf" && (
                      <span className="float-right text-xs text-muted">{t.target.page}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ))}

        {tab === "bookmarks" && (
          <div className="p-2">
            <div className="mb-2 flex gap-1.5">
              <Input placeholder="按名称筛选书签" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8" />
              {canCreate && (
                <button
                  onClick={onAddBookmark}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 text-xs text-accent-fg"
                  title="在当前位置添加书签"
                >
                  <BookmarkPlus className="h-3.5 w-3.5" />添加
                </button>
              )}
            </div>
            {shownBookmarks.length === 0 && (
              <p className="p-4 text-center text-xs text-muted">{filter ? "没有匹配的书签" : "还没有书签"}</p>
            )}
            <ul className="space-y-1">
              {shownBookmarks.map((b) => (
                <BookmarkRow
                  key={b.id}
                  bookmark={b}
                  canJump={canJump}
                  onJump={() => onJump(b.locator)}
                  onSave={(d) => onUpdateBookmark(b.id, d)}
                  onDelete={() => onDeleteBookmark(b.id)}
                />
              ))}
            </ul>
          </div>
        )}

        {tab === "annotations" && (
          <ul className="space-y-1 p-2">
            {sortedAnns.length === 0 && <p className="p-4 text-center text-xs text-muted">选中正文文字即可高亮</p>}
            {sortedAnns.map((a) => (
              <li key={a.id}>
                <button
                  className="w-full rounded-md p-2 text-left hover:bg-surface-2"
                  onClick={() => onAnnotation(a)}
                  data-testid="annotation-item"
                >
                  <span
                    className="mb-1 block border-l-[3px] pl-2 text-sm leading-snug"
                    style={{ borderColor: HIGHLIGHT_COLORS[a.color] }}
                  >
                    <span className="line-clamp-3">{a.quote}</span>
                  </span>
                  <span className="pl-2.5 text-[11px] text-muted">{locatorLabel(a.locator, pageCount)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BookmarkRow({
  bookmark,
  canJump,
  onJump,
  onSave,
  onDelete,
}: {
  bookmark: Bookmark;
  canJump: boolean;
  onJump: () => void;
  onSave: (d: { name: string; memo: string }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(bookmark.name);
  const [memo, setMemo] = useState(bookmark.memo);
  if (editing) {
    return (
      <li className="space-y-1.5 rounded-md border border-border p-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="书签名称" className="h-8" autoFocus />
        <textarea
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="备注"
          rows={2}
          className="w-full rounded-md border border-border bg-surface p-2 text-sm outline-none focus:border-accent"
        />
        <div className="flex justify-end gap-1">
          <button className="rounded p-1 hover:bg-surface-2" onClick={() => setEditing(false)} aria-label="取消"><X className="h-4 w-4" /></button>
          <button
            className="rounded p-1 text-accent hover:bg-surface-2"
            aria-label="保存书签"
            onClick={() => {
              onSave({ name, memo });
              setEditing(false);
            }}
          >
            <Check className="h-4 w-4" />
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="group flex items-start gap-1 rounded-md hover:bg-surface-2" data-testid="bookmark-item">
      <button className="min-w-0 flex-1 p-2 text-left" onClick={onJump} disabled={!canJump}>
        <span className="block truncate text-sm">{bookmark.name || bookmark.position_label}</span>
        <span className="block text-[11px] text-muted">{bookmark.position_label}</span>
        {bookmark.memo && <span className="mt-0.5 block line-clamp-2 text-xs text-muted">{bookmark.memo}</span>}
      </button>
      <div className="flex shrink-0 gap-0.5 p-1 opacity-0 group-hover:opacity-100 max-sm:opacity-100">
        <button className="rounded p-1 hover:bg-surface" onClick={() => setEditing(true)} aria-label="编辑书签"><Pencil className="h-3.5 w-3.5" /></button>
        <button className="rounded p-1 hover:bg-surface hover:text-danger" onClick={onDelete} aria-label="删除书签"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
    </li>
  );
}
