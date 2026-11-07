import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { Button, Input } from "../components/ui";

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={user.must_change_password ? "/change-password" : "/"} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const me = await login(email, password);
      navigate(me.must_change_password ? "/change-password" : "/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-sm">
        <div className="mb-6 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-3 h-12 w-12" />
          <h1 className="font-serif text-2xl font-bold">永读 EverRead</h1>
          <p className="mt-1 text-sm text-muted">永远都可以读书</p>
        </div>
        <label className="mb-1 block text-sm font-medium" htmlFor="email">
          邮箱
        </label>
        <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="mt-4 mb-1 block text-sm font-medium" htmlFor="password">
          密码
        </label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" className="mt-6 w-full" loading={busy}>
          登录
        </Button>
        <p className="mt-4 text-center text-xs text-muted">不开放注册，账号请联系管理员创建</p>
      </form>
    </div>
  );
}
