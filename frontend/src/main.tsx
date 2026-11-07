import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Layout } from "./components/Layout";
import { Spinner, ToastProvider } from "./components/ui";
import "./index.css";
import { AccountPage, ChangePasswordPage } from "./pages/AccountPage";
import { LibraryPage } from "./pages/LibraryPage";
import { LoginPage } from "./pages/LoginPage";
import { ManagePage } from "./pages/ManagePage";
import { ShelfPage } from "./pages/ShelfPage";
import { ReaderPage } from "./reader/ReaderPage";

/** 需要登录；首次登录必须先修改临时密码 */
function RequireAuth({ children, allowPasswordChange }: { children: ReactNode; allowPasswordChange?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.must_change_password && !allowPasswordChange) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/change-password", element: <RequireAuth allowPasswordChange><ChangePasswordPage /></RequireAuth> },
  { path: "/read/:bookId", element: <RequireAuth><ReaderPage /></RequireAuth> },
  {
    element: <RequireAuth><Layout /></RequireAuth>,
    children: [
      { path: "/", element: <ShelfPage /> },
      { path: "/library", element: <LibraryPage /> },
      { path: "/manage", element: <ManagePage /> },
      { path: "/account", element: <AccountPage /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </AuthProvider>
  </StrictMode>,
);
