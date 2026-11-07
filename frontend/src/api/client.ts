// 轻量 API 客户端：统一附加 Bearer 令牌、解析错误信息
import type {
  Annotation,
  Book,
  BookDetail,
  Bookmark,
  LibraryItem,
  Locator,
  Note,
  Preferences,
  Progress,
  ReadStatus,
  RecordHit,
  ShelfItem,
  User,
  Visibility,
} from "./types";

export const API = "/api/v1";
const TOKEN_KEY = "everread:token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object" && "detail" in data) {
    const d = (data as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d) && d[0]?.msg) return `参数错误：${d[0].msg}`;
  }
  if (status === 0) return "网络连接失败";
  return `请求失败（${status}）`;
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders(), ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, headers, body });
  } catch {
    throw new ApiError(0, "网络连接失败，请检查网络", null);
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    if (res.status === 401 && getToken()) onUnauthorized?.();
    throw new ApiError(res.status, errorMessage(data, res.status), data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export const api = {
  login: async (email: string, password: string) => {
    const form = new URLSearchParams({ username: email, password });
    return request<{ access_token: string }>("/login/access-token", {
      method: "POST",
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  },
  me: () => request<User>("/users/me"),
  changePassword: (current_password: string, new_password: string) =>
    request<{ access_token: string }>("/users/me/password", { method: "POST", json: { current_password, new_password } }),
  updatePreferences: (p: Partial<Preferences>) => request<User>("/users/me/preferences", { method: "PATCH", json: p }),

  // 书籍
  myUploads: () => request<Book[]>("/books/mine"),
  book: (id: string) => request<BookDetail>(`/books/${id}`),
  updateBook: (id: string, data: { title?: string; author?: string | null; visibility?: Visibility }) =>
    request<Book>(`/books/${id}`, { method: "PATCH", json: data }),
  retryBook: (id: string, encoding?: string) =>
    request<Book>(`/books/${id}/retry`, { method: "POST", json: { encoding: encoding || null } }),
  deleteImpact: (id: string) => request<{ other_readers: number }>(`/books/${id}/delete-impact`),
  deleteBook: (id: string) => request(`/books/${id}`, { method: "DELETE" }),
  deleteMyRecords: (id: string) => request(`/books/${id}/my-records`, { method: "DELETE" }),
  txtContent: (id: string) => request<{ encoding: string; paragraphs: string[] }>(`/books/${id}/txt`),

  // 书架 / 图书馆
  shelf: (params: { read_status?: ReadStatus; q?: string; sort?: string; removed?: boolean }) =>
    request<ShelfItem[]>(`/shelf${q(params)}`),
  addToShelf: (id: string) => request<ShelfItem>(`/shelf/${id}`, { method: "POST" }),
  removeFromShelf: (id: string) => request(`/shelf/${id}`, { method: "DELETE" }),
  setReadStatus: (id: string, read_status: ReadStatus) =>
    request<ShelfItem>(`/shelf/${id}`, { method: "PATCH", json: { read_status } }),
  openBook: (id: string) => request<ShelfItem>(`/shelf/${id}/open`, { method: "POST" }),
  library: (query?: string) => request<LibraryItem[]>(`/library${q({ q: query })}`),

  // 阅读记录
  progress: (id: string) => request<Progress | null>(`/books/${id}/progress`),
  saveProgress: (
    id: string,
    body: { locator: Locator; percent: number; base_revision: number | null; force?: boolean; device?: string },
    keepalive = false,
  ) => request<Progress>(`/books/${id}/progress`, { method: "PUT", json: body, keepalive }),
  annotations: (id: string) => request<Annotation[]>(`/books/${id}/annotations`),
  createAnnotation: (bookId: string, a: Partial<Annotation> & { locator: Locator }) =>
    request<Annotation>(`/books/${bookId}/annotations`, { method: "POST", json: a }),
  updateAnnotation: (id: string, color: string) =>
    request<Annotation>(`/annotations/${id}`, { method: "PATCH", json: { color } }),
  deleteAnnotation: (id: string) => request(`/annotations/${id}`, { method: "DELETE" }),
  notes: (id: string) => request<Note[]>(`/books/${id}/notes`),
  createNote: (
    bookId: string,
    n: { id: string; annotation_id?: string | null; locator?: Locator | null; quote?: string | null; body: string },
  ) => request<Note>(`/books/${bookId}/notes`, { method: "POST", json: n }),
  updateNote: (id: string, body: string, base_revision: number | null) =>
    request<Note>(`/notes/${id}`, { method: "PATCH", json: { body, base_revision } }),
  deleteNote: (id: string) => request(`/notes/${id}`, { method: "DELETE" }),
  bookmarks: (id: string, query?: string) => request<Bookmark[]>(`/books/${id}/bookmarks${q({ q: query })}`),
  createBookmark: (bookId: string, b: Omit<Bookmark, "book_id" | "created_at">) =>
    request<Bookmark>(`/books/${bookId}/bookmarks`, { method: "POST", json: b }),
  updateBookmark: (id: string, data: { name?: string; memo?: string }) =>
    request<Bookmark>(`/bookmarks/${id}`, { method: "PATCH", json: data }),
  deleteBookmark: (id: string) => request(`/bookmarks/${id}`, { method: "DELETE" }),
  searchRecords: (bookId: string, query: string, kind: "note" | "annotation", offset = 0) =>
    request<{ total: number; items: RecordHit[] }>(
      `/books/${bookId}/records/search${q({ q: query, kind, offset, limit: 50 })}`,
    ),
};

/** 带进度的上传（fetch 不支持上传进度，这里用 XHR） */
export function uploadBook(
  file: File,
  onProgress: (ratio: number) => void,
): Promise<{ ok: true; book: Book } | { ok: false; status: number; message: string; bookId?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/books`);
    const t = getToken();
    if (t) xhr.setRequestHeader("Authorization", `Bearer ${t}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const data = safeJson(xhr.responseText) as Record<string, unknown> | null;
      if (xhr.status === 201) resolve({ ok: true, book: data as unknown as Book });
      else
        resolve({
          ok: false,
          status: xhr.status,
          message: errorMessage(data, xhr.status),
          bookId: (data?.book_id as string) ?? undefined,
        });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, message: "网络连接失败" });
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/** 生成 UUID v4。crypto.randomUUID 只在 HTTPS/localhost 可用，局域网 HTTP 访问时回退到 getRandomValues */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
