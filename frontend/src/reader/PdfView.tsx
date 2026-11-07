// PDF 阅读器：翻页式单页 / 双页显示。PDF.js 渲染画布与文字层，
// 标注保存为 PDF 坐标，缩放 / 旋转 / 单双页切换后仍能正确定位。
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { API, authHeaders } from "../api/client";
import type { Annotation, PdfLocator } from "../api/types";
import { MIN_DOUBLE_WIDTH, usePageTurn } from "./pageTurn";
import type { EngineProps, LocationInfo, SearchHit, SelectionPart, TocItem } from "./types";
import { selectionAnchor, snippetAround } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const PAD = 20;
const SPREAD_GAP = 2; // 双页之间的缝隙，像一本摊开的书
const MAX_HITS = 500;

interface Size {
  w: number;
  h: number;
}

type FlashRects = { page: number; rects: number[][] } | null;

/**
 * 页面分组：双页时封面单独显示，之后 2-3、4-5 … 两两成对（与实体书一致）；单页时每页一组。
 */
function spreadCount(n: number, double: boolean) {
  return double ? Math.floor(n / 2) + 1 : n;
}
function spreadOf(page: number, double: boolean) {
  return double ? Math.floor(page / 2) : page - 1;
}
function spreadPages(i: number, n: number, double: boolean): number[] {
  if (!double) return [i + 1];
  if (i === 0) return [1];
  return [2 * i, 2 * i + 1].filter((p) => p <= n);
}

