import clsx from "clsx";
import { Minus, Plus, RotateCw } from "lucide-react";
import { useEffect, useRef } from "react";
import type { BookFormat, Preferences } from "../api/types";
import { ThemeSwitcher } from "../components/ThemeSwitcher";

export function SettingsMenu({
  format,
  prefs,
  rotation,
  onRotate,
  onChange,
  onClose,
}: {
  format: BookFormat;
  prefs: Preferences;
  rotation: number;
  onRotate: () => void;
  onChange: (p: Partial<Preferences>) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('[aria-label="阅读设置"]')) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  const Stepper = ({ label, value, onDec, onInc, testid }: { label: string; value: string; onDec: () => void; onInc: () => void; testid: string }) => (
    <div className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1">
        <button className="rounded border border-border p-1 hover:bg-surface-2" onClick={onDec} aria-label={`减小${label}`}><Minus className="h-3.5 w-3.5" /></button>
        <span className="w-12 text-center text-sm tabular-nums" data-testid={testid}>{value}</span>
        <button className="rounded border border-border p-1 hover:bg-surface-2" onClick={onInc} aria-label={`增大${label}`}><Plus className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );

  return (
    <div ref={ref} className="absolute top-11 right-0 z-40 w-64 space-y-3 rounded-lg border border-border bg-surface p-3 shadow-xl" data-testid="settings-menu">
      <div className="flex items-center justify-between">
        <span className="text-sm">主题</span>
        <ThemeSwitcher />
      </div>
      <div>
        <span className="text-sm">页面</span>
        <div className="mt-1 flex rounded-md bg-surface-2 p-0.5 text-xs" role="radiogroup" aria-label="单双页">
          {(
            [
              ["double", "双页"],
              ["single", "单页"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={prefs.page_layout === id}
              onClick={() => onChange({ page_layout: id })}
              className={clsx("flex-1 rounded py-1", prefs.page_layout === id ? "bg-surface font-medium shadow-sm" : "text-muted")}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-muted">窗口较窄时自动按单页显示。</p>
      </div>
      {format === "pdf" ? (
        <>
          <Stepper
            label="缩放"
            testid="zoom-value"
            value={`${Math.round(prefs.pdf_zoom * 100)}%`}
            onDec={() => onChange({ pdf_zoom: Math.max(0.5, Math.round((prefs.pdf_zoom - 0.1) * 10) / 10) })}
            onInc={() => onChange({ pdf_zoom: Math.min(3, Math.round((prefs.pdf_zoom + 0.1) * 10) / 10) })}
          />
          <div>
            <span className="text-sm">页面颜色</span>
            <div className="mt-1 flex rounded-md bg-surface-2 p-0.5 text-xs">
              {(
                [
                  ["none", "原稿"],
                  ["sepia", "暖色"],
                  ["dark", "暗色"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => onChange({ pdf_filter: id })}
                  className={clsx("flex-1 rounded py-1", prefs.pdf_filter === id ? "bg-surface font-medium shadow-sm" : "text-muted")}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-muted">默认保留原稿颜色；暗色会反转图片颜色。</p>
          </div>
          <button className="flex w-full items-center justify-between text-sm" onClick={onRotate}>
            <span>旋转页面</span>
            <span className="flex items-center gap-1 text-muted"><RotateCw className="h-3.5 w-3.5" />{rotation}°</span>
          </button>
        </>
      ) : (
        <>
          <Stepper
            label="字号"
            testid="font-size-value"
            value={`${prefs.font_size}`}
            onDec={() => onChange({ font_size: Math.max(12, prefs.font_size - 1) })}
            onInc={() => onChange({ font_size: Math.min(36, prefs.font_size + 1) })}
          />
          <Stepper
            label="行距"
            testid="line-height-value"
            value={prefs.line_height.toFixed(1)}
            onDec={() => onChange({ line_height: Math.max(1.2, Math.round((prefs.line_height - 0.2) * 10) / 10) })}
            onInc={() => onChange({ line_height: Math.min(2.6, Math.round((prefs.line_height + 0.2) * 10) / 10) })}
          />
        </>
      )}
    </div>
  );
}
