// EPUB 阅读器：epub.js 分页渲染，位置使用 CFI，改变字号/窗口后按内容锚点恢复。
// 书籍内容在禁用脚本的 iframe 中渲染，且后端已清理脚本与外部资源。
import ePub from "epubjs";
import type { Book as EpubBook, Rendition } from "epubjs";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { API, authHeaders } from "../api/client";
import type { Annotation, EpubLocator } from "../api/types";
import { Spinner } from "../components/ui";
import type { EngineProps, LocationInfo, TocItem } from "./types";
import { HIGHLIGHT_COLORS } from "./types";
import { MIN_DOUBLE_WIDTH, usePageTurn, zoneOf } from "./pageTurn";

interface NavItem {
  label: string;
  href: string;
  subitems?: NavItem[];
}

function flattenToc(items: NavItem[], level = 1): TocItem[] {
  return items.flatMap((it) => [
    { title: it.label.trim(), level, target: it.href },
    ...flattenToc(it.subitems ?? [], level + 1),
  ]);
}

function keyTurnDir(e: KeyboardEvent): -1 | 0 | 1 {
  if (e.ctrlKey || e.metaKey || e.altKey) return 0;
  if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) return 1;
  if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) return -1;
  return 0;
}

function readerColors() {
  const cs = getComputedStyle(document.documentElement);
  return { bg: cs.getPropertyValue("--reader-bg").trim(), fg: cs.getPropertyValue("--reader-fg").trim() };
}