export default function PdfView(props: EngineProps & { rotation: number }) {
  const { book, prefs, annotations, initial, handleRef, rotation } = props;
  const cb = useRef(props);
  useEffect(() => {
    cb.current = props;
  });

  const stageRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [baseSize, setBaseSize] = useState<Size | null>(null);
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
  const [spread, setSpread] = useState(0);
  const [flash, setFlash] = useState<FlashRects>(null);
  const [jumpText, setJumpText] = useState("");
  const [percent, setPercent] = useState(0);
  const viewports = useRef(new Map<number, PageViewport>());
  const lastLocation = useRef<LocationInfo | null>(null);
  // 当前阅读的页（切换单双页时据此重新分组）
  const anchorPage = useRef(initial?.type === "pdf" ? initial.page : 1);
  // 初次恢复阅读位置之前不上报位置
  const restored = useRef(false);
  const numPages = doc?.numPages ?? 0;
  const double = prefs.page_layout === "double" && stage.w >= MIN_DOUBLE_WIDTH;
  const count = numPages ? spreadCount(numPages, double) : 0;
  const pages = numPages ? spreadPages(spread, numPages, double) : [];

  // ---------- 加载文档（带令牌的 Range 分段加载）----------
  useEffect(() => {
    let destroyed = false;
    const task = pdfjs.getDocument({
      url: `${API}/books/${book.id}/file`,
      httpHeaders: authHeaders(),
      rangeChunkSize: 256 * 1024,
      disableAutoFetch: true,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
      iccUrl: "/pdfjs/iccs/",
    });
    task.promise.then(
      async (d) => {
        if (destroyed) return;
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        anchorPage.current = Math.min(Math.max(1, anchorPage.current), d.numPages);
        setBaseSize({ w: vp.width, h: vp.height });
        setDoc(d);
        // 目录：优先使用 PDF 自带书签，后端已解析到 meta.toc
        const toc: TocItem[] = (book.meta.toc ?? []).map((t) => ({
          title: t.title,
          level: t.level,
          target: { type: "pdf", v: 1, page: t.page ?? 1, y: 0 },
        }));
        cb.current.onReady(toc);
      },
      (err) => {
        if (!destroyed) cb.current.onError(`PDF 加载失败：${err?.message ?? err}`);
      },
    );
    return () => {
      destroyed = true;
      task.destroy();
    };
  }, [book.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 舞台尺寸 ----------
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, []);

  const rotated = rotation % 180 !== 0;
  // 统一按首页尺寸整页适配（封面与内页同样大小），再乘以用户缩放
  const scale = useMemo(() => {
    if (!baseSize || !stage.w) return 1;
    const w = rotated ? baseSize.h : baseSize.w;
    const h = rotated ? baseSize.w : baseSize.h;
    const cols = double ? 2 : 1;
    const fitW = (stage.w - PAD * 2 - (cols - 1) * SPREAD_GAP) / (w * cols);
    const fitH = (stage.h - PAD * 2) / h;
    return Math.max(0.2, Math.min(fitW, fitH) * prefs.pdf_zoom);
  }, [baseSize, stage, double, prefs.pdf_zoom, rotated]);

  // 文档加载或单双页切换后：让当前阅读的页所在的组显示出来
  useLayoutEffect(() => {
    if (!numPages || !stage.w) return;
    setSpread(spreadOf(anchorPage.current, double));
  }, [numPages, double, stage.w > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const locationOf = useCallback(
    (i: number): LocationInfo => {
      const ps = spreadPages(i, numPages, double);
      const first = ps[0];
      const last = ps[ps.length - 1];
      return {
        locator: { type: "pdf", v: 1, page: first, y: 0 },
        percent: Math.round((last / numPages) * 10000) / 100,
        label: ps.length > 1 ? `第 ${first}–${last} / ${numPages} 页` : `第 ${first} / ${numPages} 页`,
        sortKey: first,
      };
    },
    [numPages, double],
  );

  // 翻到新的一组后上报位置，并预取下一组页面数据
  useEffect(() => {
    if (!doc || !stage.w) return;
    // 首次恢复位置完成前（仍停在第 0 组）不上报，避免把封面当成进度
    if (!restored.current && spread !== spreadOf(anchorPage.current, double)) return;
    const info = locationOf(spread);
    anchorPage.current = (info.locator as PdfLocator).page;
    lastLocation.current = info;
    restored.current = true;
    cb.current.onLocation(info);
    setJumpText(String(anchorPage.current));
    setPercent(info.percent);
    for (const p of spreadPages(spread + 1, doc.numPages, double)) doc.getPage(p).catch(() => {});
  }, [doc, spread, locationOf, stage.w, double]);

  const turn = useCallback(
    (dir: -1 | 1) => {
      setSpread((s) => Math.min(Math.max(0, s + dir), Math.max(0, count - 1)));
      stageRef.current?.scrollTo({ top: 0, left: 0 });
      window.getSelection()?.removeAllRanges();
      cb.current.onSelection(null);
    },
    [count],
  );

  const goToPage = useCallback(
    (page: number) => {
      if (!numPages) return;
      const p = Math.min(Math.max(1, page), numPages);
      anchorPage.current = p;
      setSpread(spreadOf(p, double));
      stageRef.current?.scrollTo({ top: 0, left: 0 });
    },
    [numPages, double],
  );

  const goToLocator = useCallback(
    (loc: PdfLocator, doFlash: boolean) => {
      goToPage(loc.page);
      if (doFlash && loc.rects?.length) {
        setFlash({ page: loc.page, rects: loc.rects });
        setTimeout(() => setFlash(null), 2100);
      }
    },
    [goToPage],
  );

  // ---------- 选区 → PDF 坐标 ----------
  const readSelection = useCallback(() => {
    const sel = window.getSelection();
    const el = stageRef.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !el) return cb.current.onSelection(null);
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return cb.current.onSelection(null);
    const parts: SelectionPart[] = [];
    for (const pageEl of el.querySelectorAll<HTMLElement>(".pdf-page[data-page]")) {
      const textLayer = pageEl.querySelector<HTMLElement>(".textLayer");
      if (!textLayer || !range.intersectsNode(textLayer)) continue;
      const page = Number(pageEl.dataset.page);
      const vp = viewports.current.get(page);
      if (!vp) continue;
      const r = range.cloneRange();
      if (!textLayer.contains(r.startContainer)) r.setStart(textLayer, 0);
      // 选区结束点不在本页时截到本页文字末尾，并排除 endOfContent 辅助元素（选择中它会铺满整页）
      if (!textLayer.contains(r.endContainer)) {
        const end = textLayer.querySelector(":scope > .endOfContent");
        if (end) r.setEndBefore(end);
        else r.setEnd(textLayer, textLayer.childNodes.length);
      }
      const quote = r.toString().replace(/\s+/g, " ").trim();
      if (!quote) continue;
      const box = pageEl.getBoundingClientRect();
      const rects = mergeRects(
        Array.from(r.getClientRects())
          .filter((c) => c.width > 1 && c.height > 1 && c.height < box.height * 0.2)
          .map((c) => {
            const [x1, y1] = vp.convertToPdfPoint(c.left - box.left, c.top - box.top);
            const [x2, y2] = vp.convertToPdfPoint(c.right - box.left, c.bottom - box.top);
            return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map(
              (v) => Math.round(v * 100) / 100,
            );
          }),
      );
      if (rects.length) parts.push({ locator: { type: "pdf", v: 1, page, rects }, quote });
    }
    if (!parts.length) return cb.current.onSelection(null);
    cb.current.onSelection({
      parts,
      quote: parts.map((p) => p.quote).join(" "),
      rect: selectionAnchor(range),
    });
  }, []);

  useEffect(() => {
    const clear = () =>
      stageRef.current?.querySelectorAll(".textLayer.selecting").forEach((t) => t.classList.remove("selecting"));
    document.addEventListener("mouseup", clear, true);
    return () => document.removeEventListener("mouseup", clear, true);
  }, []);

  // 点击位置是否落在已有标注上
  const annotationAt = useCallback(
    (e: MouseEvent | React.MouseEvent): Annotation | undefined => {
      const pageEl = (e.target as Element).closest?.<HTMLElement>(".pdf-page[data-page]");
      if (!pageEl) return undefined;
      const page = Number(pageEl.dataset.page);
      const vp = viewports.current.get(page);
      if (!vp) return undefined;
      const box = pageEl.getBoundingClientRect();
      const [px, py] = vp.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
      return annotations.find(
        (a) =>
          a.locator.type === "pdf" &&
          a.locator.page === page &&
          a.locator.rects?.some(([x1, y1, x2, y2]) => px >= x1 - 1 && px <= x2 + 1 && py >= y1 - 1 && py <= y2 + 1),
      );
    },
    [annotations],
  );

  const onPageClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!window.getSelection()?.isCollapsed) return;
      const hit = annotationAt(e);
      if (hit) cb.current.onAnnotationClick(hit.id);
    },
    [annotationAt],
  );

  usePageTurn(stageRef, turn, { wheel: true, isAnnotationHit: (e) => !!annotationAt(e) });

  // ---------- 对外接口 ----------
  useImperativeHandle(
    handleRef,
    () => ({
      goTo: (loc, opts) => loc.type === "pdf" && goToLocator(loc, !!opts?.flash),
      goToToc: (item) =>
        typeof item.target !== "string" && item.target.type === "pdf" && goToLocator(item.target, false),
      current: () => lastLocation.current,
      clearSelection: () => window.getSelection()?.removeAllRanges(),
      search: async (q, onHit, signal, onProgress) => {
        if (!doc || !q.trim()) return;
        const needle = q.trim().toLowerCase();
        let found = 0;
        for (let p = 1; p <= doc.numPages; p++) {
          if (signal.aborted) return;
          const page = await doc.getPage(p);
          const tc = await page.getTextContent();
          // 拼接本页文字，并记录每个字符所在的文字块
          let text = "";
          const owners: number[] = [];
          tc.items.forEach((it, idx) => {
            if (!("str" in it)) return;
            text += it.str;
            for (let k = 0; k < it.str.length; k++) owners.push(idx);
            if (it.hasEOL) {
              text += " ";
              owners.push(idx);
            }
          });
          const lower = text.toLowerCase();
          let i = lower.indexOf(needle);
          while (i >= 0 && found < MAX_HITS) {
            const idxs = new Set(owners.slice(i, i + needle.length));
            const rects: number[][] = [];
            for (const idx of idxs) {
              const it = tc.items[idx];
              if (!("str" in it)) continue;
              const [, , , d, e, f] = it.transform;
              const h = it.height || Math.abs(d);
              rects.push([e, f - h * 0.2, e + it.width, f + h * 0.9]);
            }
            const hit: SearchHit = {
              locator: { type: "pdf", v: 1, page: p, rects },
              snippet: snippetAround(text, i, needle.length),
              label: `第 ${p} 页`,
            };
            onHit(hit);
            found++;
            i = lower.indexOf(needle, i + needle.length);
          }
          page.cleanup();
          onProgress(p / doc.numPages);
          if (found >= MAX_HITS) return;
        }
      },
    }),
    [doc, goToLocator],
  );

  const annsByPage = useMemo(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of annotations) {
      if (a.locator.type !== "pdf") continue;
      m.set(a.locator.page, [...(m.get(a.locator.page) ?? []), a]);
    }
    return m;
  }, [annotations]);

  const pageW = (baseSize ? (rotated ? baseSize.h : baseSize.w) : 595) * scale;
  const pageH = (baseSize ? (rotated ? baseSize.w : baseSize.h) : 842) * scale;

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={stageRef}
          className={clsx(
            "scrollbar-thin flex h-full overflow-auto bg-surface-2",
            prefs.pdf_filter === "sepia" && "pdf-filter-sepia",
            prefs.pdf_filter === "dark" && "pdf-filter-dark",
          )}
          style={{ justifyContent: "safe center", alignItems: "safe center", padding: PAD }}
          onMouseUp={() => setTimeout(readSelection, 0)}
          onKeyUp={(e) => e.shiftKey && readSelection()}
          data-testid="pdf-scroll"
          data-spread={pages.join(",")}
        >
          {doc && (
            <div className="flex shrink-0 items-start" style={{ gap: SPREAD_GAP }}>
              {pages.map((n) => (
                <PdfPage
                  key={n}
                  doc={doc}
                  pageNumber={n}
                  scale={scale}
                  rotation={rotation}
                  width={pageW}
                  height={pageH}
                  annotations={annsByPage.get(n)}
                  flash={flash?.page === n ? flash.rects : undefined}
                  onViewport={(vp) => viewports.current.set(n, vp)}
                  onClick={onPageClick}
                />
              ))}
            </div>
          )}
        </div>
        <button
          className="absolute top-1/2 left-1 -translate-y-1/2 rounded-full bg-surface/70 p-2 text-muted shadow-sm hover:text-fg disabled:opacity-0"
          onClick={() => turn(-1)}
          disabled={spread <= 0}
          aria-label="上一页"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <button
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded-full bg-surface/70 p-2 text-muted shadow-sm hover:text-fg disabled:opacity-0"
          onClick={() => turn(1)}
          disabled={spread >= count - 1}
          aria-label="下一页"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>
      {/* 底部页码栏：跳页与进度滑块 */}
      {numPages > 0 && (
        <div className="flex h-10 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-xs text-muted" data-no-turn>
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(jumpText);
              if (Number.isFinite(n) && n >= 1) goToPage(n);
            }}
          >
            <input
              value={jumpText}
              onChange={(e) => setJumpText(e.target.value.replace(/\D/g, ""))}
              className="h-7 w-14 rounded border border-border bg-surface px-1.5 text-center text-xs text-fg outline-none focus:border-accent"
              aria-label="跳到页码"
              data-testid="page-jump"
              inputMode="numeric"
            />
            <span>/ {numPages}</span>
          </form>
          <input
            type="range"
            min={0}
            max={Math.max(0, count - 1)}
            value={spread}
            onChange={(e) => {
              setSpread(Number(e.target.value));
              stageRef.current?.scrollTo({ top: 0, left: 0 });
            }}
            className="min-w-0 flex-1 accent-current text-fg"
            aria-label="翻页进度"
          />
          <span className="w-10 text-right tabular-nums">{Math.round(percent)}%</span>
        </div>
      )}
    </div>
  );
}

