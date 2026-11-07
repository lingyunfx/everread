import clsx from "clsx";
import { CircleAlert, CircleCheck, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, uploadBook } from "../api/client";
import { Button, Modal, Spinner } from "./ui";

type Stage = "uploading" | "processing" | "ready" | "failed";
interface Item {
  key: string;
  name: string;
  stage: Stage;
  progress: number;
  message?: string;
  bookId?: string;
}

const ACCEPT = ".pdf,.epub,.txt";

/**
 * 书架上传：工具栏“上传”按钮打开弹窗；把文件拖到页面任意位置也能上传。
 * 弹窗里显示上传、解析、成功或失败状态。
 */
export function Uploader({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const patch = (key: string, p: Partial<Item>) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...p } : it)));

  const start = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setOpen(true);
    for (const file of list) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      setItems((l) => [{ key, name: file.name, stage: "uploading", progress: 0 }, ...l]);
      uploadBook(file, (r) => patch(key, { progress: r })).then((res) => {
        if (res.ok) {
          patch(key, { stage: res.book.status === "ready" ? "ready" : "processing", bookId: res.book.id });
          onChangedRef.current();
        } else {
          patch(key, { stage: "failed", message: res.message, bookId: res.bookId });
        }
      });
    }
  }, []);

  // 轮询解析状态
  const processingKeys = items
    .filter((i) => i.stage === "processing" && i.bookId)
    .map((i) => i.key)
    .join();
  useEffect(() => {
    if (!processingKeys) return;
    const timer = setInterval(async () => {
      for (const it of items.filter((i) => i.stage === "processing" && i.bookId)) {
        try {
          const b = await api.book(it.bookId!);
          if (b.status === "ready") {
            patch(it.key, { stage: "ready" });
            onChangedRef.current();
          } else if (b.status === "failed") {
            patch(it.key, { stage: "failed", message: b.error ?? "解析失败" });
          }
        } catch {
          /* 下次再试 */
        }
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [processingKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // 页面级拖拽：拖入文件时显示全屏提示
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) start(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [start]);

  const busy = items.some((i) => i.stage === "uploading" || i.stage === "processing");

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} data-testid="upload-button">
        {busy ? <Spinner className="h-4 w-4 text-accent-fg" /> : <Upload className="h-4 w-4" />}
        上传
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        data-testid="upload-input"
        onChange={(e) => {
          if (e.target.files) start(e.target.files);
          e.target.value = "";
        }}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-6">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-white/80 px-14 py-10 text-white">
            <Upload className="h-8 w-8" />
            <p className="text-lg font-medium">松开即可上传</p>
            <p className="text-sm opacity-80">支持 PDF、EPUB、TXT</p>
          </div>
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="上传书籍" width="max-w-lg">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border px-4 py-7 text-center transition-colors hover:border-accent/60"
        >
          <Upload className="h-6 w-6 text-muted" />
          <span className="text-sm">
            <span className="font-medium">点击选择文件</span>，或直接把文件拖到页面上
          </span>
          <span className="text-xs text-muted">支持 PDF、EPUB、TXT，单个文件不超过 100 MB；上传后默认仅自己可见</span>
        </button>
        {items.length > 0 && (
          <ul className="mt-4 max-h-72 space-y-1.5 overflow-y-auto">
            {items.map((it) => (
              <li
                key={it.key}
                className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                data-testid="upload-item"
              >
                <span className="w-5 shrink-0">
                  {it.stage === "ready" && <CircleCheck className="h-5 w-5 text-green-600" />}
                  {it.stage === "failed" && <CircleAlert className="h-5 w-5 text-danger" />}
                  {(it.stage === "uploading" || it.stage === "processing") && <Spinner />}
                </span>
                <span className="min-w-0 flex-1 truncate">{it.name}</span>
                <span className={clsx("shrink-0 text-xs", it.stage === "failed" ? "text-danger" : "text-muted")}>
                  {it.stage === "uploading" && `上传中 ${Math.round(it.progress * 100)}%`}
                  {it.stage === "processing" && "解析中…"}
                  {it.stage === "ready" && (
                    <Link to={`/read/${it.bookId}`} className="font-medium text-fg underline">
                      已加入书架，开始阅读
                    </Link>
                  )}
                  {it.stage === "failed" && (
                    <>
                      {it.message}
                      {it.bookId && it.message?.includes("已上传过") && (
                        <Link to={`/read/${it.bookId}`} className="ml-2 font-medium text-fg underline">
                          打开已有的书
                        </Link>
                      )}
                    </>
                  )}
                </span>
                {(it.stage === "ready" || it.stage === "failed") && (
                  <button
                    className="text-muted hover:text-fg"
                    onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))}
                    aria-label="移除"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
