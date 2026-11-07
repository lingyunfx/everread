// 当前书内搜索：正文 / 我的笔记 / 我的标注，只查当前书籍与当前用户的记录
import clsx from "clsx";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api/client";
import type { Locator, RecordHit } from "../api/types";
import { Spinner } from "../components/ui";
import type { EngineHandle, SearchHit } from "./types";

type Kind = "text" | "note" | "annotation";

export function SearchPanel({
  bookId,
  engine,
  textSearchable,
  onJump,
  onOpenNote,
  onClose,
}: {
  bookId: string;
  engine: RefObject<EngineHandle | null>;
  textSearchable: boolean;
  onJump: (loc: Locator) => void;
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>(textSearchable ? "text" : "note");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [textHits, setTextHits] = useState<SearchHit[]>([]);
  const [records, setRecords] = useState<RecordHit[]>([]);
  const [total, setTotal] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async (q: string, k: Kind) => {
    abortRef.current?.abort();
    setSubmitted(q);
    setTextHits([]);
    setRecords([]);
    setTotal(0);
    if (!q.trim()) return;
    if (k === "text") {
      if (!textSearchable) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setRunning(true);
      setProgress(0);
      // 渐进返回结果：缓冲后批量更新界面
      let buf: SearchHit[] = [];
      const flush = () => {
        if (buf.length) {
          const b = buf;
          buf = [];
          setTextHits((h) => [...h, ...b]);
        }
      };
      const iv = setInterval(flush, 150);
      try {
        await engine.current?.search(q, (h) => buf.push(h), ctrl.signal, setProgress);
      } finally {
        clearInterval(iv);
        flush();
        if (abortRef.current === ctrl) setRunning(false);
      }
    } else {
      setRunning(true);
      try {
        const r = await api.searchRecords(bookId, q.trim(), k);
        setRecords(r.items);
        setTotal(r.total);
      } finally {
        setRunning(false);
      }
    }
  };

  const switchKind = (k: Kind) => {
    setKind(k);
    if (submitted) run(submitted, k);
  };

  return (
    <div className="flex h-full flex-col" data-testid="search-panel">
      <div className="border-b border-border p-2">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            run(query, kind);
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2 left-2 h-4 w-4 text-muted" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在本书中搜索，回车开始"
              className="h-8 w-full rounded-md border border-border bg-surface pr-2 pl-7 text-sm outline-none focus:border-accent"
              aria-label="搜索关键词"
            />
          </div>
          <button type="button" className="rounded p-1.5 hover:bg-surface-2" onClick={onClose} aria-label="关闭搜索">
            <X className="h-4 w-4" />
          </button>
        </form>
        <div className="mt-2 flex rounded-md bg-surface-2 p-0.5 text-xs" role="tablist">
          {(
            [
              ["text", "正文"],
              ["note", "我的笔记"],
              ["annotation", "我的标注"],
            ] as [Kind, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              onClick={() => switchKind(k)}
              className={clsx("flex-1 rounded py-1", kind === k ? "bg-surface font-medium shadow-sm" : "text-muted")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {kind === "text" && !textSearchable && (
          <p className="p-4 text-xs leading-relaxed text-muted">
            这本 PDF 没有文字层（扫描版），无法搜索正文。首版未启用 OCR，可以使用书签、页码跳转和页级笔记。
          </p>
        )}
        {running && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
            <Spinner className="h-3.5 w-3.5" />
            {kind === "text" ? `正在搜索… ${Math.round(progress * 100)}%` : "搜索中…"}
            {kind === "text" && (
              <button
                className="ml-auto underline"
                onClick={() => {
                  abortRef.current?.abort();
                  setRunning(false);
                }}
              >
                取消
              </button>
            )}
          </div>
        )}
        {submitted && !running && (
          <p className="px-3 py-2 text-xs text-muted">
            {kind === "text" ? `找到 ${textHits.length}${textHits.length >= 500 ? "+" : ""} 处` : `找到 ${total} 条`}
          </p>
        )}
        <ul>
          {kind === "text" &&
            textHits.map((h, i) => (
              <li key={i}>
                <button className="block w-full border-b border-border/60 px-3 py-2 text-left hover:bg-surface-2" onClick={() => onJump(h.locator)} data-testid="search-hit">
                  <span className="block text-[11px] text-muted">{h.label}</span>
                  <Highlighted text={h.snippet} q={submitted} />
                </button>
              </li>
            ))}
          {kind !== "text" &&
            records.map((r) => (
              <li key={r.id}>
                <button
                  className="block w-full border-b border-border/60 px-3 py-2 text-left hover:bg-surface-2"
                  onClick={() => (r.kind === "note" ? onOpenNote(r.id) : r.locator && onJump(r.locator))}
                  data-testid="search-hit"
                >
                  {r.kind === "note" && r.quote && <span className="mb-0.5 block truncate text-[11px] text-muted">“{r.quote}”</span>}
                  <Highlighted text={r.snippet} q={submitted} />
                </button>
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

function Highlighted({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <span className="text-sm">{text}</span>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const k = lower.indexOf(needle, i);
    if (k < 0) {
      parts.push(text.slice(i));
      break;
    }
    parts.push(text.slice(i, k), <mark key={k} className="rounded bg-yellow-300/70 text-inherit">{text.slice(k, k + needle.length)}</mark>);
    i = k + needle.length;
  }
  return <span className="block text-sm leading-snug">{parts}</span>;
}
