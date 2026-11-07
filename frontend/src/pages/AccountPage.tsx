import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api, setToken } from "../api/client";
import { useAuth, useUser } from "../auth/AuthContext";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { Button, Input, useToast } from "../components/ui";

export function PasswordForm({ onDone }: { onDone: () => void }) {
  const { refresh } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (next.length < 8) return setError("新密码至少 8 位");
    if (next !== confirm) return setError("两次输入的新密码不一致");
    setBusy(true);
    try {
      const { access_token } = await api.changePassword(current, next);
      setToken(access_token);
      await refresh();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="mb-1 block text-sm" htmlFor="cur">当前密码</label>
        <Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div>
        <label className="mb-1 block text-sm" htmlFor="new">新密码（至少 8 位）</label>
        <Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </div>
      <div>
        <label className="mb-1 block text-sm" htmlFor="confirm">确认新密码</label>
        <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="primary" loading={busy}>
        修改密码
      </Button>
    </form>
  );
}

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-sm">
        <h1 className="mb-1 text-xl font-bold">首次登录，请修改密码</h1>
        <p className="mb-5 text-sm text-muted">管理员为你设置的是临时密码，修改后才能开始使用。</p>
        <PasswordForm onDone={() => navigate("/", { replace: true })} />
        <button className="mt-4 text-sm text-muted underline" onClick={() => { logout(); navigate("/login"); }}>
          退出登录
        </button>
      </div>
    </div>
  );
}

export function AccountPage() {
  const user = useUser();
  const toast = useToast();
  return (
    <div className="max-w-lg space-y-8">
      <section>
        <h1 className="mb-1 text-xl font-bold">账号设置</h1>
        <p className="text-sm text-muted">
          {user.full_name ? `${user.full_name} · ` : ""}
          {user.email}
          {user.is_admin && " · 管理员"}
        </p>
      </section>
      <section>
        <h2 className="mb-3 font-semibold">阅读主题</h2>
        <ThemeSwitcher className="w-fit" />
      </section>
      <section>
        <h2 className="mb-3 font-semibold">修改密码</h2>
        <p className="mb-3 text-xs text-muted">修改后，其他设备上的登录会失效。</p>
        <PasswordForm onDone={() => toast("密码已修改")} />
      </section>
      {user.is_admin && (
        <section className="rounded-lg border border-border bg-surface p-4 text-sm">
          <h2 className="mb-2 font-semibold">管理朋友账号</h2>
          <p className="mb-2 text-muted">当前版本通过服务器命令行管理账号：</p>
          <pre className="overflow-x-auto rounded bg-surface-2 p-3 text-xs leading-relaxed">{`docker compose exec backend python -m app.cli create-user friend@example.com --name 小明
docker compose exec backend python -m app.cli reset-password friend@example.com
docker compose exec backend python -m app.cli disable-user friend@example.com
docker compose exec backend python -m app.cli list-users`}</pre>
        </section>
      )}
    </div>
  );
}
