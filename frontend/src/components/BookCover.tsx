import clsx from "clsx";
import { useEffect, useState } from "react";
import { API, authHeaders } from "../api/client";
import type { Book } from "../api/types";

// 封面接口需要鉴权，<img> 无法携带请求头，这里取回 blob 后再显示
const cache = new Map<string, string>();

export function useCoverUrl(book: Book): string | null {
  const [url, setUrl] = useState<string | null>(() => cache.get(book.id) ?? null);
  useEffect(() => {
    if (!book.has_cover || cache.has(book.id)) {
      setUrl(cache.get(book.id) ?? null);
      return;
    }
    let cancelled = false;
    fetch(`${API}/books/${book.id}/cover`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        const u = URL.createObjectURL(blob);
        cache.set(book.id, u);
        setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [book.id, book.has_cover]);
  return url;
}

// 缺封面时的占位色：低饱和的中性色
const PALETTE = ["#3a3d44", "#56606b", "#6b6a64", "#4a5a58", "#5e5866", "#44505e"];

export function BookCover({ book, className }: { book: Book; className?: string }) {
  const url = useCoverUrl(book);
  const color = PALETTE[book.title.charCodeAt(0) % PALETTE.length];
  return (
    <div className={clsx("relative aspect-[3/4] overflow-hidden rounded-md border border-border bg-surface-2", className)}>
      {url ? (
        <img src={url} alt={book.title} className="h-full w-full object-cover" />
      ) : (
        // 缺封面时的占位
        <div className="flex h-full w-full flex-col justify-between p-3 text-white" style={{ background: color }}>
          <div className="line-clamp-4 font-serif text-sm leading-snug font-semibold">{book.title}</div>
          <div className="text-xs opacity-80">{book.author ?? book.format.toUpperCase()}</div>
        </div>
      )}
      <span className="absolute top-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white uppercase">
        {book.format}
      </span>
    </div>
  );
}