export default function EpubView(props: EngineProps) {
  const { book, prefs, annotations, initial, handleRef } = props;
  const cb = useRef(props);
  cb.current = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const rendRef = useRef<Rendition | null>(null);
  const tocRef = useRef<TocItem[]>([]);
  const lastLocation = useRef<LocationInfo | null>(null);
  const drawn = useRef(new Map<string, string>()); // 标注 id → "cfi|颜色"
  const [ready, setReady] = useState(false);
  const [locationsReady, setLocationsReady] = useState(false);
  const keyTurn = (e: KeyboardEvent) => {
    const dir = keyTurnDir(e);
    if (!dir) return;
    e.preventDefault();
    turnRef.current(dir);
  };

  const chapterTitle = useCallback((href: string | undefined) => {
    if (!href) return "";
    const base = href.split("#")[0];
    let found = "";
    for (const t of tocRef.current) {
      if (typeof t.target === "string" && t.target.split("#")[0].endsWith(base)) {
        found = t.title;
        break;
      }
    }
    return found;
  }, []);

  // ---------- 加载 ----------
  useEffect(() => {
    let destroyed = false;
    (async () => {
      try {
        const res = await fetch(`${API}/books/${book.id}/file`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        if (destroyed) return;
        const epub = ePub(data as unknown as string);
        bookRef.current = epub;
        const rendition = epub.renderTo(hostRef.current!, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          // 双页：宽度足够时左右两页并排；单页：始终一页
          spread: prefs.page_layout === "double" ? "auto" : "none",
          minSpreadWidth: MIN_DOUBLE_WIDTH,
          allowScriptedContent: false,
        } as Parameters<typeof epub.renderTo>[1]);
        rendRef.current = rendition;
        const nav = await epub.loaded.navigation;
        tocRef.current = flattenToc((nav as unknown as { toc: NavItem[] }).toc);
        applyStyle();

        rendition.on("relocated", (loc: { start: { cfi: string; href: string; percentage: number } }) => {
          const cfi = loc.start.cfi;
          let percent = 0;
          try {
            percent = epub.locations.length() ? epub.locations.percentageFromCfi(cfi) * 100 : 0;
          } catch {
            /* 位置索引尚未生成 */
          }
          const chapter = chapterTitle(loc.start.href);
          const info: LocationInfo = {
            locator: { type: "epub", v: 1, cfi, percent: Math.round(percent * 100) / 100 },
            percent: Math.round(percent * 100) / 100,
            label: [chapter, epub.locations.length() ? `${Math.round(percent)}%` : ""].filter(Boolean).join(" · ") || "阅读中",
            sortKey: percent,
          };
          lastLocation.current = info;
          cb.current.onLocation(info);
        });

        // epub.js 在拖动过程中也会触发 selected：按住鼠标时先暂存，松开后再弹出菜单
        let mouseDown = false;
        let pendingCfi: string | null = null;
        let downAt: { x: number; y: number } | null = null;
        rendition.on("mousedown", (e: MouseEvent) => {
          downAt = { x: e.clientX, y: e.clientY };
          mouseDown = true;
          pendingCfi = null;
          cb.current.onSelection(null);
        });
        rendition.on("mouseup", () => {
          mouseDown = false;
          if (pendingCfi) emitSelection(pendingCfi);
          pendingCfi = null;
        });
        rendition.on("selected", (cfiRange: string) => {
          if (mouseDown) pendingCfi = cfiRange;
          else emitSelection(cfiRange);
        });
        const emitSelection = (cfiRange: string) => {
          const range = rendition.getRange(cfiRange);
          const quote = range?.toString().replace(/\s+/g, " ").trim() ?? "";
          if (!quote) return;
          // 选区在 iframe 内，换算成外层视口坐标
          const r = range.getBoundingClientRect();
          const frame = hostRef.current?.querySelector("iframe")?.getBoundingClientRect();
          const left = r.left + (frame?.left ?? 0);
          const top = r.top + (frame?.top ?? 0);
          cb.current.onSelection({
            parts: [{ locator: { type: "epub", v: 1, cfi: cfiRange }, quote }],
            quote,
            rect: { left, top, bottom: top + r.height, width: r.width },
          });
        };
        rendition.on("click", (e: MouseEvent) => {
          const doc = (e.target as Node).ownerDocument;
          if (!doc?.getSelection()?.isCollapsed) return;
          cb.current.onSelection(null);
          const start = downAt;
          downAt = null;
          if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
          if ((e.target as Element).closest?.("a")) return;
          // iframe 内坐标换算到外层，按左右区域翻页
          const frame = (e.view as Window | null)?.frameElement?.getBoundingClientRect();
          const wrap = wrapRef.current?.getBoundingClientRect();
          if (!frame || !wrap) return;
          const dir = zoneOf(e.clientX + frame.left, wrap);
          if (dir) turnRef.current(dir);
        });
        // iframe 内的键盘与滚轮也用来翻页
        rendition.hooks.content.register((contents: { document: Document }) => {
          contents.document.addEventListener("keydown", (e) => keyTurn(e));
          let last = 0;
          contents.document.addEventListener(
            "wheel",
            (e) => {
              if (Math.abs(e.deltaY) < 8) return;
              e.preventDefault();
              const now = Date.now();
              if (now - last < 350) return;
              last = now;
              turnRef.current(e.deltaY > 0 ? 1 : -1);
            },
            { passive: false },
          );
        });

        const start = initial?.type === "epub" ? initial.cfi : undefined;
        await rendition.display(start);
        if (destroyed) return;
        setReady(true);
        cb.current.onReady(tocRef.current);
        // 生成位置索引用于百分比显示（较大的书需要一点时间）
        await epub.locations.generate(1200);
        if (destroyed) return;
        setLocationsReady(true);
        const cur = rendition.currentLocation() as unknown as { start?: { cfi: string } };
        if (cur?.start) (rendition as unknown as { reportLocation: () => void }).reportLocation();
      } catch (e) {
        if (!destroyed) cb.current.onError(`EPUB 加载失败：${(e as Error).message}`);
      }
    })();
    return () => {
      destroyed = true;
      rendRef.current?.destroy();
      bookRef.current?.destroy();
      rendRef.current = null;
      bookRef.current = null;
    };
  }, [book.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const turn = useCallback((dir: -1 | 1) => {
    cb.current.onSelection(null);
    if (dir > 0) rendRef.current?.next();
    else rendRef.current?.prev();
  }, []);
  const turnRef = useRef(turn);
  // 点到高亮（epub.js 画在外层 SVG 里）时不翻页
  usePageTurn(wrapRef, turn, { wheel: true, isAnnotationHit: (e) => !!(e.target as Element).closest?.("svg g") });

  // 单双页切换：epub.js 会按内容锚点重新排版
  useEffect(() => {
    rendRef.current?.spread(prefs.page_layout === "double" ? "auto" : "none", MIN_DOUBLE_WIDTH);
  }, [prefs.page_layout]);

  // ---------- 主题与字号 ----------
  const applyStyle = useCallback(() => {
    const r = rendRef.current;
    if (!r) return;
    const { bg, fg } = readerColors();
    r.themes.override("color", fg);
    r.themes.override("background", bg);
    r.themes.override("line-height", String(prefs.line_height));
    r.themes.fontSize(`${prefs.font_size}px`);
  }, [prefs.font_size, prefs.line_height]);

  useEffect(() => {
    // 等主题 CSS 变量生效后再读取颜色
    const t = setTimeout(applyStyle, 0);
    return () => clearTimeout(t);
  }, [applyStyle, prefs.theme, ready]);

  // ---------- 标注 ----------
  useEffect(() => {
    const r = rendRef.current;
    if (!r || !ready) return;
    const want = new Map(annotations.filter((a) => a.locator.type === "epub").map((a) => [a.id, a]));
    for (const [id, key] of drawn.current) {
      if (!want.has(id)) {
        r.annotations.remove(key.split("|")[0], "highlight");
        drawn.current.delete(id);
      }
    }
    for (const a of want.values()) {
      const cfi = (a.locator as EpubLocator).cfi;
      const key = `${cfi}|${a.color}`;
      if (drawn.current.get(a.id) === key) continue;
      if (drawn.current.has(a.id)) r.annotations.remove(cfi, "highlight");
      drawHighlight(r, a);
      drawn.current.set(a.id, key);
    }
  }, [annotations, ready]);

  function drawHighlight(r: Rendition, a: Annotation) {
    const cfi = (a.locator as EpubLocator).cfi;
    r.annotations.highlight(cfi, { id: a.id }, () => cb.current.onAnnotationClick(a.id), "ever-hl", {
      fill: HIGHLIGHT_COLORS[a.color] ?? HIGHLIGHT_COLORS.yellow,
      "fill-opacity": "0.38",
      "mix-blend-mode": "multiply",
    });
  }

  // ---------- 对外接口 ----------
  useImperativeHandle(
    handleRef,
    () => ({
      goTo: async (loc, opts) => {
        const r = rendRef.current;
        if (!r || loc.type !== "epub") return;
        await r.display(loc.cfi);
        if (opts?.flash) {
          r.annotations.highlight(loc.cfi, {}, undefined, "ever-flash", { fill: "orange", "fill-opacity": "0.5" });
          setTimeout(() => r.annotations.remove(loc.cfi, "highlight"), 1800);
          // 移除闪烁后恢复同一位置的已有标注
          setTimeout(() => {
            const a = annotations.find((x) => x.locator.type === "epub" && x.locator.cfi === loc.cfi);
            if (a) drawHighlight(r, a);
          }, 1900);
        }
      },
      goToToc: (item) => typeof item.target === "string" && rendRef.current?.display(item.target),
      current: () => lastLocation.current,
      clearSelection: () => {
        const contents = rendRef.current?.getContents() as unknown as { window: Window }[] | undefined;
        contents?.forEach((c) => c.window.getSelection()?.removeAllRanges());
      },
      search: async (q, onHit, signal, onProgress) => {
        const epub = bookRef.current;
        if (!epub || !q.trim()) return;
        const items = (epub.spine as unknown as { spineItems: SpineSection[] }).spineItems;
        let count = 0;
        for (let i = 0; i < items.length; i++) {
          if (signal.aborted) return;
          const section = items[i];
          try {
            await section.load(epub.load.bind(epub));
            const results = section.find(q.trim());
            for (const r of results) {
              let pct = "";
              try {
                if (epub.locations.length()) pct = ` · ${Math.round(epub.locations.percentageFromCfi(r.cfi) * 100)}%`;
              } catch {
                /* 忽略 */
              }
              onHit({
                locator: { type: "epub", v: 1, cfi: r.cfi },
                snippet: r.excerpt,
                label: (chapterTitle(section.href) || `第 ${i + 1} 节`) + pct,
              });
              if (++count >= 500) return;
            }
          } finally {
            section.unload();
          }
          onProgress((i + 1) / items.length);
        }
      },
    }),
    [annotations, chapterTitle],
  );

  return (
    <div ref={wrapRef} className="relative h-full" style={{ background: "var(--reader-bg)" }}>
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      <div
        ref={hostRef}
        className={clsx("mx-auto h-full px-12 py-6 max-sm:px-6", prefs.page_layout === "double" ? "max-w-6xl" : "max-w-3xl")}
        data-testid="epub-host"
      />
      <button
        className="absolute top-1/2 left-1 -translate-y-1/2 rounded-full p-2 text-muted hover:bg-surface-2"
        onClick={() => turn(-1)}
        aria-label="上一页"
      >
        <ChevronLeft className="h-6 w-6" />
      </button>
      <button
        className="absolute top-1/2 right-1 -translate-y-1/2 rounded-full p-2 text-muted hover:bg-surface-2"
        onClick={() => turn(1)}
        aria-label="下一页"
      >
        <ChevronRight className="h-6 w-6" />
      </button>
      {ready && !locationsReady && (
        <div className="absolute right-3 bottom-2 text-xs text-muted">正在计算阅读进度…</div>
      )}
    </div>
  );
}

interface SpineSection {
  href: string;
  load: (req: unknown) => Promise<unknown>;
  find: (q: string) => { cfi: string; excerpt: string }[];
  unload: () => void;
}