/** PDF 坐标矩形 → 视口像素矩形（旋转后两个角点的顺序可能互换） */
function rectToViewport(vp: PageViewport, r: number[]): number[] {
  const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
  const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
  return [x1, y1, x2, y2];
}

/** 合并同一行上相邻的矩形，减少保存的数据量 */
function mergeRects(rects: number[][]): number[][] {
  const sorted = [...rects].sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out: number[][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < 2.5 && Math.abs(last[3] - r[3]) < 2.5 && r[0] <= last[2] + 14) {
      last[0] = Math.min(last[0], r[0]);
      last[2] = Math.max(last[2], r[2]);
      last[1] = Math.min(last[1], r[1]);
      last[3] = Math.max(last[3], r[3]);
    } else if (!out.some((o) => o[0] <= r[0] && o[1] <= r[1] && o[2] >= r[2] && o[3] >= r[3])) {
      out.push([...r]);
    }
  }
  return out;
}

interface PageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  width: number;
  height: number;
  annotations?: Annotation[];
  flash?: number[][];
  onViewport: (vp: PageViewport) => void;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
}

const PdfPage = memo(function PdfPage({
  doc,
  pageNumber,
  scale,
  rotation,
  width,
  height,
  annotations,
  flash,
  onViewport,
  onClick,
}: PageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<PageViewport | null>(null);
  const onViewportRef = useRef(onViewport);
  useEffect(() => {
    onViewportRef.current = onViewport;
  });

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    let page: PDFPageProxy | null = null;
    (async () => {
      page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const rot = (page.rotate + rotation) % 360;
      const viewport = page.getViewport({ scale, rotation: rot });
      onViewportRef.current(viewport);
      setVp(viewport);
      const canvas = canvasRef.current!;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      renderTask = page.render({
        canvas,
        canvasContext: canvas.getContext("2d")!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      try {
        await renderTask.promise;
      } catch {
        return;
      }
      if (cancelled || !textRef.current) return;
      const container = textRef.current;
      container.replaceChildren();
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      try {
        await textLayer.render();
      } catch {
        return;
      }
      // 与 PDF.js 官方阅读器一致：选择时用 endOfContent 防止选区跳到页首
      const end = document.createElement("div");
      end.className = "endOfContent";
      container.append(end);
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      const c = canvasRef.current;
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    };
  }, [doc, pageNumber, scale, rotation]);

  const toBox = (r: number[]) => {
    if (!vp) return null;
    const [x1, y1, x2, y2] = rectToViewport(vp, r);
    return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
  };

  return (
    <div
      className="pdf-page"
      data-page={pageNumber}
      data-testid={`pdf-page-${pageNumber}`}
      style={
        {
          flexShrink: 0,
          width,
          height,
          "--scale-factor": scale,
          "--total-scale-factor": scale,
        } as React.CSSProperties
      }
      onClick={onClick}
      onMouseDown={() => textRef.current?.classList.add("selecting")}
    >
      <canvas ref={canvasRef} />
      <div className="pdf-hl-layer">
        {annotations?.flatMap((a) =>
          a.locator.type === "pdf"
            ? (a.locator.rects ?? []).map((r, i) => {
                const box = toBox(r);
                return box && <div key={`${a.id}-${i}`} className={`hl-${a.color}`} style={box} data-ann={a.id} />;
              })
            : [],
        )}
        {flash?.map((r, i) => {
          const box = toBox(r);
          return box && <div key={`f-${i}`} className="hl-flash" style={box} />;
        })}
      </div>
      <div ref={textRef} className="textLayer" />
    </div>
  );
});
