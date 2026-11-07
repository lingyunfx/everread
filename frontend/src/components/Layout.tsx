import clsx from "clsx";
import { BookOpen, Library, LogOut, Settings, Upload } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { ThemeSwitcher } from "./ThemeSwitcher";

const NAV = [
  { to: "/", label: "我的书架", icon: BookOpen, end: true },
  { to: "/library", label: "图书馆", icon: Library, end: false },
  { to: "/manage", label: "我上传的书", icon: Upload, end: false },
];

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:gap-4 sm:px-4">
          <NavLink to="/" className="mr-1 flex items-center gap-2 font-serif text-lg font-bold text-accent sm:mr-4">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="hidden sm:inline">永读</span>
          </NavLink>
          <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto sm:gap-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  clsx(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap",
                    isActive ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg",
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </NavLink>
            ))}
          </nav>
          <ThemeSwitcher />
          <NavLink to="/account" className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg" title="账号设置">
            <Settings className="h-4 w-4" />
          </NavLink>
          <button
            className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
            title={`退出（${user?.email}）`}
            onClick={() => {
              logout();
              navigate("/login");
            }}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-5 sm:px-4">
        <Outlet />
      </main>
    </div>
  );
}
