import clsx from "clsx";
import { Globe, Lock, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { Book } from "../api/types";
import { BookCover } from "../components/BookCover";
import { Button, Input, Modal, Spinner, formatSize, useToast } from "../components/ui";

const ENCODINGS = ["utf-8", "gb18030", "big5", "utf-16", "shift_jis", "euc-kr"];

/** 上传者的书籍管理：修改信息、公开/私有、重试解析、删除原书 */
export function ManagePage() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [editing, setEditing] = useState<Book | null>(null);
  const [deleting, setDeleting] = useState<{ book: Book; others: number } | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setBooks(await api.myUploads());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // 有解析中的书时定时刷新
  useEffect(() => {
    if (!books?.some((b) => b.status === "processing")) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [books, load]);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      load();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div>
      <h1 className="text-xl font-bold">我上传的书</h1>
      <p className="mb-5 text-sm text-muted">只有上传者可以修改书籍信息、公开范围或删除原书。公开的书仅对已登录成员可见。</p>
      {books === null ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : books.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted">还没有上传过书，去 <Link to="/" className="text-accent">书架</Link> 上传吧</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {books.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap" data-testid="manage-row">
              <BookCover book={b} className="w-11 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{b.title}</p>
                <p className="truncate text-xs text-muted">
                  {b.author ?? "未知作者"} · {b.format.toUpperCase()} · {formatSize(b.file_size)}
                  {b.page_count ? ` · ${b.page_count} 页` : ""}
                  {b.format === "pdf" && b.has_text_layer === false && " · 扫描版（无文字层）"}
                </p>
                {b.status === "processing" && <p className="text-xs text-muted">解析中…</p>}
                {b.status === "failed" && <p className="text-xs text-danger">解析失败：{b.error}</p>}
              </div>
              <div className="flex items-center gap-1.5">
                {b.status === "ready" && (
                  <Button
                    size="sm"
                    variant={b.visibility === "public" ? "primary" : "secondary"}
                    title={b.visibility === "public" ? "点击改为私有" : "点击公开到图书馆"}
                    onClick={() =>
                      run(
                        () => api.updateBook(b.id, { visibility: b.visibility === "public" ? "private" : "public" }),
                        b.visibility === "public" ? "已改为私有，其他成员将无法继续阅读" : "已公开到图书馆",
                      )
                    }
                  >
                    {b.visibility === "public" ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                    {b.visibility === "public" ? "已公开" : "私有"}
                  </Button>
                )}
                {(b.status === "failed" || b.format === "txt") && b.status !== "processing" && (
                  <RetryButton book={b} onDone={load} />
                )}
                <Button size="icon" variant="ghost" title="编辑信息" onClick={() => setEditing(b)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="删除原书"
                  onClick={async () => {
                    const { other_readers } = await api.deleteImpact(b.id);
                    setDeleting({ book: b, others: other_readers });
                  }}
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <EditDialog book={editing} onClose={() => setEditing(null)} onSaved={load} />}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="删除原书"
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                const b = deleting!.book;
                setDeleting(null);
                run(() => api.deleteBook(b.id), "原书已删除");
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm">
          将删除《{deleting?.book.title}》的文件及解析产物，所有人都无法再阅读原文。
        </p>
        {deleting && deleting.others > 0 && (
          <p className="mt-2 rounded bg-surface-2 p-2 text-sm">
            另有 <b>{deleting.others}</b> 位成员读过这本书。他们的笔记和阅读记录会保留，但无法再跳转原文。
          </p>
        )}
        <p className="mt-2 text-xs text-muted">你自己的笔记同样保留，可在书架“已移出”中清除。</p>
      </Modal>
    </div>
  );
}

function RetryButton({ book, onDone }: { book: Book; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [encoding, setEncoding] = useState("gb18030");
  const toast = useToast();
  const retry = async (enc?: string) => {
    try {
      await api.retryBook(book.id, enc);
      toast("已重新开始解析");
      setOpen(false);
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  if (book.format !== "txt") {
    return (
      <Button size="sm" onClick={() => retry()}>
        <RefreshCw className="h-3.5 w-3.5" /> 重试
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" title="文字乱码时手动指定编码" onClick={() => setOpen(true)}>
        <RefreshCw className="h-3.5 w-3.5" /> {book.status === "failed" ? "重试" : "编码"}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="重新解析 TXT"
        footer={
          <>
            {book.status === "failed" && <Button onClick={() => retry()}>自动识别重试</Button>}
            <Button variant="primary" onClick={() => retry(encoding)}>按所选编码解析</Button>
          </>
        }
      >
        <p className="mb-3 text-sm">如果正文出现乱码，可以手动指定文件编码。重新解析后，此前在这本书上的 TXT 位置可能偏移。</p>
        <select value={encoding} onChange={(e) => setEncoding(e.target.value)} className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm">
          {ENCODINGS.map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
      </Modal>
    </>
  );
}

function EditDialog({ book, onClose, onSaved }: { book: Book; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Modal
      open
      onClose={onClose}
      title="编辑书籍信息"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.updateBook(book.id, { title: title.trim(), author: author.trim() || null });
                toast("已保存");
                onSaved();
                onClose();
              } catch (e) {
                toast((e as Error).message, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <label className="mb-1 block text-sm" htmlFor="t">书名</label>
      <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label className={clsx("mt-3 mb-1 block text-sm")} htmlFor="a">作者</label>
      <Input id="a" value={author} onChange={(e) => setAuthor(e.target.value)} />
    </Modal>
  );
}
