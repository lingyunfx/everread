import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "../api/client";
import type { Preferences, User } from "../api/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
  refresh: () => Promise<void>;
  setUser: (u: User) => void;
  updatePreferences: (p: Partial<Preferences>) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** 退出时清理本账号在浏览器里的私有缓存（待同步进度、笔记草稿等） */
function clearPrivateCache() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("everread:")) localStorage.removeItem(key);
  }
}

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    clearPrivateCache();
    setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      return;
    }
    try {
      setUser(await api.me());
    } catch {
      setToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    refresh().finally(() => setLoading(false));
  }, [logout, refresh]);

  useEffect(() => {
    applyTheme(user?.preferences.theme ?? "light");
  }, [user?.preferences.theme]);

  const login = useCallback(async (email: string, password: string) => {
    const { access_token } = await api.login(email, password);
    setToken(access_token);
    const me = await api.me();
    setUser(me);
    return me;
  }, []);

  const updatePreferences = useCallback(
    async (p: Partial<Preferences>) => {
      if (!user) return;
      // 先本地生效，再保存到服务端
      setUser({ ...user, preferences: { ...user.preferences, ...p } });
      try {
        setUser(await api.updatePreferences(p));
      } catch {
        /* 偏好保存失败不影响阅读 */
      }
    },
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh, setUser, updatePreferences }),
    [user, loading, login, logout, refresh, updatePreferences],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return ctx;
}

export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("未登录");
  return user;
}
