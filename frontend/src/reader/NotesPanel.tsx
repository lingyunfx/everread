// 右侧笔记栏：笔记列表与编辑器，输入后自动保存；保存失败保留草稿并可重试，重试不会重复创建
import clsx from "clsx";
import { MapPin, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { Note } from "../api/types";
import { formatTime } from "../components/ui";

type SaveState = "saved" | "saving" | "dirty" | "error" | "conflict";

export function NotesPanel({
  notes,
  userId,
  focusId,
  canJump,
  onJump,
  onAddAtLocation,
  onAddWholeBook,
  onChanged,
  onDeleted,
  canCreate,
}: {
  notes: Note[];
  userId: string;
  focusId: string | null;
  canJump: boolean;
  canCreate: boolean;
  onJump: (n: Note) => void;
  onAddAtLocation: () => void;
  onAddWholeBook: () => void;
  onChanged: (n: Note) => void;
  onDeleted: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusId) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-note="${focusId}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el?.querySelector("textarea")?.focus();
  }, [focusId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">笔记 <span className="font-normal text-muted">{notes.length}</span></h2>
        {canCreate && (
          <div className="flex gap-1">
            <button className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-surface-2" onClick={onAddAtLocation} title="在当前阅读位置写笔记">
              <Plus className="h-3.5 w-3.5" />此处
            </button>
            <button className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-surface-2" onClick={onAddWholeBook} title="不关联具体位置的整书笔记">
              <Plus className="h-3.5 w-3.5" />整书
            </button>
          </div>
        )}
      </div>
      <div ref={listRef} className="scrollbar-thin flex-1 space-y-3 overflow-y-auto p-3">
        {notes.length === 0 && <p className="py-10 text-center text-xs text-muted">选中文字后点“写笔记”，或点上方按钮添加</p>}
        {notes.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            userId={userId}
            focused={n.id === focusId}
            canJump={canJump}
            onJump={() => onJump(n)}
            onChanged={onChanged}
            onDeleted={onDeleted}
          />
        ))}
      </div>
    </div>
  );
}

function NoteCard({
  note,
  userId,
  focused,
  canJump,
  onJump,
  onChanged,
  onDeleted,
}: {
  note: Note;
  userId: string;
  focused: boolean;
  canJump: boolean;
  onJump: () => void;
  onChanged: (n: Note) => void;
  onDeleted: (id: string) => void;
}) {
  const draftKey = `everread:note-draft:${userId}:${note.id}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? note.body);
  const [state, setState] = useState<SaveState>(() => (localStorage.getItem(draftKey) !== null ? "error" : "saved"));
  const [remote, setRemote] = useState<Note | null>(null);
  const base = useRef(note.revision);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(text);
  latest.current = text;

  // 其他地方更新了笔记（如冲突时采用对方版本）
  useEffect(() => {
    if (state === "saved" && note.revision !== base.current) {
      base.current = note.revision;
      setText(note.body);
    }
  }, [note.revision, note.body, state]);

  const save = useCallback(
    async (force = false) => {
      const body = latest.current;
      setState("saving");
      try {
        const saved = await api.updateNote(note.id, body, force ? null : base.current);
        base.current = saved.revision;
        localStorage.removeItem(draftKey);
        onChanged(saved);
        setState(latest.current === body ? "saved" : "dirty");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setRemote(e.data as Note);
          setState("conflict");
        } else {
          localStorage.setItem(draftKey, body);
          setState("error");
        }
      }
    },
    [note.id, draftKey, onChanged],
  );

  const onInput = (v: string) => {
    setText(v);
    setState("dirty");
    localStorage.setItem(draftKey, v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(), 800);
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <div
      data-note={note.id}
      data-testid="note-card"
      className={clsx("rounded-lg border bg-surface p-2.5", focused ? "border-accent" : "border-border")}
    >
      {note.quote && (
        <button
          className={clsx("mb-2 block w-full border-l-2 border-accent/70 pl-2 text-left text-xs text-muted", canJump && note.locator && "hover:text-fg")}
          onClick={() => canJump && note.locator && onJump()}
          title={canJump && note.locator ? "跳转到原文" : undefined}
        >
          <span className="line-clamp-3">{note.quote}</span>
        </button>
      )}
      <textarea
        value={text}
        onChange={(e) => onInput(e.target.value)}
        onBlur={() => state === "dirty" && save()}
        placeholder="写点什么…"
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        className="w-full resize-none bg-transparent text-sm leading-relaxed outline-none"
        aria-label="笔记内容"
      />
      {state === "conflict" && remote && (
        <div className="mt-1 rounded bg-surface-2 p-2 text-xs">
          <p className="mb-1">这条笔记已在其他设备修改：</p>
          <p className="mb-2 line-clamp-3 text-muted">{remote.body || "（空）"}</p>
          <div className="flex gap-2">
            <button
              className="rounded border border-border px-2 py-0.5"
              onClick={() => {
                base.current = remote.revision;
                setText(remote.body);
                localStorage.removeItem(draftKey);
                onChanged(remote);
                setRemote(null);
                setState("saved");
              }}
            >
              用对方版本
            </button>
            <button className="rounded border border-border px-2 py-0.5" onClick={() => { setRemote(null); save(true); }}>
              保留我的版本
            </button>
          </div>
        </div>
      )}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
        {!note.quote && note.locator && canJump && (
          <button className="flex items-center gap-0.5 hover:text-fg" onClick={onJump}>
            <MapPin className="h-3 w-3" />跳转
          </button>
        )}
        {!note.locator && <span>整书笔记</span>}
        <span>{formatTime(note.updated_at)}</span>
        <span className="flex-1" />
        <span data-testid="note-status" className={clsx(state === "error" && "text-danger")}>
          {state === "saving" && "保存中…"}
          {state === "saved" && "已保存"}
          {state === "dirty" && "未保存"}
          {state === "error" && (
            <button className="underline" onClick={() => save()}>保存失败，点击重试</button>
          )}
        </span>
        <button
          className="rounded p-0.5 hover:text-danger"
          aria-label="删除笔记"
          onClick={async () => {
            if (!confirm("删除这条笔记？")) return;
            try {
              await api.deleteNote(note.id);
              localStorage.removeItem(draftKey);
              onDeleted(note.id);
            } catch {
              setState("error");
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
