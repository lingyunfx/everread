import clsx from "clsx";
import {
  ArrowLeft,
  BookmarkPlus,
  Cloud,
  CloudOff,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Search,
  Settings2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, api, uuid } from "../api/client";
import type { Annotation, BookDetail, Bookmark, HighlightColor, Locator, Note } from "../api/types";
import { useAuth, useUser } from "../auth/AuthContext";
import { Button, Spinner, useToast } from "../components/ui";
import { LeftPanel, locatorLabel, type LeftTab } from "./LeftPanel";
import { NotesPanel } from "./NotesPanel";
import { SearchPanel } from "./SearchPanel";
import { AnnotationMenu, SelectionMenu } from "./SelectionMenu";
import { SettingsMenu } from "./SettingsMenu";
import type { EngineHandle, LocationInfo, SelectionInfo, TocItem } from "./types";
import { useProgressSync } from "./useProgressSync";

const PdfView = lazy(() => import("./PdfView"));
const EpubView = lazy(() => import("./EpubView"));
const TxtView = lazy(() => import("./TxtView"));

const isDesktop = () => window.matchMedia("(min-width: 1024px)").matches;

export function ReaderPage() {
  const { bookId = "" } = useParams();
  const user = useUser();
  const navigate = useNavigate();
  const toast = useToast();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBook(null);
    setLoadError(null);
    (async () => {
      try {
        const b = await api.book(bookId);
        if (cancelled) return;
        setBook(b);
        // 打开即进入个人书架并记录最近阅读
        if (b.accessible && b.status === "ready") await api.openBook(bookId);
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <TriangleAlert className="h-8 w-8 text-danger" />
        <p>{loadError}</p>
        <Button onClick={() => navigate("/")}>返回书架</Button>
      </div>
    );
  }
  if (!book) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!book.accessible || book.status !== "ready") return <Unavailable book={book} userId={user.id} />;
  return <Reader key={book.id} book={book} toast={toast} />;
}

/** 原书已删除或改回私有：保留并展示个人笔记，禁止跳转原文 */
function Unavailable({ book, userId }: { book: BookDetail; userId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => {
    api.notes(book.id).then(setNotes, () => {});
  }, [book.id]);
  const reason = book.is_deleted
    ? "原书已被上传者删除"
    : book.status === "processing"
      ? "这本书还在解析中，请稍后再试"
      : book.status === "failed"
        ? `这本书解析失败：${book.error ?? ""}`
        : "上传者已将这本书设为私有，暂不可访问";
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col p-6">
      <Link to="/" className="mb-6 flex items-center gap-1 text-sm text-muted"><ArrowLeft className="h-4 w-4" />返回书架</Link>
      <h1 className="text-xl font-bold">{book.title}</h1>
      <p className="mt-2 rounded-md bg-surface-2 p-3 text-sm" data-testid="unavailable-reason">{reason}。你的笔记与阅读记录仍然保留，但无法跳转原文。</p>
      <div className="mt-6 flex-1 overflow-y-auto">
        <NotesPanel
          notes={notes}
          userId={userId}
          focusId={null}
          canJump={false}
          canCreate={false}
          onJump={() => {}}
          onAddAtLocation={() => {}}
          onAddWholeBook={() => {}}
          onChanged={(n) => setNotes((l) => l.map((x) => (x.id === n.id ? n : x)))}
          onDeleted={(id) => setNotes((l) => l.filter((x) => x.id !== id))}
        />
      </div>
      {!book.is_owner && (
        <Button
          variant="danger"
          className="mt-4 self-start"
          onClick={async () => {
            if (!confirm("将删除你在这本书上的全部个人记录，无法恢复。确定吗？")) return;
            await api.deleteMyRecords(book.id);
            toast("已清除个人记录");
            navigate("/");
          }}
        >
          清除我的记录
        </Button>
      )}
    </div>
  );
}

