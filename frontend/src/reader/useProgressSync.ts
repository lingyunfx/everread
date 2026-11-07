// 阅读进度自动保存：滚动稳定后短延迟保存、阅读中定时保存、页面隐藏时补存；
// 失败时暂存到本机并重试；服务端版本号防止迟到请求或其他设备覆盖新进度。
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api/client";
import type { Locator, Progress } from "../api/types";

export type SyncStatus = "idle" | "saving" | "saved" | "pending" | "offline" | "conflict";

const DEBOUNCE = 1500;
const INTERVAL = 20000;

interface Pending {
  locator: Locator;
  percent: number;
  base: number | null;
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? (/iPhone|iPad/.test(ua) ? "iOS" : "Mac") : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "设备";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "浏览器";
  return `${os} · ${br}`;
}

export function useProgressSync(bookId: string, userId: string, enabled: boolean) {
  const storageKey = `everread:pending-progress:${userId}:${bookId}`;
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [initial, setInitial] = useState<Progress | null | undefined>(undefined);
  const [conflict, setConflict] = useState<Progress | null>(null);
  const revision = useRef<number | null>(null);
  const pending = useRef<Pending | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const conflictRef = useRef(false);
  // 打开书后尚未真正移动时不保存，避免仅打开就推高版本号
  const startLocator = useRef<Locator | null>(null);
  const moved = useRef(false);

  // 读取服务端进度；若本机有未同步的进度，以它为起点并尝试补传
  useEffect(() => {
    let cancelled = false;
    api.progress(bookId).then(
      (p) => {
        if (cancelled) return;
        revision.current = p?.revision ?? null;
        const local = localStorage.getItem(storageKey);
        if (local) {
          try {
            const l = JSON.parse(local) as Pending;
            pending.current = l;
            setStatus("pending");
            // 本机暂存基于的版本仍是服务端当前版本时，说明它更新，用本机位置打开
            if (l.base === (p?.revision ?? null)) {
              setInitial({ locator: l.locator, percent: l.percent, revision: p?.revision ?? 0, device: null, updated_at: "" });
              moved.current = true;
              return;
            }
          } catch {
            localStorage.removeItem(storageKey);
          }
        }
        startLocator.current = p?.locator ?? null;
        setInitial(p);
      },
      () => !cancelled && setInitial(null),
    );
    return () => {
      cancelled = true;
    };
  }, [bookId, storageKey]);

  const flush = useCallback(
    async (opts: { keepalive?: boolean; force?: boolean } = {}) => {
      const p = pending.current;
      if (!p || saving.current || !enabled || (conflictRef.current && !opts.force)) return;
      saving.current = true;
      setStatus("saving");
      try {
        const res = await api.saveProgress(
          bookId,
          { locator: p.locator, percent: p.percent, base_revision: revision.current, force: opts.force, device: deviceName() },
          opts.keepalive,
        );
        revision.current = res.revision;
        // 保存期间又有新位置时继续保存
        if (pending.current === p) {
          pending.current = null;
          localStorage.removeItem(storageKey);
          setStatus("saved");
        } else {
          setStatus("pending");
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const current = (e.data as { current: Progress }).current;
          conflictRef.current = true;
          setConflict(current);
          setStatus("conflict");
        } else if (e instanceof ApiError && e.status !== 0) {
          // 书籍已不可访问等：放弃保存
          pending.current = null;
          localStorage.removeItem(storageKey);
          setStatus("idle");
        } else {
          localStorage.setItem(storageKey, JSON.stringify({ ...p, base: revision.current }));
          setStatus("offline");
        }
      } finally {
        saving.current = false;
      }
    },
    [bookId, enabled, storageKey],
  );

  const report = useCallback(
    (locator: Locator, percent: number) => {
      if (!moved.current) {
        if (startLocator.current && sameArea(startLocator.current, locator)) return;
        moved.current = true;
      }
      pending.current = { locator, percent, base: revision.current };
      localStorage.setItem(storageKey, JSON.stringify(pending.current));
      if (!conflictRef.current) setStatus((s) => (s === "offline" ? s : "pending"));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(), DEBOUNCE);
    },
    [flush, storageKey],
  );

  // 连续阅读期间定时保存；网络恢复时重试
  useEffect(() => {
    const iv = setInterval(() => flush(), INTERVAL);
    const online = () => flush();
    const hide = () => document.visibilityState === "hidden" && flush({ keepalive: true });
    const pagehide = () => flush({ keepalive: true });
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", pagehide);
    return () => {
      clearInterval(iv);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", pagehide);
      if (timer.current) clearTimeout(timer.current);
      // 切换书籍/离开阅读页时补存
      flush({ keepalive: true });
    };
  }, [flush]);

  /** 冲突处理：采用其他设备的进度（返回其位置供跳转），或以本机为准覆盖 */
  const resolveConflict = useCallback(
    (useRemote: boolean, current?: { locator: Locator; percent: number }) => {
      const remote = conflict;
      conflictRef.current = false;
      setConflict(null);
      if (useRemote && remote) {
        revision.current = remote.revision;
        pending.current = null;
        // 跳到远端位置后产生的近似位置不必再保存
        startLocator.current = remote.locator;
        moved.current = false;
        localStorage.removeItem(storageKey);
        setStatus("saved");
        return remote.locator;
      }
      if (!pending.current && current) pending.current = { ...current, base: revision.current };
      flush({ force: true });
      return null;
    },
    [conflict, flush, storageKey],
  );

  return { status, initial, conflict, report, resolveConflict, retry: () => flush() };
}

/** 打开书时恢复到的位置与上报位置是否基本相同（滚动换算会有细微误差） */
function sameArea(a: Locator, b: Locator): boolean {
  if (a.type === "pdf" && b.type === "pdf") return a.page === b.page && Math.abs((a.y ?? 0) - (b.y ?? 0)) < 0.03;
  if (a.type === "epub" && b.type === "epub") return a.cfi === b.cfi;
  if (a.type === "txt" && b.type === "txt") return a.para === b.para;
  return false;
}
