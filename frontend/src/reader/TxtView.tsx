// TXT 阅读器：翻页式单页 / 双页（CSS 多栏排版）。
// 后端已统一编码与换行，段落下标即稳定段落 ID；段内偏移统一用 Unicode 码点。
// 全书按章节（过长时再切分）分成若干节，一次只排版当前节，长篇小说也不会生成全部 DOM。
import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { TxtPoint } from "../api/types";
import { Spinner } from "../components/ui";
import { MIN_DOUBLE_WIDTH, usePageTurn } from "./pageTurn";
import type { EngineProps, LocationInfo, TocItem } from "./types";
import { selectionAnchor, snippetAround } from "./types";

const MAX_SECTION = 400; // 每节最多段落数
const PAD_X = 56;
const PAD_Y = 36;
const GAP = 80; // 栏间距（双页时即两页之间的距离）

/** UTF-16 下标 → 码点偏移（emoji 等占两个 UTF-16 单元） */
const cpLen = (s: string) => Array.from(s).length;

/** 计算 DOM 位置在段落内的码点偏移 */
function pointOffset(p: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(p, 0);
  r.setEnd(node, offset);
  return cpLen(r.toString());
}

function cmp(a: TxtPoint, b: TxtPoint) {
  return a.para - b.para || a.offset - b.offset;
}

interface Seg {
  start: number;
  end: number;
  cls: string;
  ann?: string;
}

type Pending = TxtPoint | "first" | "last";

