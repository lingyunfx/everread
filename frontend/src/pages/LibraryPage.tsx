import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { LibraryItem } from "../api/types";
import { BookCover } from "../components/BookCover";
import { Button, Input, Spinner, useToast } from "../components/ui";

export function LibraryPage() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [query, setQuery] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setItems(await api.library(query));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [query, toast]);

  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">图书馆</h1>
          <p className="text-sm text-muted">成员公开分享的书。加入书架后，你的进度和笔记只有自己可见。</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted" />
          <Input placeholder="按书名或作者筛选" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
      </div>
      {items === null ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted">{query ? "没有匹配的书" : "还没有人公开分享书籍"}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6">
          {items.map(({ book, on_my_shelf }) => (
            <li key={book.id} data-testid="library-card">
              <Link to={`/read/${book.id}`}>
                <BookCover book={book} />
                <p className="mt-1.5 line-clamp-2 text-sm leading-snug font-medium">{book.title}</p>
              </Link>
              <p className="text-xs text-muted">{book.author ?? "佚名"}{book.is_owner && " · 我分享的"}</p>
              {on_my_shelf ? (
                <p className="mt-1 text-xs text-muted">已在书架</p>
              ) : (
                <Button
                  size="sm"
                  className="mt-1 w-full"
                  onClick={async () => {
                    try {
                      await api.addToShelf(book.id);
                      toast("已加入书架");
                      load();
                    } catch (e) {
                      toast((e as Error).message, "error");
                    }
                  }}
                >
                  加入书架
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