function Reader({ book, toast }: { book: BookDetail; toast: ReturnType<typeof useToast> }) {
  const user = useUser();
  const { updatePreferences } = useAuth();
  const prefs = user.preferences;
  const engine = useRef<EngineHandle | null>(null);
  const sync = useProgressSync(book.id, user.id, true);

  const [toc, setToc] = useState<TocItem[]>([]);
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [activeAnn, setActiveAnn] = useState<Annotation | null>(null);
  const [focusNote, setFocusNote] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(false);
  const [leftTab, setLeftTab] = useState<LeftTab>("toc");
  const [rightOpen, setRightOpen] = useState(isDesktop);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpBack, setJumpBack] = useState<Locator | null>(null);
  const [rotation, setRotation] = useState(0);
  const [engineError, setEngineError] = useState<string | null>(null);

  const isScanned = book.format === "pdf" && book.has_text_layer === false;

  useEffect(() => {
    Promise.all([api.annotations(book.id), api.notes(book.id), api.bookmarks(book.id)]).then(
      ([a, n, b]) => {
        setAnnotations(a);
        setNotes(n);
        setBookmarks(b);
      },
      (e) => toast((e as Error).message, "error"),
    );
  }, [book.id, toast]);

  const onLocation = useCallback(
    (info: LocationInfo) => {
      setLocation(info);
      sync.report(info.locator, info.percent);
    },
    [sync.report], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** 程序跳转前记住当前位置，以便“返回跳转前位置” */
  const jump = useCallback((loc: Locator, flash = true) => {
    const cur = engine.current?.current();
    if (cur) setJumpBack(cur.locator);
    engine.current?.goTo(loc, { flash });
    if (!isDesktop()) {
      setLeftOpen(false);
      setSearchOpen(false);
    }
  }, []);

  // ---------- 标注与笔记 ----------
  const createAnnotations = async (sel: SelectionInfo, color: HighlightColor): Promise<Annotation[]> => {
    const group = sel.parts.length > 1 ? uuid() : null;
    const created: Annotation[] = [];
    for (const part of sel.parts) {
      const payload = { id: uuid(), locator: part.locator, quote: part.quote, color, group_id: group };
      created.push(await withRetry(() => api.createAnnotation(book.id, payload)));
    }
    setAnnotations((l) => [...l, ...created]);
    return created;
  };

  const createNote = async (data: { annotation_id?: string | null; locator?: Locator | null; quote?: string | null }) => {
    const payload = { id: uuid(), body: "", ...data };
    const note = await withRetry(() => api.createNote(book.id, payload));
    setNotes((l) => [...l, note]);
    setRightOpen(true);
    setFocusNote(note.id);
    return note;
  };

  const handleHighlight = async (color: HighlightColor) => {
    if (!selection) return;
    const sel = selection;
    setSelection(null);
    engine.current?.clearSelection();
    try {
      await createAnnotations(sel, color);
    } catch (e) {
      toast(`高亮保存失败：${(e as Error).message}`, "error");
    }
  };

  const handleNoteFromSelection = async () => {
    if (!selection) return;
    const sel = selection;
    setSelection(null);
    engine.current?.clearSelection();
    try {
      const [first] = await createAnnotations(sel, "yellow");
      await createNote({ annotation_id: first.id, quote: sel.quote });
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, "error");
    }
  };

  const annById = useMemo(() => new Map(annotations.map((a) => [a.id, a])), [annotations]);
  const noteForAnn = (a: Annotation) =>
    notes.find((n) => n.annotation_id === a.id || (a.group_id && annById.get(n.annotation_id ?? "")?.group_id === a.group_id));

  // ---------- 书签 ----------
  const addBookmark = async () => {
    const cur = engine.current?.current();
    if (!cur) return;
    try {
      const b = await withRetry(() =>
        api.createBookmark(book.id, {
          id: uuid(),
          locator: cur.locator,
          position_label: cur.label,
          sort_key: cur.sortKey,
          name: cur.label,
          memo: "",
        }),
      );
      setBookmarks((l) => [...l, b].sort((x, y) => x.sort_key - y.sort_key));
      toast(`已添加书签：${cur.label}`);
      setLeftTab("bookmarks");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  // ---------- 快捷键 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") {
        setSelection(null);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statusIcon = {
    idle: null,
    saving: <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />保存中</>,
    saved: <><Cloud className="h-3.5 w-3.5" />已保存</>,
    pending: <><Cloud className="h-3.5 w-3.5 opacity-50" />保存中</>,
    offline: <><CloudOff className="h-3.5 w-3.5 text-danger" />未同步</>,
    conflict: <><TriangleAlert className="h-3.5 w-3.5 text-danger" />进度冲突</>,
  }[sync.status];

  const engineProps = {
    book,
    prefs,
    annotations,
    handleRef: engine,
    onReady: setToc,
    onLocation,
    onSelection: setSelection,
    onAnnotationClick: (id: string) => {
      const a = annById.get(id);
      if (a) setActiveAnn(a);
    },
    onError: setEngineError,
  };

  const rightPanel = (
    <NotesPanel
      notes={notes}
      userId={user.id}
      focusId={focusNote}
      canJump
      canCreate
      onJump={(n) => n.locator && jump(n.locator)}
      onAddAtLocation={() => {
        const cur = engine.current?.current();
        createNote({ locator: cur?.locator ?? null }).catch((e) => toast((e as Error).message, "error"));
      }}
      onAddWholeBook={() => createNote({}).catch((e) => toast((e as Error).message, "error"))}
      onChanged={(n) => setNotes((l) => l.map((x) => (x.id === n.id ? n : x)))}
      onDeleted={(id) => setNotes((l) => l.filter((x) => x.id !== id))}
    />
  );

  return (
    <div className="flex h-full flex-col">
      {/* 顶部栏 */}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
        <Link to="/" className="rounded-md p-2 hover:bg-surface-2" title="返回书架" aria-label="返回书架">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <button className={clsx("rounded-md p-2 hover:bg-surface-2", leftOpen && "text-accent")} onClick={() => setLeftOpen((o) => !o)} title="目录 / 书签 / 标注" aria-label="切换左侧栏">
          <PanelLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-sm font-medium">{book.title}</h1>
          <p className="truncate text-[11px] text-muted" data-testid="location-label">{location?.label ?? "加载中…"}</p>
        </div>
        <span className="hidden items-center gap-1 text-[11px] text-muted sm:flex" data-testid="sync-status">
          {statusIcon}
        </span>
        <button className="rounded-md p-2 hover:bg-surface-2" onClick={() => setSearchOpen((o) => !o)} title="搜索（Ctrl+F）" aria-label="搜索">
          <Search className="h-4 w-4" />
        </button>
        <button className="rounded-md p-2 hover:bg-surface-2" onClick={addBookmark} title="在当前位置添加书签" aria-label="添加书签">
          <BookmarkPlus className="h-4 w-4" />
        </button>
        <div className="relative">
          <button className={clsx("rounded-md p-2 hover:bg-surface-2", settingsOpen && "text-accent")} onClick={() => setSettingsOpen((o) => !o)} title="阅读设置" aria-label="阅读设置">
            <Settings2 className="h-4 w-4" />
          </button>
          {settingsOpen && (
            <SettingsMenu
              format={book.format}
              prefs={prefs}
              rotation={rotation}
              onRotate={() => setRotation((r) => (r + 90) % 360)}
              onChange={updatePreferences}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
        <button className={clsx("rounded-md p-2 hover:bg-surface-2", rightOpen && "text-accent")} onClick={() => setRightOpen((o) => !o)} title="笔记" aria-label="切换笔记栏">
          <PanelRight className="h-4 w-4" />
        </button>
      </header>

      {sync.conflict && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-amber-100 px-3 py-2 text-sm text-amber-950" data-testid="progress-conflict">
          <TriangleAlert className="h-4 w-4" />
          <span className="flex-1">
            另一台设备{sync.conflict.device ? `（${sync.conflict.device}）` : ""}读到了 {locatorLabel(sync.conflict.locator, book.page_count)}，与本机不同。
          </span>
          <Button size="sm" onClick={() => { const l = sync.resolveConflict(true); if (l) engine.current?.goTo(l); }}>跳到该位置</Button>
          <Button size="sm" onClick={() => { const c = engine.current?.current(); sync.resolveConflict(false, c ? { locator: c.locator, percent: c.percent } : undefined); }}>保留本机位置</Button>
        </div>
      )}
      {isScanned && (
        <div className="border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-muted" data-testid="scanned-notice">
          这是扫描版 PDF（没有文字层）：可以阅读、保存进度、添加书签和页级笔记；首版未启用 OCR，暂不支持选字标注和正文搜索。
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* 左侧栏：桌面内嵌，手机为抽屉 */}
        {leftOpen && (
          <>
            <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setLeftOpen(false)} />
            <aside className="absolute inset-y-0 left-0 z-30 w-72 border-r border-border bg-surface lg:static lg:z-auto">
              <LeftPanel
                tab={leftTab}
                setTab={setLeftTab}
                toc={toc}
                bookmarks={bookmarks}
                annotations={annotations}
                canJump
                canCreate
                pageCount={book.page_count}
                onToc={(t) => {
                  const cur = engine.current?.current();
                  if (cur) setJumpBack(cur.locator);
                  engine.current?.goToToc(t);
                  if (!isDesktop()) setLeftOpen(false);
                }}
                onJump={(l) => jump(l, false)}
                onAddBookmark={addBookmark}
                onUpdateBookmark={async (id, d) => {
                  try {
                    const b = await api.updateBookmark(id, d);
                    setBookmarks((l) => l.map((x) => (x.id === id ? b : x)));
                  } catch (e) {
                    toast((e as Error).message, "error");
                  }
                }}
                onDeleteBookmark={async (id) => {
                  try {
                    await api.deleteBookmark(id);
                    setBookmarks((l) => l.filter((x) => x.id !== id));
                  } catch (e) {
                    toast((e as Error).message, "error");
                  }
                }}
                onAnnotation={(a) => jump(a.locator)}
              />
            </aside>
          </>
        )}

        {/* 正文 */}
        <div className="relative min-w-0 flex-1">
          {engineError ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-danger">{engineError}</div>
          ) : sync.initial === undefined ? (
            <div className="flex h-full items-center justify-center"><Spinner /></div>
          ) : (
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
              {book.format === "pdf" && <PdfView {...engineProps} initial={sync.initial?.locator ?? null} rotation={rotation} />}
              {book.format === "epub" && <EpubView {...engineProps} initial={sync.initial?.locator ?? null} />}
              {book.format === "txt" && <TxtView {...engineProps} initial={sync.initial?.locator ?? null} />}
            </Suspense>
          )}
          {jumpBack && (
            <button
              className="absolute bottom-14 left-4 z-10 flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-sm shadow-lg hover:bg-surface-2"
              onClick={() => {
                engine.current?.goTo(jumpBack, { flash: false });
                setJumpBack(null);
              }}
              data-testid="jump-back"
            >
              <Undo2 className="h-4 w-4" />返回跳转前位置
            </button>
          )}
          {jumpBack && (
            <button className="absolute bottom-[62px] left-[196px] z-10 text-xs text-muted hover:text-fg" onClick={() => setJumpBack(null)} aria-label="关闭返回提示">
              ×
            </button>
          )}
        </div>

        {/* 搜索面板 */}
        {searchOpen && (
          <aside className="absolute inset-y-0 right-0 z-30 w-80 max-w-full border-l border-border bg-surface shadow-xl">
            <SearchPanel
              bookId={book.id}
              engine={engine}
              textSearchable={!isScanned}
              onJump={(l) => jump(l)}
              onOpenNote={(id) => {
                const n = notes.find((x) => x.id === id);
                setRightOpen(true);
                setFocusNote(id);
                if (n?.locator) jump(n.locator);
              }}
              onClose={() => setSearchOpen(false)}
            />
          </aside>
        )}

        {/* 右侧笔记栏：桌面内嵌，手机为抽屉 */}
        {rightOpen && (
          <>
            <div className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setRightOpen(false)} />
            <aside className="absolute inset-y-0 right-0 z-30 w-80 max-w-[90vw] border-l border-border bg-surface lg:static lg:z-auto" data-testid="notes-panel">
              {rightPanel}
            </aside>
          </>
        )}
      </div>

      {selection && (
        <SelectionMenu
          selection={selection}
          onHighlight={handleHighlight}
          onNote={handleNoteFromSelection}
          onCopy={() => {
            navigator.clipboard?.writeText(selection.quote).then(() => toast("已复制"), () => toast("复制失败", "error"));
            setSelection(null);
          }}
        />
      )}
      {activeAnn && (
        <AnnotationMenu
          annotation={activeAnn}
          hasNote={!!noteForAnn(activeAnn)}
          onClose={() => setActiveAnn(null)}
          onColor={async (c) => {
            try {
              await api.updateAnnotation(activeAnn.id, c);
              setAnnotations((l) =>
                l.map((x) => (x.id === activeAnn.id || (activeAnn.group_id && x.group_id === activeAnn.group_id) ? { ...x, color: c } : x)),
              );
              setActiveAnn(null);
            } catch (e) {
              toast((e as Error).message, "error");
            }
          }}
          onNote={() => {
            const n = noteForAnn(activeAnn);
            const a = activeAnn;
            setActiveAnn(null);
            if (n) {
              setRightOpen(true);
              setFocusNote(n.id);
            } else {
              createNote({ annotation_id: a.id, quote: a.quote }).catch((e) => toast((e as Error).message, "error"));
            }
          }}
          onDelete={async () => {
            const a = activeAnn;
            setActiveAnn(null);
            try {
              await api.deleteAnnotation(a.id);
              setAnnotations((l) => l.filter((x) => x.id !== a.id && !(a.group_id && x.group_id === a.group_id)));
              setNotes((l) => l.map((n) => (n.annotation_id === a.id ? { ...n, annotation_id: null } : n)));
              toast("已删除标注，关联笔记已保留");
            } catch (e) {
              toast((e as Error).message, "error");
            }
          }}
        />
      )}
    </div>
  );
}

/** 网络失败时用同一个客户端 ID 重试，服务端幂等，不会重复创建 */
async function withRetry<T>(fn: () => Promise<T>, times = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof ApiError) || e.status !== 0) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}
