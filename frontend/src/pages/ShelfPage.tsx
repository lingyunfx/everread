import clsx from "clsx";
import { Ellipsis, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import type { ReadStatus, ShelfItem } from "../api/types";
import { BookCover } from "../components/BookCover";
import { Uploader } from "../components/UploadPanel";
import { Button, Input, Spinner, formatTime, useToast } from "../components/ui";

const FILTERS: { id: ReadStatus | "all" | "removed"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "unread", label: "未读" },
  { id: "reading", label: "在读" },
  { id: "finished", label: "已读" },
  { id: "removed", label: "已移出" },
];

const STATUS_LABEL: Record<ReadStatus, string> = { unread: "未读", reading: "在读", finished: "已读" };
const REASON_LABEL = { deleted: "原书已删除", private: "暂不可访问", failed: "解析失败", processing: "解析中" };

export function ShelfPage() {
  const [items, setItems] = useState<ShelfItem[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setItems(
        await api.shelf({
          read_status: filter === "all" || filter === "removed" ? undefined : filter,
          removed: filter === "removed" || undefined,
          q: query,
          sort,
        }),
      );
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [filter, query, sort, toast]);

  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  const continueItem = items?.find((i) => i.accessible && i.read_status === "reading" && i.last_read_at);

  return (
    <div>
      {continueItem && filter === "all" && !query && (
        <Link
          to={`/read/${continueItem.book.id}`}
          className="mb-6 flex items-center gap-4 rounded-lg border border-border bg-surface p-3 hover:border-accent/60"
        >
          <BookCover book={continueItem.book} className="w-12 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">继续阅读</p>
            <p className="truncate font-medium">{continueItem.book.title}</p>
            <p className="text-xs text-muted">
              已读 {Math.round(continueItem.percent ?? 0)}% · {formatTime(continueItem.last_read_at)}
            </p>
          </div>
          <Button variant="primary" size="sm" tabIndex={-1}>继续阅读</Button>
        </Link>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border bg-surface p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={clsx("rounded px-3 py-1 text-sm", filter === f.id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted" />
          <Input placeholder="按书名搜索" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="h-9 rounded-md border border-border bg-surface px-2 text-sm"
          aria-label="排序"
        >
          <option value="recent">最近阅读</option>
          <option value="added">最近加入</option>
          <option value="title">书名</option>
        </select>
        <Uploader onChanged={load} />
      </div>

      {items === null ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted">
          {query ? "没有找到匹配的书" : filter === "all" ? "书架还是空的：点右上角“上传”，或把书拖到这里，也可以去图书馆看看" : "这里没有书"}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
          {items.map((it) => (
            <ShelfCard key={it.book.id} item={it} onChanged={load} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ShelfCard({ item, onChanged }: { item: ShelfItem; onChanged: () => void }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const { book } = item;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setMenu(false);
    try {
      await fn();
      toast(msg);
      onChanged();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <li className="group relative" data-testid="shelf-card">
      <button
        className={clsx("block w-full text-left", !item.accessible && "opacity-60")}
        onClick={() => navigate(`/read/${book.id}`)}
      >
        <BookCover book={book} />
        {item.percent != null && item.accessible && (
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-surface-2">
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, item.percent)}%` }} />
          </div>
        )}
        <p className="mt-1.5 line-clamp-2 text-sm leading-snug font-medium">{book.title}</p>
      </button>
      <p className="mt-0.5 text-xs text-muted">
        {item.unavailable_reason ? (
          <span className="text-danger">{REASON_LABEL[item.unavailable_reason]}</span>
        ) : (
          <>
            {STATUS_LABEL[item.read_status]}
            {item.percent != null && ` · ${Math.round(item.percent)}%`}
            {item.last_read_at && ` · ${formatTime(item.last_read_at)}`}
          </>
        )}
        {!book.is_owner && <span className="ml-1">· 来自图书馆</span>}
      </p>
      <div ref={menuRef} className="absolute top-1 left-1">
        <button
          className="rounded bg-black/50 p-1 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 max-sm:opacity-100"
          aria-label="更多操作"
          onClick={() => setMenu((m) => !m)}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
        {menu && (
          <div className="absolute z-20 mt-1 w-36 overflow-hidden rounded-md border border-border bg-surface py-1 text-sm shadow-lg">
            {item.on_shelf ? (
              <>
                {(["unread", "reading", "finished"] as ReadStatus[])
                  .filter((s) => s !== item.read_status)
                  .map((s) => (
                    <MenuItem key={s} onClick={() => act(() => api.setReadStatus(book.id, s), `已标记为${STATUS_LABEL[s]}`)}>
                      标记为{STATUS_LABEL[s]}
                    </MenuItem>
                  ))}
                <MenuItem onClick={() => act(() => api.removeFromShelf(book.id), "已移出书架，阅读记录仍保留")}>移出书架</MenuItem>
              </>
            ) : (
              item.accessible && <MenuItem onClick={() => act(() => api.addToShelf(book.id), "已放回书架")}>放回书架</MenuItem>
            )}
            {!item.accessible && (
              <MenuItem
                danger
                onClick={() => {
                  if (confirm("将删除你在这本书上的进度、笔记、标注和书签，且无法恢复。确定吗？"))
                    act(() => api.deleteMyRecords(book.id), "已清除个人记录");
                }}
              >
                清除我的记录
              </MenuItem>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={clsx("block w-full px-3 py-1.5 text-left hover:bg-surface-2", danger && "text-danger")}>
      {children}
    </button>
  );
}
