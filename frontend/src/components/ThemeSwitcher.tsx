import clsx from "clsx";
import { Coffee, Moon, Sun } from "lucide-react";
import type { Theme } from "../api/types";
import { useAuth } from "../auth/AuthContext";

export const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: "light", label: "亮色", icon: Sun },
  { id: "dark", label: "暗色", icon: Moon },
  { id: "sepia", label: "暖黄", icon: Coffee },
];

export function ThemeSwitcher({ className }: { className?: string }) {
  const { user, updatePreferences } = useAuth();
  const current = user?.preferences.theme ?? "light";
  return (
    <div className={clsx("flex items-center rounded-md border border-border p-0.5", className)} role="radiogroup" aria-label="主题">
      {THEMES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="radio"
          aria-checked={current === id}
          title={label}
          onClick={() => updatePreferences({ theme: id })}
          className={clsx(
            "rounded p-1.5",
            current === id ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}