export default function TxtView(props: EngineProps) {
  const { book, prefs, annotations, initial, handleRef } = props;
  const cb = useRef(props);
  useEffect(() => {
    cb.current = props;
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [paras, setParas] = useState<string[] | null>(null);
  const [sec, setSec] = useState(0);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [flash, setFlash] = useState<{ start: TxtPoint; end: TxtPoint } | null>(null);
  const [, setTick] = useState(0);
  const lastLocation = useRef<LocationInfo | null>(null);
  const pending = useRef<Pending | null>(
    initial?.type === "txt" ? { para: initial.para, offset: initial.offset } : "first",
  );

  const toc = useMemo<TocItem[]>(
    () =>
      (book.meta.toc ?? []).map((t) => ({
        title: t.title,
        level: t.level,
        target: { type: "txt", v: 1, para: t.para ?? 0, offset: 0 },
      })),
    [book.meta.toc],
  );

  // 分节：每章另起一节（新的一页开始），过长的章再按段落数切分
  const sections = useMemo(() => {
    if (!paras) return [] as [number, number][];
    const starts = [...new Set([0, ...toc.map((t) => (t.target as TxtPoint).para)])]
      .filter((p) => p >= 0 && p < paras.length)
      .sort((a, b) => a - b);
    const out: [number, number][] = [];
    starts.forEach((s, i) => {
      const e = i + 1 < starts.length ? starts[i + 1] : paras.length;
      for (let k = s; k < e; k += MAX_SECTION) out.push([k, Math.min(e, k + MAX_SECTION)]);
    });
    return out;
  }, [paras, toc]);

  const secOf = useCallback(
    (para: number) => {
      let lo = 0,
        hi = sections.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (sections[mid][0] <= para) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [sections],
  );

  useEffect(() => {
    let cancelled = false;
    api.txtContent(book.id).then(
      (c) => {
        if (cancelled) return;
        setParas(c.paragraphs);
        cb.current.onReady(toc);
      },
      (e) => !cancelled && cb.current.onError(`TXT 加载失败：${e.message}`),
    );
    return () => {
      cancelled = true;
    };
  }, [book.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 内容加载后定位到起始节
  useLayoutEffect(() => {
    if (!sections.length) return;
    const p = pending.current;
    if (p && p !== "first" && p !== "last") setSec(secOf(Math.min(p.para, paras!.length - 1)));
  }, [sections]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [paras !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 版面尺寸 ----------
  const fs = prefs.font_size;
  const cols = prefs.page_layout === "double" && stage.w >= MIN_DOUBLE_WIDTH ? 2 : 1;
  // 每栏最多约 34 个汉字宽，过宽时居中
  const viewW = Math.max(
    200,
    Math.min(stage.w - PAD_X * 2, cols === 2 ? fs * 34 * 2 + GAP : fs * 38),
  );
  const viewH = Math.max(120, stage.h - PAD_Y * 2);
  const stride = viewW + GAP;

  // 版面变化（字号、行距、窗口、单双页）后回到同一处内容
  const layoutKey = `${fs}|${prefs.line_height}|${viewW}|${viewH}|${cols}`;
  const prevLayout = useRef(layoutKey);
  useLayoutEffect(() => {
    if (prevLayout.current === layoutKey) return;
    prevLayout.current = layoutKey;
    const l = lastLocation.current?.locator;
    if (l?.type === "txt" && !pending.current) pending.current = { para: l.para, offset: l.offset };
  }, [layoutKey]);

  const percentOf = useCallback((p: TxtPoint) => (paras?.length ? (p.para / paras.length) * 100 : 0), [paras]);

  const chapterOf = useCallback(
    (para: number) => {
      let title = "";
      for (const t of toc) {
        if ((t.target as TxtPoint).para <= para) title = t.title;
        else break;
      }
      return title;
    },
    [toc],
  );

  /** 当前页上的第一个段落及段内偏移 */
  const computeLocation = useCallback((): LocationInfo | null => {
    const content = contentRef.current;
    if (!content || !paras) return null;
    const left = content.getBoundingClientRect().left;
    const x0 = page * stride;
    let point: TxtPoint | null = null;
    for (const p of content.querySelectorAll<HTMLElement>("p[data-para]")) {
      const rects = Array.from(p.getClientRects());
      const onPage = rects.find((r) => r.width > 0 && r.left - left >= x0 - 2 && r.left - left < x0 + viewW);
      if (!onPage) continue;
      let offset = 0;
      // 段落从上一页延续过来时，找出本页第一个字的偏移
      if (rects[0] !== onPage) {
        const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
        const r = doc.caretRangeFromPoint?.(onPage.left + 1, onPage.top + onPage.height / 2);
        if (r && p.contains(r.startContainer)) offset = pointOffset(p, r.startContainer, r.startOffset);
      }
      point = { para: Number(p.dataset.para), offset };
      break;
    }
    if (!point) return null;
    const percent = Math.round(percentOf(point) * 100) / 100;
    return {
      locator: { type: "txt", v: 1, para: point.para, offset: point.offset },
      percent,
      label: [chapterOf(point.para), `${Math.round(percent)}%`].filter(Boolean).join(" · "),
      sortKey: point.para + point.offset / 1e6,
    };
  }, [paras, page, stride, viewW, percentOf, chapterOf]);

  /** 某个位置位于当前节的第几页 */
  const pageOfPoint = useCallback(
    (pt: TxtPoint): number | null => {
      const content = contentRef.current;
      if (!content) return null;
      const p = content.querySelector<HTMLElement>(`p[data-para="${pt.para}"]`);
      if (!p) return null;
      const r = (pt.offset > 0 && rangeForOffsets(p, pt.offset, pt.offset + 1)?.getClientRects()[0]) || p.getClientRects()[0];
      if (!r) return 0;
      return Math.max(0, Math.floor((r.left - content.getBoundingClientRect().left + 1) / stride));
    },
    [stride],
  );

  // 每次渲染后：测量页数、执行挂起的定位、上报当前位置
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !paras || !stage.w) return;
    const last = content.lastElementChild as HTMLElement | null;
    const left = content.getBoundingClientRect().left;
    const right = last ? Math.max(...Array.from(last.getClientRects()).map((r) => r.right)) - left : 0;
    const pc = Math.max(1, Math.floor(Math.max(0, right - 1) / stride) + 1);
    if (pc !== pageCount) setPageCount(pc);
    const pend = pending.current;
    if (pend) {
      let target: number | null = 0;
      if (pend === "last") target = pc - 1;
      else if (pend !== "first") {
        if (secOf(pend.para) !== sec) {
          setSec(secOf(pend.para));
          return;
        }
        target = pageOfPoint(pend);
      }
      if (target === null) return;
      pending.current = null;
      if (target !== page) {
        setPage(Math.min(target, pc - 1));
        return;
      }
    }
    const info = computeLocation();
    const prev = lastLocation.current?.locator;
    if (info && (!prev || prev.type !== "txt" || cmp(prev, info.locator as TxtPoint) !== 0)) {
      lastLocation.current = info;
      cb.current.onLocation(info);
    }
  });

  // ---------- 翻页 ----------
  const turn = useCallback(
    (dir: -1 | 1) => {
      window.getSelection()?.removeAllRanges();
      cb.current.onSelection(null);
      if (dir > 0) {
        if (page < pageCount - 1) setPage(page + 1);
        else if (sec < sections.length - 1) {
          pending.current = "first";
          setSec(sec + 1);
          setPage(0);
        }
      } else if (page > 0) setPage(page - 1);
      else if (sec > 0) {
        pending.current = "last";
        setSec(sec - 1);
      }
    },
    [page, pageCount, sec, sections.length],
  );
  usePageTurn(wrapRef, turn, { wheel: true });

  const goToPoint = useCallback(
    (pt: TxtPoint) => {
      pending.current = pt;
      const s = secOf(pt.para);
      if (s !== sec) setSec(s);
      // 目标在当前节时也触发一次渲染，以执行挂起的定位
      setTick((t) => t + 1);
    },
    [secOf, sec],
  );

  // ---------- 选区 ----------
  const readSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return cb.current.onSelection(null);
    const range = sel.getRangeAt(0);
    const elOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement);
    const startP = elOf(range.startContainer)?.closest<HTMLElement>("p[data-para]");
    const endP = elOf(range.endContainer)?.closest<HTMLElement>("p[data-para]");
    if (!startP || !endP || !contentRef.current?.contains(startP)) return cb.current.onSelection(null);
    const start = { para: Number(startP.dataset.para), offset: pointOffset(startP, range.startContainer, range.startOffset) };
    const end = { para: Number(endP.dataset.para), offset: pointOffset(endP, range.endContainer, range.endOffset) };
    const quote = range.toString().trim();
    if (!quote || cmp(start, end) >= 0) return cb.current.onSelection(null);
    cb.current.onSelection({
      parts: [{ locator: { type: "txt", v: 1, para: start.para, offset: start.offset, end }, quote }],
      quote,
      rect: selectionAnchor(range),
    });
  }, []);

  // ---------- 标注分段 ----------
  const segsByPara = useMemo(() => {
    const m = new Map<number, Seg[]>();
    const add = (start: TxtPoint, end: TxtPoint, cls: string, ann?: string) => {
      for (let p = start.para; p <= end.para; p++) {
        const s = p === start.para ? start.offset : 0;
        const e = p === end.para ? end.offset : Number.MAX_SAFE_INTEGER;
        if (e > s) m.set(p, [...(m.get(p) ?? []), { start: s, end: e, cls, ann }]);
      }
    };
    for (const a of annotations) {
      if (a.locator.type !== "txt" || !a.locator.end) continue;
      add({ para: a.locator.para, offset: a.locator.offset }, a.locator.end, `hl-${a.color}`, a.id);
    }
    if (flash) add(flash.start, flash.end, "hl-flash");
    return m;
  }, [annotations, flash]);

  useImperativeHandle(
    handleRef,
    () => ({
      goTo: (loc, opts) => {
        if (loc.type !== "txt") return;
        goToPoint({ para: loc.para, offset: loc.offset });
        if (opts?.flash && loc.end) {
          setFlash({ start: { para: loc.para, offset: loc.offset }, end: loc.end });
          setTimeout(() => setFlash(null), 2100);
        }
      },
      goToToc: (item) =>
        typeof item.target !== "string" && item.target.type === "txt" && goToPoint({ para: item.target.para, offset: 0 }),
      current: () => lastLocation.current,
      clearSelection: () => window.getSelection()?.removeAllRanges(),
      search: async (q, onHit, signal, onProgress) => {
        if (!paras || !q.trim()) return;
        const needle = q.trim().toLowerCase();
        let count = 0;
        for (let i = 0; i < paras.length; i++) {
          if (i % 2000 === 0) {
            await new Promise((r) => setTimeout(r, 0));
            if (signal.aborted) return;
            onProgress(i / paras.length);
          }
          const text = paras[i];
          const lower = text.toLowerCase();
          let k = lower.indexOf(needle);
          while (k >= 0) {
            const offset = cpLen(text.slice(0, k));
            onHit({
              locator: {
                type: "txt",
                v: 1,
                para: i,
                offset,
                end: { para: i, offset: offset + cpLen(text.slice(k, k + needle.length)) },
              },
              snippet: snippetAround(text, k, needle.length),
              label: [chapterOf(i), `${Math.round((i / paras.length) * 100)}%`].filter(Boolean).join(" · "),
            });
            if (++count >= 500) return;
            k = lower.indexOf(needle, k + needle.length);
          }
        }
        onProgress(1);
      },
    }),
    [paras, goToPoint, chapterOf],
  );

  if (!paras) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: "var(--reader-bg)" }}>
        <Spinner />
      </div>
    );
  }

  const [from, to] = sections[sec] ?? [0, 0];
  return (
    <div
      ref={wrapRef}
      className="relative h-full overflow-hidden"
      style={{ background: "var(--reader-bg)", color: "var(--reader-fg)" }}
      onMouseUp={() => setTimeout(readSelection, 0)}
      onClick={(e) => {
        const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-ann]");
        if (mark && window.getSelection()?.isCollapsed) cb.current.onAnnotationClick(mark.dataset.ann!);
      }}
      data-testid="txt-scroll"
      data-page={`${sec}:${page}`}
    >
      <div
        className="absolute overflow-hidden"
        style={{ top: PAD_Y, height: viewH, width: viewW, left: Math.max(PAD_X, (stage.w - viewW) / 2) }}
      >
        <div
          ref={contentRef}
          className="txt-body font-serif"
          style={{
            height: viewH,
            width: viewW,
            columnCount: cols,
            columnGap: GAP,
            columnFill: "auto",
            fontSize: fs,
            lineHeight: prefs.line_height,
            transform: `translateX(${-page * stride}px)`,
          }}
        >
          {paras.slice(from, to).map((text, j) => {
            const i = from + j;
            return <Para key={i} index={i} text={text} segs={segsByPara.get(i)} />;
          })}
          {sec === sections.length - 1 && (
            <p className="py-10 text-center text-sm opacity-50" style={{ textIndent: 0 }}>
              — 全书完 —
            </p>
          )}
        </div>
      </div>
      {cols === 2 && (
        <div
          className="pointer-events-none absolute w-px bg-current opacity-10"
          style={{ top: PAD_Y, height: viewH, left: Math.max(PAD_X, (stage.w - viewW) / 2) + viewW / 2 }}
        />
      )}
      <button
        className="absolute top-1/2 left-1 -translate-y-1/2 rounded-full p-2 opacity-50 hover:opacity-100"
        onClick={() => turn(-1)}
        aria-label="上一页"
      >
        <ChevronLeft className="h-6 w-6" />
      </button>
      <button
        className="absolute top-1/2 right-1 -translate-y-1/2 rounded-full p-2 opacity-50 hover:opacity-100"
        onClick={() => turn(1)}
        aria-label="下一页"
      >
        <ChevronRight className="h-6 w-6" />
      </button>
      <div className="pointer-events-none absolute right-4 bottom-2 text-[11px] opacity-50">
        {page + 1} / {pageCount}
      </div>
    </div>
  );
}

const Para = memo(
  function Para({ index, text, segs }: { index: number; text: string; segs?: Seg[] }) {
    if (!segs?.length) return <p data-para={index}>{text}</p>;
    // 按码点切分，后添加的标注覆盖先添加的
    const chars = Array.from(text);
    const owner: (Seg | null)[] = new Array(chars.length).fill(null);
    for (const s of segs) for (let k = Math.max(0, s.start); k < Math.min(chars.length, s.end); k++) owner[k] = s;
    const out: React.ReactNode[] = [];
    let k = 0;
    while (k < chars.length) {
      const o = owner[k];
      let j = k;
      while (j < chars.length && owner[j] === o) j++;
      const piece = chars.slice(k, j).join("");
      out.push(
        o ? (
          <mark key={k} className={o.cls} data-ann={o.ann}>
            {piece}
          </mark>
        ) : (
          piece
        ),
      );
      k = j;
    }
    return <p data-para={index}>{out}</p>;
  },
  (a, b) => a.text === b.text && JSON.stringify(a.segs) === JSON.stringify(b.segs),
);

/** 在段落中按码点偏移构造 Range（用于跳转定位） */
function rangeForOffsets(p: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let pos = 0;
  const r = document.createRange();
  let started = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent ?? "";
    const len = cpLen(t);
    const toUnits = (cp: number) => Array.from(t).slice(0, cp).join("").length;
    if (!started && start <= pos + len) {
      r.setStart(n, toUnits(start - pos));
      started = true;
    }
    if (started && end <= pos + len) {
      r.setEnd(n, toUnits(end - pos));
      return r;
    }
    pos += len;
  }
  return started ? r : null;
}
